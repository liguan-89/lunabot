/*
 * Pins the verdict logic behind the self-check probes: the permissions
 * decision from its four grants, the helper's attached/round-trip states, the
 * virtual display's created/not-created answer at each Android level, the
 * person's display read from its fingerprint, and the seven display-driving
 * probes' verdicts from the observation each one made. The system reads
 * themselves are not tested here — only the decisions they feed; the probe
 * paths, including the release of every display, are in
 * PhoneUiProbesProbeTest.kt.
 */
package com.lunabot.companion.phoneui

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

    // MARK: - APP LAUNCH

    @Test
    fun `an app that reaches the top of the helper display passes`() {
        val outcome = judgeAppLaunch(
            helperAttached = true,
            displayOpened = true,
            launchCode = LAUNCH_OK,
            topPackage = BENIGN_APP_PACKAGE,
            app = BENIGN_APP_PACKAGE,
        )
        assertEquals(ProbeStatus.Pass, outcome.status)
        assertTrue(outcome.detail.contains("launched on the helper's display"), outcome.detail)
    }

    @Test
    fun `an app already on the person's screen is a failure with the reason to close it`() {
        val outcome = judgeAppLaunch(true, true, LAUNCH_IN_USE, null, BENIGN_APP_PACKAGE)
        assertEquals(ProbeStatus.Fail, outcome.status)
        assertTrue(outcome.detail.contains("person's screen"), outcome.detail)
        assertTrue(outcome.fix.orEmpty().contains("Close"), outcome.fix.orEmpty())
    }

    @Test
    fun `a launch with no app, no display, a missing entry or an error each fail differently`() {
        val noApp = judgeAppLaunch(true, true, LAUNCH_OK, BENIGN_APP_PACKAGE, app = null)
        assertEquals(ProbeStatus.Fail, noApp.status)
        assertTrue(noApp.detail.contains("no app with a launcher entry"), noApp.detail)

        val noDisplay = judgeAppLaunch(true, false, LAUNCH_OK, null, BENIGN_APP_PACKAGE)
        assertEquals(ProbeStatus.Fail, noDisplay.status)
        assertTrue(noDisplay.detail.contains("could not create a display"), noDisplay.detail)

        val noEntry = judgeAppLaunch(true, true, LAUNCH_NO_ENTRY, null, BENIGN_APP_PACKAGE)
        assertEquals(ProbeStatus.Fail, noEntry.status)
        assertTrue(noEntry.detail.contains("no launcher entry"), noEntry.detail)

        val error = judgeAppLaunch(true, true, LAUNCH_ERROR, null, BENIGN_APP_PACKAGE)
        assertEquals(ProbeStatus.Fail, error.status)
        assertTrue(error.detail.contains("code 3"), error.detail)
    }

    @Test
    fun `a launch that never reaches the top is a failure that names what was there`() {
        val other = judgeAppLaunch(true, true, LAUNCH_OK, "com.other.app", BENIGN_APP_PACKAGE)
        assertEquals(ProbeStatus.Fail, other.status)
        assertTrue(other.detail.contains("com.other.app stayed in front"), other.detail)

        val nothing = judgeAppLaunch(true, true, LAUNCH_OK, null, BENIGN_APP_PACKAGE)
        assertEquals(ProbeStatus.Fail, nothing.status)
        assertTrue(nothing.detail.contains("did not appear"), nothing.detail)
    }

    @Test
    fun `a detached helper fails app launch before any launch code is read`() {
        val outcome = judgeAppLaunch(false, true, LAUNCH_OK, BENIGN_APP_PACKAGE, BENIGN_APP_PACKAGE)
        assertEquals(ProbeStatus.Fail, outcome.status)
        assertTrue(outcome.detail.contains("helper is not attached"), outcome.detail)
    }

    // MARK: - SCREEN READING

    @Test
    fun `a tree with one labelled node passes and reports the counts`() {
        val outcome = judgeScreenReading(
            helperAttached = true,
            treeBound = true,
            displayOpened = true,
            launchCode = LAUNCH_OK,
            read = ProbeTreeRead(taken = true, nodes = 12, labelled = 4),
            app = BENIGN_APP_PACKAGE,
        )
        assertEquals(ProbeStatus.Pass, outcome.status)
        assertTrue(outcome.detail.contains("4 of 12 nodes"), outcome.detail)
    }

    @Test
    fun `an unbound service, an unreadable display and an empty tree are three answers`() {
        val unbound = judgeScreenReading(true, false, true, LAUNCH_OK, EMPTY_TREE_READ, BENIGN_APP_PACKAGE)
        assertEquals(ProbeStatus.Fail, unbound.status)
        assertTrue(unbound.detail.contains("not bound"), unbound.detail)

        val unsupported = judgeScreenReading(
            true, true, true, LAUNCH_OK, ProbeTreeRead(taken = false, nodes = 0, labelled = 0), BENIGN_APP_PACKAGE,
        )
        assertEquals(ProbeStatus.Fail, unsupported.status)
        assertTrue(unsupported.detail.contains("per display"), unsupported.detail)

        val empty = judgeScreenReading(
            true, true, true, LAUNCH_OK, ProbeTreeRead(taken = true, nodes = 0, labelled = 0), BENIGN_APP_PACKAGE,
        )
        assertEquals(ProbeStatus.Fail, empty.status)
        assertTrue(empty.detail.contains("no readable application window"), empty.detail)
    }

    @Test
    fun `nodes without text or a resource id are a failure, not a pass`() {
        val outcome = judgeScreenReading(
            true, true, true, LAUNCH_OK, ProbeTreeRead(taken = true, nodes = 9, labelled = 0), BENIGN_APP_PACKAGE,
        )
        assertEquals(ProbeStatus.Fail, outcome.status)
        assertTrue(outcome.detail.contains("carries text or a resource id"), outcome.detail)
        assertTrue(outcome.fix.orEmpty().contains("phone unlocked"), outcome.fix.orEmpty())
    }

    // MARK: - ACTIONS

    @Test
    fun `an accepted back key passes and asserts nothing about the app`() {
        val outcome = judgeActions(true, true, LAUNCH_OK, accepted = true, app = BENIGN_APP_PACKAGE)
        assertEquals(ProbeStatus.Pass, outcome.status)
        assertEquals("the helper accepted a back key on its own display", outcome.detail)
    }

    @Test
    fun `a refused back key is a failure that says input cannot be driven`() {
        val outcome = judgeActions(true, true, LAUNCH_OK, accepted = false, app = BENIGN_APP_PACKAGE)
        assertEquals(ProbeStatus.Fail, outcome.status)
        assertTrue(outcome.detail.contains("refused a back key"), outcome.detail)
        assertTrue(outcome.fix.orEmpty().contains("Re-pair"), outcome.fix.orEmpty())
    }

    // MARK: - STAYS ALIVE

    @Test
    fun `a helper that hands out a second display passes`() {
        val outcome = judgeStaysAlive(
            helperAttached = true,
            answeredAfter = true,
            firstOpened = true,
            secondOpened = true,
        )
        assertEquals(ProbeStatus.Pass, outcome.status)
        assertTrue(outcome.detail.contains("stayed attached"), outcome.detail)
    }

    @Test
    fun `each way the run can wedge the phone has its own failure`() {
        val detached = judgeStaysAlive(false, true, true, true)
        assertEquals(ProbeStatus.Fail, detached.status)
        assertTrue(detached.detail.contains("detached"), detached.detail)

        val noFirst = judgeStaysAlive(true, true, false, true)
        assertEquals(ProbeStatus.Fail, noFirst.status)
        assertTrue(noFirst.detail.contains("could not create a display"), noFirst.detail)

        val silent = judgeStaysAlive(true, false, true, true)
        assertEquals(ProbeStatus.Fail, silent.status)
        assertTrue(silent.detail.contains("stopped answering"), silent.detail)

        val noSecond = judgeStaysAlive(true, true, true, false)
        assertEquals(ProbeStatus.Fail, noSecond.status)
        assertTrue(noSecond.detail.contains("second display"), noSecond.detail)
    }

    // MARK: - BROWSER

    @Test
    fun `a browser that reaches the top of the helper display passes`() {
        val outcome = judgeBrowser(true, "com.android.chrome", true, LAUNCH_OK, "com.android.chrome")
        assertEquals(ProbeStatus.Pass, outcome.status)
        assertTrue(outcome.detail.contains("com.android.chrome opened"), outcome.detail)
    }

    @Test
    fun `no browser installed is a failure with a plain sentence, not a skip`() {
        val outcome = judgeBrowser(true, null, false, NO_LAUNCH, null)
        assertEquals(ProbeStatus.Fail, outcome.status)
        assertEquals("no browser is installed on this phone", outcome.detail)
        assertTrue(outcome.fix.orEmpty().contains("Install or enable a browser"), outcome.fix.orEmpty())
    }

    @Test
    fun `a browser that stays behind another app fails`() {
        val outcome = judgeBrowser(true, "com.android.chrome", true, LAUNCH_OK, "com.android.settings")
        assertEquals(ProbeStatus.Fail, outcome.status)
        assertTrue(outcome.detail.contains("stayed in front"), outcome.detail)
    }

    // MARK: - SANDBOX

    private fun sandbox(
        attached: Boolean = true,
        displays: Boolean = true,
        launch: Int = LAUNCH_OK,
        onOwn: Boolean = true,
        main: Boolean? = true,
        moved: Boolean = true,
    ) = judgeSandbox(attached, displays, launch, onOwn, main, moved)

    @Test
    fun `an isolated task that moves between own displays passes`() {
        val outcome = sandbox()
        assertEquals(ProbeStatus.Pass, outcome.status)
        assertTrue(outcome.detail.contains("person's screen was not touched"), outcome.detail)
    }

    @Test
    fun `a task that lands off the helper display fails the sandbox`() {
        val outcome = sandbox(onOwn = false)
        assertEquals(ProbeStatus.Fail, outcome.status)
        assertTrue(outcome.detail.contains("did not appear as a task"), outcome.detail)
    }

    @Test
    fun `a changed person screen and an unreadable one are different failures`() {
        val touched = sandbox(main = false)
        assertEquals(ProbeStatus.Fail, touched.status)
        assertTrue(touched.detail.contains("person's screen changed"), touched.detail)

        val unknown = sandbox(main = null)
        assertEquals(ProbeStatus.Fail, unknown.status)
        assertTrue(unknown.detail.contains("could not report the person's screen"), unknown.detail)
    }

    @Test
    fun `a move the helper refuses fails the sandbox`() {
        val outcome = sandbox(moved = false)
        assertEquals(ProbeStatus.Fail, outcome.status)
        assertTrue(outcome.detail.contains("could not move a task"), outcome.detail)
    }

    @Test
    fun `no display or no launch is named before the isolation verdict`() {
        val noDisplay = sandbox(displays = false)
        assertEquals(ProbeStatus.Fail, noDisplay.status)
        assertTrue(noDisplay.detail.contains("two displays"), noDisplay.detail)

        val noLaunch = sandbox(launch = NO_LAUNCH)
        assertEquals(ProbeStatus.Fail, noLaunch.status)
        assertTrue(noLaunch.detail.contains("no app with a launcher entry"), noLaunch.detail)
    }

    // MARK: - APP COPIES

    @Test
    fun `app copies passes with the count and fails on an empty or unreadable list`() {
        val counted = judgeAppCopies(listOf("com.android.settings", "com.android.chrome"))
        assertEquals(ProbeStatus.Pass, counted.status)
        assertTrue(counted.detail.contains("2 launchable apps"), counted.detail)

        val none = judgeAppCopies(emptyList())
        assertEquals(ProbeStatus.Fail, none.status)
        assertTrue(none.detail.contains("no launchable app"), none.detail)

        val unreadable = judgeAppCopies(null)
        assertEquals(ProbeStatus.Fail, unreadable.status)
        assertTrue(unreadable.detail.contains("could not be read"), unreadable.detail)
    }
}
