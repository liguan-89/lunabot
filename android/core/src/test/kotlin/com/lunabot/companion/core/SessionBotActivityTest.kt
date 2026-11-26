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
import kotlin.test.assertNull

/**
 * 活动记录的会话层折叠：与 loadMcpServers 同一个先例——拒答、旧电脑、
 * 够不到电脑全是 null，由屏幕画成一行说明，而不是错误横幅。
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionBotActivityTest {
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
    fun rowsComeBackInServerOrder() = runTest {
        val session = session()
        server.enqueue(json("""{"rows":[
            {"at":"2026-11-26T08:31:00.000Z","threadId":"t1","tool":"Bash","app":null,"label":"Ran a command","outcome":"ran"},
            {"at":"2026-11-26T08:30:00.000Z","threadId":"t1","tool":"Read","app":null,"label":"Read a file","outcome":"allowed"}
        ]}""".trimIndent().replace("\n", "")))

        val rows = session.loadBotActivity("bot-1")

        assertEquals(listOf("Bash", "Read"), rows?.map { it.tool })
        assertEquals("GET /api/bots/bot-1/activity?limit=300", server.takeRequest().let { "${it.method} ${it.path}" })
    }

    @Test
    fun refusalAndOldComputerBothReadAsNull() = runTest {
        val session = session()
        // 旁车对未放行的路由答 404 no route，旧电脑对没有的路由也答 404，
        // 团队成员会话被 scope 拒是 403——折叠后全是 null。
        server.enqueue(json("""{"error":"no route"}""", code = 404))
        assertNull(session.loadBotActivity("bot-1"))

        server.enqueue(json("""{"error":"admin scope required"}""", code = 403))
        assertNull(session.loadBotActivity("bot-1"))
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
