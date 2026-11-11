package com.openmausbot.companion.core.e2e

import com.openmausbot.companion.core.PairingInvite
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
        relays = listOf("relay1.openmausbot.com", "relay2.openmausbot.com"),
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
}
