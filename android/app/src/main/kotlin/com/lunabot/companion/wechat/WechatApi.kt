// Adapted from Mika's WechatApi and WechatRuntime (Apache-2.0).
package com.lunabot.companion.wechat

import java.io.IOException
import java.util.Base64
import kotlin.random.Random
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * The iLink host. **Pinned.**
 *
 * Mika trusts the `baseurl` a QR-confirm response carries and then sends the
 * bot token to it, which lets a hostile (or compromised) response point the
 * token at any server it likes. Here the host is a compile-time constant and
 * the response's `baseurl` is parsed only to be ignored. The constructor
 * parameter exists so tests can point at a loopback server.
 */
internal const val ILINK_BASE_URL = "https://ilinkai.weixin.qq.com"

private val wechatJson = Json { ignoreUnknownKeys = true; explicitNulls = false }
private val jsonBody = "application/json; charset=utf-8".toMediaType()

/**
 * iLink has been seen sending `message_id` as a number and as a string. Reading
 * it as a string either way keeps the id usable as a dedupe key.
 */
private object FlexibleStringSerializer : KSerializer<String> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("FlexibleString", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: String) = encoder.encodeString(value)

    override fun deserialize(decoder: Decoder): String =
        decoder.decodeSerializableValue(JsonPrimitive.serializer()).content
}

@Serializable
data class WechatBaseInfo(@SerialName("channel_version") val channelVersion: String)

/** The binding: a bot token and who owns the bot. Never logged, never sent upstream. */
@Serializable
data class WechatAccount(
    val token: String,
    /** Recorded for diagnostics only. Every request goes to [ILINK_BASE_URL]. */
    @SerialName("baseurl") val baseUrl: String = ILINK_BASE_URL,
    @SerialName("ilink_bot_id") val botId: String = "",
    @SerialName("ilink_user_id") val ownerId: String,
)

@Serializable
data class WechatQrStart(
    val ret: Int = 0,
    val errmsg: String? = null,
    /** The polling key. Opaque; never rendered and never logged. */
    val qrcode: String? = null,
    /** What to encode into the QR image the person scans from WeChat's album. */
    @SerialName("qrcode_img_content") val qrContent: String? = null,
)

@Serializable
data class WechatQrStatus(
    val ret: Int = 0,
    val errmsg: String? = null,
    val status: String = "wait",
    @SerialName("bot_token") val token: String? = null,
    @SerialName("ilink_bot_id") val botId: String? = null,
    @SerialName("baseurl") val baseUrl: String? = null,
    @SerialName("ilink_user_id") val ownerId: String? = null,
) {
    /**
     * The confirmed account, or null while still waiting. The response's
     * `baseUrl` is deliberately discarded — see [ILINK_BASE_URL].
     */
    fun account(): WechatAccount? {
        if (status != "confirmed" || token.isNullOrBlank() || ownerId.isNullOrBlank()) return null
        return WechatAccount(token = token, botId = botId.orEmpty(), ownerId = ownerId)
    }
}

@Serializable
data class WechatText(val text: String = "")

@Serializable
data class WechatItem(
    val type: Int = 0,
    @SerialName("text_item") val textItem: WechatText? = null,
    @SerialName("image_item") val imageItem: WechatImage? = null,
)

@Serializable
data class WechatMessage(
    @Serializable(with = FlexibleStringSerializer::class)
    @SerialName("message_id") val messageId: String? = null,
    @SerialName("from_user_id") val fromUserId: String? = null,
    @SerialName("to_user_id") val toUserId: String? = null,
    @SerialName("client_id") val clientId: String? = null,
    @SerialName("create_time_ms") val createTimeMs: Long = 0,
    @SerialName("message_type") val messageType: Int = 0,
    @SerialName("message_state") val messageState: Int = 0,
    @SerialName("item_list") val items: List<WechatItem> = emptyList(),
    @SerialName("context_token") val contextToken: String? = null,
    @SerialName("group_id") val groupId: String? = null,
) {
    /**
     * Mika's double rule, kept verbatim: a user-sent private message — type 1,
     * with an id and a sender, and no group. A group message is dropped here,
     * before it can become an event; this build has no group policy at all.
     */
    fun isUserPrivateMessage(): Boolean =
        messageType == 1 && !messageId.isNullOrBlank() && !fromUserId.isNullOrBlank() && groupId.isNullOrBlank()

    /** Concatenated text items; empty when the message is images only. */
    fun text(): String =
        items.filter { it.type == 1 }
            .mapNotNull { it.textItem?.text?.takeIf(String::isNotBlank) }
            .joinToString("\n")

    /** Every image item, including malformed ones, so a failed attachment is reported rather than dropped. */
    fun images(): List<WechatImage> = items.filter { it.type == 2 }.map { it.imageItem ?: WechatImage() }
}

