// Adapted from Mika's WechatApi and WechatRuntime (Apache-2.0).
package com.lunabot.companion.wechat

import android.content.Context
import com.lunabot.companion.core.PhoneSmsEvent
import java.io.File
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Before
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * The runtime's policy, without a network and without a clock.
 *
 * Mika's rules are the subject here — private only, owner only, dedupe by
 * message id, backoff, and 401 means rebind — plus this build's frozen job
 * answer. Everything runs against a [WechatTransport] that answers from a
 * script, so a test states one behaviour at a time.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WechatRuntimeTest {

    private val context: Context = RuntimeEnvironment.getApplication()
    private val owner = "wxid_owner"
    private lateinit var scope: CoroutineScope
    private lateinit var root: File
    private lateinit var store: WechatStore

    /** A cipher that is obviously not encryption: these tests are about state, not crypto. */
    private val plainCipher = object : WechatKeyCipher {
        override fun encrypt(plain: ByteArray): ByteArray = plain
        override fun decrypt(data: ByteArray): ByteArray = data
    }

    @Before
    fun setUp() {
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        root = File(context.filesDir, "wechat-test-${System.nanoTime()}")
        store = WechatStore(
            context.getSharedPreferences("wechat-test-${System.nanoTime()}", Context.MODE_PRIVATE),
            plainCipher,
        )
    }

    @After
    fun tearDown() {
        scope.cancel()
        root.deleteRecursively()
    }

    private fun boundStore(): WechatStore {
        store.saveAccount(WechatAccount(token = "secret-token", botId = "bot", ownerId = owner))
        store.setEnabled(true)
        return store
    }

    private open class ScriptedTransport(
        var sendFailure: Exception? = null,
        var updates: () -> WechatUpdates = { WechatUpdates() },
    ) : WechatTransport {
        val sent = mutableListOf<Triple<String, String, String>>()
        var updateCalls = 0

        override fun startLogin(): WechatQrStart = WechatQrStart(qrcode = "key", qrContent = "payload")
        override fun pollLogin(qrcode: String): WechatQrStatus = WechatQrStatus(status = "wait")
        override suspend fun updates(account: WechatAccount, cursor: String): WechatUpdates {
            updateCalls++
            return updates()
        }

        override suspend fun sendText(
            account: WechatAccount,
            peerId: String,
            clientId: String,
            text: String,
            contextToken: String?,
        ) {
            sendFailure?.let { throw it }
            sent += Triple(peerId, clientId, text)
        }

        override suspend fun downloadImage(image: WechatImage): WechatDownloadedImage =
            WechatDownloadedImage(byteArrayOf(1, 2, 3), "image/png", "png")

        override suspend fun uploadImage(
            account: WechatAccount,
            peerId: String,
            bytes: ByteArray,
        ): WechatUploadedImage = WechatUploadedImage(WechatImage())

        override suspend fun sendImage(
            account: WechatAccount,
            peerId: String,
            clientId: String,
            uploaded: WechatUploadedImage,
            contextToken: String?,
        ) = Unit
    }

    private class RecordingSink : WechatEventSink {
        val events = mutableListOf<PhoneSmsEvent>()
        var accept = true
        override suspend fun post(event: PhoneSmsEvent): Boolean {
            if (accept) events += event
            return accept
        }
    }

    private fun runtime(
        transport: WechatTransport,
        sink: WechatEventSink = RecordingSink(),
        images: WechatImageFiles? = null,
        store: WechatStore = this.store,
    ) = WechatRuntime(
        store = store,
        transport = transport,
        images = images,
        sink = sink,
        scope = scope,
        pause = { },
    )

    private fun textMessage(
        id: String,
        from: String = owner,
        text: String = "你好",
        groupId: String? = null,
        images: List<WechatImage> = emptyList(),
    ) = WechatMessage(
        messageId = id,
        fromUserId = from,
        messageType = 1,
        groupId = groupId,
        items = buildList {
            if (text.isNotEmpty()) add(WechatItem(type = 1, textItem = WechatText(text)))
            images.forEach { add(WechatItem(type = 2, imageItem = it)) }
        },
    )

    @Test
    fun `a private message from the owner becomes one event`() = runTest {
        boundStore()
        val sink = RecordingSink()
        val transport = ScriptedTransport { WechatUpdates(msgs = listOf(textMessage("m1")), cursor = "c1") }
        val runtime = runtime(transport, sink)

        runtime.pollOnce(store.account()!!)

        assertEquals(1, sink.events.size)
        val event = sink.events.single()
        assertEquals("wechat", event.kind)
        assertEquals("m1", event.sendId)
        assertEquals(owner, event.from)
        assertEquals("你好", event.text)
        // The cursor is persisted so a restart resumes rather than replays.
        assertEquals("c1", store.cursor())
        // Acknowledged, so the journal is empty and the id is remembered.
        assertTrue(store.pending().isEmpty())
        assertTrue(store.hasMessage("m1"))
    }

    @Test
    fun `the same message id is posted once even if the cursor rewinds`() = runTest {
        boundStore()
        val sink = RecordingSink()
        val transport = ScriptedTransport { WechatUpdates(msgs = listOf(textMessage("m1")), cursor = "c1") }
        val runtime = runtime(transport, sink)

        runtime.pollOnce(store.account()!!)
        // The same batch again, as a replayed cursor would deliver it.
        runtime.pollOnce(store.account()!!)

        assertEquals(1, sink.events.size)
    }

    @Test
    fun `a private message from anyone but the owner is dropped`() = runTest {
        boundStore()
        val sink = RecordingSink()
        val transport = ScriptedTransport {
            WechatUpdates(msgs = listOf(textMessage("m1", from = "wxid_stranger")), cursor = "c1")
        }
        val runtime = runtime(transport, sink)

        runtime.pollOnce(store.account()!!)

        assertTrue(sink.events.isEmpty())
        // The cursor still advances: the stranger's message is not a reason to
        // refetch it forever.
        assertEquals("c1", store.cursor())
    }

    @Test
    fun `a group message is dropped before it becomes an event`() = runTest {
        boundStore()
        val sink = RecordingSink()
        val transport = ScriptedTransport {
            WechatUpdates(msgs = listOf(textMessage("m1", groupId = "123@chatroom")), cursor = "c1")
        }
        val runtime = runtime(transport, sink)

        runtime.pollOnce(store.account()!!)

        // Mika's rule, kept verbatim: groupId != null is not a private message.
        assertTrue(sink.events.isEmpty())
        assertFalse(store.hasMessage("m1"))
    }

    @Test
    fun `a message with no sender or no id is dropped`() = runTest {
        boundStore()
        val sink = RecordingSink()
        val transport = ScriptedTransport {
            WechatUpdates(
                msgs = listOf(
                    textMessage("m1").copy(fromUserId = null),
                    textMessage("m2").copy(messageId = null),
                    // Not a user message: type 2 is the outbound shape.
                    textMessage("m3").copy(messageType = 2),
                ),
                cursor = "c1",
            )
        }
        val runtime = runtime(transport, sink)

        runtime.pollOnce(store.account()!!)

        assertTrue(sink.events.isEmpty())
    }

    @Test
    fun `a 401 marks the binding dead and stops the loop`() = runTest {
        boundStore()
        val transport = ScriptedTransport { throw WechatHttpException(401) }
        val runtime = runtime(transport)

        runtime.monitorLoop(store.account()!!)

        assertTrue(store.needsRebind())
        assertFalse(store.enabled())
        assertIs<WechatConnectionState.NeedsBinding>(runtime.state.value)
    }

    @Test
    fun `a 403 does the same as a 401`() = runTest {
        boundStore()
        val transport = ScriptedTransport { throw WechatHttpException(403) }
        val runtime = runtime(transport)

        runtime.monitorLoop(store.account()!!)

        assertTrue(store.needsRebind())
    }

    @Test
    fun `backoff doubles to a 30 second ceiling`() {
        assertEquals(1_000L, backoffMillis(1))
        assertEquals(2_000L, backoffMillis(2))
        assertEquals(4_000L, backoffMillis(3))
        assertEquals(8_000L, backoffMillis(4))
        assertEquals(16_000L, backoffMillis(5))
        assertEquals(30_000L, backoffMillis(6))
        assertEquals(30_000L, backoffMillis(50))
        // A zero or negative count cannot happen, but must not shift negative.
        assertEquals(1_000L, backoffMillis(0))
    }

    @Test
    fun `a non-auth failure is reported and the loop recovers`() = runTest {
        boundStore()
        var calls = 0
        val sink = RecordingSink()
        val transport = ScriptedTransport {
            calls++
            when (calls) {
                1 -> throw java.io.IOException("network down")
                2 -> WechatUpdates(msgs = listOf(textMessage("m1")), cursor = "c1")
                // End the loop the way a person does: turn the switch off.
                else -> {
                    store.setEnabled(false)
                    WechatUpdates()
                }
            }
        }
        val runtime = runtime(transport, sink)

        runtime.monitorLoop(store.account()!!)

        assertEquals(1, sink.events.size)
        assertEquals("m1", sink.events.single().sendId)
    }

    @Test
    fun `an image message is downloaded, stored and sent as base64`() = runTest {
        boundStore()
        val sink = RecordingSink()
        val files = WechatImageFiles(
            root = root,
            download = { WechatDownloadedImage("PNGDATA".toByteArray(), "image/png", "png") },
            prepare = { PreparedImage(it.bytes, it.mimeType, it.extension) },
        )
        val transport = ScriptedTransport {
            WechatUpdates(
                msgs = listOf(textMessage("m1", text = "", images = listOf(WechatImage()))),
                cursor = "c1",
            )
        }
        val runtime = runtime(transport, sink, images = files)

        runtime.pollOnce(store.account()!!)

        val event = sink.events.single()
        assertEquals(1, event.images.size)
        assertEquals("image/png", event.images.single().mime)
        assertEquals(
            Base64.getEncoder().encodeToString("PNGDATA".toByteArray()),
            event.images.single().data,
        )
        // The local copy is released once the computer accepted the event.
        assertFalse(files.file("m1", event.images.single().name).exists())
    }

    @Test
    fun `a failed image download drops the message instead of sending it bare`() = runTest {
        boundStore()
        val sink = RecordingSink()
        val files = WechatImageFiles(
            root = root,
            download = { throw java.io.IOException("cdn down") },
            prepare = { PreparedImage(it.bytes, it.mimeType, it.extension) },
        )
        val transport = ScriptedTransport {
            WechatUpdates(
                msgs = listOf(textMessage("m1", text = "看图", images = listOf(WechatImage()))),
                cursor = "c1",
            )
        }
        val runtime = runtime(transport, sink, images = files)

        runtime.pollOnce(store.account()!!)

        // A caption with a silently missing picture is worse than nothing.
        assertTrue(sink.events.isEmpty())
        assertFalse(store.hasMessage("m1"))
    }

    @Test
    fun `an unposted event stays in the journal and is retried`() = runTest {
        boundStore()
        val sink = RecordingSink().apply { accept = false }
        val transport = ScriptedTransport { WechatUpdates(msgs = listOf(textMessage("m1")), cursor = "c1") }
        val runtime = runtime(transport, sink)

        runtime.pollOnce(store.account()!!)
        assertEquals(1, store.pending().size)

        sink.accept = true
        runtime.pollOnce(store.account()!!)

        // Replayed from the journal, then acknowledged.
        assertEquals(1, sink.events.size)
        assertTrue(store.pending().isEmpty())
    }

    @Test
    fun `a reply goes to the owner with the job id as its client id`() = runTest {
        boundStore()
        store.rememberContextToken("ctx")
        val transport = ScriptedTransport()
        val runtime = runtime(transport)

        val result = runtime.reply(clientId = "job-1", to = owner, text = "收到")

        assertEquals(WechatReplyResult.Success, result)
        assertEquals(Triple(owner, "job-1", "收到"), transport.sent.single())
    }

    @Test
    fun `a reply to anyone but the owner is refused`() = runTest {
        boundStore()
        val transport = ScriptedTransport()
        val runtime = runtime(transport)

        val result = runtime.reply(clientId = "job-1", to = "wxid_stranger", text = "hi")

        val failure = assertIs<WechatReplyResult.Failure>(result)
        assertEquals("not_owner", failure.code)
        assertTrue(transport.sent.isEmpty())
    }

    @Test
    fun `the job answer is not_bound when there is no binding`() = runTest {
        // No saveAccount: the runtime has no token at all.
        val runtime = runtime(ScriptedTransport())
        val answer = answerWechatReply(
            runtime = runtime,
            jobId = "job-1",
            arguments = JsonObject(
                mapOf("to" to JsonPrimitive(owner), "text" to JsonPrimitive("hi")),
            ),
        )
        assertEquals(false, answer.getValue("ok").jsonPrimitive.boolean)
        assertEquals("not_bound", answer.getValue("error").jsonPrimitive.content)
    }

    @Test
    fun `the job answer is not_bound when the runtime cannot be built`() = runTest {
        val answer = answerWechatReply(
            runtime = null,
            jobId = "job-1",
            arguments = JsonObject(
                mapOf("to" to JsonPrimitive(owner), "text" to JsonPrimitive("hi")),
            ),
        )
        assertEquals(false, answer.getValue("ok").jsonPrimitive.boolean)
        assertEquals("not_bound", answer.getValue("error").jsonPrimitive.content)
    }

    @Test
    fun `a successful reply answers exactly ok true`() = runTest {
        boundStore()
        val runtime = runtime(ScriptedTransport())
        val answer = answerWechatReply(
            runtime = runtime,
            jobId = "job-1",
            arguments = JsonObject(
                mapOf("to" to JsonPrimitive(owner), "text" to JsonPrimitive("hi")),
            ),
        )
        assertEquals(setOf("ok"), answer.keys)
        assertEquals(true, answer.getValue("ok").jsonPrimitive.boolean)
    }

    @Test
    fun `a send failure is send_failed and a 401 there also kills the binding`() = runTest {
        boundStore()
        val transport = ScriptedTransport(sendFailure = WechatHttpException(401))
        val runtime = runtime(transport)
        val answer = answerWechatReply(
            runtime = runtime,
            jobId = "job-1",
            arguments = JsonObject(
                mapOf("to" to JsonPrimitive(owner), "text" to JsonPrimitive("hi")),
            ),
        )
        assertEquals("send_failed", answer.getValue("error").jsonPrimitive.content)
        assertTrue(store.needsRebind())
    }

    @Test
    fun `a rebind is required before a reply even with a token`() = runTest {
        boundStore()
        store.setNeedsRebind(true)
        val transport = ScriptedTransport()
        val runtime = runtime(transport)
        val answer = answerWechatReply(
            runtime = runtime,
            jobId = "job-1",
            arguments = JsonObject(
                mapOf("to" to JsonPrimitive(owner), "text" to JsonPrimitive("hi")),
            ),
        )
        assertEquals("not_bound", answer.getValue("error").jsonPrimitive.content)
        assertTrue(transport.sent.isEmpty())
    }

    @Test
    fun `an outbound image uploads then sends one message with the job id`() = runTest {
        boundStore()
        val transport = object : ScriptedTransport() {
            val order = mutableListOf<String>()
            override suspend fun uploadImage(
                account: WechatAccount,
                peerId: String,
                bytes: ByteArray,
            ): WechatUploadedImage {
                order += "upload:$peerId:${bytes.size}"
                return WechatUploadedImage(WechatImage(midSize = bytes.size.toLong()))
            }

            override suspend fun sendImage(
                account: WechatAccount,
                peerId: String,
                clientId: String,
                uploaded: WechatUploadedImage,
                contextToken: String?,
            ) {
                order += "send:$peerId:$clientId"
            }
        }
        val runtime = runtime(transport)

        val result = runtime.replyImage(clientId = "job-7", to = owner, bytes = byteArrayOf(1, 2, 3, 4))

        assertEquals(WechatReplyResult.Success, result)
        // Upload first, then one message: Mika sends one image per message.
        assertEquals(listOf("upload:$owner:4", "send:$owner:job-7"), transport.order)
    }

    @Test
    fun `a journal entry whose image file vanished is dropped, not posted bare`() = runTest {
        boundStore()
        val sink = RecordingSink()
        val files = WechatImageFiles(
            root = root,
            download = { WechatDownloadedImage("PNGDATA".toByteArray(), "image/png", "png") },
            prepare = { PreparedImage(it.bytes, it.mimeType, it.extension) },
        )
        // A pending entry naming a file that is not on disk: exactly what a
        // process killed between the journal write and the copy landing leaves.
        store.journal(
            PendingWechatEvent(
                sendId = "m-gone",
                from = owner,
                text = "看图",
                images = listOf(PendingWechatImage("wechat-1.png", "image/png")),
            ),
        )
        val runtime = runtime(ScriptedTransport { WechatUpdates(cursor = "c1") }, sink, images = files)

        runtime.pollOnce(store.account()!!)

        assertTrue(sink.events.isEmpty())
        // Acknowledged, so the poll does not spin on a broken entry forever.
        assertTrue(store.pending().isEmpty())
    }

    @Test
    fun `stopping the runtime keeps the token`() = runTest {
        boundStore()
        val runtime = runtime(ScriptedTransport())
        runtime.setEnabled(false)
        // The token is still there; only listening stopped. Rebinding is not
        // needed to disable, which is the point of the stop action.
        assertEquals("secret-token", store.account()?.token)
        assertFalse(store.enabled())
    }
}
