package com.lunabot.companion.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/** 「到点继续」路由：POST /api/limit-resets/continue，正文点名会话。 */
class LimitResetContinueClientTest {
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
    fun postsTheConversationInTheBody() = runBlocking {
        server.enqueue(json("""{"routine":{"id":"r1"}}""", code = 201))

        client.continueAtLimitReset("bot-1", "thread-1")

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/limit-resets/continue", request.path)
        assertEquals("Bearer paired-token", request.getHeader("Authorization"))
        val body = CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("bot-1", body.getValue("botId").jsonPrimitive.content)
        assertEquals("thread-1", body.getValue("threadId").jsonPrimitive.content)
        assertEquals(2, body.size)
    }

    @Test
    fun bothCreatedAndAlreadyWaitingAreSuccess() = runBlocking {
        // 201 是新建，200 是已有一条等待中的安排——幂等设计下两者是同一个终态，
        // 都不许当成失败抛出来。
        server.enqueue(json("""{"routine":{"id":"r1"}}""", code = 201))
        server.enqueue(json("""{"routine":{"id":"r1"}}""", code = 200))

        client.continueAtLimitReset("bot-1", "thread-1")
        client.continueAtLimitReset("bot-1", "thread-1")

        assertEquals(2, server.requestCount)
    }

    @Test
    fun theHarnessRefusalReachesTheCallerInItsOwnWords() = runBlocking {
        server.enqueue(json("""{"error":"This conversation has no engine to wait for."}""", code = 409))

        val error = assertFailsWith<APIError.Status> { client.continueAtLimitReset("bot-1", "thread-1") }

        assertEquals(409, error.code)
        assertEquals("This conversation has no engine to wait for.", error.message)
    }

    private fun json(body: String, code: Int = 200) = MockResponse()
        .setResponseCode(code)
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}
