/*
 * Pins the verdict logic behind the self-check probes: the permissions
 * decision from its four grants, the helper's attached/round-trip states, the
 * virtual display's created/not-created answer at each Android level, and the
 * person's display read from its fingerprint. The system reads themselves are
 * not tested here — only the decisions they feed.
 */
package com.openmausbot.companion.phoneui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PhoneUiProbesTest {
    private fun facts(
        sdk: Int = 34,
        release: String = "14",
        wirelessDebugging: Boolean? = true,
    ): PhoneUiDeviceFacts = PhoneUiDeviceFacts(
        manufacturer = "Google",
        model = "Pixel 8",
        androidRelease = release,
        sdk = sdk,
        abis = listOf("arm64-v8a"),
        ramBytes = 8L * 1024 * 1024 * 1024,
        screenWidth = 1080,
        screenHeight = 2400,
        wirelessDebugging = wirelessDebugging,
        appVersion = "2.1.0",
        appBuild = "20100",
    )

    // MARK: - DEVICE

    @Test
    fun `the device row keeps the judge's verdict and adds the model, version and helper state`() {
        val attached = judgeDeviceWithHelper(facts(), helperAttached = true)
        assertEquals(ProbeStatus.Pass, attached.status)
        assertTrue(attached.detail.contains("Google Pixel 8"), attached.detail)
        assertTrue(attached.detail.contains("app 2.1.0"), attached.detail)
        assertTrue(attached.detail.endsWith("helper attached"), attached.detail)

        val detached = judgeDeviceWithHelper(facts(), helperAttached = false)
        assertEquals(ProbeStatus.Pass, detached.status, "a detached helper is HELPER's row, not the phone's")
        assertTrue(detached.detail.endsWith("helper not attached"), detached.detail)
    }

    @Test
    fun `the model name does not repeat the manufacturer`() {
        assertEquals("Pixel 8", facts().copy(manufacturer = "Pixel", model = "Pixel 8").modelName)
        assertEquals("Google Pixel 8", facts().modelName)
    }

    @Test
    fun `an old phone fails the device row whatever the helper says`() {
        val outcome = judgeDeviceWithHelper(facts(sdk = 29, release = "10"), helperAttached = true)
        assertEquals(ProbeStatus.Fail, outcome.status)
        assertTrue(outcome.detail.contains("SDK 29"), outcome.detail)
        assertEquals(PhoneUiDeviceFacts.MIN_PHONE_SDK - 1, 29)
    }

    @Test
    fun `missing wireless debugging is a pass that says USB only`() {
        val outcome = judgeDeviceWithHelper(facts(wirelessDebugging = false), helperAttached = true)
        assertEquals(ProbeStatus.Pass, outcome.status)
        assertTrue(outcome.detail.contains("wireless debugging missing"), outcome.detail)
    }

    // MARK: - PERMISSIONS

    @Test
    fun `all four grants is a pass that names each one`() {
        val outcome = judgePermissions(
            accessibilityEnabled = true,
            accessibilityBound = true,
            notificationAccess = true,
            batteryExempt = true,
        )
        assertEquals(ProbeStatus.Pass, outcome.status)
        assertEquals(
            "accessibility on and bound, notification access granted, battery optimisation exempt",
            outcome.detail,
        )
        assertNull(outcome.fix)
    }

    @Test
    fun `a service listed but not bound is its own failure`() {
        val outcome = judgePermissions(
            accessibilityEnabled = true,
            accessibilityBound = false,
            notificationAccess = true,
            batteryExempt = true,
        )
        assertEquals(ProbeStatus.Fail, outcome.status)
        assertTrue(outcome.detail.contains("listed but not running"), outcome.detail)
        assertTrue(outcome.fix.orEmpty().contains("off and on again"), outcome.fix.orEmpty())
    }

    @Test
    fun `accessibility off is named first even when the other grants are missing`() {
        val outcome = judgePermissions(
            accessibilityEnabled = false,
            accessibilityBound = false,
            notificationAccess = false,
            batteryExempt = false,
        )
        assertEquals(ProbeStatus.Fail, outcome.status)
        assertTrue(outcome.detail.contains("screen reading is off"), outcome.detail)
        // The other two still appear, so one run answers all three.
        assertTrue(outcome.detail.contains("notification access not granted"), outcome.detail)
        assertTrue(outcome.detail.contains("battery optimisation not exempt"), outcome.detail)
    }

    @Test
    fun `missing notification access and a restricted battery each fail with their own fix`() {
        val notifications = judgePermissions(true, true, notificationAccess = false, batteryExempt = true)
        assertEquals(ProbeStatus.Fail, notifications.status)
        assertTrue(notifications.fix.orEmpty().contains("Notification access"), notifications.fix.orEmpty())

        val battery = judgePermissions(true, true, notificationAccess = true, batteryExempt = false)
        assertEquals(ProbeStatus.Fail, battery.status)
        assertTrue(battery.fix.orEmpty().contains("battery optimisation"), battery.fix.orEmpty())
    }

    // MARK: - HELPER

    @Test
    fun `the helper row reports attached with the round trip it measured`() {
        val outcome = judgeHelper(attached = true, roundTripMs = 7L)
        assertEquals(ProbeStatus.Pass, outcome.status)
        assertTrue(outcome.detail.contains("one round trip took 7 ms"), outcome.detail)
    }

    @Test
    fun `a detached helper and a failed round trip are different failures`() {
        val detached = judgeHelper(attached = false, roundTripMs = null)
        assertEquals(ProbeStatus.Fail, detached.status)
        assertTrue(detached.detail.contains("not attached"), detached.detail)

        val silent = judgeHelper(attached = true, roundTripMs = null)
        assertEquals(ProbeStatus.Fail, silent.status)
        assertTrue(silent.detail.contains("round trip failed"), silent.detail)
    }

    // MARK: - VIRTUAL DISPLAY

    @Test
    fun `a display that could not be created fails the row`() {
        val outcome = judgeVirtualDisplay(created = false, sdk = 34)
        assertEquals(ProbeStatus.Fail, outcome.status)
        assertTrue(outcome.fix.orEmpty().contains("Re-pair"), outcome.fix.orEmpty())
    }

    @Test
    fun `from Android 14 the row says own focus is the helper's choice`() {
        val modern = judgeVirtualDisplay(created = true, sdk = PhoneUiDeviceFacts.OWN_FOCUS_SDK)
        assertEquals(ProbeStatus.Pass, modern.status)
        assertTrue(modern.detail.contains("own focus"), modern.detail)

        val older = judgeVirtualDisplay(created = true, sdk = PhoneUiDeviceFacts.OWN_FOCUS_SDK - 1)
        assertEquals(ProbeStatus.Pass, older.status)
        assertTrue(!older.detail.contains("own focus"), older.detail)
    }

    // MARK: - MAIN SCREEN

    @Test
    fun `a readable main display passes with its node count`() {
        val outcome = judgeMainScreen("42:ff00aa")
        assertEquals(ProbeStatus.Pass, outcome.status)
        assertTrue(outcome.detail.contains("42 nodes"), outcome.detail)
    }

    @Test
    fun `an unbound service, an old Android and an empty screen are three different answers`() {
        val unbound = judgeMainScreen(null)
        assertEquals(ProbeStatus.Fail, unbound.status)
        assertTrue(unbound.detail.contains("not bound"), unbound.detail)

        val old = judgeMainScreen("unsupported")
        assertEquals(ProbeStatus.Fail, old.status)
        assertTrue(old.detail.contains("per display"), old.detail)

        val empty = judgeMainScreen("0:0")
        assertEquals(ProbeStatus.Fail, empty.status)
        assertTrue(empty.fix.orEmpty().contains("Unlock the phone"), empty.fix.orEmpty())
    }
}
