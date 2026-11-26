package com.lunabot.companion.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Data 只读路由：GET data、POST data/page 与图表卡 PNG。 */
class BotDataClientTest {
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
    fun decodesTheSheetAndTablesAndIgnoresTheRest() = runBlocking {
        // sql/vegaLite/chart 规格是桌面端重跑与画图用的，手机不解码；
        // 结果经分页接口单取，图经 image 接口单取。
        server.enqueue(json("""{
            "sheet":{"version":1,"botId":"bot-1","updatedAt":"2026-11-26T08:30:00Z",
                "cards":[
                    {"id":"c_1","kind":"chart","title":"销量","sql":"select 1","result":"omb_results.r1",
                     "chart":{"type":"bar","x":"a"},"vegaLite":{"mark":"bar"},"status":"ready","by":"bot",
                     "pinned":true,"createdAt":"x","updatedAt":"y","rowCount":9,"truncated":true},
                    {"id":"c_2","kind":"table","title":"明细","status":"ready","rowCount":1000},
                    {"id":"c_3","kind":"text","title":"说明","text":"**md**","status":"failed"}
                ],
                "sources":[{"name":"orders","sqlName":"\"orders\"","kind":"csv","source":"/tmp/o.csv",
                    "rowCount":100,"columns":[],"loadedAt":"x","options":{"a":1}}]},
            "tables":[{"name":"orders","sqlName":"\"orders\"","rowCount":100,
                "columns":[{"name":"id","type":"BIGINT","nullPct":0.0,"sample":["1"]},
                           {"name":"name","type":"VARCHAR"}]}]
        }""".trimIndent().replace("\n", "")))

        val data = client.botData("bot-1")

        assertEquals("GET /api/bots/bot-1/data", server.takeRequest().let { "${it.method} ${it.path}" })
        assertEquals(3, data.sheet.cards.size)
        val chart = data.sheet.cards[0]
        assertEquals("c_1", chart.id)
        assertEquals("chart", chart.kind)
        assertEquals("销量", chart.title)
        assertEquals(9, chart.rowCount)
        assertEquals(true, chart.truncated)
        val text = data.sheet.cards[2]
        assertEquals("**md**", text.text)
        assertEquals("failed", text.status)
        assertEquals(1, data.sheet.sources.size)
        assertEquals("csv", data.sheet.sources[0].kind)
        assertEquals(1, data.tables.size)
        assertEquals(100, data.tables[0].rowCount)
        assertEquals(listOf("id", "name"), data.tables[0].columns.map { it.name })
        assertEquals("BIGINT", data.tables[0].columns[0].type)
    }

    @Test
    fun pagesATableWithExactlyTheTableKey() = runBlocking {
        server.enqueue(json("""{"columns":[],"rows":[],"rowCount":0,"offset":0}"""))

        client.botDataPage("bot-1", table = "orders", cardId = null, offset = 50, limit = 25)

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/bots/bot-1/data/page", request.path)
        val body = CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        // 服务端 schema 是 strict 且要求 table 与 cardId 有且只有一个——
        // body 里不许出现 null 的 cardId 键，也不许带 sort/filter。
        assertEquals("orders", body.getValue("table").jsonPrimitive.content)
        assertEquals(50, body.getValue("offset").jsonPrimitive.int)
        assertEquals(25, body.getValue("limit").jsonPrimitive.int)
        assertEquals(3, body.size)
    }

    @Test
    fun pagesACardResultWithExactlyTheCardIdKey() = runBlocking {
        server.enqueue(json("""{"columns":[],"rows":[],"rowCount":0,"offset":0}"""))

        client.botDataPage("bot-1", table = null, cardId = "c_2", offset = 0, limit = 100)

        val body = CompanionJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals("c_2", body.getValue("cardId").jsonPrimitive.content)
        assertEquals(3, body.size)
    }

    @Test
    fun decodesPageRowsAsJsonCells() = runBlocking {
        // DuckDB 的 bigint 与 decimal 到站是字符串，null 与布尔原样——
        // 单元格保留 JSON，画成文本是页面的事。
        server.enqueue(json("""{"columns":[{"name":"id","type":"BIGINT"},{"name":"ok","type":"BOOLEAN"}],
            "rows":[["1",true],[null,false]],"rowCount":2,"offset":0}""".trimIndent().replace("\n", "")))

        val page = client.botDataPage("bot-1", table = "t", cardId = null, offset = 0, limit = 50)

        assertEquals(2, page.rows.size)
        assertEquals("1", page.rows[0][0].jsonPrimitive.content)
        assertEquals("true", page.rows[0][1].jsonPrimitive.content)
        assertTrue(page.rows[1][0] is kotlinx.serialization.json.JsonNull)
        assertEquals(2, page.rowCount)
    }

    @Test
    fun fetchesTheChartImageBytesWithTheRenderQuery() = runBlocking {
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47)
        server.enqueue(MockResponse().setResponseCode(200)
            .setHeader("Content-Type", "image/png")
            .setBody(okio.Buffer().write(png)))

        val bytes = client.botDataCardImage("bot-1", "c_1", width = 800, scale = 2, dark = true)

        assertContentEquals(png, bytes)
        assertEquals("/api/bots/bot-1/data/cards/c_1/image?width=800&scale=2&theme=dark", server.takeRequest().path)
    }

    @Test
    fun theLightThemeLeavesTheQueryParamOut() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(okio.Buffer().write(byteArrayOf(1))))

        client.botDataCardImage("bot-1", "c_1", width = 800, scale = 2, dark = false)

        assertEquals("/api/bots/bot-1/data/cards/c_1/image?width=800&scale=2", server.takeRequest().path)
    }

    @Test
    fun aMissingCardIsAnErrorStatus() = runBlocking {
        server.enqueue(json("""{"error":{"code":"card_not_found","message":"No card c_9 on the sheet."}}""", code = 404))

        val error = kotlin.test.assertFailsWith<APIError.Status> {
            client.botDataCardImage("bot-1", "c_9", width = 800, scale = 2, dark = false)
        }

        assertEquals(404, error.code)
    }

    private fun json(body: String, code: Int = 200) = MockResponse()
        .setResponseCode(code)
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}
