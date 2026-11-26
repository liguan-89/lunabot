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
 * Data 只读的会话层折叠：拒答、太旧、够不到、引擎不可用（503）全是 null，
 * 由屏幕画成一行说明，不是错误横幅——与 loadBotActivity 同一个先例。
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionBotDataTest {
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
    fun dataComesBackWithSheetAndTables() = runTest {
        val session = session()
        server.enqueue(json("""{"sheet":{"version":1,"botId":"bot-1","cards":[],"sources":[],"updatedAt":"x"},
            "tables":[{"name":"orders","rowCount":3,"columns":[]}]}""".trimIndent().replace("\n", "")))

        val data = session.loadBotData("bot-1")

        assertEquals(listOf("orders"), data?.tables?.map { it.name })
        assertEquals("GET /api/bots/bot-1/data", server.takeRequest().let { "${it.method} ${it.path}" })
    }

    @Test
    fun refusalOldComputerAndEngineDownAllReadAsNull() = runTest {
        val session = session()
        server.enqueue(json("""{"error":"no route"}""", code = 404))
        assertNull(session.loadBotData("bot-1"))

        // DuckDB 引擎不可用是 503 不是 404——同样折成 null，屏幕只有一行说明。
        server.enqueue(json("""{"error":{"code":"engine_unavailable","message":"no duckdb"}}""", code = 503))
        assertNull(session.loadBotData("bot-1"))

        server.enqueue(json("""{"error":{"code":"engine_unavailable","message":"no duckdb"}}""", code = 503))
        assertNull(session.loadBotDataPage("bot-1", table = "t", cardId = null, offset = 0, limit = 50))

        server.enqueue(json("""{"error":{"code":"card_not_found","message":"missing"}}""", code = 404))
        assertNull(session.loadBotDataCardImage("bot-1", "c_9", width = 800, scale = 2, dark = false))
    }

    @Test
    fun pageAndImageComeBackOnSuccess() = runTest {
        val session = session()
        server.enqueue(json("""{"columns":[{"name":"id","type":"BIGINT"}],"rows":[["1"]],"rowCount":1,"offset":0}"""))
        server.enqueue(MockResponse().setResponseCode(200)
            .setHeader("Content-Type", "image/png")
            .setBody(okio.Buffer().write(byteArrayOf(1, 2, 3))))

        val page = session.loadBotDataPage("bot-1", table = "orders", cardId = null, offset = 0, limit = 50)
        val image = session.loadBotDataCardImage("bot-1", "c_1", width = 800, scale = 2, dark = false)

        assertEquals(1, page?.rows?.size)
        assertEquals(3, image?.size)
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
