/*
 * Pins PHONE_UI_WAIT's text conditions: appear is met when the text or
 * description is on the screen, disappear when it is not, the match is the
 * case-insensitive substring PHONE_UI_QUERY uses, an unmet wait answers false
 * exactly at its budget, and a wait that meets on a later poll stops there
 * rather than at the timeout. No Android: the clock, the sleep and the screen
 * reads are plain lambdas here.
 */
package com.openmausbot.companion.phoneui

import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PhoneUiWaitTest {
    private fun element(
        ref: String = "e1",
        text: String? = null,
        description: String? = null,
        viewId: String? = null,
    ) = PhoneUiElement(
        ref = ref,
        viewId = viewId,
        className = "android.widget.TextView",
        text = text,
        description = description,
        bounds = listOf(0, 0, 100, 100),
        clickable = false,
        editable = false,
        scrollable = false,
        password = false,
    )

    // MARK: - The condition itself

    @Test
    fun `appear is met when the text is on the screen`() {
        val screen = listOf(element(text = "Saved to your library"))
        assertTrue(PhoneUiWait.isMet(screen, "appear", "Saved"))
        assertFalse(PhoneUiWait.isMet(screen, "disappear", "Saved"))
    }

    @Test
    fun `appear is not met when the text is absent`() {
        val screen = listOf(element(text = "Inbox"))
        assertFalse(PhoneUiWait.isMet(screen, "appear", "Saved"))
        assertTrue(PhoneUiWait.isMet(screen, "disappear", "Saved"))
    }

    @Test
    fun `a content description counts as text`() {
        val screen = listOf(element(text = null, description = "Close dialog"))
        assertTrue(PhoneUiWait.isMet(screen, "appear", "close dialog"))
        assertFalse(PhoneUiWait.isMet(screen, "disappear", "close dialog"))
    }

    @Test
    fun `the match is case-insensitive and a substring`() {
        val screen = listOf(element(text = "CONNECTION LOST, retrying"))
        assertTrue(PhoneUiWait.textMatches(screen.single(), "connection lost"))
        assertTrue(PhoneUiWait.textMatches(screen.single(), "retry"))
        assertFalse(PhoneUiWait.textMatches(screen.single(), "connected"))
    }

    @Test
    fun `a password field's silence is not a match`() {
        // The snapshot never carries a password field's text, so an appear on
        // one can only be met by something else on the screen.
        val screen = listOf(element(text = null, description = null))
        assertFalse(PhoneUiWait.isMet(screen, "appear", "secret"))
        assertTrue(PhoneUiWait.isMet(screen, "disappear", "secret"))
    }

    // MARK: - The wait

    @Test
    fun `a condition already true costs no poll`() = runBlocking {
        var now = 0L
        var reads = 0
        val met = PhoneUiWait.await(
            mode = "appear",
            text = "Done",
            timeoutMs = 2_500,
            now = { now },
            sleep = { now += it },
            read = { reads++; listOf(element(text = "Done")) },
        )
        assertEquals(true, met)
        assertEquals(1, reads)
        assertEquals(0L, now)
    }

    @Test
    fun `a wait that meets on the second poll stops there`() = runBlocking {
        var now = 0L
        var reads = 0
        val met = PhoneUiWait.await(
            mode = "appear",
            text = "Uploaded",
            timeoutMs = 2_500,
            now = { now },
            sleep = { now += it },
            read = {
                reads++
                if (reads < 2) listOf(element(text = "Uploading…")) else listOf(element(text = "Uploaded"))
            },
        )
        assertEquals(true, met)
        assertEquals(2, reads)
        // One poll interval, not the whole budget.
        assertEquals(PhoneUiWait.POLL_MS, now)
    }

    @Test
    fun `an unmet wait answers false exactly at its budget`() = runBlocking {
        var now = 0L
        var reads = 0
        val met = PhoneUiWait.await(
            mode = "disappear",
            text = "Saving…",
            timeoutMs = 900,
            now = { now },
            sleep = { now += it },
            read = { reads++; listOf(element(text = "Saving…")) },
        )
        assertEquals(false, met)
        assertEquals(900L, now, "the wait must not run past timeoutMs")
        // 900 ms at the 150 ms cadence is six polls plus the deadline read.
        assertEquals(7, reads)
    }

    @Test
    fun `a short budget is still polled, not busy-looped`() = runBlocking {
        var now = 0L
        val sleeps = mutableListOf<Long>()
        val met = PhoneUiWait.await(
            mode = "appear",
            text = "Late",
            timeoutMs = 100,
            now = { now },
            sleep = { sleeps += it; now += it },
            read = { listOf(element(text = "Early")) },
        )
        assertEquals(false, met)
        assertEquals(100L, now)
        assertTrue(sleeps.all { it > 0 }, "every sleep is positive: $sleeps")
        assertTrue(sleeps.sumOf { it } == 100L)
    }

    @Test
    fun `an unreadable screen is a refusal, not an unmet wait`() = runBlocking {
        var now = 0L
        val met = PhoneUiWait.await(
            mode = "appear",
            text = "Anything",
            timeoutMs = 2_500,
            now = { now },
            sleep = { now += it },
            read = { null },
        )
        assertNull(met, "a null snapshot is refused before the budget is spent")
        assertEquals(0L, now)
    }
}
