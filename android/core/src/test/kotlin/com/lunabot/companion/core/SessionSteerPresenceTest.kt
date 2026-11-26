package com.lunabot.companion.core

import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.assertFalse
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest

@OptIn(ExperimentalCoroutinesApi::class)
class SessionSteerPresenceTest {
    private lateinit var server: MockWebServer

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @AfterTest
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun steerPostsToTheQueueHeadRouteWithThePinnedThread() = runTest {
        val session = session()
        val chat = Chat.BotChat(bot("b1", "task-a", "task-a"))
        server.enqueue(json("""{"ok":true,"steered":true}"""))

        assertTrue(session.steerQueued(QueuedSend("queue-a", "hold on"), chat))

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/bots/b1/queue/queue-a/steer", request.path)
        assertEquals("task-a", body(request)["threadId"])
        assertNull(session.actionError)
    }

    @Test
    fun steerTreatsADrainedEntryQuietlyAndAnOldComputerAsAnActionError() = runTest {
        val session = session()
        val chat = Chat.BotChat(bot("b1", "task-a", "task-a"))
        val queued = QueuedSend("queue-a", "hold on")

        server.enqueue(json("""{"error":"no such queued message"}""", code = 404))
        assertFalse(session.steerQueued(queued, chat))
        assertNull(session.actionError, "a drained row is the outcome the press wanted")

        server.enqueue(json("""{"error":"no route"}""", code = 404))
        assertFalse(session.steerQueued(queued, chat))
        assertEquals(
            "此电脑版本过旧，无法把排队中的消息插进当前回合。请在电脑上更新 Luna Bot。",
            session.actionError,
        )
    }

    @Test
    fun steerSurfacesServerRefusals() = runTest {
        val session = session()
        val chat = Chat.BotChat(bot("b1", "task-a", "task-a"))

        server.enqueue(json("""{"error":"waits its turn"}""", code = 403))
        assertFalse(session.steerQueued(QueuedSend("queue-a", "hold on"), chat))
        assertEquals("waits its turn", session.actionError)
    }

    @Test
    fun presenceCarriesPhoneSourceZoneLanguageAndTheOpenThread() = runTest {
        var now = 0L
        val session = session(now = { now })
        val chat = Chat.BotChat(bot("b1", "task-a", "task-a"))
        server.enqueue(json("""{"ok":true}"""))

        session.noteChatOpen(chat.threadId)
        runCurrent()

        val request = server.takeRequest(2, TimeUnit.SECONDS)
        assertNotNull(request, "opening a chat reports presence")
        assertEquals("POST", request.method)
        assertEquals("/api/presence/active", request.path)
        val sent = body(request)
        assertEquals("phone", sent["source"])
        assertEquals(chat.threadId, sent["threadId"])
        assertTrue(sent["timeZone"]?.isNotBlank() == true, "timeZone rides every ping")
        assertTrue(sent["language"]?.isNotBlank() == true, "language rides every ping")
    }

    @Test
    fun presenceThrottleSkipsRepeatsButFollowsThreadSwitches() = runTest {
        var now = 0L
        val session = session(now = { now })
        server.enqueue(json("""{"ok":true}"""))
        server.enqueue(json("""{"ok":true}"""))
        server.enqueue(json("""{"ok":true}"""))

        session.noteChatOpen("task-a")
        runCurrent()
        // takeRequest blocks the test thread until the real OkHttp call lands —
        // the ping runs fire-and-forget outside the test dispatcher.
        val first = server.takeRequest(2, TimeUnit.SECONDS)
        assertNotNull(first, "opening a chat reports right away")
        assertEquals("task-a", body(first)["threadId"])

        // Same thread inside the repeat window: nothing new to say.
        now += 10_000
        session.reportPresence()
        runCurrent()
        assertNull(server.takeRequest(300, TimeUnit.MILLISECONDS), "a repeat inside the window is throttled")

        // A different thread is new information even inside the window.
        session.noteChatOpen("task-b")
        runCurrent()
        val second = server.takeRequest(2, TimeUnit.SECONDS)
        assertNotNull(second, "a thread switch reports even inside the window")
        assertEquals("task-b", body(second)["threadId"])

        // The repeat window elapsed: the same thread reports again.
        now += 60_000
        session.reportPresence()
        runCurrent()
        assertNotNull(server.takeRequest(2, TimeUnit.SECONDS), "the window elapsed, so the same thread reports again")
    }

    @Test
    fun presenceFailureStaysQuiet() = runTest {
        var now = 0L
        val session = session(now = { now })
        server.enqueue(json("""{"error":"boom"}""", code = 500))

        session.reportPresence()
        runCurrent()

        assertNotNull(server.takeRequest(2, TimeUnit.SECONDS), "the ping still fires")
        // An uncaught failure inside the fire-and-forget coroutine would fail
        // this test at scope completion; the banner assertion is one-sided —
        // it can catch a regression, never prove a negative.
        Thread.sleep(300)
        runCurrent()
        assertNull(session.actionError)
    }

    private suspend fun TestScope.session(
        now: () -> Long = { 0L },
    ): Session {
        val connection = requireNotNull(Connection.parse(server.url("/").toString()))
        return Session(
            scope = backgroundScope,
            connectionStore = object : ConnectionStore {
                override suspend fun load(): Connection = connection
                override suspend fun save(connection: Connection) = Unit
                override suspend fun clear() = Unit
                override suspend fun loadRegistry() = ConnectionRegistryRestore(
                    ConnectionRegistry(listOf(connection), connection.id),
                    migratedLegacyConnection = false,
                )
            },
            tokenStore = object : TokenStore {
                override suspend fun save(connectionId: String, token: String) = Unit
                override suspend fun read(connectionId: String): TokenStore.ReadResult =
                    TokenStore.ReadResult.Found("device-token")
                override suspend fun remove(connectionId: String) = Unit
            },
            onboardingStore = InMemoryOnboardingStore(),
            deviceNameProvider = { "Pixel" },
            eventsFn = { _, _, _ -> emptyFlow() },
            hydrateFn = { _, _ -> Fleet(emptyList(), emptyList()) },
            nowFn = now,
        ).also { it.awaitRestored() }
    }

    private fun bot(id: String, active: String, vararg tasks: String): Bot = Bot(
        id = id,
        threadId = active,
        name = id,
        title = "",
        description = "",
        notifications = true,
        color = "green",
        unread = false,
        modelSelection = ModelSelection("instance", "model"),
        createdAt = 1.0,
        tasks = tasks.mapIndexed { index, threadId ->
            BotTask(threadId, "Task ${index + 1}", index.toDouble())
        },
    )

    private fun json(body: String, code: Int = 200): MockResponse = MockResponse()
        .setResponseCode(code)
        .setHeader("Content-Type", "application/json")
        .setBody(body)

    private fun body(request: RecordedRequest): Map<String, String> =
        CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
            .mapValues { it.value.jsonPrimitive.content }
}