@Serializable
private data class UpdatesRequest(
    @SerialName("get_updates_buf") val cursor: String,
    @SerialName("base_info") val baseInfo: WechatBaseInfo,
)

@Serializable
data class WechatUpdates(
    val ret: Int = 0,
    val errmsg: String? = null,
    val msgs: List<WechatMessage> = emptyList(),
    @SerialName("get_updates_buf") val cursor: String = "",
)

@Serializable
private data class SendRequest(
    val msg: WechatMessage,
    @SerialName("base_info") val baseInfo: WechatBaseInfo,
)

/** iLink answered with a non-zero `ret`: a protocol refusal, not a transport failure. */
class WechatApiException(val code: Int, message: String) : IOException(message)

/** iLink answered with an HTTP error. 401/403 mean the binding is dead. */
class WechatHttpException(val httpCode: Int) : IOException("WeChat HTTP $httpCode")

/**
 * The WeChat Bot HTTPS client: protocol only, no tasks and no Android lifecycle.
 *
 * Text and images only, private chats only. Mika also carried contact lists,
 * moments, payments, image galleries, device unlock and "send as the person";
 * none of them are ported.
 */
internal class WechatApi(
    private val client: OkHttpClient,
    private val channelVersion: String,
    baseUrl: String = ILINK_BASE_URL,
    cdnBaseUrl: String = WechatImages.CDN_BASE_URL,
) : WechatTransport {
    private val base = baseUrl.trimEnd('/').toHttpUrl()

    /**
     * Media transfers never follow a redirect and never retry: a redirect on a
     * CDN request is either a mistake or an attempt to move the request.
     */
    private val mediaClient = client.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .callTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
        .build()
    private val images = WechatImageTransfer(mediaClient, cdnBaseUrl)

    /** Start a bind: a polling key plus the QR payload to show. */
    override fun startLogin(): WechatQrStart {
        val url = endpoint("get_bot_qrcode").newBuilder().addQueryParameter("bot_type", "3").build()
        val request = Request.Builder().url(url).headers(headers())
            .post(ByteArray(0).toRequestBody(null)).build()
        return execute(request, WechatQrStart.serializer())
    }

    /** One status poll: `wait`, then `confirmed` (with the token) or `expired`. */
    override fun pollLogin(qrcode: String): WechatQrStatus {
        val url = endpoint("get_qrcode_status").newBuilder().addQueryParameter("qrcode", qrcode).build()
        return execute(Request.Builder().url(url).headers(headers()).get().build(), WechatQrStatus.serializer())
    }

    /** One long poll. Cancellable, so a stopped or re-bound runtime cannot leave two polls running. */
    override suspend fun updates(account: WechatAccount, cursor: String): WechatUpdates {
        val payload = wechatJson.encodeToString(
            UpdatesRequest.serializer(),
            UpdatesRequest(cursor, WechatBaseInfo(channelVersion)),
        ).toRequestBody(jsonBody)
        val request = Request.Builder().url(endpoint("getupdates")).headers(headers(account.token))
            .post(payload).build()
        return executeCancellable(request, WechatUpdates.serializer())
    }

    /** Send text to the bound peer. Mika's own direct-chat path, verbatim. */
    override suspend fun sendText(
        account: WechatAccount,
        peerId: String,
        clientId: String,
        text: String,
        contextToken: String?,
    ) {
        val message = WechatMessage(
            fromUserId = "",
            toUserId = peerId,
            clientId = clientId,
            messageType = 2,
            messageState = 2,
            items = listOf(WechatItem(type = 1, textItem = WechatText(text))),
            contextToken = contextToken,
        )
        val body = SendRequest(message, WechatBaseInfo(channelVersion))
        val request = Request.Builder().url(endpoint("sendmessage")).headers(headers(account.token))
            .post(wechatJson.encodeToString(SendRequest.serializer(), body).toRequestBody(jsonBody)).build()
        executeCancellable(request, WechatQrStart.serializer())
    }

    override suspend fun downloadImage(image: WechatImage): WechatDownloadedImage = images.download(image)

    /**
     * Upload bytes. This does not send a chat message, so the caller can
     * re-check its binding before [sendImage].
     */
    override suspend fun uploadImage(account: WechatAccount, peerId: String, bytes: ByteArray): WechatUploadedImage {
        val prepared = WechatImages.prepare(bytes)
        val body = WechatUploadRequest(
            fileKey = prepared.fileKey,
            mediaType = 1,
            toUserId = peerId,
            rawSize = prepared.plainSize,
            rawFileMd5 = prepared.md5,
            fileSize = prepared.encrypted.size,
            noNeedThumb = true,
            aesKey = prepared.keyHex,
            baseInfo = WechatBaseInfo(channelVersion),
        )
        val request = Request.Builder().url(endpoint("getuploadurl")).headers(headers(account.token))
            .post(wechatJson.encodeToString(WechatUploadRequest.serializer(), body).toRequestBody(jsonBody))
            .build()
        val upload = executeCancellable(request, WechatUploadResponse.serializer(), mediaClient)
        return images.upload(prepared, upload)
    }

    /**
     * One image per message, with a stable client id; a caption is a separate
     * text delivery. Mika's own image path, verbatim.
     */
    override suspend fun sendImage(
        account: WechatAccount,
        peerId: String,
        clientId: String,
        uploaded: WechatUploadedImage,
        contextToken: String?,
    ) {
        val message = WechatMessage(
            fromUserId = "",
            toUserId = peerId,
            clientId = clientId,
            messageType = 2,
            messageState = 2,
            items = listOf(WechatItem(type = 2, imageItem = uploaded.image)),
            contextToken = contextToken,
        )
        val body = SendRequest(message, WechatBaseInfo(channelVersion))
        val request = Request.Builder().url(endpoint("sendmessage")).headers(headers(account.token))
            .post(wechatJson.encodeToString(SendRequest.serializer(), body).toRequestBody(jsonBody)).build()
        executeCancellable(request, WechatQrStart.serializer(), mediaClient)
    }

    private fun <T> execute(request: Request, serializer: kotlinx.serialization.DeserializationStrategy<T>): T =
        client.newCall(request).execute().use { decode(it, serializer) }

    private suspend fun <T> executeCancellable(
        request: Request,
        serializer: kotlinx.serialization.DeserializationStrategy<T>,
        http: OkHttpClient = client,
    ): T = awaitWechatResponse(http, request) { decode(it, serializer) }

    private fun <T> decode(response: Response, serializer: kotlinx.serialization.DeserializationStrategy<T>): T {
        val text = response.body?.string().orEmpty()
        if (!response.isSuccessful) throw WechatHttpException(response.code)
        if (text.isBlank()) throw IOException("WeChat returned an empty response")
        val result = wechatJson.decodeFromString(serializer, text)
        val (code, message) = when (result) {
            is WechatQrStart -> result.ret to result.errmsg
            is WechatQrStatus -> result.ret to result.errmsg
            is WechatUpdates -> result.ret to result.errmsg
            is WechatUploadResponse -> result.ret to result.errmsg
            else -> 0 to null
        }
        if (code != 0) throw WechatApiException(code, message ?: "WeChat API error $code")
        return result
    }

    private fun endpoint(path: String) = base.newBuilder().addPathSegments("ilink/bot/$path").build()

    /**
     * Mika's headers, verbatim. `X-WECHAT-UIN` is a fresh random value per
     * request: base64 of four random bytes.
     */
    private fun headers(token: String? = null) = okhttp3.Headers.Builder().apply {
        add("iLink-App-Id", "bot")
        add("iLink-App-ClientVersion", encodeVersion(channelVersion))
        if (token != null) {
            add("AuthorizationType", "ilink_bot_token")
            add("Authorization", "Bearer $token")
            add("X-WECHAT-UIN", randomUin())
        }
    }.build()

    private fun encodeVersion(version: String): String =
        String.format("%08x", version.filter { it.isDigit() }.take(8).ifEmpty { "1" }.toLong().toInt())

    private fun randomUin(): String = Base64.getEncoder().encodeToString(ByteArray(4).also { Random.nextBytes(it) })

    companion object {
        /** Production construction: the pinned host, an ordinary connection pool. */
        fun default(channelVersion: String): WechatApi = WechatApi(OkHttpClient(), channelVersion)
    }
}
