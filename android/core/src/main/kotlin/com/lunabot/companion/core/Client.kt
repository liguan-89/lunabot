package com.lunabot.companion.core

import java.io.IOException
import java.net.Inet6Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.Proxy
import java.net.URI
import java.net.UnknownHostException
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Dns
import okhttp3.Headers
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

internal data class ConnectionEndpoint(val baseUrl: HttpUrl, val dns: Dns)

/**
 * The HTTP stack that runs inside an E2E tunnel.
 *
 * The tunnel is the route: every byte already reaches the computer through it,
 * and its synthetic host (`h-….e2e.invalid`) is not a name any proxy could
 * resolve. Left to the platform's proxy selector — a VPN app's local HTTP
 * proxy, say — OkHttp would dial *the proxy* through this same socket factory
 * and write an absolute-form request line (`PUT http://h-….e2e.invalid/api/…`)
 * into the tunnel. The computer reads that whole string as a path, finds no
 * route for it, and the phone reports the connection as unreachable while the
 * tunnel itself is perfectly healthy.
 */
internal fun e2eHttpClient(base: OkHttpClient, tunnel: com.lunabot.companion.core.e2e.E2eTransport): OkHttpClient =
    base.newBuilder()
        .socketFactory(tunnel.socketFactory)
        .dns(tunnel.dns)
        .proxy(Proxy.NO_PROXY)
        .build()

/** The durable pairing result together with the route that actually redeemed it. */
data class PairingOutcome(
    val response: PairResponse,
    val connection: Connection,
)

/** No automatically permitted route identified itself and completed the logical pairing. */
class PairingRouteError(
    val attemptedRoutes: List<String>,
    message: String = "无法通过任何可用路由连接到此电脑 " +
        "(${attemptedRoutes.joinToString()})。请在 Luna Bot 中保持开启“手机访问”后再试。",
) : IOException(message)

/** Keep the same code and request id after an uncertain redemption or rate-limit refusal. */
class ServerPairingRetryError(cause: IOException) : IOException(
    if (cause is APIError.Status && cause.code == 429) cause.message
    else "无法完成与服务器的连接。请使用相同的配对码重试。", cause,
)

internal const val SCOPED_IPV6_HTTP_HOST = "scoped-ipv6.lunabot.invalid"

/** What a companion answers `/api/health` with; one on an older release says the name that release had. */
internal val COMPANION_APP_NAMES: Set<String> = setOf("lunabot", "dexbot", "openmausbot")

/**
 * OkHttp deliberately rejects RFC 6874 zone identifiers in HttpUrl hosts.
 * A bare IPv6 literal makes OkHttp bypass Dns entirely, so a zoned address
 * uses a private synthetic hostname in HttpUrl. ScopedIpv6Dns maps that name
 * straight to the scoped Inet6Address OkHttp passes to Socket.connect.
 */
internal fun Connection.httpEndpoint(fallbackDns: Dns): ConnectionEndpoint? {
    val dialingEndpoint = activeEndpoint
        ?: CompanionEndpoint.direct(host, port, priority = 0)
        ?: return null
    if (!allowsEndpoint(dialingEndpoint)) return null
    return runCatching {
        val dialingHost = dialingEndpoint.host
        val dialingPort = dialingEndpoint.port
        val dialingScheme = if (dialingEndpoint.isSecure) "https" else "http"
        val bareHost = if (dialingHost.startsWith('[') && dialingHost.endsWith(']')) {
            dialingHost.substring(1, dialingHost.length - 1)
        } else {
            dialingHost
        }
        val zoneAt = if (':' in bareHost) bareHost.indexOf('%') else -1
        require(zoneAt < 0 || zoneAt < bareHost.lastIndex) { "IPv6 zone identifier is empty" }
        val addressHost = if (zoneAt >= 0) bareHost.substring(0, zoneAt) else bareHost
        val httpHost = if (zoneAt >= 0) SCOPED_IPV6_HTTP_HOST else addressHost
        val zone = if (zoneAt >= 0) bareHost.substring(zoneAt + 1) else null
        val url = HttpUrl.Builder()
            .scheme(dialingScheme)
            .host(httpHost)
            .port(dialingPort)
            .build()
        val dns = if (zone == null) {
            fallbackDns
        } else {
            ScopedIpv6Dns(url.host, addressHost, zone, fallbackDns)
        }
        ConnectionEndpoint(url, dns)
    }.getOrNull()
}

internal class ScopedIpv6Dns(
    private val targetHost: String,
    private val addressHost: String,
    private val zone: String,
    private val fallback: Dns,
) : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
        if (!hostname.equals(targetHost, ignoreCase = true)) return fallback.lookup(hostname)
        val unscoped = InetAddress.getByName(addressHost) as? Inet6Address
            ?: throw UnknownHostException("$addressHost is not an IPv6 address")
        val scoped = zone.toIntOrNull()?.let { scopeId ->
            if (scopeId <= 0) throw UnknownHostException("Invalid IPv6 scope id: $zone")
            Inet6Address.getByAddress(addressHost, unscoped.address, scopeId)
        } ?: run {
            val networkInterface = NetworkInterface.getByName(zone)
                ?: throw UnknownHostException("No network interface named $zone")
            Inet6Address.getByAddress(addressHost, unscoped.address, networkInterface)
        }
        return listOf(scoped)
    }
}

