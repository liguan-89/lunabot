package com.lunabot.companion.phone

import com.lunabot.companion.core.PhoneNoticeEvent
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The notification repost dedup is a two-minute window, not an unbounded LRU. */
class NoticePostDedupTest {

    private fun event(key: String): PhoneNoticeEvent = PhoneNoticeEvent(
        key = key,
        packageName = "com.chat.app",
        postedAtMs = 1_000L,
        title = "Alex",
        text = "到了吗",
    )

    @Test
    fun `an identical repost is dropped inside the window and delivered after it`() {
        val event = event("dedupe-window-test")
        try {
            assertTrue(NoticeRelay.NoticePostDedup.noteAt(event, 1_000L))
            assertFalse(NoticeRelay.NoticePostDedup.noteAt(event, 60_000L))
            assertTrue(NoticeRelay.NoticePostDedup.noteAt(event, 122_000L))
        } finally {
            NoticeRelay.NoticePostDedup.forget(event)
        }
    }

    @Test
    fun `forget withdraws the claim entirely`() {
        val event = event("dedupe-forget-test")
        try {
            assertTrue(NoticeRelay.NoticePostDedup.noteAt(event, 1_000L))
            NoticeRelay.NoticePostDedup.forget(event)
            assertTrue(NoticeRelay.NoticePostDedup.noteAt(event, 2_000L))
        } finally {
            NoticeRelay.NoticePostDedup.forget(event)
        }
    }
}
