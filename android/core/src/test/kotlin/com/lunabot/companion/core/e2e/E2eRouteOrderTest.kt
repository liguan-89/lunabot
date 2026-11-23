package com.lunabot.companion.core.e2e

import java.security.SecureRandom
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Route selection and the close that arrives before the handshake: spec §3/§4 (direct routes lead, the relay is the
 * fallback) and §9/§12 (a relay refusal means "try the next route", a direct 4001 means "removed").
 */
class E2eRouteOrderTest {
    private val random = SecureRandom()
    private val transportKey = P256.generateKeyPair(random)
    private val token = "omb_device_" + "C".repeat(43)
    private val hostId = E2eCrypto.randomBytes(16, random)

    private fun descriptor(routes: String? = null) = E2eDescriptor(
        k = E2eBase64.encode(transportKey.publicKey),
        h = E2eBase64.encode(hostId),
        relays = listOf("relay1.lunabot.com"),
        routes = routes,
    )

    /** A connector that records every URL it is asked for and refuses the socket with [closeCode]. */
    private class RefusingConnector(private val closeCode: Int) : E2eSocketConnector {
        val dialled = ArrayList<String>()

        override fun connect(url: String, protocols: List<String>, listener: E2eSocketListener): E2eSocket {
            dialled += url
            Thread {
                Thread.sleep(5)
                listener.onOpen()
                Thread.sleep(5)
                listener.onClosed(closeCode)
            }.apply { isDaemon = true; start() }
            return object : E2eSocket {
                override val bufferedBytes: Long = 0
                override val isOpen: Boolean = true
                override fun sendBinary(bytes: ByteArray) = Unit
                override fun sendText(text: String) = Unit
                override fun close(code: Int) = Unit
            }
        }
    }

    @Test
    fun `a direct route leads and the relay follows`() {
        val connector = RefusingConnector(4404)
        val transport = E2eTransport(
            descriptor = descriptor(),
            token = token,
            app = "mausbot-test",
            connector = connector,
            directUrl = "ws://192.168.1.42:8810/v1/e2e",
        )
        assertFailsWith<Exception> { transport.ensureSession() }
        assertEquals(
            listOf("ws://192.168.1.42:8810/v1/e2e", "wss://relay1.lunabot.com/v1/phone"),
            connector.dialled,
        )
    }

    @Test
    fun `a route restricted to local never dials the relay`() {
        val connector = RefusingConnector(4404)
        val transport = E2eTransport(
            descriptor = descriptor(routes = "local"),
            token = token,
            app = "mausbot-test",
            connector = connector,
            directUrl = "ws://192.168.1.42:8810/v1/e2e",
        )
        assertFailsWith<Exception> { transport.ensureSession() }
        assertEquals(listOf("ws://192.168.1.42:8810/v1/e2e"), connector.dialled)
    }

    @Test
    fun `a relay refusal before ready fails the session instead of returning one with no keys`() {
        val connector = RefusingConnector(4404)
        val admission = E2eCredentials.admission(token, hostId)
        val session = E2eSession(
            connector = connector,
            target = E2eTarget.Relay("wss://relay1.lunabot.com/v1/phone", hostId, admission),
            transportKey = transportKey.publicKey,
            psk = E2eCredentials.psk(token, E2eCredentials.keyId(transportKey.publicKey)),
            app = "mausbot-test",
        )
        assertFailsWith<NoiseException> { session.connect() }
        assertEquals("asleep", session.failure)
        assertFalse(session.isUsable)
    }

    @Test
    fun `a 4001 on a direct route is the owner removing the phone`() {
        val session = E2eSession(
            connector = RefusingConnector(4001),
            target = E2eTarget.Direct("ws://192.168.1.42:8810/v1/e2e"),
            transportKey = transportKey.publicKey,
            psk = E2eCredentials.psk(token, E2eCredentials.keyId(transportKey.publicKey)),
            app = "mausbot-test",
        )
        assertFailsWith<NoiseException> { session.connect() }
        assertEquals("removed", session.failure)
    }

    @Test
    fun `a 4001 through the relay is the relay's own word and is not a removal`() {
        val admission = E2eCredentials.admission(token, hostId)
        val session = E2eSession(
            connector = RefusingConnector(4001),
            target = E2eTarget.Relay("wss://relay1.lunabot.com/v1/phone", hostId, admission),
            transportKey = transportKey.publicKey,
            psk = E2eCredentials.psk(token, E2eCredentials.keyId(transportKey.publicKey)),
            app = "mausbot-test",
        )
        assertFailsWith<NoiseException> { session.connect() }
        assertEquals("relay_rejected", session.failure)
        assertTrue(session.failure != "removed")
    }

    @Test
    fun `pairing walks the same order and stops at the first refusal that is not a removal`() {
        val connector = RefusingConnector(4404)
        val failure = assertFailsWith<Throwable> {
            E2ePairing.pair(
                connector = connector,
                descriptor = descriptor(),
                credential = "omb_pair_" + "D".repeat(43),
                deviceName = "Pixel",
                app = "mausbot-test",
                directWsUrl = "ws://192.168.1.42:8810/v1/e2e",
            )
        }
        assertEquals(
            listOf("ws://192.168.1.42:8810/v1/e2e", "wss://relay1.lunabot.com/v1/phone"),
            connector.dialled,
        )
        assertTrue(failure is NoiseException)
    }
}
