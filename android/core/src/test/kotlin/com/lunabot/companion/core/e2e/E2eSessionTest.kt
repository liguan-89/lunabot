package com.lunabot.companion.core.e2e

import java.security.SecureRandom
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * A two-sided session test: the phone session under test on one side, a
 * computer responder written from the same spec on the other, connected by a
 * synchronous in-memory byte pipe. No sockets, no relay — this pins the
 * session state machine: handshake, streams, window, FIN and the HTTP echo.
 */
class E2eSessionTest {
    private val random = SecureRandom()
    private val transportKey = P256.generateKeyPair(random)
    private val token = "omb_pair_" + "A".repeat(43)
    private val psk = E2eCredentials.psk(token, E2eCredentials.keyId(transportKey.publicKey))

    @Test
    fun `direct session handshakes, opens a stream and echoes a request`() {
        val computer = ComputerResponder(transportKey, psk, Noise.TRANSPORT_DIRECT, random)
        lateinit var listener: E2eSocketListener
        val socket = object : E2eSocket {
            override val bufferedBytes: Long = 0
        override val isOpen: Boolean = true
            override fun sendBinary(bytes: ByteArray) {
                for (reply in computer.receive(bytes)) listener.onBinary(reply)
            }
            override fun sendText(text: String) {
                for (reply in computer.receiveText(text)) listener.onText(reply)
            }
            override fun close(code: Int) {
                // The phone closing is what stops the responder.
            }
        }
        val session = E2eSession(
            connector = { _, _, opened ->
                listener = opened
                Thread { Thread.sleep(5); opened.onOpen() }.apply { isDaemon = true; start() }
                socket
            },
            target = E2eTarget.Direct("ws://127.0.0.1:1/v1/e2e"),
            transportKey = transportKey.publicKey,
            psk = psk,
            app = "lunabot-test",
        )
        session.connect()
        assertTrue(computer.handshakeDone, "the computer completed the handshake")

        val stream = session.openStream()
        assertTrue(stream.write("GET /api/health HTTP/1.1\r\nHost: h\r\n\r\n".toByteArray()))
        stream.finish()

        val response = StringBuilder()
        val buffer = ByteArray(256)
        while (true) {
            val read = stream.read(buffer, timeoutMs = 2_000)
            if (read <= 0) break
            response.append(String(buffer, 0, read))
        }
        assertEquals("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok", response.toString())
        session.close()
    }

    @Test
    fun `relay session waits for ready and then handshakes`() {
        val hostId = E2eCrypto.randomBytes(16, random)
        val admission = E2eCredentials.admission(token, hostId)
        val computer = ComputerResponder(transportKey, psk, Noise.TRANSPORT_RELAY, random)
        lateinit var listener: E2eSocketListener
        val socket = object : E2eSocket {
            override val bufferedBytes: Long = 0
        override val isOpen: Boolean = true
            override fun sendBinary(bytes: ByteArray) {
                for (reply in computer.receive(bytes)) listener.onBinary(reply)
            }
            override fun sendText(text: String) {
                for (reply in computer.receiveText(text)) listener.onText(reply)
            }
            override fun close(code: Int) = Unit
        }
        val session = E2eSession(
            connector = { url, protocols, opened ->
                listener = opened
                assertEquals(listOf("omb-relay.v1"), protocols)
                assertTrue(url.startsWith("wss://"))
                Thread { Thread.sleep(5); opened.onOpen() }.apply { isDaemon = true; start() }
                socket
            },
            target = E2eTarget.Relay("wss://relay1.openmausbot.com/v1/phone", hostId, admission),
            transportKey = transportKey.publicKey,
            psk = psk,
            app = "lunabot-test",
        )
        session.connect()
        assertTrue(computer.handshakeDone)
        assertTrue(computer.sawRelayHello, "the phone announced hid and adm before the handshake")
        session.close()
    }

