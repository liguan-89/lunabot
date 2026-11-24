package com.lunabot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

/** A phone the platform keeps off its own network: what the session dials, says, and does when that changes. */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionLocalNetworkTest {
    private val lan = requireNotNull(
        CompanionEndpoint.create("http://192.168.1.20:8810", CompanionEndpointKind.LAN, 0),
    )
    private val hosted = requireNotNull(
        CompanionEndpoint.create("https://mac.companion.example", CompanionEndpointKind.HOSTED, 50),
    )
    private val lanOnly = Connection(
        id = "c1", name = "Mac", host = lan.host, port = lan.port, activeEndpoint = lan, endpoints = listOf(lan),
    )

    @Test
    fun aSavedPairingWhoseOnlyRouteIsTheClosedLocalNetworkDialsNothing() = runTest {
        val dialed = mutableListOf<String>()
        val session = session(saved = lanOnly, allowed = { false }, dialed = dialed)

        session.awaitRestored()

        assertEquals(lanOnly, session.connection.value)
        assertEquals(Session.RestoreState.Pending, session.restoreState.value)
        val status = assertIs<Session.Status.Offline>(session.status.value)
        assertEquals(LocalNetworkRefused.CONNECT, status.message)
        assertEquals(LocalNetworkRefused.SETTINGS, status.hint)
        assertTrue(dialed.isEmpty(), "a route the platform refuses was dialled anyway")
    }

    @Test
    fun theSavedPairingIsRestoredAsSoonAsTheLocalNetworkOpens() = runTest {
        var allowed = false
        val dialed = mutableListOf<String>()
        val session = session(saved = lanOnly, allowed = { allowed }, dialed = dialed)
        session.awaitRestored()

        allowed = true
        session.onRouteAccessChanged()
        runCurrent()

        assertEquals(Session.RestoreState.Ready, session.restoreState.value)
        assertEquals(Session.Status.Connecting, session.status.value)
        assertEquals(listOf(lan.displayAddress), dialed)
    }

    @Test
    fun anEncryptedPairingIsNotHeldBackByAClosedLocalNetwork() = runTest {
        val dialed = mutableListOf<String>()
        val session = session(saved = encryptedLanOnly(), allowed = { false }, dialed = dialed)

        session.awaitRestored()

        assertEquals(Session.RestoreState.Ready, session.restoreState.value)
        assertEquals(Session.Status.Connecting, session.status.value)
        assertEquals(listOf("tunnel:relay"), dialed)
    }

    @Test
    fun aSessionTheRelayCarriedMovesOntoTheWifiRouteOnceItOpens() = runTest {
        var allowed = false
        val dialed = mutableListOf<String>()
        val session = session(saved = encryptedLanOnly(), allowed = { allowed }, dialed = dialed)
        session.awaitRestored()
        assertEquals(listOf("tunnel:relay"), dialed)

        session.onRouteAccessChanged()
        runCurrent()
        assertEquals(1, dialed.size, "nothing changed, so a healthy session is not restarted")

        allowed = true
        session.onRouteAccessChanged()
        runCurrent()
        assertEquals(listOf("tunnel:relay", "tunnel:ws://192.168.1.20:8810/v1/e2e"), dialed)

        session.onRouteAccessChanged()
        runCurrent()
        assertEquals(2, dialed.size, "already on the route the computer leads with")
    }

    @Test
    fun grantingTheLocalNetworkMovesTheSessionOntoTheRouteTheComputerLeadsWith() = runTest {
        var allowed = false
        val dialed = mutableListOf<String>()
        val saved = lanOnly.copy(endpoints = listOf(lan, hosted))
        val session = session(saved = saved, allowed = { allowed }, dialed = dialed)
        session.awaitRestored()
        assertEquals(listOf(hosted.displayAddress), dialed)

        session.onRouteAccessChanged()
        runCurrent()
        assertEquals(1, dialed.size, "nothing changed, so nothing moved")

        allowed = true
        session.onRouteAccessChanged()
        runCurrent()
        assertEquals(listOf(hosted.displayAddress, lan.displayAddress), dialed)

        session.onRouteAccessChanged()
        runCurrent()
        assertEquals(2, dialed.size, "already on the route the stored order leads with")
    }

    @Test
    fun aPlainPairingIsRefusedWhileTheLocalNetworkIsClosedAndKeepsItsCode() = runTest {
        var allowed = false
        var paired = 0
        val session = session(
            saved = null,
            allowed = { allowed },
            pair = { connection, _, _, _ ->
                paired += 1
                PairingOutcome(
                    PairResponse("device-token", PairedDevice("d1", "Pixel", 1.0, 1.0), "Mac"),
                    connection,
                )
            },
        )
        val connection = requireNotNull(Connection.parse("192.168.1.20:8810"))

        val refused = assertFailsWith<PairingRouteError> { session.pair(connection, "123456") }

        assertEquals(LocalNetworkRefused.PAIR + LocalNetworkRefused.SETTINGS, refused.message)
        assertEquals(0, paired, "the computer was probed over a route the platform refuses")

        allowed = true
        session.pair(connection, "123456")
        assertEquals(1, paired)
    }

    private fun encryptedLanOnly() = lanOnly.copy(
        e2e = com.lunabot.companion.core.e2e.E2eDescriptor(
            k = com.lunabot.companion.core.e2e.E2eBase64.encode(
                com.lunabot.companion.core.e2e.P256.generateKeyPair(java.security.SecureRandom()).publicKey,
            ),
            h = com.lunabot.companion.core.e2e.E2eBase64.encode(ByteArray(16) { 1 }),
            relays = listOf("cloud.dexai.vip"),
        ).encode(),
    )

    private fun TestScope.session(
        saved: Connection?,
        allowed: () -> Boolean,
        dialed: MutableList<String> = mutableListOf(),
        pair: suspend (Connection, String, String, String) -> PairingOutcome = { _, _, _, _ -> error("pair not expected") },
    ): Session {
        val connections = LocalNetworkConnectionStore(saved)
        val tokens = LocalNetworkTokenStore(saved?.id, if (saved == null) null else "device-token")
        return Session(
            scope = backgroundScope,
            connectionStore = connections,
            tokenStore = tokens,
            onboardingStore = InMemoryOnboardingStore(),
            deviceNameProvider = { "Pixel" },
            routeAccess = RouteAccess.localNetwork(allowed),
            clientFactory = { connection, _ ->
                CompanionClient(connection, "device-token", routeAccess = RouteAccess.localNetwork(allowed)).also { made ->
                    // What the client really dials: an encrypted one its tunnel's own route, a plain one its address.
                    dialed += made.e2eDirectUrl?.let { "tunnel:$it" }
                        ?: if (connection.e2eDescriptor != null) "tunnel:relay" else connection.displayAddress
                }
            },
            pairFn = pair,
            eventsFn = { _, _, _ -> emptyFlow() },
            hydrateFn = { _, _ -> Fleet(emptyList(), emptyList()) },
        )
    }
}

