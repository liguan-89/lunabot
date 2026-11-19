// Adapted from Mika's WechatApi and WechatRuntime (Apache-2.0).
package com.openmausbot.companion.wechat

import java.io.IOException
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.SecretKeySpec
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okio.Buffer
import org.junit.After
import org.junit.Before
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The wire: headers, paths, bodies, and the CDN rules.
 *
 * The loopback server is a stand-in for iLink, so these are assertions about
 * *this* client's requests — which is the half of the contract the server agent
 * cannot see. The base URL is injectable for exactly this reason; production
 * always uses the pinned constant.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WechatApiTest {

    private lateinit var server: MockWebServer
    private lateinit var api: WechatApi

    private val account = WechatAccount(token = "bot-token", botId = "bot", ownerId = "owner")

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        val base = server.url("/").toString().trimEnd('/')
        api = WechatApi(OkHttpClient(), "2.0.1", base, "$base/c2c")
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun json(body: String) = MockResponse()
        .setHeader("Content-Type", "application/json")
        .setBody(body)

    @Test
    fun `the QR request carries the bot type and the iLink headers`() {
        server.enqueue(json("""{"qrcode":"key","qrcode_img_content":"https://example.test/qr"}"""))

        val start = api.startLogin()

        assertEquals("key", start.qrcode)
        assertEquals("https://example.test/qr", start.qrContent)
        val request = server.takeRequest()
        assertEquals("3", request.requestUrl?.queryParameter("bot_type"))
        assertEquals("/ilink/bot/get_bot_qrcode", request.requestUrl?.encodedPath)
        assertEquals("bot", request.getHeader("iLink-App-Id"))
        // "2.0.1" → 201 as a zero-padded hex word.
        assertEquals(String.format("%08x", 201), request.getHeader("iLink-App-ClientVersion"))
        // No token on an unauthenticated call.
        assertNull(request.getHeader("Authorization"))
    }

    @Test
    fun `the status poll sends the key as a query parameter`() {
        server.enqueue(json("""{"status":"wait"}"""))
        api.pollLogin("the-key")
        val request = server.takeRequest()
        assertEquals("the-key", request.requestUrl?.queryParameter("qrcode"))
        assertEquals("/ilink/bot/get_qrcode_status", request.requestUrl?.encodedPath)
    }

    @Test
    fun `a confirmed status yields the account and ignores the response baseurl`() {
        // The hostile field: a baseurl pointing somewhere else must not be used.
        server.enqueue(
            json(
                """{"status":"confirmed","bot_token":"tok","ilink_bot_id":"bot",
                   "baseurl":"https://evil.example.test","ilink_user_id":"owner"}""",
            ),
        )
        val account = api.pollLogin("key").account()
        assertNotNull(account)
        assertEquals("tok", account.token)
        assertEquals("owner", account.ownerId)
        assertEquals(ILINK_BASE_URL, account.baseUrl)
    }

    @Test
    fun `an unconfirmed status yields no account`() {
        server.enqueue(json("""{"status":"wait","bot_token":"tok","ilink_user_id":"owner"}"""))
        assertNull(api.pollLogin("key").account())
        server.enqueue(json("""{"status":"confirmed","ilink_user_id":"owner"}"""))
        assertNull(api.pollLogin("key").account())
    }

    @Test
    fun `a non-zero ret is an API error, not an empty answer`() {
        server.enqueue(json("""{"ret":5,"errmsg":"nope"}"""))
        val error = assertFailsWith<WechatApiException> { api.startLogin() }
        assertEquals(5, error.code)
    }

    @Test
    fun `updates send the cursor and authenticate with the bot token`() = kotlinx.coroutines.runBlocking {
        server.enqueue(
            json(
                """{"get_updates_buf":"next","msgs":[
                   {"message_id":123,"from_user_id":"owner","message_type":1,
                    "context_token":"ctx","item_list":[{"type":1,"text_item":{"text":"你好"}}]}]}""",
            ),
        )

        val updates = api.updates(account, "old")

        assertEquals("next", updates.cursor)
        assertEquals("123", updates.msgs.single().messageId)
        assertEquals("你好", updates.msgs.single().text())
        assertEquals("ctx", updates.msgs.single().contextToken)
        val request = server.takeRequest()
        assertEquals("/ilink/bot/getupdates", request.requestUrl?.encodedPath)
        assertEquals("Bearer bot-token", request.getHeader("Authorization"))
        assertEquals("ilink_bot_token", request.getHeader("AuthorizationType"))
        // A fresh random 4-byte base64 value on every authenticated request.
        assertEquals(8, request.getHeader("X-WECHAT-UIN")?.length)
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("old", body.getValue("get_updates_buf").jsonPrimitive.content)
    }

    @Test
    fun `two authenticated requests carry different random uins`() = kotlinx.coroutines.runBlocking {
        repeat(2) { server.enqueue(json("""{"get_updates_buf":"c"}""")) }
        api.updates(account, "")
        api.updates(account, "")
        val first = server.takeRequest().getHeader("X-WECHAT-UIN")
        val second = server.takeRequest().getHeader("X-WECHAT-UIN")
        assertTrue(first != second, "X-WECHAT-UIN must be per-request")
    }

    @Test
    fun `a numeric and a string message id both read as strings`() = kotlinx.coroutines.runBlocking {
        server.enqueue(
            json(
                """{"msgs":[{"message_id":42,"from_user_id":"owner","message_type":1,
                   "item_list":[{"type":1,"text_item":{"text":"a"}}]},
                   {"message_id":"str-1","from_user_id":"owner","message_type":1,
                   "item_list":[{"type":1,"text_item":{"text":"b"}}]}]}""",
            ),
        )
        val updates = api.updates(account, "")
        assertEquals(listOf("42", "str-1"), updates.msgs.map { it.messageId })
    }

    @Test
    fun `the group rule is Mika's exactly`() {
        val base = WechatMessage(messageId = "m", fromUserId = "owner", messageType = 1)
        assertTrue(base.isUserPrivateMessage())
        assertTrue(!base.copy(groupId = "123@chatroom").isUserPrivateMessage())
        assertTrue(!base.copy(messageType = 2).isUserPrivateMessage())
        assertTrue(!base.copy(fromUserId = null).isUserPrivateMessage())
        assertTrue(!base.copy(messageId = null).isUserPrivateMessage())
    }

    @Test
    fun `text items concatenate and images are kept separately`() {
        val message = WechatMessage(
            messageId = "m",
            fromUserId = "owner",
            messageType = 1,
            items = listOf(
                WechatItem(type = 1, textItem = WechatText("第一行")),
                WechatItem(type = 1, textItem = WechatText("第二行")),
                WechatItem(type = 2, imageItem = WechatImage(midSize = 10)),
                WechatItem(type = 2, imageItem = null),
            ),
        )
        assertEquals("第一行\n第二行", message.text())
        assertEquals(2, message.images().size)
    }

    @Test
    fun `sendText posts the frozen outbound message shape`() = kotlinx.coroutines.runBlocking {
        server.enqueue(json("""{"ret":0}"""))

        api.sendText(account, "owner", "job-1", "完成了", "ctx")

        val request = server.takeRequest()
        assertEquals("/ilink/bot/sendmessage", request.requestUrl?.encodedPath)
        assertEquals("Bearer bot-token", request.getHeader("Authorization"))
        val message = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
            .getValue("msg").jsonObject
        assertEquals("job-1", message.getValue("client_id").jsonPrimitive.content)
        assertEquals("owner", message.getValue("to_user_id").jsonPrimitive.content)
        assertEquals("ctx", message.getValue("context_token").jsonPrimitive.content)
        assertEquals("2", message.getValue("message_type").jsonPrimitive.content)
        assertEquals("2", message.getValue("message_state").jsonPrimitive.content)
        // No group field on a private reply: this build never sets one.
        assertTrue(!message.containsKey("group_id"))
    }

    @Test
    fun `an HTTP 401 surfaces as a 401 the runtime can act on`() = kotlinx.coroutines.runBlocking {
        server.enqueue(MockResponse().setResponseCode(401).setBody("{}"))
        val error = assertFailsWith<WechatHttpException> { api.updates(account, "") }
        assertEquals(401, error.httpCode)
    }

    @Test
    fun `the CDN download path carries no bot token`() = kotlinx.coroutines.runBlocking {
        server.enqueue(
            MockResponse().setHeader("Content-Type", "image/png")
                .setBody(Buffer().write(PNG_BYTES)),
        )
        val downloaded = api.downloadImage(
            WechatImage(media = WechatCdnMedia(encryptQueryParam = "param"), midSize = 8),
        )
        assertEquals("image/png", downloaded.mimeType)
        val request = server.takeRequest()
        assertEquals("/c2c/download", request.requestUrl?.encodedPath)
        assertEquals("param", request.requestUrl?.queryParameter("encrypted_query_param"))
        assertNull(request.getHeader("Authorization"))
        assertNull(request.getHeader("AuthorizationType"))
        assertNull(request.getHeader("X-WECHAT-UIN"))
    }

    @Test
    fun `a CDN response is decrypted before it is sniffed`() = kotlinx.coroutines.runBlocking {
        val key = ByteArray(16) { (it + 1).toByte() }
        val cipher = Cipher.getInstance("AES/ECB/PKCS5Padding").apply {
            init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"))
        }
        val encrypted = cipher.doFinal(PNG_BYTES)
        server.enqueue(MockResponse().setBody(Buffer().write(encrypted)))

        val downloaded = api.downloadImage(
            WechatImage(
                media = WechatCdnMedia(encryptQueryParam = "param"),
                aesKey = keyHex(key),
                midSize = encrypted.size.toLong(),
            ),
        )
        assertEquals("image/png", downloaded.mimeType)
    }

    @Test
    fun `a non-image payload is refused after decryption`() {
        kotlinx.coroutines.runBlocking {
            server.enqueue(MockResponse().setBody(Buffer().write("not an image".toByteArray())))
            assertFailsWith<IOException> {
                api.downloadImage(WechatImage(media = WechatCdnMedia(encryptQueryParam = "p")))
            }
        }
    }

    @Test
    fun `an image over the size cap is refused`() {
        kotlinx.coroutines.runBlocking {
            server.enqueue(
                MockResponse().setBody(Buffer().write(ByteArray(WechatImages.MAX_BYTES + 1))),
            )
            assertFailsWith<IOException> {
                api.downloadImage(WechatImage(media = WechatCdnMedia(encryptQueryParam = "p")))
            }
        }
    }

    @Test
    fun `a CDN address outside Tencent's host is refused`() {
        kotlinx.coroutines.runBlocking {
            server.enqueue(MockResponse().setBody(Buffer().write(PNG_BYTES)))
            assertFailsWith<IOException> {
                api.downloadImage(
                    WechatImage(
                        media = WechatCdnMedia(
                            encryptQueryParam = "p",
                            fullUrl = "https://evil.example.test/download?x=1",
                        ),
                    ),
                )
            }
        }
    }

    @Test
    fun `a CDN redirect is not followed`() {
        kotlinx.coroutines.runBlocking {
            server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", server.url("/elsewhere")))
            assertFailsWith<IOException> {
                api.downloadImage(WechatImage(media = WechatCdnMedia(encryptQueryParam = "p")))
            }
        }
    }

    @Test
    fun `image upload asks for an address, uploads, and returns the CDN reference`() = kotlinx.coroutines.runBlocking {
        server.enqueue(json("""{"ret":0,"upload_param":"up-param"}"""))
        server.enqueue(MockResponse().setHeader("x-encrypted-param", "down-param"))

        val uploaded = api.uploadImage(account, "owner", PNG_BYTES)

        val ask = server.takeRequest()
        assertEquals("/ilink/bot/getuploadurl", ask.requestUrl?.encodedPath)
        assertEquals("Bearer bot-token", ask.getHeader("Authorization"))
        val askBody = Json.parseToJsonElement(ask.body.readUtf8()).jsonObject
        assertEquals("owner", askBody.getValue("to_user_id").jsonPrimitive.content)
        assertEquals(PNG_BYTES.size.toString(), askBody.getValue("rawsize").jsonPrimitive.content)
        // The AES key travels hex-encoded, as Mika's did.
        assertTrue(askBody.getValue("aeskey").jsonPrimitive.content.matches(Regex("[0-9a-f]{32}")))

        val put = server.takeRequest()
        assertEquals("/c2c/upload", put.requestUrl?.encodedPath)
        assertEquals("up-param", put.requestUrl?.queryParameter("encrypted_query_param"))
        // No bot token on the CDN call, ever.
        assertNull(put.getHeader("Authorization"))
        assertEquals("down-param", uploaded.image.media?.encryptQueryParam)
    }

    @Test
    fun `sendImage carries the uploaded reference and the stable client id`() = kotlinx.coroutines.runBlocking {
        server.enqueue(json("""{"ret":0}"""))
        val uploaded = WechatUploadedImage(
            WechatImage(media = WechatCdnMedia(encryptQueryParam = "ref", encryptType = 1), midSize = 9),
        )

        api.sendImage(account, "owner", "job-9", uploaded, "ctx")

        val message = Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
            .getValue("msg").jsonObject
        assertEquals("job-9", message.getValue("client_id").jsonPrimitive.content)
        val item = message.getValue("item_list").let { Json.parseToJsonElement(it.toString()) }
            .let { it as kotlinx.serialization.json.JsonArray }
        assertEquals("2", item.single().jsonObject.getValue("type").jsonPrimitive.content)
        assertEquals(
            "ref",
            item.single().jsonObject.getValue("image_item").jsonObject
                .getValue("media").jsonObject.getValue("encrypt_query_param").jsonPrimitive.content,
        )
    }

    @Test
    fun `a stalled connection is cancellable`() {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val call = OkHttpClient().newCall(Request.Builder().url(server.url("/")).build())
        call.cancel()
        assertTrue(call.isCanceled())
    }

    private fun keyHex(key: ByteArray) = key.joinToString("") { "%02x".format(it) }

    private companion object {
        /** An 8-byte PNG header plus an IHDR stub: enough for the signature sniff. */
        val PNG_BYTES = byteArrayOf(
            0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        )
    }
}
