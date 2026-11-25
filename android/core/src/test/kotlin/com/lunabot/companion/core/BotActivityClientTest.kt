package com.lunabot.companion.core

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** 活动记录路由：GET /api/bots/:id/activity，只读，新的在前。 */
class BotActivityClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: CompanionClient

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
        val connection = requireNotNull(Connection.parse(server.url("/").toString()))
        client = CompanionClient(connection, "paired-token")
    }

    @AfterTest
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun fetchesRowsWithTheLimitInTheQuery() = runBlocking {
        server.enqueue(json("""{"rows":[]}"""))

        client.botActivity("bot-1", limit = 120)

        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/api/bots/bot-1/activity?limit=120", request.path)
        assertEquals("Bearer paired-token", request.getHeader("Authorization"))
    }

    @Test
    fun decodesTheFieldsThePhoneDrawsAndIgnoresTheRest() = runBlocking {
        // labelKey/appKey/summaryCode/summaryParams 与未来的字段都该被忽略——
        // 手机画 label 与 summary 原文，桌面端的本地化键不属于这里。
        server.enqueue(json("""{"rows":[
            {"at":"2026-11-26T08:30:00.000Z","threadId":"t1","turnId":"turn-9","requestId":"req-1",
             "tool":"Bash","app":"Team","label":"Ran a command","labelKey":"activity.tool.ranCommand",
             "summary":"ls -la","summaryCode":"activity.summary.command","outcome":"ran"},
            {"at":"2026-11-26T08:31:00.000Z","threadId":"t1","tool":"GMAIL_SEND","app":null,
             "label":"Sent an email","outcome":"denied","futureField":{"x":1}}
        ]}""".trimIndent().replace("\n", "")))

        val rows = client.botActivity("bot-1").rows

        assertEquals(2, rows.size)
        val first = rows[0]
        assertEquals("2026-11-26T08:30:00.000Z", first.at)
        assertEquals("t1", first.threadId)
        assertEquals("Bash", first.tool)
        assertEquals("Team", first.app)
        assertEquals("Ran a command", first.label)
        assertEquals("ls -la", first.summary)
        assertEquals("ran", first.outcome)
        val second = rows[1]
        assertNull(second.app)
        assertNull(second.summary)
        assertEquals("denied", second.outcome)
    }

    @Test
    fun theDefaultLimitIsTheDesktopPanelOwn() = runBlocking {
        // 桌面端 ActivityPanel 取 300；手机跟随同一页大小，两端看到的是同一份记录。
        server.enqueue(json("""{"rows":[]}"""))

        client.botActivity("bot-1")

        assertEquals("/api/bots/bot-1/activity?limit=300", server.takeRequest().path)
    }

    private fun json(body: String, code: Int = 200) = MockResponse()
        .setResponseCode(code)
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}
