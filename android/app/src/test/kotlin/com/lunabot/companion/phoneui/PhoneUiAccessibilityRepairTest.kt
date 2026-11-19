/*
 * Pins the accessibility repair rules: a listed-but-dead service is repaired
 * by rewriting the list, a service the person disabled is never written back,
 * the repair waits out a grace period and backs off between attempts, and the
 * list parsing only ever adds our component — every other accessibility
 * service on the phone stays exactly where it was.
 */
package com.lunabot.companion.phoneui

import com.lunabot.companion.phoneui.PhoneUiAccessibilityRepair.A11yObservation
import com.lunabot.companion.phoneui.PhoneUiAccessibilityRepair.Decision
import com.lunabot.companion.phoneui.PhoneUiAccessibilityRepair.RepairState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PhoneUiAccessibilityRepairTest {
    private val ours = "com.lunabot.companion/.phoneui.PhoneUiAccessibilityService"
    private val other = "com.example.helper/.TalkService"

    private val dead = A11yObservation(enabled = true, connected = false)
    private val alive = A11yObservation(enabled = true, connected = true)
    private val disabled = A11yObservation(enabled = false, connected = false)

    @Test
    fun `an empty setting becomes just our component`() {
        assertEquals(ours, PhoneUiAccessibilityRepair.settingWith(null, ours))
        assertEquals(ours, PhoneUiAccessibilityRepair.settingWith("", ours))
        assertEquals(ours, PhoneUiAccessibilityRepair.settingWith("   ", ours))
        assertEquals(ours, PhoneUiAccessibilityRepair.settingWith("null", ours))
    }

    @Test
    fun `a setting with one other service keeps it and appends ours`() {
        assertEquals("$other:$ours", PhoneUiAccessibilityRepair.settingWith(other, ours))
    }

    @Test
    fun `a setting that already has ours is idempotent`() {
        val setting = "$other:$ours"
        assertEquals(setting, PhoneUiAccessibilityRepair.settingWith(setting, ours))
        assertEquals(setting, PhoneUiAccessibilityRepair.settingWith(setting, ours))
        assertEquals(2, PhoneUiAccessibilityRepair.entries(PhoneUiAccessibilityRepair.settingWith(setting, ours)).size)
    }

    @Test
    fun `the short and full class forms are the same component`() {
        val full = "com.lunabot.companion/com.lunabot.companion.phoneui.PhoneUiAccessibilityService"
        assertEquals(full, PhoneUiAccessibilityRepair.settingWith(full, ours))
        assertEquals(ours, PhoneUiAccessibilityRepair.settingWith(ours, full))
        assertTrue(PhoneUiAccessibilityRepair.contains(full, ours))
        assertTrue(PhoneUiAccessibilityRepair.contains(ours, full))
    }

    @Test
    fun `removing ours never removes another service`() {
        val setting = "$other:$ours:com.third/.Reader"
        assertEquals("$other:com.third/.Reader", PhoneUiAccessibilityRepair.settingWithout(setting, ours))
    }

    @Test
    fun `removing the only entry leaves an empty string for the caller to delete`() {
        assertEquals("", PhoneUiAccessibilityRepair.settingWithout(ours, ours))
        val state = PhoneUiAccessibilityRepair.observe(RepairState(), dead, nowMs = 0)
        val decision = PhoneUiAccessibilityRepair.decide(
            dead,
            ours,
            ours,
            state,
            nowMs = PhoneUiAccessibilityRepair.GRACE_MS,
        )
        assertIs<Decision.Write>(decision)
        assertEquals(ours, decision.setting)
        assertEquals("", decision.remove)
    }

    @Test
    fun `entries drop empties and keep the colon separator`() {
        assertEquals(listOf("a", "b"), PhoneUiAccessibilityRepair.entries(" a :: b "))
        assertEquals(emptyList(), PhoneUiAccessibilityRepair.entries(null))
        assertEquals(emptyList(), PhoneUiAccessibilityRepair.entries("null"))
    }

    @Test
    fun `a bound service needs no write`() {
        assertNull(PhoneUiAccessibilityRepair.settingToWrite(alive, null, ours))
        assertEquals(Decision.Healthy, PhoneUiAccessibilityRepair.decide(alive, null, ours, RepairState(), 1_000))
    }

    @Test
    fun `a service the person disabled is never written back`() {
        assertNull(PhoneUiAccessibilityRepair.settingToWrite(disabled, "$other:$ours", ours))
        assertEquals(Decision.NeedsPerson, PhoneUiAccessibilityRepair.decide(disabled, "$other:$ours", ours, RepairState(), 1_000))
    }

    @Test
    fun `a listed but dead service is removed and re-added`() {
        val setting = "$other:$ours"
        val state = PhoneUiAccessibilityRepair.observe(RepairState(), dead, nowMs = 0)
        val decision = PhoneUiAccessibilityRepair.decide(
            dead,
            setting,
            ours,
            state,
            nowMs = PhoneUiAccessibilityRepair.GRACE_MS,
        )
        assertIs<Decision.Write>(decision)
        assertEquals(setting, decision.setting)
        assertEquals(other, decision.remove, "the repair rewrites the list without us first")
    }

    @Test
    fun `a dead service missing from the list is added without a removal`() {
        val state = PhoneUiAccessibilityRepair.observe(RepairState(), dead, nowMs = 0)
        val decision = PhoneUiAccessibilityRepair.decide(
            dead,
            other,
            ours,
            state,
            nowMs = PhoneUiAccessibilityRepair.GRACE_MS,
        )
        assertIs<Decision.Write>(decision)
        assertEquals("$other:$ours", decision.setting)
        assertNull(decision.remove)
    }

    @Test
    fun `the grace period comes before the first write`() {
        val state = PhoneUiAccessibilityRepair.observe(RepairState(), dead, nowMs = 0)
        val decision = PhoneUiAccessibilityRepair.decide(dead, other, ours, state, nowMs = 1_000)
        assertIs<Decision.Wait>(decision)
        assertEquals(PhoneUiAccessibilityRepair.GRACE_MS - 1_000, decision.ms)
    }

    @Test
    fun `backoff prevents a second write inside its window and allows one after`() {
        var state = PhoneUiAccessibilityRepair.observe(RepairState(), dead, nowMs = 0)

        val first = PhoneUiAccessibilityRepair.decide(dead, other, ours, state, nowMs = 3_000)
        assertIs<Decision.Write>(first)
        state = PhoneUiAccessibilityRepair.attempted(state, atMs = 3_000, restored = false)
        assertEquals(1, state.failures)

        val insideWindow = PhoneUiAccessibilityRepair.decide(dead, other, ours, state, nowMs = 5_000)
        assertIs<Decision.Wait>(insideWindow)
        assertEquals(PhoneUiAccessibilityRepair.BACKOFF_MS - 2_000, insideWindow.ms)

        val afterWindow = PhoneUiAccessibilityRepair.decide(dead, other, ours, state, nowMs = 8_000)
        assertIs<Decision.Write>(afterWindow)
    }

    @Test
    fun `MAX_ATTEMPTS failures end the episode with GaveUp`() {
        var state = PhoneUiAccessibilityRepair.observe(RepairState(), dead, nowMs = 0)
        repeat(PhoneUiAccessibilityRepair.MAX_ATTEMPTS) { index ->
            state = PhoneUiAccessibilityRepair.attempted(
                state,
                atMs = 3_000L + index * 10_000L,
                restored = false,
            )
        }
        val decision = PhoneUiAccessibilityRepair.decide(dead, other, ours, state, nowMs = 100_000)
        assertEquals(Decision.GaveUp, decision)
    }

    @Test
    fun `a service that comes back resets the episode`() {
        var state = PhoneUiAccessibilityRepair.observe(RepairState(), dead, nowMs = 0)
        state = PhoneUiAccessibilityRepair.attempted(state, atMs = 3_000, restored = false)
        assertEquals(1, state.failures)

        val restored = PhoneUiAccessibilityRepair.observe(state, alive, nowMs = 20_000)
        assertEquals(RepairState(), restored)

        val afterRestore = PhoneUiAccessibilityRepair.attempted(state, atMs = 20_000, restored = true)
        assertEquals(RepairState(), afterRestore)
    }

    @Test
    fun `turning the service off ends the episode too`() {
        val state = PhoneUiAccessibilityRepair.observe(RepairState(), dead, nowMs = 0)
        assertEquals(RepairState(), PhoneUiAccessibilityRepair.observe(state, disabled, nowMs = 10_000))
    }
}
