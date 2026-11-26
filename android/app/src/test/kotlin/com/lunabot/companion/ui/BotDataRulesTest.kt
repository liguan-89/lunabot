package com.lunabot.companion.ui

import com.lunabot.companion.core.DataCardEntry
import com.lunabot.companion.core.DataColumnEntry
import com.lunabot.companion.core.DataPageResponse
import com.lunabot.companion.core.DataTableEntry
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class BotDataRulesTest {

    @Test
    fun `only a ready table card is browsable`() {
        // 图表卡的图内联在卡片上，文本卡原文即是全部，运行中与失败没有结果。
        assertTrue(BotDataRules.cardBrowsable(card(kind = "table", status = "ready")))
        assertFalse(BotDataRules.cardBrowsable(card(kind = "table", status = "running")))
        assertFalse(BotDataRules.cardBrowsable(card(kind = "table", status = "failed")))
        assertFalse(BotDataRules.cardBrowsable(card(kind = "chart", status = "ready")))
        assertFalse(BotDataRules.cardBrowsable(card(kind = "text", status = "ready")))
    }

    @Test
    fun `the card detail says the status before the shape`() {
        assertEquals("运行中", BotDataRules.cardDetail(card(status = "running")))
        assertEquals("已失败", BotDataRules.cardDetail(card(status = "failed")))
        assertEquals("表 · 1000 行", BotDataRules.cardDetail(card(kind = "table", rowCount = 1000)))
        assertEquals("图表", BotDataRules.cardDetail(card(kind = "chart", rowCount = 9)))
        assertEquals("文本", BotDataRules.cardDetail(card(kind = "text")))
    }

    @Test
    fun `the table detail counts rows and columns`() {
        assertEquals(
            "100 行 · 3 列",
            BotDataRules.tableDetail(
                DataTableEntry(
                    name = "orders",
                    rowCount = 100,
                    columns = listOf(
                        DataColumnEntry("a"), DataColumnEntry("b"), DataColumnEntry("c"),
                    ),
                ),
            ),
        )
    }

    @Test
    fun `the page position spans the rows in hand`() {
        assertEquals(
            "1–100 / 共 3204 行",
            BotDataRules.pagePosition(page(offset = 0, rows = 100, total = 3204)),
        )
        assertEquals(
            "101–150 / 共 3204 行",
            BotDataRules.pagePosition(page(offset = 100, rows = 50, total = 3204)),
        )
        assertEquals("共 0 行", BotDataRules.pagePosition(page(offset = 0, rows = 0, total = 0)))
    }

    @Test
    fun `cells render their raw content and null stays null`() {
        // DuckDB 的 bigint 与 decimal 到站是字符串，与数字画出来一个样；
        // null 留给页面画灰的 NULL，不能和空字符串混。
        assertEquals("1", BotDataRules.cellText(JsonPrimitive(1)))
        assertEquals("998244353000000000", BotDataRules.cellText(JsonPrimitive("998244353000000000")))
        assertEquals("abc", BotDataRules.cellText(JsonPrimitive("abc")))
        assertEquals("true", BotDataRules.cellText(JsonPrimitive(true)))
        assertNull(BotDataRules.cellText(JsonNull))
    }

    private fun card(
        kind: String = "table",
        status: String = "ready",
        rowCount: Long? = null,
    ) = DataCardEntry(id = "c_1", kind = kind, status = status, rowCount = rowCount)

    private fun page(offset: Int, rows: Int, total: Long) = DataPageResponse(
        columns = listOf(DataColumnEntry("a")),
        rows = List(rows) { listOf(JsonPrimitive(1)) },
        rowCount = total,
        offset = offset,
    )
}
