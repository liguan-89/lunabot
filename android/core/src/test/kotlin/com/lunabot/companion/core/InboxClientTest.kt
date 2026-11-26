package com.lunabot.companion.core

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** 收件箱路由：GET /api/inbox、count 与 read/done 标记。 */
class InboxClientTest {
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
    fun decodesTheViewAndSkipsCardPayloads() = runBlocking {
        // card/secret/signIn/connector 是桌面端回答卡片用的——手机不解码，
        // 行里出现它们不影响其余字段进列表。
        server.enqueue(json("""{
            "botId":"bot-1","threadId":"t-inbox","anchor":"l-1",
            "rows":[
                {"id":"l-1","kind":"ask","tab":"needs-you",
                 "from":{"name":"Luna","email":"l@x","botId":"bot-1"},
                 "via":{"botId":"bot-9","name":"Chief"},"workingFor":{"botId":"bot-8","name":"Boss"},
                 "origin":{"botId":"bot-1","threadId":"t1","title":"会话","groupId":"g1","messageId":"m1"},
                 "text":"可以删库吗","at":1764194400000,"unread":true,"replies":true,
                 "card":{"kind":"options","title":"t"},"answers":[{"by":"person","text":"x","at":1}]},
                {"id":"l-2","kind":"result","tab":"info","from":{"name":"Maus"},
                 "text":"巡检完成","at":1764194300000,"unread":false}
            ]
        }""".trimIndent().replace("\n", "")))

        val view = client.inbox()

        assertEquals("bot-1", view.botId)
        assertEquals("l-1", view.anchor)
        assertEquals(2, view.rows.size)
        val ask = view.rows[0]
        assertEquals("ask", ask.kind)
        assertEquals("needs-you", ask.tab)
        assertEquals("Luna", ask.from.name)
        assertEquals("Chief", ask.via?.name)
        assertEquals("Boss", ask.workingFor?.name)
        assertEquals("t1", ask.origin?.threadId)
        assertEquals("可以删库吗", ask.text)
        assertEquals(true, ask.unread)
        val result = view.rows[1]
        assertNull(result.via)
        assertNull(result.origin)
    }

    @Test
    fun readsTheCount() = runBlocking {
        server.enqueue(json("""{"count":3}"""))

        assertEquals(3, client.inboxCount())
        assertEquals("GET /api/inbox/count", server.takeRequest().let { "${it.method} ${it.path}" })
    }

    @Test
    fun markReadPostsToReadAndAnswersWithTheFreshView() = runBlocking {
        server.enqueue(json("""{"botId":null,"threadId":null,"rows":[],"anchor":null}"""))

        val view = client.markInboxRow("l-1", done = false)

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/inbox/l-1/read", request.path)
        assertEquals(0, view.rows.size)
    }

    @Test
    fun markDonePostsToDone() = runBlocking {
        server.enqueue(json("""{"botId":null,"threadId":null,"rows":[],"anchor":null}"""))

        client.markInboxRow("l-1", done = true)

        assertEquals("/api/inbox/l-1/done", server.takeRequest().path)
    }

    private fun json(body: String, code: Int = 200) = MockResponse()
        .setResponseCode(code)
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}
