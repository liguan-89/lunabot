package com.lunabot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield

/**
 * The offline roster cache end to end: the pure bounding function, the store
 * contract, and the Session wiring that makes an unreachable computer show the
 * roster it showed minutes ago instead of 暂无智能体.
 *
 * Session-level tests follow the `SessionTest` harness shape — fake stores, a
 * hung stream, virtual time — because the cache is threaded through restore,
 * switch, hydrate, and unpair, and only those paths can prove the stamp and
 * the store move together.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionRosterCacheTest {
    // MARK: - Fleet.rosterCacheBounded

    @Test
    fun boundingKeepsTheLastTenMessagesInOrderAndMarksTruncatedThreads() {
        val long = (1..15).map { cacheMessage("m-$it", it.toDouble()) }
        val short = (1..3).map { cacheMessage("s-$it", it.toDouble()) }
        val exact = (1..10).map { cacheMessage("e-$it", it.toDouble()) }
        val fleet = Fleet(
            bots = listOf(
                cacheSampleBot("b-long", "t-long", long, hasMore = false),
                cacheSampleBot("b-short", "t-short", short),
                cacheSampleBot("b-exact", "t-exact", exact, hasMore = false),
                cacheSampleBot("b-null", "t-null"),
            ),
            groups = listOf(
                cacheSampleRoom("t-room", (1..12).map { cacheMessage("r-$it", it.toDouble()) }, hasMore = false),
            ),
            botQueuedMessages = mapOf("t-short" to listOf(QueuedSend("q1", "held"))),
        )

        val bounded = fleet.rosterCacheBounded()

        // Pure: the fleet it was given is untouched.
        assertEquals(15, fleet.bots[0].messages?.size)
        assertEquals(false, fleet.bots[0].hasMore)

        // Truncated: the LAST ten, original order, honest boundary.
        val truncated = bounded.bots[0]
        assertEquals((6..15).map { "m-$it" }, truncated.messages?.map(Message::id))
        assertEquals(true, truncated.hasMore)

        // Within the bound: transcript and existing hasMore (even null) stay.
        val kept = bounded.bots[1]
        assertEquals((1..3).map { "s-$it" }, kept.messages?.map(Message::id))
        assertNull(kept.hasMore)
        assertEquals(false, bounded.bots[2].hasMore)
        assertNull(bounded.bots[3].messages)

        // Channels truncate by the same rule.
        val room = bounded.groups.single()
        assertEquals((3..12).map { "r-$it" }, room.messages?.map(Message::id))
        assertEquals(true, room.hasMore)

        // Held sends ride along untouched, and the bound is a parameter.
        assertEquals(fleet.botQueuedMessages, bounded.botQueuedMessages)
        assertEquals(5, fleet.rosterCacheBounded(maxMessagesPerThread = 5).bots[0].messages?.size)
    }

    // MARK: - InMemoryRosterSnapshotStore

    @Test
    fun theMemoryStoreKeysSnapshotsPerConnection() = runTest {
        val store = InMemoryRosterSnapshotStore()
        val snapshot = RosterSnapshot(
            1_000L,
            Fleet(bots = listOf(cacheSampleBot("b1", "t1")), groups = emptyList()),
        )

        assertNull(store.load("c1"))
        store.save("c1", snapshot)
        assertEquals(snapshot, store.load("c1"))
        assertNull(store.load("c2"), "one computer's cache is not another's")
        store.clear("c1")
        assertNull(store.load("c1"))
    }

    // MARK: - Restore

    @Test
    fun restoreShowsTheCachedRosterAndStampsItsAge() = runTest {
        val savedAt = 1_700_000_000_000L
        val session = session(
            connectionStore = CacheFakeConnectionStore(
                Connection(id = "c1", name = "Mac", host = "192.168.1.2", port = 8810),
            ),
            tokenStore = CacheFakeTokenStore().apply { saved["c1"] = "tok" },
            rosterSnapshotStore = FakeRosterSnapshotStore().apply {
                snapshots["c1"] = RosterSnapshot(
                    savedAt,
                    Fleet(bots = listOf(cacheSampleBot("b1", "t1")), groups = emptyList()),
                )
            },
        )

        session.awaitRestored()

        assertEquals(Session.RestoreState.Ready, session.restoreState.value)
        assertEquals(listOf("b1"), session.state.value.bots.map(Bot::id))
        assertEquals(savedAt, session.rosterSnapshotAt.value)
        // The cache carries no stream position: the first live hello must
        // still re-hydrate from scratch, not "resume" from a stale cursor.
        assertNull(session.state.value.cursor)
    }

    @Test
    fun restoreWithoutACacheLeavesNoStampAndNoRoster() = runTest {
        val session = session(
            connectionStore = CacheFakeConnectionStore(
                Connection(id = "c1", name = "Mac", host = "192.168.1.2", port = 8810),
            ),
            tokenStore = CacheFakeTokenStore().apply { saved["c1"] = "tok" },
            rosterSnapshotStore = FakeRosterSnapshotStore(),
        )

        session.awaitRestored()

        assertTrue(session.state.value.bots.isEmpty())
        assertNull(session.rosterSnapshotAt.value)
    }

    @Test
    fun aCacheStoreThatThrowsIsNoCacheAndNeverARestoreFailure() = runTest {
        val session = session(
            connectionStore = CacheFakeConnectionStore(
                Connection(id = "c1", name = "Mac", host = "192.168.1.2", port = 8810),
            ),
            tokenStore = CacheFakeTokenStore().apply { saved["c1"] = "tok" },
            rosterSnapshotStore = object : RosterSnapshotStore {
                override suspend fun load(connectionId: String) = throw IllegalStateException("locked")
                override suspend fun save(connectionId: String, snapshot: RosterSnapshot) = Unit
                override suspend fun clear(connectionId: String) = Unit
            },
        )

        session.awaitRestored()

        // The pairing still restored and the session still tries to connect;
        // only the amenity is missing.
        assertEquals(Session.RestoreState.Ready, session.restoreState.value)
        assertEquals(Session.Status.Connecting, session.status.value)
        assertTrue(session.state.value.bots.isEmpty())
        assertNull(session.rosterSnapshotAt.value)
    }

    // MARK: - Switch

    @Test
    fun switchingComputersShowsThatComputersCacheWithItsOwnStamp() = runTest {
        val mac1 = Connection(id = "c1", name = "Mac1", host = "192.168.1.2", port = 8810)
        val mac2 = Connection(id = "c2", name = "Mac2", host = "192.168.1.3", port = 8810)
        val connections = CacheFakeConnectionStore().apply {
            saveRegistry(ConnectionRegistry(listOf(mac1, mac2), "c1"))
        }
        val session = session(
            connectionStore = connections,
            tokenStore = CacheFakeTokenStore().apply {
                saved["c1"] = "tok1"
                saved["c2"] = "tok2"
            },
            rosterSnapshotStore = FakeRosterSnapshotStore().apply {
                snapshots["c1"] = RosterSnapshot(
                    1_000L,
                    Fleet(bots = listOf(cacheSampleBot("a1", "ta")), groups = emptyList()),
                )
                snapshots["c2"] = RosterSnapshot(
                    2_000L,
                    Fleet(bots = listOf(cacheSampleBot("b2", "tb")), groups = emptyList()),
                )
            },
        )
        session.awaitRestored()
        assertEquals(listOf("a1"), session.state.value.bots.map(Bot::id))
        assertEquals(1_000L, session.rosterSnapshotAt.value)

        session.switchComputer("c2")
        runCurrent()

        assertEquals("c2", session.connection.value?.id)
        assertEquals(listOf("b2"), session.state.value.bots.map(Bot::id))
        assertEquals(2_000L, session.rosterSnapshotAt.value)
    }

    // MARK: - Hydrate

    @Test
    fun aLiveHydrateClearsTheStampAndSavesABoundedSnapshot() = runTest {
        val savedAt = 1_700_000_000_000L
        val cache = FakeRosterSnapshotStore().apply {
            snapshots["c1"] = RosterSnapshot(
                savedAt,
                Fleet(bots = listOf(cacheSampleBot("b1", "t1")), groups = emptyList()),
            )
        }
        val hang = MutableSharedFlow<StreamFrame>(extraBufferCapacity = 1)
        val liveFleet = Fleet(
            bots = listOf(
                cacheSampleBot("b1", "t1", (1..15).map { cacheMessage("m-$it", it.toDouble()) }, hasMore = false),
            ),
            groups = emptyList(),
            botQueuedMessages = mapOf("t1" to listOf(QueuedSend("q1", "held"))),
        )
        val session = session(
            connectionStore = CacheFakeConnectionStore(
                Connection(id = "c1", name = "Mac", host = "127.0.0.1", port = 8810),
            ),
            tokenStore = CacheFakeTokenStore().apply { saved["c1"] = "tok" },
            rosterSnapshotStore = cache,
            events = { _, _ -> hang },
            hydrate = { liveFleet },
        )
        session.awaitRestored()
        assertEquals(savedAt, session.rosterSnapshotAt.value)

        session.connect()
        runCurrent()
        hang.tryEmit(StreamFrame(Frame.Hello(cursor = "stream:7", resumed = false), seq = 0))
        runCurrent()
        yield()
        runCurrent()

        assertEquals(Session.Status.Live, session.status.value)
        assertEquals("stream:7", session.state.value.cursor)
        // Live data leads the moment it lands — before the save finishes.
        assertNull(session.rosterSnapshotAt.value)

        advanceUntilIdle()
        val saved = assertNotNull(cache.snapshots["c1"], "the fetched fleet is cached off the critical path")
        assertTrue(saved.savedAtMillis != savedAt)
        val bot = saved.fleet.bots.single()
        // Only the bounded fleet is written, whatever the live state shows.
        assertEquals((6..15).map { "m-$it" }, bot.messages?.map(Message::id))
        assertEquals(true, bot.hasMore)
        assertEquals(liveFleet.botQueuedMessages, saved.fleet.botQueuedMessages)
    }

    // MARK: - Unpair / forget

    @Test
    fun forgettingTheComputerTakesItsRosterCacheWithIt() = runTest {
        val cache = FakeRosterSnapshotStore().apply {
            snapshots["c1"] = RosterSnapshot(
                1_000L,
                Fleet(bots = listOf(cacheSampleBot("b1", "t1")), groups = emptyList()),
            )
        }
        val session = session(
            connectionStore = CacheFakeConnectionStore(
                Connection(id = "c1", name = "Mac", host = "192.168.1.2", port = 8810),
            ),
            tokenStore = CacheFakeTokenStore().apply { saved["c1"] = "tok" },
            rosterSnapshotStore = cache,
        )
        session.awaitRestored()
        assertEquals(1_000L, session.rosterSnapshotAt.value)

        session.signOutAndAwait()

        assertTrue(cache.snapshots.isEmpty(), "an unpaired computer's cached roster must not resurface")
        assertNull(session.rosterSnapshotAt.value)
        assertEquals(Session.Status.Unpaired, session.status.value)
    }

    // MARK: - Harness

    private fun TestScope.session(
        connectionStore: ConnectionStore = CacheFakeConnectionStore(),
        tokenStore: TokenStore = CacheFakeTokenStore(),
        rosterSnapshotStore: RosterSnapshotStore = InMemoryRosterSnapshotStore(),
        events: (String?, Boolean) -> Flow<StreamFrame> = { _, _ -> emptyFlow() },
        hydrate: suspend () -> Fleet = { Fleet(emptyList(), emptyList()) },
    ): Session = Session(
        scope = backgroundScope,
        connectionStore = connectionStore,
        tokenStore = tokenStore,
        onboardingStore = InMemoryOnboardingStore(),
        deviceNameProvider = { "Pixel" },
        rosterSnapshotStore = rosterSnapshotStore,
        eventsFn = { _, since, screens -> events(since, screens) },
        hydrateFn = { _, _ -> hydrate() },
        // The older sidecar every existing session test implicitly speaks to.
        metadataFn = { throw APIError.Status(404) },
    )
}

private fun cacheMessage(id: String, at: Double) = Message(
    id = id,
    role = Message.Role.USER,
    kind = Message.Kind.TEXT,
    at = at,
    text = id,
)

private fun cacheSampleBot(
    id: String,
    threadId: String,
    messages: List<Message>? = null,
    hasMore: Boolean? = null,
) = Bot(
    id = id,
    threadId = threadId,
    name = "Scout",
    title = "coder",
    description = "",
    notifications = true,
    color = "green",
    unread = false,
    modelSelection = ModelSelection("i", "m"),
    createdAt = 1.0,
    messages = messages,
    hasMore = hasMore,
)

private fun cacheSampleRoom(
    threadId: String,
    messages: List<Message>? = null,
    hasMore: Boolean? = null,
) = Room(
    id = "g1",
    threadId = threadId,
    name = "Launch Team",
    memberIds = listOf("b1"),
    defaultResponder = GroupResponder("mentions"),
    bulletin = "",
    unread = false,
    createdAt = 1.0,
    messages = messages,
    hasMore = hasMore,
)

private class FakeRosterSnapshotStore : RosterSnapshotStore {
    val snapshots = linkedMapOf<String, RosterSnapshot>()
    val cleared = mutableListOf<String>()

    override suspend fun load(connectionId: String): RosterSnapshot? = snapshots[connectionId]

    override suspend fun save(connectionId: String, snapshot: RosterSnapshot) {
        snapshots[connectionId] = snapshot
    }

    override suspend fun clear(connectionId: String) {
        cleared += connectionId
        snapshots.remove(connectionId)
    }
}

private class CacheFakeConnectionStore(
    initial: Connection? = null,
) : ConnectionStore {
    var saved: Connection? = initial
    private var registry: ConnectionRegistry? = null

    override suspend fun load(): Connection? = saved

    override suspend fun save(connection: Connection) {
        saved = connection
    }

    override suspend fun clear() {
        saved = null
    }

    override suspend fun loadRegistry(): ConnectionRegistryRestore {
        registry?.let { return ConnectionRegistryRestore(it, migratedLegacyConnection = false) }
        val legacy = saved ?: return ConnectionRegistryRestore(ConnectionRegistry(), migratedLegacyConnection = false)
        return ConnectionRegistryRestore(
            ConnectionRegistry.restoring(listOf(legacy), legacy.id),
            migratedLegacyConnection = true,
        )
    }

    override suspend fun saveRegistry(registry: ConnectionRegistry) {
        this.registry = registry.normalized()
        saved = this.registry?.activeConnection
    }

    override suspend fun clearRegistry() {
        registry = ConnectionRegistry()
        saved = null
    }
}

private class CacheFakeTokenStore : TokenStore {
    val saved = linkedMapOf<String, String>()

    override suspend fun save(connectionId: String, token: String) {
        saved[connectionId] = token
    }

    override suspend fun read(connectionId: String): TokenStore.ReadResult {
        val token = saved[connectionId] ?: return TokenStore.ReadResult.Missing
        return TokenStore.ReadResult.Found(token)
    }

    override suspend fun remove(connectionId: String) {
        saved.remove(connectionId)
    }
}