private class LocalNetworkConnectionStore(initial: Connection?) : ConnectionStore {
    private var registry = initial?.let { ConnectionRegistry.restoring(listOf(it), it.id) }

    override suspend fun load(): Connection? = registry?.activeConnection

    override suspend fun save(connection: Connection) {
        registry = ConnectionRegistry.restoring(listOf(connection), connection.id)
    }

    override suspend fun clear() {
        registry = null
    }

    override suspend fun loadRegistry(): ConnectionRegistryRestore = ConnectionRegistryRestore(
        registry ?: ConnectionRegistry(),
        migratedLegacyConnection = false,
    )

    override suspend fun saveRegistry(registry: ConnectionRegistry) {
        this.registry = registry.normalized()
    }

    override suspend fun clearRegistry() {
        registry = null
    }
}

private class LocalNetworkTokenStore(private val id: String?, private var token: String?) : TokenStore {
    override suspend fun save(connectionId: String, token: String) {
        if (connectionId == id) this.token = token
    }

    override suspend fun read(connectionId: String): TokenStore.ReadResult {
        val current = token
        return if (connectionId == id && current != null) TokenStore.ReadResult.Found(current) else TokenStore.ReadResult.Missing
    }

    override suspend fun remove(connectionId: String) {
        if (connectionId == id) token = null
    }
}
