/*
 * Pins the helper's own-display, key-whitelist, display-flag and stroke
 * rules. The whitelist is the security invariant: no key outside navigation
 * and editing may leave the helper, and no display flag combination may
 * include trust flags in a non-trusted retry.
 */
package com.lunabot.companion.phoneui.shell

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PhoneUiShellPolicyTest {
    // KEYCODE constants, inlined to keep this suite free of Android runtime.
    private val back = 4
    private val dpadUp = 19
    private val dpadDown = 20
    private val dpadLeft = 21
    private val dpadRight = 22
    private val tab = 61
    private val enter = 66
    private val del = 67
    private val forwardDel = 112

    @Test
    fun `the whitelist is exactly back, enter, tab, arrows and delete`() {
        assertEquals(
            setOf(back, dpadUp, dpadDown, dpadLeft, dpadRight, tab, enter, del, forwardDel),
            PhoneUiPolicy.ALLOWED_KEYS,
        )
    }

    @Test
    fun `every whitelisted key passes`() {
        for (key in PhoneUiPolicy.ALLOWED_KEYS) {
            assertTrue(PhoneUiPolicy.isKeyAllowed(key), "key $key must be allowed")
        }
    }

    @Test
    fun `whole-phone keys are refused`() {
        val home = 3
        val volumeUp = 24
        val volumeDown = 25
        val power = 26
        val sleep = 223
        val wakeup = 224
        val recents = 187
        val menu = 82
        val mediaPlayPause = 85
        val camera = 27
        val search = 84
        for (key in listOf(home, volumeUp, volumeDown, power, sleep, wakeup, recents, menu, mediaPlayPause, camera, search)) {
            assertFalse(PhoneUiPolicy.isKeyAllowed(key), "key $key must be refused")
        }
    }

    @Test
    fun `negative, zero and garbage key codes are refused`() {
        for (key in listOf(-1, 0, 1000, Int.MIN_VALUE, Int.MAX_VALUE)) {
            assertFalse(PhoneUiPolicy.isKeyAllowed(key))
        }
    }

    @Test
    fun `trusted flags add nothing and untrusted flags never carry trust bits`() {
        val sdk34Untrusted = PhoneUiPolicy.displayFlags(34, trusted = false)
        val sdk34Trusted = PhoneUiPolicy.displayFlags(34, trusted = true)
        // FLAG_TRUSTED = 1 shl 10, FLAG_OWN_DISPLAY_GROUP = 1 shl 11,
        // FLAG_ALWAYS_UNLOCKED = 1 shl 12, FLAG_OWN_FOCUS = 1 shl 14,
        // FLAG_STEAL_TOP_FOCUS_DISABLED = 1 shl 16.
        for (bit in listOf(1 shl 10, 1 shl 11, 1 shl 12, 1 shl 14, 1 shl 16)) {
            assertTrue(sdk34Trusted and bit != 0)
            assertEquals(0, sdk34Untrusted and bit, "the SecurityException retry must drop trust flag $bit")
        }
        // The non-trust flags are a subset of the trusted set, and the delta
        // between the two is exactly the trust flags.
        assertEquals(0, sdk34Untrusted and sdk34Trusted.inv())
        val trustBits = (1 shl 10) or (1 shl 11) or (1 shl 12) or (1 shl 14) or (1 shl 16)
        assertEquals(0, (sdk34Trusted xor sdk34Untrusted) and trustBits.inv())
    }

    @Test
    fun `below treble there are no trust flags to add`() {
        val flags = PhoneUiPolicy.displayFlags(28, trusted = true)
        assertEquals(0, flags and (1 shl 10))
        assertEquals(0, flags and (1 shl 11))
        assertEquals(0, flags and (1 shl 13))
    }

    @Test
    fun `only a SecurityException earns a non-trusted retry`() {
        assertTrue(PhoneUiPolicy.retryWithoutTrust(SecurityException("ADD_TRUSTED_DISPLAY")))
        assertFalse(PhoneUiPolicy.retryWithoutTrust(IllegalArgumentException("bad size")))
        assertFalse(PhoneUiPolicy.retryWithoutTrust(RuntimeException("boom")))
    }

    @Test
    fun `keys wait for a result, touches do not`() {
        assertEquals(1, PhoneUiPolicy.injectMode(key = true, waitForFinish = false))
        assertEquals(0, PhoneUiPolicy.injectMode(key = false, waitForFinish = false))
        assertEquals(2, PhoneUiPolicy.injectMode(key = true, waitForFinish = true))
    }

    @Test
    fun `a valid stroke has a press, a lift and a budget`() {
        assertTrue(PhoneUiPolicy.strokeValid(intArrayOf(1, 2, 3), intArrayOf(4, 5, 6), longArrayOf(0, 50, 100)))
        assertTrue(PhoneUiPolicy.strokeValid(intArrayOf(0, 0), intArrayOf(0, 0), longArrayOf(0, PhoneUiPolicy.STROKE_MAX_MS)))
    }

    @Test
    fun `degenerate strokes are refused`() {
        // Fewer than two points: no lift.
        assertFalse(PhoneUiPolicy.strokeValid(intArrayOf(1), intArrayOf(2), longArrayOf(0)))
        // Array length mismatch.
        assertFalse(PhoneUiPolicy.strokeValid(intArrayOf(1, 2), intArrayOf(4), longArrayOf(0, 10)))
        // First time must be zero (it is the press).
        assertFalse(PhoneUiPolicy.strokeValid(intArrayOf(1, 2), intArrayOf(4, 5), longArrayOf(10, 20)))
        // Times must not go backwards.
        assertFalse(PhoneUiPolicy.strokeValid(intArrayOf(1, 2, 3), intArrayOf(4, 5, 6), longArrayOf(0, 50, 40)))
        // Over the duration budget.
        assertFalse(PhoneUiPolicy.strokeValid(intArrayOf(1, 2), intArrayOf(4, 5), longArrayOf(0, PhoneUiPolicy.STROKE_MAX_MS + 1)))
        // Over the point budget.
        val n = PhoneUiPolicy.STROKE_MAX_POINTS + 1
        assertFalse(PhoneUiPolicy.strokeValid(IntArray(n) { 0 }, IntArray(n) { 0 }, LongArray(n) { 0L }))
    }
}
