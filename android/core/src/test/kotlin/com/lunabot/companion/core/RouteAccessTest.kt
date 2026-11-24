package com.lunabot.companion.core

import com.lunabot.companion.core.e2e.E2eBase64
import com.lunabot.companion.core.e2e.E2eDescriptor
import com.lunabot.companion.core.e2e.P256
import java.security.SecureRandom
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** What a phone dials while the platform keeps it off its own network. */
class RouteAccessTest {
    private val lan = endpoint("http://192.168.1.20:8810", CompanionEndpointKind.LAN, 0)
    private val hosted = endpoint("https://mac.companion.example", CompanionEndpointKind.HOSTED, 50)
    private val tailnet = endpoint("http://mac.tail1234.ts.net:8810", CompanionEndpointKind.TAILNET, 100)
    private val closed = RouteAccess.localNetwork { false }
    private val open = RouteAccess.localNetwork { true }

    private fun endpoint(url: String, kind: CompanionEndpointKind, priority: Int): CompanionEndpoint =
        requireNotNull(CompanionEndpoint.create(url, kind, priority))

    private fun encrypted(relays: List<String>?, routes: String? = null): E2eDescriptor {
        val key = E2eBase64.encode(P256.generateKeyPair(SecureRandom()).publicKey)
        val host = E2eBase64.encode(ByteArray(16) { 1 })
        return E2eDescriptor(k = key, h = if (relays == null) null else host, relays = relays.orEmpty(), routes = routes)
    }

    private fun connection(vararg endpoints: CompanionEndpoint, e2e: E2eDescriptor? = null) = Connection(
        name = "Mac",
        host = endpoints.first().host,
        port = endpoints.first().port,
        activeEndpoint = endpoints.first(),
        endpoints = endpoints.toList(),
        e2e = e2e?.encode(),
    )

    @Test
    fun aClosedLocalNetworkLeavesTheWalkItsOtherRoutes() {
        val connection = connection(lan, hosted)
        assertEquals(listOf(lan, hosted), connection.dialableEndpoints(open))
        assertEquals(listOf(lan, hosted), connection.dialableEndpoints())
        assertEquals(listOf(hosted), connection.dialableEndpoints(closed))
        assertEquals(listOf(lan, hosted), connection.orderedEndpoints, "the stored walk keeps the route")
    }

    @Test
    fun theEncryptedDirectRouteFollowsTheSameAnswer() {
        val connection = connection(lan, hosted, e2e = encrypted(listOf("cloud.dexai.vip")))
        assertEquals("ws://192.168.1.20:8810/v1/e2e", connection.e2eDirectUrl(open))
        assertNull(connection.e2eDirectUrl(closed))
    }

    @Test
    fun theTailnetRouteNeverWaitsForTheLocalNetwork() {
        val connection = connection(lan, tailnet, hosted)
        assertEquals(listOf(hosted, tailnet), connection.dialableEndpoints(closed))
        assertEquals("ws://mac.tail1234.ts.net:8810/v1/e2e", connection.e2eDirectUrl(closed))
    }

    @Test
    fun loopbackIsNotALocalNetworkRoute() {
        for (host in listOf("127.0.0.1", "localhost", "[::1]")) {
            assertFalse(requireNotNull(CompanionEndpoint.direct(host, 8810, priority = 0)).isOnLocalNetwork, host)
            assertTrue(requireNotNull(CompanionEndpoint.direct(host, 8810, priority = 0)).let { closed.allows(it) }, host)
        }
        assertTrue(lan.isOnLocalNetwork)
        assertFalse(hosted.isOnLocalNetwork)
        assertFalse(tailnet.isOnLocalNetwork)
        assertTrue(connection(lan, hosted).usesLocalNetwork)
        assertFalse(connection(hosted).usesLocalNetwork)
        assertFalse(
            connection(requireNotNull(CompanionEndpoint.direct("127.0.0.1", 8810, priority = 0))).usesLocalNetwork,
            "a developer's forwarded companion costs no prompt",
        )
    }

    @Test
    fun theRelayIsTheWayInWhenNoRouteMayBeDialed() {
        assertTrue(connection(lan, e2e = encrypted(listOf("cloud.dexai.vip"))).reachesComputerByRelay)
        assertFalse(connection(lan, e2e = encrypted(listOf("cloud.dexai.vip"), routes = "local")).reachesComputerByRelay)
        assertFalse(connection(lan, e2e = encrypted(relays = null)).reachesComputerByRelay)
        assertFalse(connection(lan).reachesComputerByRelay)
    }

    @Test
    fun theClientTunnelsThroughTheRelayAloneWhileTheLocalNetworkIsClosed() {
        val connection = connection(lan, e2e = encrypted(listOf("cloud.dexai.vip")))
        assertNull(CompanionClient(connection, "device-token", routeAccess = closed).e2eDirectUrl)
        assertEquals("ws://192.168.1.20:8810/v1/e2e", CompanionClient(connection, "device-token", routeAccess = open).e2eDirectUrl)
    }
}
