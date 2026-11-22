/*
 * Pins the spill judgement: an app that opened on the person's own screen is
 * pulled back only when they are not the one driving, and a system picker is
 * never touched.
 */
package com.lunabot.companion.phoneui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class PhoneUiSpillTest {
    private val pickers = setOf("android", "com.google.android.documentsui")
    private val home = setOf("com.miui.home", "com.android.systemui")

    @Test
    fun `a normal app that arrived during the action is pulled back`() {
        val decision = PhoneUiSpill.decide(
            arrivals = listOf(PhoneUiSpill.Arrival(42, "com.example.shop", 1_000)),
            since = 500,
            topBefore = 7,
            userTouchedAt = null,
            excludedPackages = setOf("com.lunabot.companion"),
            pickerPackages = pickers,
            homePackages = home,
        )
        assertEquals(PhoneUiSpill.Verdict.PullBack, decision.verdict)
        assertEquals(42, decision.arrival?.taskId)
    }

    @Test
    fun `a system picker is left to the person`() {
        val decision = PhoneUiSpill.decide(
            arrivals = listOf(PhoneUiSpill.Arrival(43, "android", 1_000)),
            since = 500, topBefore = 7, userTouchedAt = null,
            excludedPackages = emptySet(), pickerPackages = pickers, homePackages = home,
        )
        assertEquals(PhoneUiSpill.Verdict.LeaveForUser, decision.verdict)
    }

    @Test
    fun `the person touching their own screen means they are driving`() {
        val decision = PhoneUiSpill.decide(
            arrivals = listOf(PhoneUiSpill.Arrival(44, "com.example.shop", 1_000)),
            since = 500, topBefore = 7, userTouchedAt = 900,
            excludedPackages = emptySet(), pickerPackages = pickers, homePackages = home,
        )
        assertEquals(PhoneUiSpill.Verdict.None, decision.verdict)
    }

    @Test
    fun `user activity just before the action makes the arrival too uncertain to pull back`() {
        // The touch count moved between actions, so the person was driving
        // even though no timestamped tap sits inside this window (#798).
        val decision = PhoneUiSpill.decide(
            arrivals = listOf(PhoneUiSpill.Arrival(49, "com.example.shop", 1_000)),
            since = 500, topBefore = 7, userTouchedAt = null,
            excludedPackages = emptySet(), pickerPackages = pickers, homePackages = home,
            userActiveBefore = true,
        )
        assertEquals(PhoneUiSpill.Verdict.None, decision.verdict)
        assertEquals(49, decision.arrival?.taskId)
    }

    @Test
    fun `user activity before the action quiets a picker arrival too`() {
        // Ownership is uncertain; either way there is nothing for us to do.
        val decision = PhoneUiSpill.decide(
            arrivals = listOf(PhoneUiSpill.Arrival(50, "android", 1_000)),
            since = 500, topBefore = 7, userTouchedAt = null,
            excludedPackages = emptySet(), pickerPackages = pickers, homePackages = home,
            userActiveBefore = true,
        )
        assertEquals(PhoneUiSpill.Verdict.None, decision.verdict)
    }

    @Test
    fun `the task that was already on top is not a spill`() {
        val decision = PhoneUiSpill.decide(
            arrivals = listOf(PhoneUiSpill.Arrival(7, "com.example.other", 1_000)),
            since = 500, topBefore = 7, userTouchedAt = null,
            excludedPackages = emptySet(), pickerPackages = pickers, homePackages = home,
        )
        assertEquals(PhoneUiSpill.Verdict.None, decision.verdict)
    }

    @Test
    fun `home and system ui are not pulled back`() {
        for (pkg in home) {
            val decision = PhoneUiSpill.decide(
                arrivals = listOf(PhoneUiSpill.Arrival(45, pkg, 1_000)),
                since = 500, topBefore = 7, userTouchedAt = null,
                excludedPackages = emptySet(), pickerPackages = pickers, homePackages = home,
            )
            assertEquals(PhoneUiSpill.Verdict.None, decision.verdict, "package $pkg")
        }
    }

    @Test
    fun `our own package is ignored`() {
        val decision = PhoneUiSpill.decide(
            arrivals = listOf(PhoneUiSpill.Arrival(46, "com.lunabot.companion", 1_000)),
            since = 500, topBefore = 7, userTouchedAt = null,
            excludedPackages = setOf("com.lunabot.companion"),
            pickerPackages = pickers, homePackages = home,
        )
        assertEquals(PhoneUiSpill.Verdict.None, decision.verdict)
    }

    @Test
    fun `an arrival outside the window is ignored`() {
        val decision = PhoneUiSpill.decide(
            arrivals = listOf(PhoneUiSpill.Arrival(47, "com.example.shop", 9_000)),
            since = 500, topBefore = 7, userTouchedAt = null,
            excludedPackages = emptySet(), pickerPackages = pickers, homePackages = home,
        )
        assertEquals(PhoneUiSpill.Verdict.None, decision.verdict)
    }

    @Test
    fun `no arrival is nothing`() {
        val decision = PhoneUiSpill.decide(
            arrivals = emptyList(), since = 500, topBefore = 7, userTouchedAt = null,
            excludedPackages = emptySet(), pickerPackages = pickers, homePackages = home,
        )
        assertEquals(PhoneUiSpill.Verdict.None, decision.verdict)
        assertNull(decision.arrival)
    }

    @Test
    fun `an arrival without a package cannot be judged`() {
        val decision = PhoneUiSpill.decide(
            arrivals = listOf(PhoneUiSpill.Arrival(48, null, 1_000)),
            since = 500, topBefore = 7, userTouchedAt = null,
            excludedPackages = emptySet(), pickerPackages = pickers, homePackages = home,
        )
        assertEquals(PhoneUiSpill.Verdict.None, decision.verdict)
    }
}