    @Test
    fun `a session the mux refuses a new stream on dies for new work`() {
        val computer = ComputerResponder(transportKey, psk, Noise.TRANSPORT_DIRECT, random)
        lateinit var listener: E2eSocketListener
        val socket = object : E2eSocket {
            override val bufferedBytes: Long = 0
        override val isOpen: Boolean = true
            override fun sendBinary(bytes: ByteArray) {
                for (reply in computer.receive(bytes)) listener.onBinary(reply)
            }
            override fun sendText(text: String) = Unit
            override fun close(code: Int) = Unit
        }
        val session = E2eSession(
            connector = { _, _, opened ->
                listener = opened
                Thread { Thread.sleep(5); opened.onOpen() }.apply { isDaemon = true; start() }
                socket
            },
            target = E2eTarget.Direct("ws://127.0.0.1:1/v1/e2e"),
            transportKey = transportKey.publicKey,
            psk = psk,
            app = "lunabot-test",
        )
        session.connect()

        repeat(Yamux.MAX_STREAMS) { session.openStream() }
        val error = assertFailsWith<YamuxException> { session.openStream() }
        assertEquals("too_many_streams", error.reason)
        // The refusal must read as the session's death: isUsable is what
        // E2eTransport.ensureSession() trusts, so a session that keeps it true
        // gets reused forever while every new request it opens fails.
        assertEquals("too_many_streams", session.failure)
        assertFalse(session.isUsable)
        session.close()
    }

    @Test
    fun `the receive window is granted back as the reader consumes, not as bytes arrive`() {
        val computer = ComputerResponder(transportKey, psk, Noise.TRANSPORT_DIRECT, random, responseSize = 1500 * 1024, finishResponse = false)
        lateinit var listener: E2eSocketListener
        val socket = object : E2eSocket {
            override val bufferedBytes: Long = 0
        override val isOpen: Boolean = true
            override fun sendBinary(bytes: ByteArray) {
                for (reply in computer.receive(bytes)) listener.onBinary(reply)
            }
            override fun sendText(text: String) = Unit
            override fun close(code: Int) = Unit
        }
        val session = E2eSession(
            connector = { _, _, opened ->
                listener = opened
                Thread { Thread.sleep(5); opened.onOpen() }.apply { isDaemon = true; start() }
                socket
            },
            target = E2eTarget.Direct("ws://127.0.0.1:1/v1/e2e"),
            transportKey = transportKey.publicKey,
            psk = psk,
            app = "lunabot-test",
        )
        session.connect()

        val stream = session.openStream()
        assertTrue(stream.write("GET /big HTTP/1.1\r\nHost: h\r\n\r\n".toByteArray()))
        stream.finish()
        // The whole 1.5 MiB answer has arrived and sits in the stream's queue, unread.
        val windowBeforeRead = computer.sendWindow(stream.streamId)
        assertTrue(windowBeforeRead < Yamux.STREAM_WINDOW, "the computer spent window writing the answer")

        // Nothing read yet: no window comes back, however long the computer waits.
        assertEquals(windowBeforeRead, computer.sendWindow(stream.streamId))

        // Read past the 1 MiB grant step: the computer's window grows again.
        val buffer = ByteArray(64 * 1024)
        var consumed = 0
        while (consumed < Yamux.WINDOW_UPDATE_AFTER + 1) {
            val read = stream.read(buffer, timeoutMs = 2_000)
            assertTrue(read > 0, "bytes are available")
            consumed += read
        }
        assertTrue(
            computer.sendWindow(stream.streamId) > windowBeforeRead,
            "reading granted window back: before=$windowBeforeRead after=${computer.sendWindow(stream.streamId)}",
        )
        session.close()
    }

