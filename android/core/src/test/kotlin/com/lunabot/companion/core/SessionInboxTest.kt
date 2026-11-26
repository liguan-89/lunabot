package com.lunabot.companion.core

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 通知与收件箱的会话层折叠：与 loadMcpServers 同一个先例——拒答、旧电脑、
 * 够不到全是静默状态。收件箱多分一个 Missing：这台电脑没有收件箱不是错误，
 * 与够不到电脑分开画。
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionInboxTest {
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
    fun notificationsComeBackInServerOrder() = runTest {
        val session = session()
        server.enqueue(json("""{"notifications":[
            {"id":"n-1","at":2,"kind":"done","botId":"b","botName":"Luna","threadId":"t","title":"一","body":"","read":false},
            {"id":"n-2","at":1,"kind":"mention","botId":"b","botName":"Luna","threadId":"t","title":"二","body":"","read":true}
        ]}""".trimIndent().replace("\n", "")))

        val rows = session.loadNotifications()

        assertEquals(listOf("n-1", "n-2"), rows?.map { it.id })
    }

    @Test
    fun notificationRefusalAndOldComputerBothReadAsNull() = runTest {
        val session = session()
        server.enqueue(json("""{"error":"no route"}""", code = 404))
        assertNull(session.loadNotifications())

        server.enqueue(json("""{"error":"admin scope required"}""", code = 403))
        assertNull(session.loadNotifications())
    }

    @Test
    fun markNotificationReadIsQuietlyFalseOnFailure() = runTest {
        val session = session()
        server.enqueue(json("""{"ok":true}"""))
        assertTrue(session.markNotificationRead("n-1"))

        // 通知已从列表消失（404）或电脑答错——都静默，下一次刷新带回真实状态。
        server.enqueue(json("""{"error":"missing"}""", code = 404))
        assertEquals(false, session.markNotificationRead("n-1"))
    }

    @Test
    fun inboxLoadsTheView() = runTest {
        val session = session()
        server.enqueue(json("""{"botId":null,"threadId":null,"anchor":null,"rows":[
            {"id":"l-1","kind":"ask","tab":"needs-you","from":{"name":"Luna"},"text":"可以删库吗","at":1,"unread":true}
        ]}""".trimIndent().replace("\n", "")))

        val result = session.loadInbox()

        val loaded = assertIs<InboxResult.Loaded>(result)
        assertEquals("l-1", loaded.view.rows[0].id)
    }

    @Test
    fun inboxMissingAndUnreachableAreDistinct() = runTest {
        val session = session()
        // 404 两种来源同码：团队云答 serverError.inbox.missing，旧电脑答 no route——
        // 都是 Missing，画「这里没有收件箱」的一行说明。
        server.enqueue(json("""{"error":"There is no inbox here.","errorKey":"serverError.inbox.missing"}""", code = 404))
        assertEquals(InboxResult.Missing, session.loadInbox())

        server.enqueue(json("""{"error":"no route"}""", code = 404))
        assertEquals(InboxResult.Missing, session.loadInbox())

        // 403/500/传输错误是另一回事：这台电脑明明该有，只是这次没读到。
        server.enqueue(json("""{"error":"broken"}""", code = 500))
        assertEquals(InboxResult.Unreachable, session.loadInbox())

        server.enqueue(json("""{"error":"scope"}""", code = 403))
        assertEquals(InboxResult.Unreachable, session.loadInbox())
    }

    @Test
    fun markInboxRowAnswersWithTheFreshView() = runTest {
        val session = session()
        server.enqueue(json("""{"botId":null,"threadId":null,"anchor":null,"rows":[
            {"id":"l-1","kind":"result","tab":"done","from":{"name":"Luna"},"text":"巡检完成","at":1,"unread":false}
        ]}""".trimIndent().replace("\n", "")))

        val view = session.markInboxRow("l-1", done = true)

        assertEquals("done", view?.rows?.get(0)?.tab)
        assertEquals("/api/inbox/l-1/done", server.takeRequest().path)
    }

    @Test
    fun markInboxRowIsNullOnTheAnswerRequiredConflict() = runTest {
        val session = session()
        // ask 行点办结服务端答 409——行保持原样，不报错。
        server.enqueue(json("""{"error":"answer required"}""", code = 409))
        assertNull(session.markInboxRow("l-1", done = true))
    }

    @Test
    fun inboxCountIsNullOnAnyFailure() = runTest {
        val session = session()
        server.enqueue(json("""{"count":2}"""))
        assertEquals(2, session.loadInboxCount())

        server.enqueue(json("""{"error":"no route"}""", code = 404))
        assertNull(session.loadInboxCount())
    }

    private suspend fun TestScope.session(): Session {
        val connection = requireNotNull(Connection.parse(server.url("/").toString()))
        return Session(
            scope = backgroundScope,
            connectionStore = object : ConnectionStore {
                override suspend fun load(): Connection = connection
                override suspend fun save(connection: Connection) = Unit
                override suspend fun clear() = Unit
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
        ).also { it.awaitRestored() }
    }

    private fun json(body: String, code: Int = 200): MockResponse = MockResponse()
        .setResponseCode(code)
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}
