package com.lunabot.companion.ui

import com.lunabot.companion.core.InboxParty
import com.lunabot.companion.core.InboxRowLine
import com.lunabot.companion.core.NotificationLogRow
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NotificationRulesTest {

    @Test
    fun `a row waits in step with the desktop count semantics`() {
        // needs-you 全部等待；info 只有未读等待；done 永远不等。
        assertTrue(NotificationRules.inboxRowWaits(inboxRow(tab = "needs-you", unread = false)))
        assertTrue(NotificationRules.inboxRowWaits(inboxRow(tab = "needs-you", unread = true)))
        assertTrue(NotificationRules.inboxRowWaits(inboxRow(tab = "info", unread = true)))
        assertFalse(NotificationRules.inboxRowWaits(inboxRow(tab = "info", unread = false)))
        assertFalse(NotificationRules.inboxRowWaits(inboxRow(tab = "done", unread = true)))
        // 未来新的 tab 类型不当成等待——徽章宁可少说。
        assertFalse(NotificationRules.inboxRowWaits(inboxRow(tab = "some-future-tab", unread = true)))
    }

    @Test
    fun `the inbox row title carries the hand-off`() {
        assertEquals("Luna", NotificationRules.inboxRowTitle(inboxRow(from = "Luna")))
        assertEquals(
            "Luna · 为 Boss 工作",
            NotificationRules.inboxRowTitle(inboxRow(from = "Luna", workingFor = "Boss")),
        )
        // 名字缺失行不能是空白。
        assertEquals("智能体", NotificationRules.inboxRowTitle(inboxRow(from = "")))
    }

    @Test
    fun `the notification detail joins bot and body`() {
        assertEquals(
            "Luna · 跑完了巡检",
            NotificationRules.notificationDetail(notification(botName = "Luna", body = "跑完了巡检")),
        )
        assertEquals("跑完了巡检", NotificationRules.notificationDetail(notification(botName = "", body = "跑完了巡检")))
        assertEquals("Luna", NotificationRules.notificationDetail(notification(botName = "Luna", body = "")))
        assertEquals("", NotificationRules.notificationDetail(notification(botName = "", body = "")))
    }

    private fun inboxRow(
        tab: String = "info",
        unread: Boolean = false,
        from: String = "Luna",
        workingFor: String? = null,
    ) = InboxRowLine(
        id = "l-1",
        kind = "message",
        tab = tab,
        from = InboxParty(name = from),
        at = 1,
        unread = unread,
        workingFor = workingFor?.let { InboxParty(name = it) },
    )

    private fun notification(botName: String, body: String) = NotificationLogRow(
        id = "n-1",
        at = 1,
        kind = "done",
        botName = botName,
        body = body,
    )
}
