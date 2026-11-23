package com.lunabot.companion.core.e2e

import com.lunabot.companion.core.CompanionConnectionMetadata
import com.lunabot.companion.core.CompanionEndpoint
import com.lunabot.companion.core.CompanionJson
import com.lunabot.companion.core.Connection
import com.lunabot.companion.core.Frame
import com.lunabot.companion.core.StreamFrame
import com.lunabot.companion.core.PairingInvite
import java.security.SecureRandom
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The QR link's `e2e` parameter, as the scanner sees it. */
class PairingInviteE2eTest {
    private val transportKey = P256.generateKeyPair(SecureRandom())
    private val hostId = E2eCrypto.randomBytes(16, SecureRandom())
    private val descriptor = E2eDescriptor(
        k = E2eBase64.encode(transportKey.publicKey),
        h = E2eBase64.encode(hostId),
        relays = listOf("relay1.lunabot.com", "relay2.lunabot.com"),
    )

    private fun link(e2e: String) =
        "openmausbot://pair?address=192.168.1.20&token=omb_pair_${"C".repeat(43)}&e2e=${e2e}"

    @Test
    fun `a descriptor in the link is pinned on the connection`() {
        val invite = PairingInvite.parse(link(descriptor.encode()))
        assertNotNull(invite)
        assertEquals(descriptor.encode(), invite.connection.e2e)
        assertEquals(descriptor.k, invite.connection.e2eDescriptor?.k)
        assertEquals(descriptor.relays, invite.connection.e2eDescriptor?.relays)
    }

    @Test
    fun `a malformed descriptor refuses the whole invite`() {
        assertNull(PairingInvite.parse(link("not-base64!")))
        // A newer descriptor version must never fall back to plain pairing.
        val newer = E2eBase64.encode("""{"v":2,"k":"${descriptor.k}"}""".toByteArray())
        assertNull(PairingInvite.parse(link(newer)))
    }

    @Test
    fun `a link without a descriptor still pairs plainly`() {
        val invite = PairingInvite.parse("openmausbot://pair?address=192.168.1.20&token=omb_pair_${"C".repeat(43)}")
        assertNotNull(invite)
        assertNull(invite.connection.e2e)
        assertTrue(invite.connection.e2eDirectUrl == null)
    }

    @Test
    fun `the direct encrypted route comes from the advertised endpoint`() {
        val invite = PairingInvite.parse(
            link(descriptor.encode()) + "&endpoints=" + E2eBase64.encode(
                """[{"url":"http://192.168.1.20:8810","kind":"lan","priority":10}]""".toByteArray(),
            ),
        )
        assertNotNull(invite)
        assertEquals("ws://192.168.1.20:8810/v1/e2e", invite.connection.e2eDirectUrl)
    }

    @Test
    fun `a paired phone adopts the descriptor once from the endpoint snapshot`() {
        val connection = Connection(name = "Mac", host = "192.168.1.20", port = 8810)
        val metadata = CompanionConnectionMetadata(
            serverName = "Mac",
            endpoints = listOf(CompanionEndpoint.direct("192.168.1.20", 8810, priority = 0)!!),
            e2e = descriptor,
        )
        val upgraded = connection.reconciling(metadata)
        assertEquals(descriptor.encode(), upgraded.e2e)

        // A later, different descriptor never replaces the pinned one.
        val other = descriptor.copy(k = E2eBase64.encode(P256.generateKeyPair(SecureRandom()).publicKey))
        val again = upgraded.reconciling(metadata.copy(e2e = other))
        assertEquals(descriptor.encode(), again.e2e)
    }

    @Test
    fun `the endpoint-change event decodes without a sequence number`() {
        val raw = """{"kind":"companion.endpoints","serverName":"Mac","endpoints":[{"url":"http://192.168.1.20:8810","kind":"lan","priority":1}],"e2e":{"v":1,"k":"${descriptor.k}","h":"${descriptor.h}","r":["relay1.lunabot.com"],"routes":"local"}}"""
        val frame = CompanionJson.decodeFromString<StreamFrame>(raw)
        assertEquals(null, frame.seq)
        val endpoints = frame.frame as Frame.CompanionEndpoints
        assertEquals("Mac", endpoints.metadata.serverName)
        assertEquals("local", endpoints.metadata.e2e?.routes)
    }

    @Test
    fun `a route restriction keeps the pinned key and takes the new routes`() {
        val connection = Connection(name = "Mac", host = "192.168.1.20", port = 8810, e2e = descriptor.encode())
        val restricted = descriptor.copy(routes = "local")
        val metadata = CompanionConnectionMetadata(
            serverName = "Mac",
            endpoints = listOf(CompanionEndpoint.direct("192.168.1.20", 8810, priority = 0)!!),
            e2e = restricted,
        )
        val updated = connection.reconciling(metadata)
        assertEquals(descriptor.k, updated.e2eDescriptor?.k)
        assertEquals("local", updated.e2eDescriptor?.routes)

        // A different key is never adopted, even when the snapshot is restricted.
        val stranger = restricted.copy(k = E2eBase64.encode(P256.generateKeyPair(SecureRandom()).publicKey))
        val kept = connection.reconciling(metadata.copy(e2e = stranger))
        assertEquals(descriptor.k, kept.e2eDescriptor?.k)
    }
}
