package com.lunabot.companion.ui

import com.lunabot.companion.core.BotActivityRow
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class BotActivityRulesTest {

    private val zone: ZoneId = ZoneId.of("Asia/Shanghai")

    @Test
    fun `outcome words match the desktop zh catalog`() {
        // 桌面端 zh.json 的 activity.outcome.*；新结局类型画空徽标而不是猜一个词。
        assertEquals("已运行", BotActivityRules.outcomeText("ran"))
        assertEquals("已失败", BotActivityRules.outcomeText("failed"))
        assertEquals("运行中", BotActivityRules.outcomeText("running"))
        assertEquals("已允许", BotActivityRules.outcomeText("allowed"))
        assertEquals("已拒绝", BotActivityRules.outcomeText("denied"))
        assertEquals("需要你处理", BotActivityRules.outcomeText("waiting"))
        assertEquals("", BotActivityRules.outcomeText("some-future-outcome"))
    }

    @Test
    fun `the line title puts the app before the action`() {
        assertEquals(
            "Gmail · Sent an email",
            BotActivityRules.lineTitle(row(app = "Gmail", label = "Sent an email")),
        )
        assertEquals(
            "Ran a command",
            BotActivityRules.lineTitle(row(app = null, label = "Ran a command")),
        )
        // label 缺失时退回工具名，行不能是空白。
        assertEquals("Bash", BotActivityRules.lineTitle(row(app = null, label = "", tool = "Bash")))
    }

    @Test
    fun `the row clock is HHmm in the reader zone`() {
        // 08:30 UTC 是上海的 16:30。
        assertEquals("16:30", BotActivityRules.timeText("2026-11-26T08:30:00.000Z", zone))
        assertEquals("--:--", BotActivityRules.timeText("not-a-time", zone))
    }

    @Test
    fun `grouping keeps server order and labels consecutive days`() {
        val zone8 = ZoneId.of("Asia/Shanghai")
        val now = java.time.ZonedDateTime.of(2026, 11, 26, 20, 0, 0, 0, zone8).toInstant().toEpochMilli()
        val rows = listOf(
            row(at = "2026-11-26T11:00:00.000Z"),  // 今天 19:00 上海
            row(at = "2026-11-26T10:00:00.000Z"),  // 今天 18:00 上海
            row(at = "2026-11-25T12:00:00.000Z"),  // 昨天 20:00 上海
            row(at = "2026-11-20T12:00:00.000Z"),  // 11月20日
        )

        val groups = BotActivityRules.groupByDay(rows, now, zone8)

        assertEquals(listOf("今天", "昨天", "11月20日"), groups.map { it.label })
        assertEquals(2, groups[0].rows.size)
        assertEquals(1, groups[1].rows.size)
        // 组内保持服务端顺序，新的在前。
        assertTrue(groups[0].rows[0].at > groups[0].rows[1].at)
    }

    @Test
    fun `a row across the year boundary carries the year`() {
        val now = java.time.ZonedDateTime.of(2026, 1, 2, 12, 0, 0, 0, zone).toInstant().toEpochMilli()
        val rows = listOf(row(at = "2025-12-30T04:00:00.000Z"))  // 2025年12月30日 上海

        assertEquals(listOf("2025年12月30日"), BotActivityRules.groupByDay(rows, now, zone).map { it.label })
    }

    private fun row(
        at: String = "2026-11-26T08:30:00.000Z",
        app: String? = null,
        label: String = "Ran a command",
        tool: String = "Bash",
    ) = BotActivityRow(at = at, threadId = "t1", tool = tool, app = app, label = label)
}
