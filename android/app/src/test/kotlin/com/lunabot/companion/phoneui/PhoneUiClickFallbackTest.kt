/*
 * Pins the click-retry judgement: outward, irreversible and toggle controls
 * are never retried by coordinates, and a coordinate retry only ever picks a
 * small clickable target under the point.
 */
package com.lunabot.companion.phoneui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PhoneUiClickFallbackTest {
    @Test
    fun `outward and irreversible labels are never retried`() {
        for (label in listOf(
            "发送", "提交", "支付", "删除", "确认", "确认订单", "立即支付 ¥1,299.00",
            "Send", "Send message to Alice", "Delete account", "Confirm order", "OK", "Done",
        )) {
            assertTrue(PhoneUiClickFallback.mayBeOutward(label, null), "label $label must be refused")
        }
    }

    @Test
    fun `toggle labels are never retried`() {
        for (label in listOf("关注", "已关注", "点赞(12)", "收藏", "静音", "Follow", "Liked", "Unfollow")) {
            assertTrue(PhoneUiClickFallback.mayBeOutward(label, null), "label $label must be refused")
        }
    }

    @Test
    fun `ordinary labels are retried`() {
        for (label in listOf("Wi-Fi", "Settings", "Next", "搜索", "打开", "第 3 项", null, "")) {
            assertFalse(PhoneUiClickFallback.mayBeOutward(label, null), "label $label must be allowed")
        }
    }

    @Test
    fun `outward view ids are refused`() {
        assertTrue(PhoneUiClickFallback.mayBeOutward(null, "com.example:id/send_button"))
        assertTrue(PhoneUiClickFallback.mayBeOutward("Next", "com.example:id/checkoutButton"))
        assertFalse(PhoneUiClickFallback.mayBeOutward(null, "com.example:id/title"))
        assertFalse(PhoneUiClickFallback.mayBeOutward(null, "com.example:id/list_item"))
    }

    @Test
    fun `the smallest target under the point wins`() {
        val screen = 1000 to 2000
        val fullScreen = candidate("container", 0, 0, 1000, 2000, scrollable = true)
        val row = candidate("row", 0, 0, 1000, 200)
        val icon = candidate("icon", 0, 0, 120, 120)
        val pick = PhoneUiClickFallback.pickTarget(
            x = 40, y = 40, screenWidth = screen.first, screenHeight = screen.second,
            candidates = listOf(fullScreen, row, icon),
        )
        assertEquals("icon", pick)
    }

    @Test
    fun `outward targets and oversized targets are skipped`() {
        val sendButton = candidate("send", 0, 0, 200, 200, label = "发送")
        val huge = candidate("huge", 0, 0, 1000, 900)
        val ok = candidate("ok", 0, 0, 100, 100)
        val pick = PhoneUiClickFallback.pickTarget(
            x = 50, y = 50, screenWidth = 1000, screenHeight = 2000,
            candidates = listOf(sendButton, huge, ok),
        )
        assertEquals("ok", pick)
        assertNull(
            PhoneUiClickFallback.pickTarget(50, 50, 1000, 2000, listOf(sendButton, huge)),
        )
    }

    @Test
    fun `nothing under the point means no retry`() {
        assertNull(
            PhoneUiClickFallback.pickTarget(
                x = 900, y = 1_900, screenWidth = 1000, screenHeight = 2000,
                candidates = listOf(candidate("row", 0, 0, 1000, 200)),
            ),
        )
    }

    private fun candidate(
        item: String,
        left: Int,
        top: Int,
        right: Int,
        bottom: Int,
        label: String? = null,
        scrollable: Boolean = false,
    ) = PhoneUiClickFallback.Candidate(item, left, top, right, bottom, label, null, scrollable)
}