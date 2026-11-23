package com.lunabot.companion.core.e2e

import java.security.SecureRandom
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Pairing over the encrypted connection: request on a stream, JSON answer back. */
class E2ePairingTest {
    private val random = SecureRandom()
    private val transportKey = P256.generateKeyPair(random)
    private val credential = "omb_pair_" + "B".repeat(43)
    private val psk = E2eCredentials.psk(credential, E2eCredentials.keyId(transportKey.publicKey))
    private val hostId = E2eCrypto.randomBytes(16, random)

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

    private class PairingResponder(
        private val keyPair: P256.KeyPair,
        private val psk: ByteArray,
        private val transport: Byte,
        private val random: SecureRandom,
    ) {
        var sawRelayHello = false
            private set
        var sawPairRequest = false
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
                    if (text.contains("POST /api/pair") && text.endsWith("\r\n\r\n") || text.contains("}\r\n") || text.endsWith("}")) {
                        val body = """{"token":"omb_device_token","device":{"id":"d1","name":"Pixel"},"serverName":"Mac mini","hosts":["192.168.1.42"],"endpoints":[{"url":"http://192.168.1.42:8810","kind":"lan","priority":200},{"url":"http://unknown:1","kind":"future-kind","priority":1}]}"""
                        val response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n$body"
                        sawPairRequest = true
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
