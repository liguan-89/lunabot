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

/**
 * 「到点继续」的会话层折叠：201 与 200 都是 Set，404/403 安静折成
 * Unavailable（旧电脑、被拒的会话、已删除的会话不可区分，按钮都是消失），
 * 其余的错带着服务端原话进 Failed。
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionLimitResetContinueTest {
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
    fun createdAndAlreadyWaitingBothReadAsSet() = runTest {
        val session = session()
        server.enqueue(json("""{"routine":{"id":"r1"}}""", code = 201))
        assertEquals(LimitResetContinueResult.Set, session.continueAtLimitReset("bot-1", "thread-1"))

        server.enqueue(json("""{"routine":{"id":"r1"}}""", code = 200))
        assertEquals(LimitResetContinueResult.Set, session.continueAtLimitReset("bot-1", "thread-1"))

        assertEquals(
            listOf("POST /api/limit-resets/continue", "POST /api/limit-resets/continue"),
            List(2) { server.takeRequest() }.map { "${it.method} ${it.path}" },
        )
    }

    @Test
    fun missingRouteAndRefusedSessionBothFoldIntoUnavailable() = runTest {
        val session = session()
        // 404 既可能是旧电脑没有这条路由，也可能是路由自己答的 no such
        // conversation——折叠的结果不问是哪一种，因为按钮的处置相同。
        server.enqueue(json("""{"error":"no route"}""", code = 404))
        assertEquals(LimitResetContinueResult.Unavailable, session.continueAtLimitReset("bot-1", "thread-1"))

        server.enqueue(json("""{"error":"no such conversation"}""", code = 404))
        assertEquals(LimitResetContinueResult.Unavailable, session.continueAtLimitReset("bot-1", "thread-1"))

        server.enqueue(json("""{"error":"admin scope required"}""", code = 403))
        assertEquals(LimitResetContinueResult.Unavailable, session.continueAtLimitReset("bot-1", "thread-1"))
    }

    @Test
    fun otherFailuresKeepTheServerWords() = runTest {
        val session = session()
        server.enqueue(json("""{"error":"This conversation has no engine to wait for."}""", code = 409))

        val result = session.continueAtLimitReset("bot-1", "thread-1")

        assertIs<LimitResetContinueResult.Failed>(result)
        assertEquals("This conversation has no engine to wait for.", result.message)
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
