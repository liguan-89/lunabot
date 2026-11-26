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

/** 团队记忆的会话层折叠：读失败是 null；写入把版本冲突与不可用分开。 */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionTeamMemoryTest {
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
    fun loadReturnsTheViewAndFailureReadsAsNull() = runTest {
        val session = session()
        server.enqueue(json("""{"section":"Editing","label":"Editing","entries":[],"loadedIds":[]}"""))
        assertEquals("Editing", session.loadTeamMemory("Editing")?.section)

        server.enqueue(json("""{"error":"no route"}""", code = 404))
        assertNull(session.loadTeamMemory("Editing"))
    }

    @Test
    fun writeConflictIsChangedAndOtherFailureIsUnavailable() = runTest {
        val session = session()
        val entry = TeamMemoryEntry(id = "m1", kind = "term", name = "Luna", detail = "机器人的名字", status = "accepted", revision = "rev1")

        server.enqueue(json("""{"error":"memory changed"}""", code = 409))
        assertIs<TeamMemoryWriteResult.Changed>(session.removeTeamMemory("Editing", entry))

        server.enqueue(json("""{"error":"offline"}""", code = 500))
        assertIs<TeamMemoryWriteResult.Unavailable>(session.removeTeamMemory("Editing", entry))
    }

    @Test
    fun successfulWriteReturnsTheServerView() = runTest {
        val session = session()
        server.enqueue(json("""{"entries":[{"id":"m1","kind":"term","name":"Luna","detail":"机器人的名字","status":"accepted","revision":"rev1"}],"loadedIds":["m1"]}"""))

        val result = session.addTeamMemory("Editing", "term", "Luna", "机器人的名字")

        assertIs<TeamMemoryWriteResult.Saved>(result)
        assertEquals(listOf("m1"), result.mutation.entries.map { it.id })
        assertEquals(listOf("m1"), result.mutation.loadedIds)
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
