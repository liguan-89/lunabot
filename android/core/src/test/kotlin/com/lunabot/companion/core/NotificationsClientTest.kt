package com.lunabot.companion.core

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** 通知日志路由：GET /api/notifications 与两条已读标记。 */
class NotificationsClientTest {
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
    fun fetchesTheLogWithTheBearerToken() = runBlocking {
        server.enqueue(json("""{"notifications":[]}"""))

        client.notifications()

        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/api/notifications", request.path)
        assertEquals("Bearer paired-token", request.getHeader("Authorization"))
    }

    @Test
    fun decodesTheFieldsThePhoneDrawsAndIgnoresTheRest() = runBlocking {
        server.enqueue(json("""{"notifications":[
            {"id":"n-1","at":1764194400000,"kind":"approval","botId":"bot-1","botName":"Luna",
             "threadId":"t1","title":"需要批准","body":"运行 ls","avatarUrl":"/api/attachments/a.webp",
             "groupId":"g1","forPerson":"p1","read":false,"futureField":{"x":1}},
            {"id":"n-2","at":1764194300000,"kind":"done","botId":"bot-2","botName":"Maus",
             "threadId":"t2","title":"完成了","body":"","read":true}
        ]}""".trimIndent().replace("\n", "")))

        val rows = client.notifications().notifications

        assertEquals(2, rows.size)
        val first = rows[0]
        assertEquals("n-1", first.id)
        assertEquals(1764194400000, first.at)
        assertEquals("approval", first.kind)
        assertEquals("Luna", first.botName)
        assertEquals("t1", first.threadId)
        assertEquals("需要批准", first.title)
        assertEquals("g1", first.groupId)
        assertEquals(false, first.read)
        val second = rows[1]
        assertNull(second.groupId)
        assertTrue(second.read)
    }

    @Test
    fun marksOneRowReadWithAnEmptyPost() = runBlocking {
        server.enqueue(json("""{"ok":true}"""))

        client.markNotificationRead("n-1")

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/notifications/n-1/read", request.path)
    }

    @Test
    fun percentEscapesAnIdSoItStaysOnePathSegment() = runBlocking {
        server.enqueue(json("""{"ok":true}"""))

        client.markNotificationRead("n/1/../x")

        assertEquals("/api/notifications/n%2F1%2F..%2Fx/read", server.takeRequest().path)
    }

    @Test
    fun marksEverythingRead() = runBlocking {
        server.enqueue(json("""{"ok":true}"""))

        client.markAllNotificationsRead()

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/notifications/read-all", request.path)
    }

    @Test
    fun aServerErrorComesBackAsStatus() = runBlocking {
        server.enqueue(json("""{"error":"no route"}""", code = 404))

        val error = assertFailsWith<APIError.Status> { client.notifications() }

        assertEquals(404, error.code)
    }

    private fun json(body: String, code: Int = 200) = MockResponse()
        .setResponseCode(code)
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}