    /** The computer half, from the same spec the desktop follows. */
    private class ComputerResponder(
        private val keyPair: P256.KeyPair,
        private val psk: ByteArray,
        private val transport: Byte,
        private val random: SecureRandom,
        /** Bytes the response body carries; the default is the two of "ok". */
        private val responseSize: Int = 2,
        /** False leaves the stream open after the body — a response still in flight, so the window state stays observable. */
        private val finishResponse: Boolean = true,
    ) {
        var handshakeDone = false
            private set
        var sawRelayHello = false
            private set
        private var send: RecordCipher? = null
        private var receive: RecordCipher? = null
        private var mux: YamuxMux? = null
        private val outbound = ArrayList<ByteArray>()
        private val request = StringBuilder()

        fun sendWindow(streamId: Int): Int = mux?.sendWindow(streamId) ?: 0

        fun receiveText(text: String): List<String> {
            if (transport == Noise.TRANSPORT_RELAY && text.contains("\"t\":\"phone\"")) {
                sawRelayHello = true
                return listOf("""{"t":"ready"}""")
            }
            return emptyList()
        }

        fun receive(bytes: ByteArray): List<ByteArray> {
            if (!handshakeDone) return listOf(handshake(bytes))
            mux!!.receive(Yamux.decode(receive!!.open(bytes)))
            val frames = outbound.toList()
            outbound.clear()
            return frames.map { send!!.seal(it) }
        }

        private fun handshake(message1: ByteArray): ByteArray {
            val symmetric = SymmetricState.initialize().also {
                it.mixHash(Noise.prologue(transport))
                it.mixHash(keyPair.publicKey)
                it.mixKeyAndHash(psk)
            }
            val peerEphemeral = message1.copyOfRange(0, P256.PUBLIC_KEY_BYTES)
            symmetric.mixHash(peerEphemeral)
            symmetric.mixKey(peerEphemeral)
            symmetric.mixKey(P256.dh(keyPair.privateKey, peerEphemeral))
            val payload1 = symmetric.decryptAndHash(message1.copyOfRange(P256.PUBLIC_KEY_BYTES, message1.size))
            val conn = (Json.parseToJsonElement(payload1.toString(Charsets.UTF_8)) as JsonObject)["conn"]!!
                .jsonPrimitive.content

            val ephemeral = P256.generateKeyPair(random)
            symmetric.mixHash(ephemeral.publicKey)
            symmetric.mixKey(ephemeral.publicKey)
            symmetric.mixKey(P256.dh(ephemeral.privateKey, peerEphemeral))
            val message2 = ephemeral.publicKey + symmetric.encryptAndHash(Noise.encodePayload2(conn))
            val (phoneToComputer, computerToPhone) = symmetric.split()
            receive = RecordCipher(phoneToComputer)
            send = RecordCipher(computerToPhone)
            handshakeDone = true
            mux = YamuxMux("computer", object : YamuxEvents {
                override fun send(frame: Yamux.Frame) {
                    outbound += Yamux.encode(frame)
                }
                override fun data(streamId: Int, data: ByteArray) {
                    request.append(String(data))
                    if (request.endsWith("\r\n\r\n")) {
                        val head = "HTTP/1.1 200 OK\r\nContent-Length: $responseSize\r\n\r\n"
                        mux!!.write(streamId, head.toByteArray())
                        var left = responseSize
                        // "ok" leads so the default two-byte response is the text the echo test expects.
                        val chunk = ByteArray(32 * 1024).also { it[0] = 'o'.code.toByte(); if (it.size > 1) it[1] = 'k'.code.toByte() }
                        while (left > 0) {
                            val part = if (left >= chunk.size) chunk else chunk.copyOf(left)
                            val taken = mux!!.write(streamId, part)
                            if (taken <= 0) break
                            left -= taken
                        }
                        if (finishResponse) mux!!.finish(streamId)
                    }
                }
                override fun ended(streamId: Int) = Unit
                override fun reset(streamId: Int) = Unit
                override fun writable(streamId: Int) = Unit
                override fun opened(streamId: Int) {
                    mux!!.accept(streamId)
                }
            })
            return message2
        }
    }
}
