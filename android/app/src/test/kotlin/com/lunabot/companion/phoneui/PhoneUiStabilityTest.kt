/*
 * Pins the stability wait used after every phone-UI action: a change is only
 * reported once the screen is quiet, an unchanged screen is reported at the
 * cap, and a page that never goes quiet cannot hold an action forever.
 */
package com.lunabot.companion.phoneui

import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PhoneUiStabilityTest {
    @Test
    fun `a quiet change is reported as soon as it is quiet`() = runBlocking {
        var now = 0L
        var index = 0
        val readings = listOf(
            PhoneUiStability.Reading("a", 0),
            PhoneUiStability.Reading("b", 0),
            PhoneUiStability.Reading("b", 500),
        )
        val changed = PhoneUiStability.awaitChange(
            now = { now },
            sleep = { now += it },
            read = { readings[minOf(index++, readings.lastIndex)] },
            before = "a",
        )
        assertTrue(changed)
    }

    @Test
    fun `an unchanged screen is reported false at the cap`() = runBlocking {
        var now = 0L
        val changed = PhoneUiStability.awaitChange(
            now = { now },
            sleep = { now += it },
            read = { PhoneUiStability.Reading("a", 500) },
            before = "a",
        )
        assertFalse(changed)
        assertEquals(PhoneUiStability.CAP_MS, now)
    }

    @Test
    fun `a change that never goes quiet still counts at the cap`() = runBlocking {
        var now = 0L
        val changed = PhoneUiStability.awaitChange(
            now = { now },
            sleep = { now += it },
            read = { PhoneUiStability.Reading("b", 0) },
            before = "a",
        )
        assertTrue(changed)
    }

    @Test
    fun `a slower cap is honoured`() = runBlocking {
        var now = 0L
        val changed = PhoneUiStability.awaitChange(
            now = { now },
            sleep = { now += it },
            read = { PhoneUiStability.Reading("a", 500) },
            before = "a",
            capMs = 400,
        )
        assertFalse(changed)
        assertEquals(400L, now)
    }

    @Test
    fun `settle returns once the tree holds still`() = runBlocking {
        var now = 0L
        val settled = PhoneUiStability.awaitSettled(
            now = { now },
            sleep = { now += it },
            read = { PhoneUiStability.Reading("a", 500) },
            timeoutMs = 2_000,
        )
        assertEquals("a", settled)
        assertTrue(now < 2_000, "settle must not wait for the timeout when the tree is stable")
    }

    @Test
    fun `settle gives up at its timeout on a tree that keeps changing`() = runBlocking {
        var now = 0L
        var tick = 0
        val settled = PhoneUiStability.awaitSettled(
            now = { now },
            sleep = { now += it },
            read = { PhoneUiStability.Reading(if (tick++ % 2 == 0) "a" else "b", 500) },
            timeoutMs = 600,
        )
        assertTrue(settled == "a" || settled == "b")
        assertEquals(600L, now)
    }
}