package com.lunabot.companion.discovery

import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Which host a discovered computer is dialled at.
 *
 * Android's DNS resolver does not answer for `.local` names, so a phone can
 * only reach a resolved address. These pin that preference, and the fallbacks
 * for the resolves that answer with a name and nothing else.
 */
class DialableHostTest {
    private val ipv4 = InetAddress.getByName("192.168.31.75")
    private val linkLocalV6 = InetAddress.getByName("fe80::1")
    private val globalV6 = InetAddress.getByName("2001:db8::1")

    @Test
    fun `a resolved address is preferred over the advertised bonjour name`() {
        assertEquals(
            "192.168.31.75",
            dialableHost("lunabot-90e339db.local", listOf(ipv4), null),
        )
    }

    @Test
    fun `a bare label from the platform is not a name but an address still wins`() {
        assertEquals("192.168.31.75", dialableHost("macbook", listOf(ipv4), null))
    }

    @Test
    fun `ipv4 wins when the host resolves to both families`() {
        assertEquals("192.168.31.75", dialableHost(null, listOf(linkLocalV6, ipv4), null))
        assertEquals("192.168.31.75", dialableHost(null, listOf(ipv4, linkLocalV6), null))
    }

    @Test
    fun `a lone ipv6 address is used as it is`() {
        // The JVM prints the uncompressed form; what matters is that it is bracket-quoted for a URL.
        assertEquals("[${globalV6.hostAddress}]", dialableHost(null, listOf(globalV6), null))
    }

    @Test
    fun `the legacy host field is used when no address list arrived`() {
        assertEquals("192.168.31.75", dialableHost(null, null, ipv4))
    }

    @Test
    fun `the bonjour name is the fallback when the resolve carries no address`() {
        assertEquals(
            "lunabot-90e339db.local",
            dialableHost("lunabot-90e339db.local", emptyList(), null),
        )
        assertEquals(
            "macbook.local",
            dialableHost("macbook", null, null),
        )
    }

    @Test
    fun `nothing dialable yields null`() {
        assertNull(dialableHost(null, null, null))
        assertNull(dialableHost(null, emptyList(), null))
    }

    @Test
    fun `an ip literal in the name field is not turned into a local name`() {
        assertNull(bonjourHost("192.168.31.75"))
        assertNull(bonjourHost("some.host.example"))
        assertEquals("macbook.local", bonjourHost("macbook."))
    }

    @Test
    fun `address families are the ones the helper reasons about`() {
        assertTrue(ipv4 is Inet4Address)
        assertTrue(linkLocalV6 is Inet6Address)
    }
}