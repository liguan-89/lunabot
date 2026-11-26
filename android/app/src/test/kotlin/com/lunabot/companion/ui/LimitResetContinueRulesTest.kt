package com.lunabot.companion.ui

import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class LimitResetContinueRulesTest {

    private val zone: ZoneId = ZoneId.of("Asia/Shanghai")

    @Test
    fun `the offer stands only while the reset is still ahead`() {
        val now = 1_764_000_000_000L
        assertTrue(LimitResetContinueRules.offers(now + 60_000.0, now))
        assertFalse(LimitResetContinueRules.offers(now.toDouble(), now), "刚好到点不再是「未来」")
        assertFalse(LimitResetContinueRules.offers(now - 1.0, now))
        assertFalse(LimitResetContinueRules.offers(Double.NaN, now))
        assertFalse(LimitResetContinueRules.offers(Double.POSITIVE_INFINITY, now))
    }

    @Test
    fun `a same-day reset reads as the clock alone`() {
        // 2026-11-24 10:00 上海，重置在当天 18:40。
        val now = shanghai(2026, 11, 24, 10, 0)
        val resetsAt = shanghai(2026, 11, 24, 18, 40).toDouble()
        assertEquals("18:40", LimitResetContinueRules.resetTimeText(resetsAt, now, zone))
    }

    @Test
    fun `a reset on a later day carries the date`() {
        val now = shanghai(2026, 11, 24, 10, 0)
        val resetsAt = shanghai(2026, 11, 28, 9, 5).toDouble()
        assertEquals("11月28日 09:05", LimitResetContinueRules.resetTimeText(resetsAt, now, zone))
    }

    @Test
    fun `the offer sentence is the desktop one`() {
        // 桌面端 zh 的 chat.limit.continueAt：「额度在 {time} 重置后可继续」。
        assertEquals("额度在 18:40 重置后可继续", LimitResetContinueRules.offerText("18:40"))
    }

    private fun shanghai(year: Int, month: Int, day: Int, hour: Int, minute: Int): Long =
        java.time.ZonedDateTime.of(year, month, day, hour, minute, 0, 0, zone)
            .toInstant().toEpochMilli()
}
