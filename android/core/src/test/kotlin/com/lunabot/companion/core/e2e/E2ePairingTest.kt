package com.lunabot.companion.core.e2e

import com.lunabot.companion.core.PairingRouteError
import java.security.SecureRandom
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** Pairing over the encrypted connection: request on a stream, JSON answer back. */
class E2ePairingTest {
    private val random = SecureRandom()
    private val transportKey = P256.generateKeyPair(random)
    private val credential = "omb_pair_" + "B".repeat(43)
    private val psk = E2eCredentials.psk(credential, E2eCredentials.keyId(transportKey.publicKey))
    private val hostId = E2eCrypto.randomBytes(16, random)

    private fun descriptor() = E2eDescriptor(
        k = E2eBase64.encode(transportKey.publicKey),
        h = E2eBase64.encode(hostId),
        relays = listOf("relay1.openmausbot.com"),
    )

    @Test
    fun `pairs through the relay and parses the answer`() {
        val computer = PairingResponder(transportKey, psk, Noise.TRANSPORT_RELAY, random)
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
        val descriptor = E2eDescriptor(
            k = E2eBase64.encode(transportKey.publicKey),
            h = E2eBase64.encode(hostId),
            relays = listOf("relay1.openmausbot.com"),
        )
        val result = E2ePairing.pair(
            connector = { _, _, opened ->
                listener = opened
                Thread { Thread.sleep(5); opened.onOpen() }.apply { isDaemon = true; start() }
                socket
            },
            descriptor = descriptor,
            credential = credential,
            deviceName = "Pixel",
            app = "lunabot-test",
            pairRequestId = "req-1",
        )
        assertEquals("omb_device_token", result.token)
        assertEquals("d1", result.deviceId)
        assertEquals("Mac mini", result.serverName)
        assertEquals(listOf("192.168.1.42"), result.hosts)
        // The route this build knows is kept; the one whose kind it does not is dropped, not the token beside it.
        assertEquals(listOf("http://192.168.1.42:8810"), result.endpoints.map { it.url })
        assertTrue(computer.sawPairRequest)
        assertTrue(computer.sawRelayHello)
    }

    @Test
    fun `an authoritative refusal stops the walk with the original error`() {
        val dials = ArrayList<String>()
        val computers = mutableMapOf<String, PairingResponder>()
        val connector = E2eSocketConnector { url, _, opened ->
            dials += url
            val computer = PairingResponder(
                transportKey, psk,
                if (url.startsWith("ws://")) Noise.TRANSPORT_DIRECT else Noise.TRANSPORT_RELAY,
                random, status = 410,
            )
            computers[url] = computer
            Thread { Thread.sleep(5); opened.onOpen() }.apply { isDaemon = true; start() }
            object : E2eSocket {
                override val bufferedBytes: Long = 0
                override val isOpen: Boolean = true
                override fun sendBinary(bytes: ByteArray) {
                    for (reply in computer.receive(bytes)) opened.onBinary(reply)
                }
                override fun sendText(text: String) {
                    for (reply in computer.receiveText(text)) opened.onText(reply)
                }
                override fun close(code: Int) = Unit
            }
        }
        val error = assertFailsWith<E2eHttpException> {
            E2ePairing.pair(
                connector = connector,
                descriptor = descriptor(),
                credential = credential,
                deviceName = "Pixel",
                app = "lunabot-test",
                directWsUrl = "ws://192.168.1.42:8810/v1/e2e",
                pairRequestId = "req-2",
            )
        }
        assertEquals(410, error.status)
        // The computer answered on the direct route: the relay is never tried and nothing is swallowed.
        assertEquals(listOf("ws://192.168.1.42:8810/v1/e2e"), dials)
        assertEquals(1, computers.values.sumOf { it.pairRequests })
    }

    @Test
    fun `a pure route failure keeps the credential retryable`() {
        val dials = ArrayList<String>()
        val connector = E2eSocketConnector { url, _, opened ->
            dials += url
            Thread {
                Thread.sleep(5)
                opened.onOpen()
                Thread.sleep(5)
                opened.onClosed(4001)
            }.apply { isDaemon = true; start() }
            object : E2eSocket {
                override val bufferedBytes: Long = 0
                override val isOpen: Boolean = true
                override fun sendBinary(bytes: ByteArray) = Unit
                override fun sendText(text: String) = Unit
                override fun close(code: Int) = Unit
            }
        }
        val error = assertFailsWith<PairingRouteError> {
            E2ePairing.pair(
                connector = connector,
                descriptor = descriptor(),
                credential = credential,
                deviceName = "Pixel",
                app = "lunabot-test",
                directWsUrl = "ws://192.168.1.42:8810/v1/e2e",
                pairRequestId = "req-3",
            )
        }
        assertEquals(
            listOf("ws://192.168.1.42:8810/v1/e2e", "wss://relay1.openmausbot.com/v1/phone"),
            dials,
        )
        assertEquals(2, error.attemptedRoutes.size)
    }

    private class PairingResponder(
        private val keyPair: P256.KeyPair,
        private val psk: ByteArray,
        private val transport: Byte,
        private val random: SecureRandom,
        private val status: Int = 200,
    ) {
        var sawRelayHello = false
            private set
        var sawPairRequest = false
            private set
        var pairRequests = 0
            private set
        private var send: RecordCipher? = null
        private var receive: RecordCipher? = null
        private var mux: YamuxMux? = null
        private val outbound = ArrayList<ByteArray>()
        private val request = StringBuilder()
        private var handshakeDone = false

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
                    val text = request.toString()
                    if (!sawPairRequest && (text.contains("POST /api/pair") && text.endsWith("\r\n\r\n") || text.contains("}\r\n") || text.endsWith("}"))) {
                        val body = if (status == 200) """{"token":"omb_device_token","device":{"id":"d1","name":"Pixel"},"serverName":"Mac mini","hosts":["192.168.1.42"],"endpoints":[{"url":"http://192.168.1.42:8810","kind":"lan","priority":200},{"url":"http://unknown:1","kind":"future-kind","priority":1}]}""" else """{"error":"code expired"}"""
                        val reason = if (status == 200) "OK" else "Gone"
                        val response = "HTTP/1.1 $status $reason\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n$body"
                        sawPairRequest = true
                        pairRequests += 1
                        mux!!.write(streamId, response.toByteArray())
                        mux!!.finish(streamId)
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