class CompanionClient(
    val connection: Connection,
    private val token: String?,
    baseClient: OkHttpClient = OkHttpClient(),
    appLabel: String = "lunabot-android",
    routeAccess: RouteAccess = RouteAccess.ALL,
) {
    /**
     * When the pairing carried an e2e descriptor, every request and stream runs
     * inside that encrypted session: OkHttp is pointed at a synthetic host whose
     * SocketFactory is the tunnel, so nothing else in this class changes.
     */
    private val e2e: com.lunabot.companion.core.e2e.E2eTransport? =
        connection.e2eDescriptor?.let { descriptor ->
            token?.let {
                com.lunabot.companion.core.e2e.E2eTransport(
                    descriptor = descriptor,
                    token = it,
                    app = appLabel,
                    directUrl = connection.e2eDirectUrl(routeAccess),
                )
            }
        }

    /** The route the tunnel tries before the relay; null when only the relay may carry this session. */
    val e2eDirectUrl: String?
        get() = e2e?.directUrl

    private val transportClient: OkHttpClient = run {
        val tunnel = e2e ?: return@run baseClient
        e2eHttpClient(baseClient, tunnel)
    }

    private val endpoint = run {
        val tunnel = e2e
        if (tunnel == null) {
            connection.httpEndpoint(baseClient.dns)
        } else {
            runCatching {
                ConnectionEndpoint(
                    HttpUrl.Builder().scheme("http").host(tunnel.httpHost).port(80).build(),
                    tunnel.dns,
                )
            }.getOrNull()
        }
    }

    init {
        com.lunabot.companion.core.e2e.E2eLog.line(
            "client e2e=${e2e != null} base=${endpoint?.baseUrl}",
        )
        // A tunnel that had to be rebuilt invalidates every connection the
        // pool still holds against the old one; otherwise OkHttp keeps
        // reusing a dead socket and each request times out without ever
        // reaching the socket factory again.
        e2e?.onTunnelLost = {
            for (client in listOf(
                actionClient, uploadClient, streamingClient, phoneJobClient,
                avatarGenerationClient, videoAvatarGenerationClient, claudeUpdateClient,
            )) {
                client.connectionPool.evictAll()
            }
        }
    }

    private val actionClient = transportClient.newBuilder()
        .followRedirects(transportClient.followRedirects && !connection.pairedWithServer)
        .followSslRedirects(transportClient.followSslRedirects && !connection.pairedWithServer)
        .dns(endpoint?.dns ?: transportClient.dns)
        .callTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .connectTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .writeTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()

    /**
     * Share uploads can be tens of MB. A wall-clock [callTimeout] would abort a
     * steady transfer; iOS uses an idle `timeoutInterval` that resets on bytes.
     * Connect/read/write idle limits, no overall call deadline.
     */
    private val uploadClient = transportClient.newBuilder()
        .followRedirects(transportClient.followRedirects && !connection.pairedWithServer)
        .followSslRedirects(transportClient.followSslRedirects && !connection.pairedWithServer)
        .dns(endpoint?.dns ?: transportClient.dns)
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .connectTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .writeTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()

    private val streamingClient = transportClient.newBuilder()
        .followRedirects(transportClient.followRedirects && !connection.pairedWithServer)
        .followSslRedirects(transportClient.followSslRedirects && !connection.pairedWithServer)
        .dns(endpoint?.dns ?: transportClient.dns)
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .connectTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(STREAM_IDLE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .writeTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()

    /**
     * The job poll is held open by the server for 20 s on purpose; an ordinary
     * action's 30 s deadline would abandon it at the same moment it answers.
     */
    private val phoneJobClient = transportClient.newBuilder()
        .followRedirects(transportClient.followRedirects && !connection.pairedWithServer)
        .followSslRedirects(transportClient.followSslRedirects && !connection.pairedWithServer)
        .dns(endpoint?.dns ?: transportClient.dns)
        .callTimeout(PHONE_JOB_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .connectTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(PHONE_JOB_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .writeTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()

    /**
     * A job's answer is worthless once the server stops waiting for it, so the
     * result post fails fast: a stuck socket or a busy computer is retried by
     * the caller instead of burning the whole window on one attempt.
     */
    private val phoneResultClient = transportClient.newBuilder()
        .followRedirects(transportClient.followRedirects && !connection.pairedWithServer)
        .followSslRedirects(transportClient.followSslRedirects && !connection.pairedWithServer)
        .dns(endpoint?.dns ?: transportClient.dns)
        .callTimeout(PHONE_RESULT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .connectTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(PHONE_RESULT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .writeTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()

    private val avatarGenerationClient = transportClient.newBuilder()
        .followRedirects(transportClient.followRedirects && !connection.pairedWithServer)
        .followSslRedirects(transportClient.followSslRedirects && !connection.pairedWithServer)
        .dns(endpoint?.dns ?: transportClient.dns)
        .callTimeout(AVATAR_GENERATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .connectTimeout(AVATAR_GENERATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(AVATAR_GENERATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .writeTimeout(AVATAR_GENERATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()

    /**
     * Seedance video avatar generation can queue and render for up to 25 minutes on the server.
     * Give the mobile request a 26-minute deadline so the server's own result or timeout lands cleanly.
     */
    private val videoAvatarGenerationClient = transportClient.newBuilder()
        .followRedirects(transportClient.followRedirects && !connection.pairedWithServer)
        .followSslRedirects(transportClient.followSslRedirects && !connection.pairedWithServer)
        .dns(endpoint?.dns ?: transportClient.dns)
        .callTimeout(VIDEO_AVATAR_GENERATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .connectTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(VIDEO_AVATAR_GENERATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .writeTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()

    /**
     * Claude Code's own updater can take minutes on the computer, so this
     * route gets its own deadline instead of the thirty-second action one.
     */
    private val claudeUpdateClient = transportClient.newBuilder()
        .followRedirects(transportClient.followRedirects && !connection.pairedWithServer)
        .followSslRedirects(transportClient.followSslRedirects && !connection.pairedWithServer)
        .dns(endpoint?.dns ?: transportClient.dns)
        .callTimeout(CLAUDE_UPDATE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .connectTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(CLAUDE_UPDATE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .writeTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()

    /** Read identity without sending the saved bearer to a potentially replaced server. */
    suspend fun environment(): ServerEnvironment {
        connection.requireServerTransport()
        val publicClient = CompanionClient(connection, null, actionClient)
        return publicClient.send(
            publicClient.makeRequest("GET", "/.well-known/dexbot/environment"),
            publicClient.actionClient.newBuilder().followRedirects(false).followSslRedirects(false).build(),
        )
    }

    suspend fun health(): JsonObject = send(makeRequest("GET", "/api/health"))

    /** Wire support for P1-03; applying the snapshot to a live session is deliberately later. */
    suspend fun connectionMetadata(): CompanionConnectionMetadata =
        send(makeRequest("GET", "/api/companion/endpoints"))

    suspend fun fleet(messages: Int? = 50): Fleet = send(makeRequest(
        method = "GET",
        path = "/api/bots",
        query = messages?.let { listOf("messages" to it.toString()) }.orEmpty(),
    ))

    suspend fun messages(threadId: String, before: String? = null, limit: Int = 50): ThreadPage {
        val query = buildList {
            add("limit" to limit.toString())
            before?.let { add("before" to it) }
        }
        return send(makeRequest("GET", "/api/threads/${segment(threadId)}/messages", query))
    }

    suspend fun messagesAround(threadId: String, messageId: String, limit: Int = 50): ThreadPage = send(
        makeRequest(
            "GET",
            "/api/threads/${segment(threadId)}/messages",
            listOf("limit" to limit.toString(), "around" to messageId),
        ),
    )

    suspend fun search(query: String, limit: Int = 40): List<SearchHit> = send<SearchResponse>(
        makeRequest("GET", "/api/search", listOf("q" to query, "limit" to limit.toString())),
    ).hits

    suspend fun export(threadId: String, format: String): TranscriptExport {
        val raw = perform(makeRequest(
            "GET",
            "/api/threads/${segment(threadId)}/export",
            listOf("format" to format),
        ))
        check(raw)
        val fallback = "transcript.${if (format == "json") "json" else "md"}"
        val filename = raw.headers["Content-Disposition"]
            .orEmpty()
            .split(';')
            .map(String::trim)
            .firstOrNull { it.startsWith("filename=", ignoreCase = true) }
            ?.drop("filename=".length)
            ?.trim('"')
            ?: fallback
        return TranscriptExport(
            data = raw.data,
            filename = filename,
            contentType = raw.headers["Content-Type"] ?: "application/octet-stream",
        )
    }

    suspend fun instances(): List<Instance> = send<InstanceList>(
        makeRequest("GET", "/api/instances"),
    ).instances

    /** Missing capability data fails closed: image prompts must be readable by the selected model. */
    suspend fun imageCapableInstanceIds(): Set<String> = instances()
        .filter { it.capabilities?.images == true }
        .mapTo(mutableSetOf(), Instance::instanceId)

    suspend fun config(): ConfigStatus = send(makeRequest("GET", "/api/config"))

    /**
     * The engine is a setting, not a secret, so it rides the ordinary config
     * write — the same one `VoiceSettings.tsx` sends from its Voice engine
     * group. Only the provider field is written; keys and server addresses
     * stay on the computer.
     */
    suspend fun updateVoiceProvider(provider: VoiceProvider): ConfigStatus = send(
        makeRequest(
            "PUT",
            "/api/config",
            body = buildJsonObject {
                put("tts", buildJsonObject { put("provider", provider.wire) })
            },
        ),
    )

    suspend fun connectorCatalog(): ConnectorCatalog =
        send(makeRequest("GET", "/api/connectors/catalog"))

    suspend fun allConnectorStatuses(): ConnectorStatuses =
        send(makeRequest("GET", "/api/connectors/connected"))

    suspend fun image(threadId: String, messageId: String): ByteArray {
        val raw = perform(makeRequest("GET", "/api/threads/${segment(threadId)}/messages/${segment(messageId)}/image"))
        check(raw)
        return raw.data
    }

    /**
     * Fetch an app-owned file mentioned by one transcript message. The path
     * still names the file on the paired computer, so it is sent in an
     * authenticated JSON body rather than placed in the URL. The server
     * verifies both message provenance and its attachment roots.
     */
    suspend fun downloadFile(threadId: String, messageId: String, path: String): DownloadedFile {
        val link = LocalMessageLink.resolve(path) as? LocalMessageLink.DesktopFile ?: throw APIError.BadUrl
        val raw = perform(
            makeRequest(
                "POST",
                "/api/threads/${safeRouteId(threadId)}/messages/${safeRouteId(messageId)}/file",
                body = jsonBody("path" to link.path),
            ),
        )
        check(raw)
        val declared = raw.headers["Content-Length"]?.trim()?.toLongOrNull() ?: -1L
        if (declared > MAXIMUM_FILE_DOWNLOAD_BYTES || raw.data.size > MAXIMUM_FILE_DOWNLOAD_BYTES) {
            throw APIError.Transport("该文件大于 25 MB。")
        }
        val rawContentType = raw.headers["Content-Type"].orEmpty()
        val contentType = if (AttachmentPolicy.validMime(rawContentType)) {
            AttachmentPolicy.normalizedMime(rawContentType)
        } else {
            "application/octet-stream"
        }
        return DownloadedFile(
            data = raw.data,
            filename = downloadFilename(raw.headers["Content-Disposition"], link.path),
            contentType = contentType,
        )
    }

    suspend fun avatar(path: String): ByteArray {
        if (!validAvatarPath(path)) throw APIError.BadUrl
        val raw = perform(makeRequest("GET", path))
        check(raw)
        return raw.data
    }

    suspend fun voices(): List<Voice> = send<VoiceListResponse>(
        makeRequest("GET", "/api/tts/voices"),
    ).voices

    suspend fun routines(): RoutinesResponse = send(makeRequest("GET", "/api/routines"))

    suspend fun overview(botId: String): BotOverview =
        send(makeRequest("GET", "/api/bots/${segment(botId)}/overview"))

    /**
     * The bot's MCP servers: names and switches only. Like the overview this
     * needs the admin scope, so a Team Cloud member's session is refused — and
     * a plain refusal is the whole answer to show them.
     */
    suspend fun mcpServers(botId: String): McpServersResponse =
        send(makeRequest("GET", "/api/bots/${segment(botId)}/mcp-servers"))

    suspend fun createBot(): Bot = send<CreatedBot>(makeRequest("POST", "/api/bots")).bot

    /**
     * Atomically file visible bots under one shared sidebar heading. This is
     * narrower than the desktop's general bot patch: pairing a phone grants
     * organization, never execution-policy edits.
     */
    suspend fun assignSection(name: String, botIds: List<String>): List<Bot> = send<SidebarSectionResponse>(
        makeRequest(
            "POST",
            "/api/sidebar-sections",
            body = buildJsonObject {
                put("name", name)
                put("botIds", JsonArray(botIds.map(::JsonPrimitive)))
            },
        ),
    ).bots

    suspend fun updateProfile(botId: String, patch: BotProfilePatch): Bot {
        val body = CompanionJson.encodeToJsonElement(BotProfilePatch.serializer(), patch).jsonObject
        return send<BotResponse>(
            makeRequest("PATCH", "/api/bots/${segment(botId)}/profile", body = body),
        ).bot
    }

    /**
     * Summarize this thread's context on the computer. Asynchronous like a turn:
     * the summary arrives as a normal message on the stream, and history is kept.
     */
    suspend fun compact(botId: String, threadId: String) {
        sendUnit(
            makeRequest(
                "POST",
                "/api/bots/${segment(botId)}/compact",
                body = jsonBody("threadId" to threadId),
            ),
        )
    }

    /**
     * A captured task changes only that task's model. The optional legacy form
     * retains the narrow profile/default model route for older callers.
     */
    suspend fun updateModel(botId: String, selection: ModelSelection, threadId: String? = null): Bot {
        val model = CompanionJson.encodeToJsonElement(ModelSelection.serializer(), selection).jsonObject
        val path = if (threadId == null) "/api/bots/${segment(botId)}/model"
            else "/api/bots/${segment(botId)}/tasks/${segment(threadId)}"
        val body = if (threadId == null) model else buildJsonObject {
            put("modelSelection", model)
            put("requireAvailableModel", true)
        }
        return send<BotResponse>(
            makeRequest("PATCH", path, body = body),
        ).bot
    }

    /** Upload a shared image as raw bytes; [uploadId] makes an interrupted retry idempotent. */
    suspend fun uploadImage(data: ByteArray, mime: String, uploadId: String? = null): String {
        if (!validUploadId(uploadId)) throw APIError.BadUrl
        val normalized = mime.lowercase()
        if (normalized !in AVATAR_MIME_TYPES || data.size > AVATAR_MAX_BYTES) {
            throw APIError.Transport("请选择不超过 10 MB 的 PNG、JPEG、GIF 或 WebP 图片。")
        }
        val saved = send<AttachmentResponse>(
            makeRequest(
                "POST",
                "/api/attachments",
                query = uploadId?.let { listOf("uploadId" to it) }.orEmpty(),
                rawBody = data.toRequestBody(normalized.toMediaType()),
            ),
            uploadClient,
        )
        if (!validUploadedPath(saved.path)) {
            throw APIError.Transport("无法使用已上传的图片。")
        }
        return saved.path
    }

    suspend fun uploadAvatar(data: ByteArray, mime: String): String {
        val path = uploadImage(data, mime)
        val name = path.substringAfterLast('/')
        if (name.isEmpty() || '/' in name) throw APIError.Transport("无法使用已上传的图片。")
        return "/api/attachments/$name"
    }

    /** Upload a supported document. The server picks its storage path; [name] is display metadata. */
    suspend fun uploadFile(data: ByteArray, name: String, mime: String, uploadId: String? = null): UploadedFile {
        if (!validUploadId(uploadId)) throw APIError.BadUrl
        val displayName = name.substringAfterLast('/').substringAfterLast('\\').trim()
        val normalized = mime.lowercase()
        if (
            displayName.isEmpty() || displayName.toByteArray().size > 255 ||
            !validUploadMime(normalized) || data.size > SHARE_FILE_MAX_BYTES
        ) throw APIError.Transport("请选择文件名有效且不超过 25 MB 的文件。")
        val saved = send<FileUploadResponse>(
            makeRequest(
                "POST",
                "/api/files",
                query = buildList {
                    add("name" to displayName)
                    uploadId?.let { add("uploadId" to it) }
                },
                rawBody = data.toRequestBody(normalized.toMediaType()),
            ),
            uploadClient,
        )
        val returnedName = saved.name.trim()
        if (!validUploadedPath(saved.path) || !validUploadedName(returnedName)) {
            throw APIError.Transport("无法使用已上传的文件。")
        }
        return UploadedFile(saved.path, returnedName)
    }

    suspend fun generateAvatar(botId: String, prompt: String): Bot =
        send<GeneratedAvatarResponse>(
            makeRequest(
                "POST",
                "/api/bots/${segment(botId)}/avatar/generate",
                body = jsonBody("prompt" to prompt.take(400)),
            ),
            avatarGenerationClient,
        ).bot

    suspend fun generateAvatarState(
        botId: String,
        state: String,
        style: String? = null,
        prompt: String? = null,
        resolution: String = "720p",
        loop: Boolean = state != "working",
    ): Bot {
        val body = buildJsonObject {
            put("state", state)
            style?.takeIf { it.isNotBlank() }?.let { put("style", it) }
            prompt?.takeIf { it.isNotBlank() }?.let { put("prompt", it.take(600)) }
            put("resolution", resolution)
            put("loop", loop)
        }
        return send<GeneratedAvatarStateResponse>(
            makeRequest(
                "POST",
                "/api/bots/${segment(botId)}/avatar/states/generate",
                body = body,
            ),
            videoAvatarGenerationClient,
        ).bot
    }

    suspend fun uploadAvatarState(
        botId: String,
        state: String,
        data: ByteArray,
        mime: String,
    ): Bot {
        val normalized = mime.lowercase()
        if (normalized !in AVATAR_STATE_MIME_TYPES || data.size > AVATAR_STATE_MAX_BYTES) {
            throw APIError.Transport("请选择不超过 25 MB 的 MP4、WebM 或图片文件。")
        }
        return send<GeneratedAvatarStateResponse>(
            makeRequest(
                "POST",
                "/api/bots/${segment(botId)}/avatar/states/upload",
                query = listOf("state" to state),
                rawBody = data.toRequestBody(normalized.toMediaType()),
            ),
            uploadClient,
        ).bot
    }

    /**
     * Run Claude Code's updater for one engine on the computer and return the
     * version it now reports. The harness refuses while a Claude turn is
     * running, and its refusal is already worded for a person.
     */
    suspend fun updateClaude(instanceId: String): String {
        if (!isSafeInstanceId(instanceId)) throw APIError.BadUrl
        return send<ClaudeUpdateResponse>(
            makeRequest(
                "POST",
                "/api/instances/$instanceId/claude-update",
                body = JsonObject(emptyMap()),
            ),
            claudeUpdateClient,
        ).version
    }

    suspend fun previewVoice(text: String, voiceId: String): ByteArray = speak(text, voiceId)

    /**
     * One utterance, synthesized on the paired computer. The server caps this
     * at 500 characters; [prepareSpeech] splits a reply into pieces that fit.
     * An empty [voiceId] means the workspace default.
     */
    suspend fun speak(text: String, voiceId: String?): ByteArray {
        val raw = perform(makeRequest(
            "POST",
            "/api/tts/speak",
            body = buildJsonObject {
                put("text", text.take(500))
                if (!voiceId.isNullOrEmpty()) put("voiceId", voiceId)
            },
        ))
        check(raw)
        return raw.data
    }

    /**
     * One voice clip heard by the computer's ASR provider: the raw WAV goes
     * up as the body, `{text}` comes back. The upload client because a minute
     * of speech is a real transfer plus a remote transcription round-trip,
     * not an action's twenty seconds.
     */
    suspend fun transcribe(wav: ByteArray): String = send<TranscribeResponse>(
        makeRequest(
            "POST",
            "/api/tts/transcribe",
            rawBody = wav.toRequestBody(WAV_MEDIA_TYPE),
        ),
        uploadClient,
    ).text

    @Serializable
    private data class TranscribeResponse(val text: String = "")

    /**
     * Split a reply into utterances the way the desktop does — on the server,
     * next to the transform that shapes replies — and learn whether the
     * computer can voice them at all.
     */
    suspend fun prepareSpeech(text: String, voiceId: String?): PreparedSpeech = send(
        makeRequest(
            "POST",
            "/api/tts/prepare",
            body = buildJsonObject {
                put("text", text)
                if (!voiceId.isNullOrEmpty()) put("voiceId", voiceId)
            },
        ),
    )

    @Serializable
    private data class LiveCallResponse(val call: LiveCallState? = null)

    /** 电脑当前是否有 Live 通话；只读状态，不含语音内容或密钥。 */
    suspend fun liveCall(): LiveCallState? = send<LiveCallResponse>(
        makeRequest("GET", "/api/live/call"),
    ).call

    /** 切换语音引擎；请求体必须正好是 companion 窄写口允许的形状。 */
    suspend fun updateVoiceProvider(provider: String) {
        sendUnit(makeRequest("PUT", "/api/config", body = buildJsonObject {
            put("tts", buildJsonObject { put("provider", provider) })
        }))
    }

    suspend fun createRoutine(input: RoutineInput): Routine {
        requireSupported(input.schedule)
        requireValidTimeout(input.timeoutMinutes)
        return send<RoutineResponse>(
            makeRequest("POST", "/api/routines", body = routineBody(input)),
        ).routine
    }

    suspend fun updateRoutine(id: String, input: RoutineInput): Routine {
        requireSupported(input.schedule)
        requireValidTimeout(input.timeoutMinutes)
        return send<RoutineResponse>(
            makeRequest("PATCH", "/api/routines/${segment(id)}", body = routineBody(input)),
        ).routine
    }

    suspend fun setRoutineEnabled(id: String, enabled: Boolean): Routine =
        send<RoutineResponse>(
            makeRequest("PATCH", "/api/routines/${segment(id)}", body = buildJsonObject { put("enabled", enabled) }),
        ).routine

    suspend fun runRoutine(id: String): RoutineRun = send<RoutineRunResponse>(
        makeRequest("POST", "/api/routines/${segment(id)}/run"),
    ).run

    suspend fun deleteRoutine(id: String) {
        sendUnit(makeRequest("DELETE", "/api/routines/${segment(id)}"))
    }

    /** Clear a run's "needs you" dot without opening the task it produced. */
    suspend fun markRoutineRunSeen(id: String) {
        sendUnit(makeRequest("POST", "/api/routine-runs/${segment(id)}/seen"))
    }

    /** Stop a run that is still going, or waiting on the person. */
    suspend fun cancelRoutineRun(id: String) {
        sendUnit(makeRequest("POST", "/api/routine-runs/${segment(id)}/cancel"))
    }

    suspend fun createRoom(name: String?, memberIds: List<String>): Room {
        val body = buildJsonObject {
            put("memberIds", JsonArray(memberIds.map(::JsonPrimitive)))
            name?.let { value ->
                val trimmed = value.trim { character ->
                    character == '\t' || character.category == CharCategory.SPACE_SEPARATOR
                }
                if (trimmed.isNotEmpty()) put("name", value)
            }
        }
        return send<CreatedRoom>(makeRequest("POST", "/api/groups", body = body)).group
    }

    suspend fun sendToBot(botId: String, text: String, threadId: String? = null): SendReceipt =
        sendForReceipt(
            makeRequest("POST", "/api/bots/${segment(botId)}/messages", body = jsonBody("text" to text, "threadId" to threadId)),
        )

    suspend fun sendToRoom(groupId: String, text: String, threadId: String? = null): SendReceipt =
        sendForReceipt(
            makeRequest("POST", "/api/groups/${segment(groupId)}/messages", body = jsonBody("text" to text, "threadId" to threadId)),
        )

    /**
     * Drop a message the harness is still holding, before the turn it is
     * waiting behind settles.
     *
     * An entry that drained a moment ago is not an error worth showing — that
     * is the outcome the caller wanted. But that is matched positively on the
     * harness's own wording and never on the status alone: the sidecar answers
     * 404 "no route" for a route it does not allow, so a computer too old to
     * have this route looks identical to a drained entry. Reading those as the
     * same thing takes the message off the phone while it is still queued on
     * the computer, and it then arrives anyway.
     */
    // A drained row can disappear, but only a confirmed cancellation permits Edit to restore it.
    suspend fun cancelQueued(queueId: String, to: MessageDestination): Boolean {
        if (!isSafeRouteId(queueId)) throw APIError.BadUrl
        val route = when (to) {
            is MessageDestination.Bot -> "/api/bots/${safeRouteId(to.id)}/queue/$queueId"
            is MessageDestination.Room -> "/api/groups/${safeRouteId(to.id)}/queue/$queueId"
        }
        try {
            sendUnit(makeRequest("DELETE", route, body = jsonBody("threadId" to to.threadId)))
            return true
        } catch (error: APIError.Status) {
            if (error.code != 404) throw error
            // The harness's own words, not Throwable.message, which falls
            // back to generic text for a 404 and would swallow everything.
            if (error.serverMessage?.contains(ALREADY_DRAINED, ignoreCase = true) == true) return false
            throw APIError.Status(
                404,
                "此电脑版本过旧，无法撤回排队中的消息。请在电脑上更新 Luna Bot。",
            )
        }
    }

    /** Retry-safe send: [threadId] is fixed at destination selection, never inferred on retry. */
    suspend fun send(text: String, to: MessageDestination, sendId: String): SendReceipt {
        val route = when (to) {
            is MessageDestination.Bot -> "/api/bots/${safeRouteId(to.id)}/messages"
            is MessageDestination.Room -> "/api/groups/${safeRouteId(to.id)}/messages"
        }
        if (!isSafeRouteId(to.threadId) || !isSafeSendId(sendId)) throw APIError.BadUrl
        return sendForReceipt(makeRequest(
            "POST",
            route,
            body = buildJsonObject {
                put("text", text)
                put("threadId", to.threadId)
                put("sendId", sendId)
            },
        ))
    }

    /** A widget press rides the same message POST as text: `widgetAction` names the
     * message, the pressed ref and the rev it was made on, plus the collected form
     * values. [sendId] makes a retried press land once. */
    suspend fun sendWidgetAction(botId: String, widgetAction: JsonObject, threadId: String, sendId: String): SendReceipt {
        if (!isSafeRouteId(botId) || !isSafeRouteId(threadId) || !isSafeSendId(sendId)) throw APIError.BadUrl
        return sendForReceipt(makeRequest(
            "POST",
            "/api/bots/${safeRouteId(botId)}/messages",
            body = buildJsonObject {
                put("widgetAction", widgetAction)
                put("threadId", threadId)
                put("sendId", sendId)
            },
        ))
    }

    suspend fun respond(
        threadId: String,
        requestId: String,
        behavior: String,
        message: String? = null,
        reviewedSha256: String? = null,
    ) {
        val body = buildJsonObject {
            put("requestId", requestId)
            put("behavior", behavior)
            message?.let { put("message", it) }
            reviewedSha256?.let { put("reviewedSha256", it) }
        }
        sendUnit(makeRequest("POST", "/api/threads/${segment(threadId)}/respond", body = body))
    }

    suspend fun alwaysAllow(botId: String, key: String, threadId: String? = null) {
        sendUnit(makeRequest("POST", "/api/bots/${segment(botId)}/always-allow", body = jsonBody("allowKey" to key, "threadId" to threadId)))
    }

    /**
     * Revoke one connected account.
     *
     * The companion allowlist carries this route precisely so a phone can undo
     * what a phone connected; the host still proves the account belongs to its
     * own user before revoking.
     */
    suspend fun deleteConnectorAccount(slug: String, accountId: String) {
        if (!validConnectorSlug(slug)) throw APIError.BadUrl
        sendUnit(makeRequest("DELETE", "/api/connectors/$slug/accounts/${segment(accountId)}"))
    }

    suspend fun authorizeConnector(slug: String, alias: String?): URI {
        if (!validConnectorSlug(slug)) throw APIError.BadUrl
        val body = ConnectedAppsRules.trimmedAlias(alias)?.let { jsonBody("alias" to it) }
        val response = send<ConnectorAuthorizationResponse>(makeRequest(
            "POST",
            "/api/connectors/$slug/authorize",
            body = body,
        ))
        val url = runCatching { URI(response.url) }.getOrNull()
        if (url == null || !url.scheme.equals("https", ignoreCase = true) || url.host.isNullOrEmpty()) {
            throw APIError.BadUrl
        }
        return url
    }

    suspend fun toggleReaction(threadId: String, messageId: String, emoji: String): Message =
        send<MessageResponse>(makeRequest(
            "POST",
            "/api/threads/${segment(threadId)}/messages/${segment(messageId)}/reactions",
            body = jsonBody("emoji" to emoji),
        )).message

    /**
     * Resume or dismiss an inline connector request.
     *
     * The card carries its own message id, and the server answers by patching
     * that message — which arrives again over the event stream. So the reply
     * body is not needed here; what matters is that the request happens.
     */
    suspend fun connectorCardAction(
        botId: String,
        messageId: String,
        threadId: String,
        action: ConnectorCardAction,
    ) {
        sendUnit(makeRequest(
            "POST",
            "/api/bots/${segment(botId)}/connector-cards/${segment(messageId)}/${action.wire}",
            body = jsonBody("threadId" to threadId),
        ))
    }

    /** The same two verbs for a credential request. */
    suspend fun secretCardAction(
        botId: String,
        messageId: String,
        threadId: String,
        action: SecretCardAction,
    ) {
        sendUnit(makeRequest(
            "POST",
            "/api/bots/${segment(botId)}/secret-cards/${segment(messageId)}/${action.wire}",
            body = jsonBody("threadId" to threadId),
        ))
    }

    /**
     * Answer a sign-in request: the person signed in themselves, or gave up.
     * No credential passes through here — the body carries the thread, and the
     * password stays in the page the computer is working in.
     */
    suspend fun signInCardAction(
        botId: String,
        messageId: String,
        threadId: String,
        action: SignInCardAction,
    ) {
        sendUnit(makeRequest(
            "POST",
            "/api/bots/${segment(botId)}/sign-in-cards/${segment(messageId)}/${action.wire}",
            body = jsonBody("threadId" to threadId),
        ))
    }

    /**
     * Fork the conversation at a user message. Returns the computer's new
     * message when the response carries one. [sendId] makes a retry of the same
     * edit answer with the existing fork instead of forking twice.
     */
    suspend fun edit(
        botId: String,
        messageId: String,
        text: String,
        threadId: String? = null,
        sendId: String? = null,
    ): Message? {
        val raw = perform(makeRequest(
            "POST",
            "/api/bots/${segment(botId)}/messages/${segment(messageId)}/edit",
            body = jsonBody("text" to text, "threadId" to threadId, "sendId" to sendId),
        ))
        check(raw)
        // The fork already happened; an unreadable body only costs the early
        // swap, and the event stream still delivers the same fork.
        return runCatching {
            CompanionJson.decodeFromString<EditResponse>(raw.data.toString(Charsets.UTF_8)).message
        }.getOrNull()
    }

    suspend fun setActiveBranch(botId: String, messageId: String, threadId: String? = null): String =
        send<ActiveBranchResponse>(makeRequest(
            "POST",
            "/api/bots/${segment(botId)}/active-branch",
            body = jsonBody("messageId" to messageId, "threadId" to threadId),
        )).activeLeafId

    suspend fun createTask(botId: String, title: String? = null): Bot {
        val body = buildJsonObject {
            title?.takeIf(String::isNotEmpty)?.let { put("title", it) }
        }
        return send<BotResponse>(makeRequest("POST", "/api/bots/${segment(botId)}/tasks", body = body)).bot
    }

    suspend fun switchTask(botId: String, threadId: String): Bot = send<BotResponse>(
        makeRequest("POST", "/api/bots/${segment(botId)}/tasks/${segment(threadId)}"),
    ).bot

    suspend fun renameTask(botId: String, threadId: String, title: String) {
        sendUnit(makeRequest(
            "PATCH",
            "/api/bots/${segment(botId)}/tasks/${segment(threadId)}",
            body = jsonBody("title" to title),
        ))
    }

    /**
     * 0 sleeps until new activity, a timestamp until it passes, and null — a
     * real JSON null, not an omitted field — wakes the thread now. Long
     * milliseconds, never Double: the stamp must not travel in scientific
     * notation, and an omitted field would leave the snooze untouched.
     */
    suspend fun snoozeTask(botId: String, threadId: String, snoozedUntil: Long?) {
        sendUnit(makeRequest(
            "PATCH",
            "/api/bots/${segment(botId)}/tasks/${segment(threadId)}",
            body = buildJsonObject { put("snoozedUntil", JsonPrimitive(snoozedUntil)) },
        ))
    }

    /** The unarchive PATCH carries an explicit null, so jsonBody's skip-nulls
     * rule cannot be used here. Stamps are whole milliseconds: a Double would
     * serialize large ones in scientific notation. */
    suspend fun setTaskPinned(botId: String, threadId: String, pinned: Boolean) {
        sendUnit(makeRequest(
            "PATCH",
            "/api/bots/${segment(botId)}/tasks/${segment(threadId)}",
            body = buildJsonObject { put("pinned", pinned) },
        ))
    }

    /** Title is echoed so an older server does not rename the thread to empty. */
    suspend fun setRoomTaskPinned(groupId: String, threadId: String, pinned: Boolean, title: String) {
        sendUnit(makeRequest(
            "PATCH",
            "/api/groups/${segment(groupId)}/tasks/${segment(threadId)}",
            body = buildJsonObject {
                put("pinned", pinned)
                put("title", title)
            },
        ))
    }

    suspend fun setTaskArchived(botId: String, threadId: String, archivedAt: Double?) {
        sendUnit(makeRequest(
            "PATCH",
            "/api/bots/${segment(botId)}/tasks/${segment(threadId)}",
            body = buildJsonObject { put("archivedAt", JsonPrimitive(archivedAt?.toLong())) },
        ))
    }

    suspend fun deleteTask(botId: String, threadId: String): Bot = send<BotResponse>(
        makeRequest("DELETE", "/api/bots/${segment(botId)}/tasks/${segment(threadId)}"),
    ).bot

    suspend fun createRoomTask(groupId: String, title: String? = null): Room {
        val body = buildJsonObject {
            title?.takeIf(String::isNotEmpty)?.let { put("title", it) }
        }
        return send<RoomResponse>(
            makeRequest("POST", "/api/groups/${segment(groupId)}/tasks", body = body),
        ).group
    }

    suspend fun switchRoomTask(groupId: String, threadId: String): Room = send<RoomResponse>(
        makeRequest("POST", "/api/groups/${segment(groupId)}/tasks/${segment(threadId)}"),
    ).group

    suspend fun renameRoomTask(groupId: String, threadId: String, title: String) {
        sendUnit(makeRequest(
            "PATCH",
            "/api/groups/${segment(groupId)}/tasks/${segment(threadId)}",
            body = jsonBody("title" to title),
        ))
    }

    suspend fun deleteRoomTask(groupId: String, threadId: String): Room = send<RoomResponse>(
        makeRequest("DELETE", "/api/groups/${segment(groupId)}/tasks/${segment(threadId)}"),
    ).group

    suspend fun interrupt(botId: String, threadId: String? = null) {
        sendUnit(makeRequest("POST", "/api/bots/${segment(botId)}/interrupt", body = jsonBody("threadId" to threadId)))
    }

    /** Stop whatever bot is speaking in a room, or one thread of it. */
    suspend fun interruptRoom(groupId: String, threadId: String? = null) {
        sendUnit(makeRequest("POST", "/api/groups/${segment(groupId)}/interrupt", body = jsonBody("threadId" to threadId)))
    }

    /**
     * Revoke this device's session on a server-direct pairing. The companion
     * sidecar has no such route (pairing is a host-side setting), so a 404 is
     * expected there and means the local unpair is already the whole story.
     */
    suspend fun logout() {
        sendUnit(makeRequest("POST", "/api/auth/logout"))
    }

    suspend fun cloudDesktop(botId: String): CloudDesktopSession = send(
        makeRequest("POST", "/api/bots/${segment(botId)}/computer/join"),
    )

    /**
     * One fresh capture, for the computer viewer when no live frame is arriving.
     *
     * Cloud/Box and VPS answer `{ png, format }`; the Local VM answers
     * `{ image }` from its own route. "This Mac" answers its own frame shape
     * (`desktop/screenshot`), which also carries the screen size a tap has to be
     * expressed in, so it has its own call rather than sharing [screenshot].
     */
    suspend fun computerScreenshot(botId: String, threadId: String?): ScreenFrame =
        screenshot("/api/bots/${segment(botId)}/computer/screenshot", threadId)

    suspend fun localComputerScreenshot(botId: String, threadId: String?): ScreenFrame =
        screenshot("/api/bots/${segment(botId)}/local-computer/screenshot", threadId)

    /**
     * This computer's own screen. The frame is drawn in [DesktopScreenFrame.imageWidth] pixels but a tap must be sent in
     * [DesktopScreenFrame.screenWidth] points, so the sizes travel with the picture instead of being guessed.
     */
    suspend fun desktopScreenScreenshot(botId: String): DesktopScreenFrame =
        send(makeRequest("POST", "/api/bots/${segment(botId)}/desktop/screenshot", body = jsonBody()))

    /** One tap, key or typed run on this computer; needs the lease taken with [takeLocalComputer]. */
    suspend fun desktopScreenAction(botId: String, body: JsonObject): Unit =
        sendUnit(makeRequest("POST", "/api/bots/${segment(botId)}/desktop/action", body = body))

    /**
     * Take the bot's Local VM under a lease this phone names. The same lease is
     * what the sidecar checks every few seconds; without it the viewer is never
     * handed out.
     */
    suspend fun takeLocalComputer(botId: String, leaseId: String): ComputerControl =
        send(makeRequest(
            "POST",
            "/api/bots/${segment(botId)}/computer/control",
            body = buildJsonObject {
                put("action", "take")
                put("controlLeaseId", leaseId)
            },
        ))

    suspend fun releaseLocalComputer(botId: String, leaseId: String): ComputerControl =
        send(makeRequest(
            "POST",
            "/api/bots/${segment(botId)}/computer/control",
            body = buildJsonObject {
                put("action", "release")
                put("controlLeaseId", leaseId)
            },
        ))

    /** The viewer path, bound to [leaseId]; the sidecar closes it when the lease lapses. */
    suspend fun joinLocalComputer(botId: String, leaseId: String): LocalComputerJoin =
        send(makeRequest(
            "POST",
            "/api/bots/${segment(botId)}/local-computer/join",
            query = listOf("controlLeaseId" to leaseId),
        ))

    /** Hand the computer back: closes the viewer session before the lease is released. */
    suspend fun closeComputerViewer(botId: String) {
        sendUnit(makeRequest(
            "POST",
            "/api/bots/${segment(botId)}/computer/viewer-close",
        ))
    }

    /**
     * WebSockets outlive any request deadline: actionClient's 30 s
     * call/read/write limits would amputate a call mid-flight, so sockets get
     * their own client with no lifetime bounds and protocol pings to keep the
     * path honest.
     */
    private val socketClient = transportClient.newBuilder()
        .followRedirects(transportClient.followRedirects && !connection.pairedWithServer)
        .followSslRedirects(transportClient.followSslRedirects && !connection.pairedWithServer)
        .dns(endpoint?.dns ?: transportClient.dns)
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .connectTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(SOCKET_PING_INTERVAL_SECONDS, TimeUnit.SECONDS)
        .build()

    /**
     * A WebSocket to a companion path, carrying this device's bearer. The
     * viewer relay speaks raw RFB on the other end, so the caller writes and
     * reads bytes, not frames.
     */
    fun openViewerSocket(path: String, listener: WebSocketListener): WebSocket =
        openSocket(path, emptyList(), listener)

    /**
     * The same socket with query parameters, encoded like [makeRequest]'s.
     * The Live-call relay names its call target that way.
     */
    fun openSocket(path: String, query: List<Pair<String, String>>, listener: WebSocketListener): WebSocket {
        val base = endpoint?.baseUrl ?: throw APIError.BadUrl
        val url = base.newBuilder()
            .encodedPath(path)
            .apply { query.forEach { (name, value) -> addQueryParameter(name, value) } }
            .build()
        val request = Request.Builder()
            .url(url)
            .apply { token?.let { header("Authorization", "Bearer $it") } }
            .build()
        return socketClient.newWebSocket(request, listener)
    }

    private suspend fun screenshot(path: String, threadId: String?): ScreenFrame {
        val response: ScreenshotResponse = send(
            makeRequest(
                "POST",
                path,
                query = threadId?.let { listOf("threadId" to it) }.orEmpty(),
                body = jsonBody(),
            ),
        )
        val encoded = (response.png ?: response.image)?.takeIf(String::isNotBlank)
            ?: throw APIError.Transport("电脑没有返回画面。")
        val mime = when (response.format?.lowercase()) {
            "jpeg", "jpg", "image/jpeg" -> "image/jpeg"
            else -> "image/png"
        }
        return ScreenFrame(encoded, mime)
    }

    /** Both screenshot routes, flattened; only one field is ever present. */
    @Serializable
    private data class ScreenshotResponse(
        val png: String? = null,
        val image: String? = null,
        val format: String? = null,
    )

    suspend fun markBotRead(botId: String, threadId: String? = null) {
        sendUnit(makeRequest("POST", "/api/bots/${segment(botId)}/read", body = jsonBody("threadId" to threadId)))
    }

    suspend fun markRoomRead(roomId: String, threadId: String? = null) {
        sendUnit(makeRequest("POST", "/api/groups/${segment(roomId)}/read", body = jsonBody("threadId" to threadId)))
    }

    fun events(since: String?, screens: Boolean = false): Flow<StreamFrame> {
        val query = buildList {
            add("screens" to if (screens) "on" else "off")
            since?.let { add("since" to it) }
        }
        val request = makeRequest("GET", "/api/events", query).newBuilder()
            .header("Accept", "text/event-stream")
            .build()
        return eventStream(request, streamingClient)
    }

    // MARK: - A bot's browser, live

    /**
     * The bot's browser as server-sent events, undecoded: this view names each message with `event:` (`frame`, `ready`,
     * `control`, `tabs`, `url`, `status`, `waiting`, `heartbeat`, `error`) and a frame's payload is base64 image data
     * plus its own metadata, not one of the general feed's frame kinds.
     *
     * `size` is the panel's CSS pixels, which the page fills; the server answers with the frames that match it.
     */
    fun browserLive(botId: String, threadId: String? = null, size: Pair<Int, Int>? = null, resume: String? = null): Flow<SSEEvent> {
        val query = buildList {
            threadId?.let { add("threadId" to it) }
            size?.let { (width, height) ->
                add("width" to width.toString())
                add("height" to height.toString())
            }
            resume?.let { add("resume" to it) }
        }
        val request = makeRequest("GET", "/api/bots/${segment(botId)}/browser/live", query).newBuilder()
            .header("Accept", "text/event-stream")
            .build()
        return namedEventStream(request, streamingClient)
    }

    /**
     * One action on that view. The server routes it by `viewerId`, the id its `ready` event handed out, so it travels
     * inside the body on every call — a frame's acknowledgement included.
     */
    suspend fun browserAction(botId: String, viewerId: String, body: JsonObject, threadId: String? = null) {
        val withViewer = buildJsonObject {
            put("viewerId", viewerId)
            body.forEach { (name, value) -> put(name, value) }
        }
        sendUnit(makeRequest(
            "POST",
            "/api/bots/${segment(botId)}/browser/action",
            query = threadId?.let { listOf("threadId" to it) }.orEmpty(),
            body = withViewer,
        ))
    }

    // MARK: - Phone apps as bot tools

    /** Tell the computer what this phone allows. The key is the paired device, never the body. */
    suspend fun registerPhone(registration: PhoneRegistration) {
        sendUnit(makeRequest(
            "PUT",
            "/api/phones/self",
            body = CompanionJson.encodeToJsonElement(PhoneRegistration.serializer(), registration).jsonObject,
        ))
    }

    /** Forget this phone's apps; the computer stops offering them to bots. */
    suspend fun unregisterPhone() {
        sendUnit(makeRequest("DELETE", "/api/phones/self"))
    }

    /** Whether the computer has a registration for this phone. */
    suspend fun myPhone(): Boolean =
        send<PhoneSelfResponse>(makeRequest("GET", "/api/phones/self")).phone != null

    /** One long poll: null when no job arrived inside the server's window. */
    suspend fun pollPhoneJob(): PhoneJob? =
        send<PhoneJobPoll>(makeRequest("GET", "/api/phones/self/jobs"), phoneJobClient).job

    /** Take the job before running it; false when the asking turn already ended. */
    suspend fun leasePhoneJob(jobId: String): Boolean =
        send<PhoneLease>(
            makeRequest("POST", "/api/phones/self/jobs/${segment(jobId)}/lease"),
            phoneJobClient,
        ).active

    /** Push an inbound text the phone received; `sendId` dedupes re-broadcasts. */
    suspend fun postPhoneEvent(event: PhoneSmsEvent) {
        sendUnit(makeRequest(
            "POST",
            "/api/phones/self/events",
            body = CompanionJson.encodeToJsonElement(PhoneSmsEvent.serializer(), event).jsonObject,
        ))
    }

    /** Push one notification the person allowed this phone to share. */
    suspend fun postPhoneNotice(event: PhoneNoticeEvent) {
        sendUnit(makeRequest(
            "POST",
            "/api/phones/self/events",
            body = CompanionJson.encodeToJsonElement(PhoneNoticeEvent.serializer(), event).jsonObject,
        ))
    }

    /** Push the shade's key set for the ticked packages, for the server's reconcile. */
    suspend fun postPhoneShade(event: PhoneShadeEvent) {
        sendUnit(makeRequest(
            "POST",
            "/api/phones/self/events",
            body = CompanionJson.encodeToJsonElement(PhoneShadeEvent.serializer(), event).jsonObject,
        ))
    }

    /** Answer a leased job: `{ ok: true, result }` or `{ ok: false, error, code }`. */
    suspend fun completePhoneJob(jobId: String, outcome: JsonObject) {
        sendUnit(makeRequest(
            "POST",
            "/api/phones/self/jobs/${segment(jobId)}/result",
            body = outcome,
        ), phoneResultClient)
    }

    private fun makeRequest(
        method: String,
        path: String,
        query: List<Pair<String, String>> = emptyList(),
        body: JsonObject? = null,
        rawBody: RequestBody? = null,
    ): Request {
        require(body == null || rawBody == null)
        if (connection.pairedWithServer) connection.requireServerTransport()
        val base = endpoint?.baseUrl ?: throw APIError.BadUrl
        val url = base.newBuilder().encodedPath(path).apply {
            query.forEach { (name, value) -> addQueryParameter(name, value) }
        }.build()
        val requestBody = when {
            rawBody != null -> rawBody
            body != null -> CompanionJson.encodeToString(JsonObject.serializer(), body)
                .toRequestBody(JSON_MEDIA_TYPE)
            method == "POST" || method == "PATCH" -> EMPTY_BODY
            else -> null
        }
        return Request.Builder()
            .url(url)
            .method(method, requestBody)
            .apply { token?.let { header("Authorization", "Bearer $it") } }
            .build()
    }

    private suspend inline fun <reified T> send(
        request: Request,
        requestClient: OkHttpClient = actionClient,
    ): T {
        val raw = perform(request, requestClient)
        check(raw)
        return try {
            CompanionJson.decodeFromString(raw.data.toString(Charsets.UTF_8))
        } catch (error: SerializationException) {
            throw APIError.Transport("电脑返回了此应用无法识别的数据。", error)
        }
    }

    private suspend fun sendUnit(request: Request, requestClient: OkHttpClient = actionClient) {
        val raw = perform(request, requestClient)
        check(raw)
    }

    /**
     * A send, and what the harness did with it. Unlike [send] an unreadable
     * body is not an error here: the request succeeded, and an older harness
     * answering with a shape this build has never seen still made a plain
     * send. Only the extra mid-turn detail is lost.
     */
    private suspend fun sendForReceipt(request: Request): SendReceipt {
        val raw = perform(request)
        check(raw)
        return try {
            CompanionJson
                .decodeFromString<SendReceiptBody>(raw.data.toString(Charsets.UTF_8))
                .receipt()
        } catch (_: SerializationException) {
            SendReceipt.Sent(threadId = null, steered = false)
        }
    }

    /** Every authenticated action, including shares to inactive saved servers, checks identity. */
    private suspend fun perform(
        request: Request,
        requestClient: OkHttpClient = actionClient,
    ): RawResponse {
        if (token != null && connection.serverEnvironmentId != null &&
            environment().environmentId != connection.serverEnvironmentId
        ) {
            throw APIError.Status(401, "该地址属于另一台服务器。请重新配对以继续。")
        }
        return performUnchecked(request, requestClient)
    }

    private suspend fun performUnchecked(
        request: Request,
        requestClient: OkHttpClient = actionClient,
    ): RawResponse = suspendCancellableCoroutine { continuation ->
        val call = requestClient.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (continuation.isActive) {
                    continuation.resumeWithException(
                        APIError.Transport(e.message ?: "无法连接到电脑。", e),
                    )
                }
            }

            override fun onResponse(call: Call, response: Response) {
                try {
                    response.use {
                        val result = RawResponse(
                            code = response.code,
                            headers = response.headers,
                            data = response.body?.bytes() ?: ByteArray(0),
                        )
                        if (continuation.isActive) continuation.resume(result)
                    }
                } catch (error: IOException) {
                    if (continuation.isActive) {
                        continuation.resumeWithException(
                            APIError.Transport(error.message ?: "无法连接到电脑。", error),
                        )
                    }
                }
            }
        })
    }

    private fun check(response: RawResponse) {
        if (response.code in 200..299) return
        val message = runCatching {
            CompanionJson.decodeFromString<APIErrorBody>(response.data.toString(Charsets.UTF_8)).error
        }.getOrNull()
        throw APIError.Status(response.code, message)
    }

    private data class RawResponse(val code: Int, val headers: Headers, val data: ByteArray)

    companion object {
        /**
         * The harness's own answer when the entry is not in its queue.
         * Matched positively, never by status alone — see [cancelQueued].
         */
        const val ALREADY_DRAINED = "no such queued message"

        /**
         * 30 s: a screen action waits for a capture-sized frame to clear the relay before its own reply comes back, and
         * 20 s cut a tap off on a slow link (the phone showed a bare "timeout" while the action had in fact landed).
         */
        private const val ACTION_TIMEOUT_SECONDS = 30L
        private const val SOCKET_PING_INTERVAL_SECONDS = 20L
        /** The server holds a job poll for 20 s; this leaves it room to answer. */
        private const val PHONE_JOB_TIMEOUT_SECONDS = 35L
        private const val PHONE_RESULT_TIMEOUT_SECONDS = 10L
        private const val AVATAR_GENERATION_TIMEOUT_SECONDS = 150L
        private const val VIDEO_AVATAR_GENERATION_TIMEOUT_SECONDS = 1_560L
        /** The harness allows the updater three minutes; leave room to hear back. */
        private const val CLAUDE_UPDATE_TIMEOUT_SECONDS = 200L
        private const val STREAM_IDLE_TIMEOUT_SECONDS = 90L
        private const val AVATAR_MAX_BYTES = 10 * 1_024 * 1_024
        private const val AVATAR_STATE_MAX_BYTES = 25 * 1_024 * 1_024
        const val SHARE_FILE_MAX_BYTES = 25 * 1_024 * 1_024
        const val MAXIMUM_FILE_DOWNLOAD_BYTES = AttachmentPolicy.MAXIMUM_FILE_BYTES

        /**
         * The name to show a downloaded file under: `filename*=` first, then
         * `filename=`, then the last segment of the requested path — reduced to
         * a basename, with control and bidi-override characters blanked so a
         * server-chosen name cannot disguise itself.
         */
        internal fun downloadFilename(disposition: String?, fallbackPath: String): String {
            val parameters = disposition.orEmpty().split(';').map(String::trim)
            val encoded = parameters.firstOrNull { it.startsWith("filename*=", ignoreCase = true) }
                ?.drop("filename*=".length)
            val ordinary = parameters.firstOrNull { it.startsWith("filename=", ignoreCase = true) }
                ?.drop("filename=".length)
            val decodedEncoded = encoded?.let { value ->
                val unquoted = value.trim('"')
                val payload = unquoted.split('\'', limit = 3)
                val encodedValue = if (payload.size == 3) payload[2] else unquoted
                runCatching { java.net.URLDecoder.decode(encodedValue.replace("+", "%2B"), "UTF-8") }.getOrNull()
            }
            val candidate = decodedEncoded
                ?: ordinary?.trim('"')
                ?: fallbackPath.split('/', '\\').lastOrNull { it.isNotEmpty() }
                ?: "file"
            return sanitisePortableFilename(candidate, "file")
        }
        private val AVATAR_MIME_TYPES = setOf("image/png", "image/jpeg", "image/gif", "image/webp")
        private val AVATAR_STATE_MIME_TYPES = setOf(
            "image/png", "image/jpeg", "image/gif", "image/webp",
            "video/mp4", "video/webm",
        )
        private val JSON_MEDIA_TYPE = "application/json".toMediaType()
        private val WAV_MEDIA_TYPE = "audio/wav".toMediaType()
        private val EMPTY_BODY: RequestBody = ByteArray(0).toRequestBody(null)
        private const val HEX_DIGITS = "0123456789ABCDEF"

        /**
         * Escape one opaque id so it can only ever be a single path segment.
         *
         * [makeRequest] hands the finished string to `encodedPath`, which reads
         * it as already-encoded path syntax: an id holding `/` splits into extra
         * segments, and an id that is `.` or `..` is resolved away against the
         * segments before it. Percent-escaping alone cannot save a dot segment —
         * OkHttp resolves `%2e` and `%2e%2e` the same way — so those two ids are
         * refused outright, as is the empty id that would collapse the route.
         * Ids the sidecar issues carry no path syntax, so nothing valid changes.
         */
        private fun segment(value: String): String {
            if (value.isEmpty() || value == "." || value == "..") throw APIError.BadUrl
            val escaped = StringBuilder(value.length)
            for (byte in value.toByteArray(Charsets.UTF_8)) {
                val code = byte.toInt() and 0xFF
                val character = code.toChar()
                val unreserved = character in '0'..'9' ||
                    character in 'A'..'Z' ||
                    character in 'a'..'z' ||
                    character == '-' ||
                    character == '.' ||
                    character == '_' ||
                    character == '~'
                if (unreserved) {
                    escaped.append(character)
                } else {
                    escaped.append('%')
                        .append(HEX_DIGITS[code shr 4])
                        .append(HEX_DIGITS[code and 0x0F])
                }
            }
            return escaped.toString()
        }

        private fun validAvatarPath(path: String): Boolean {
            val prefix = "/api/attachments/"
            if (!path.startsWith(prefix)) return false
            val name = path.removePrefix(prefix).substringBefore('?')
            val dot = name.lastIndexOf('.')
            if (dot <= 0) return false
            val stem = name.substring(0, dot)
            val extension = name.substring(dot + 1)
            // The server's own rule for a stored avatar (shared/bot-avatar.ts, readAttachment):
            // [A-Za-z0-9-] stem, lowercase extension. Anything else is a 404, so refuse it here.
            return stem.all { it in '0'..'9' || it in 'A'..'Z' || it in 'a'..'z' || it == '-' } &&
                extension in setOf("png", "jpg", "gif", "webp", "mp4", "webm")
        }

        private fun validUploadMime(value: String): Boolean =
            value.isNotEmpty() && value.toByteArray().size <= 127 && '/' in value && value.all {
                it.isLetterOrDigit() || it in "!#$&+-. /^_".filterNot(Char::isWhitespace)
            }

        private fun validUploadId(value: String?): Boolean = value == null || runCatching {
            UUID.fromString(value).toString().equals(value, ignoreCase = true)
        }.getOrDefault(false)

        private fun validUploadedPath(value: String): Boolean =
            value.isNotEmpty() && value.toByteArray().size <= 4_096 && '\u0000' !in value

        private fun validUploadedName(value: String): Boolean =
            value.isNotEmpty() && value.toByteArray().size <= 255 && '/' !in value && '\\' !in value &&
                value.none(Char::isISOControl)

        private fun isSafeRouteId(value: String): Boolean =
            value.isNotEmpty() && value.all { it.isLetterOrDigit() || it == '-' || it == '_' }

        private fun safeRouteId(value: String): String = if (isSafeRouteId(value)) value else throw APIError.BadUrl

        /**
         * Engine instance ids are `[\w.-]+` on the harness — dots allowed, which
         * [isSafeRouteId] rightly refuses everywhere else. ASCII only, and never
         * a bare dot segment.
         */
        private fun isSafeInstanceId(value: String): Boolean =
            value != "." && value != ".." && INSTANCE_ID.matches(value)

        private val INSTANCE_ID = Regex("^[A-Za-z0-9_.-]+$")

        private fun isSafeSendId(value: String): Boolean = value.length in 16..80 && isSafeRouteId(value)

        private fun validConnectorSlug(value: String): Boolean =
            value.isNotEmpty() && value.all {
                it in '0'..'9' || it in 'A'..'Z' || it in 'a'..'z' || it == '_' || it == '-'
            }

        private fun requireSupported(schedule: RoutineSchedule) {
            if (schedule.type == RoutineSchedule.Kind.UNKNOWN) {
                throw APIError.Transport("保存此例程前请先选择受支持的运行计划。")
            }
            if (
                schedule.type == RoutineSchedule.Kind.INTERVAL &&
                ((schedule.everyMinutes ?: 0) !in 5..1_440 || schedule.anchorAt == null)
            ) {
                throw APIError.Transport(
                    "请选择 5 到 1,440 分钟之间的间隔以及对齐时间。",
                )
            }
        }

        private fun requireValidTimeout(timeoutMinutes: Int?) {
            if (timeoutMinutes != null && timeoutMinutes !in 5..240) {
                throw APIError.Transport("请选择不限超时，或 5 到 240 分钟之间的整数。")
            }
        }

        private fun routineBody(input: RoutineInput): JsonObject = buildJsonObject {
            put("name", input.name)
            put("prompt", input.prompt)
            put("botId", input.botId)
            put("runOn", input.runOn)
            input.enabled?.let { put("enabled", it) }
            put("schedule", buildJsonObject {
                put("type", input.schedule.type.name.lowercase())
                input.schedule.at?.let { put("at", it) }
                input.schedule.time?.let { put("time", it) }
                input.schedule.weekdays?.let { days ->
                    put("weekdays", JsonArray(days.map(::JsonPrimitive)))
                }
                input.schedule.everyMinutes?.let { put("everyMinutes", it) }
                input.schedule.anchorAt?.let { put("anchorAt", it) }
            })
            put("durationMinutes", input.durationMinutes)
            if (input.timeoutMinutes != null) put("timeoutMinutes", input.timeoutMinutes)
            else if (input.clearTimeout) put("timeoutMinutes", JsonNull)
        }

        suspend fun pairWithServer(
            connection: Connection,
            code: String,
            label: String,
            attemptId: String,
            client: OkHttpClient = OkHttpClient(),
        ): ServerPairResponse {
            connection.requireServerTransport()
            val companion = CompanionClient(connection, token = null, baseClient = client)
            val pairClient = client.newBuilder()
                .dns(companion.endpoint?.dns ?: client.dns)
                .followRedirects(false)
                .followSslRedirects(false)
                .callTimeout(PAIR_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .connectTimeout(PAIR_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .readTimeout(PAIR_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .writeTimeout(PAIR_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .build()
            return companion.send(companion.makeRequest(
                "POST", "/api/auth/pair",
                body = jsonBody("code" to code, "label" to label, "attemptId" to attemptId),
            ), pairClient)
        }

        suspend fun pair(
            connection: Connection,
            credential: String,
            deviceName: String,
            pairRequestId: String? = null,
            client: OkHttpClient = OkHttpClient(),
        ): PairResponse {
            val field = if (credential.length == 6 && credential.all { it in '0'..'9' }) {
                "code"
            } else {
                "credential"
            }
            val companion = CompanionClient(connection, token = null, baseClient = client)
            val body = buildList {
                add(field to credential)
                add("deviceName" to deviceName)
                pairRequestId?.let { add("pairRequestId" to it) }
            }
            val pairClient = client.newBuilder()
                .dns(companion.endpoint?.dns ?: client.dns)
                .callTimeout(PAIR_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .connectTimeout(PAIR_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .readTimeout(PAIR_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .writeTimeout(PAIR_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .build()
            return companion.send(companion.makeRequest(
                "POST",
                "/api/pair",
                body = jsonBody(*body.toTypedArray()),
            ), pairClient)
        }

        /**
         * Source-compatible entry point for callers written before request ids existed.
         *
         * This overload sends the credential directly to [connection], without a health/identity
         * preflight or request id. It is not safe for new multi-route pairing invitations; those
         * callers must use [pairFirstReachable].
         */
        suspend fun pair(
            connection: Connection,
            credential: String,
            deviceName: String,
            client: OkHttpClient,
        ): PairResponse = pair(
            connection,
            credential,
            deviceName,
            pairRequestId = null,
            client = client,
        )

        /**
         * Identify every automatically permitted route before presenting the one-time credential.
         * Probes run together, but the advertised order wins rather than response speed.
         */
        suspend fun pairFirstReachable(
            connection: Connection,
            credential: String,
            deviceName: String,
            pairRequestId: String = UUID.randomUUID().toString(),
            client: OkHttpClient = OkHttpClient(),
            routeAccess: RouteAccess = RouteAccess.ALL,
        ): PairingOutcome {
            val endpoints = CompanionEndpoint.automaticCandidates(connection.dialableEndpoints(routeAccess))
            val attemptedRoutes = endpoints.map(CompanionEndpoint::url)
            val remaining = endpoints.map(connection::dialing).toMutableList()

            while (remaining.isNotEmpty()) {
                val winnerIndex = firstHealthy(remaining, client)
                    ?: throw PairingRouteError(attemptedRoutes)
                val winner = remaining.removeAt(winnerIndex)
                try {
                    val response = pair(
                        connection = winner,
                        credential = credential,
                        deviceName = deviceName,
                        pairRequestId = pairRequestId,
                        client = client,
                    )
                    return PairingOutcome(response, winner)
                } catch (error: CancellationException) {
                    throw error
                } catch (error: APIError) {
                    if (ConnectionAdvice.shouldRetryPairingOnAnotherRoute(error)) continue
                    throw error
                } catch (_: Exception) {
                    // An unreadable/lost response is ambiguous. A newer sidecar replays the
                    // result for this exact request id through the next verified route.
                    continue
                }
            }
            throw PairingRouteError(attemptedRoutes)
        }

        private suspend fun firstHealthy(
            candidates: List<Connection>,
            client: OkHttpClient,
        ): Int? = coroutineScope {
            val probes = candidates.map { candidate ->
                async { healthy(candidate, client) }
            }
            try {
                for (index in probes.indices) {
                    if (probes[index].await()) {
                        probes.forEachIndexed { offset, probe ->
                            if (offset != index) probe.cancel()
                        }
                        return@coroutineScope index
                    }
                }
                null
            } finally {
                probes.forEach { it.cancel() }
            }
        }

        private suspend fun healthy(connection: Connection, client: OkHttpClient): Boolean {
            val companion = CompanionClient(connection, token = null, baseClient = client)
            val probeClient = client.newBuilder()
                .dns(companion.endpoint?.dns ?: client.dns)
                .callTimeout(PROBE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .connectTimeout(PROBE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .readTimeout(PROBE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .writeTimeout(PROBE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .build()
            return try {
                val identity = companion.send<HealthIdentity>(
                    companion.makeRequest("GET", "/api/health"),
                    probeClient,
                )
                identity.app in COMPANION_APP_NAMES
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                false
            }
        }

        @Serializable
        private data class HealthIdentity(val app: String)

        private fun jsonBody(vararg values: Pair<String, String?>): JsonObject = buildJsonObject {
            values.forEach { (name, value) -> value?.let { put(name, it) } }
        }

        private const val PROBE_TIMEOUT_SECONDS = 4L
        private const val PAIR_TIMEOUT_SECONDS = 8L
    }
}
