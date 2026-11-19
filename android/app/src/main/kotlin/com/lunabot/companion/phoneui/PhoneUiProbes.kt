/*
 * The probes [runSelfCheck] runs, one per check.
 *
 * PhoneUiSelfCheck.kt is the ported runner and the judge; it deliberately knows
 * nothing about Android. This file is the other half: it reads the system the
 * way PhoneUiController and PhoneUiTaskExecutor already do, and hands the
 * runner a probe for each check.
 *
 * DEVICE, PERMISSIONS, HELPER, VIRTUAL_DISPLAY, MAIN_SCREEN and APP_COPIES read
 * the system directly. The six that need a display — APP_LAUNCH,
 * SCREEN_READING, ACTIONS, STAYS_ALIVE, BROWSER and SANDBOX — open their own
 * display through [SessionProbeShell], which wraps [PhoneUiDisplaySession]
 * exactly as [PhoneUiTaskExecutor] does, and release it in a `finally` so a
 * check that fails half way leaves nothing behind for the next task. They run
 * only when the person asks for the self-check from Settings; nothing starts on
 * its own.
 *
 * Every decision that is not a direct system read lives in a small pure
 * function below ([judgeDeviceWithHelper], [judgePermissions], [judgeHelper],
 * [judgeVirtualDisplay], [judgeAppLaunch], [judgeScreenReading], [judgeActions],
 * [judgeStaysAlive], [judgeMainScreen], [judgeBrowser], [judgeSandbox],
 * [judgeAppCopies]) so the JVM tests pin the verdicts without a phone. The
 * helper sits behind [ProbeShell] and the accessibility tree behind [ProbeTree],
 * so the probe paths themselves — a refused launch, an empty tree, a display
 * that must be released — are tested with fakes rather than a device.
 */
package com.openmausbot.companion.phoneui

import android.app.ActivityManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.view.Display
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.pm.PackageInfoCompat
import com.openmausbot.companion.phoneui.shell.PhoneUiShell
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull

// MARK: - The seams a probe runs through

/** One display a probe opened, with the id and size its steps need. */
internal interface ProbeDisplay : AutoCloseable {
    val displayId: Int
    val width: Int
    val height: Int
}

/**
 * The helper calls one probe makes. The real implementation
 * ([SessionProbeShell]) delegates to [PhoneUiShell] and opens displays through
 * [PhoneUiDisplaySession]; a test supplies its own, so the branches that only a
 * phone could otherwise reach are pinned without one.
 */
internal interface ProbeShell {
    /** Opens one display this probe owns, or null when the helper could not create one. */
    fun openDisplay(): ProbeDisplay?

    /** 0=launched 1=in use on the main display 2=no launcher entry 3=error. */
    fun launchApp(displayId: Int, packageName: String): Int

    fun topPackage(displayId: Int): String?
    fun topTaskId(displayId: Int): Int
    fun packageOfTask(taskId: Int): String?
    fun moveTask(taskId: Int, displayId: Int): Boolean
    fun injectKey(displayId: Int, keyCode: Int): Boolean

    /** Whether the helper is attached now; re-read, so a detach during the check is visible. */
    fun isAttached(): Boolean
}

/** The accessibility tree of one display; the real one is [PhoneUiAccessibilityService.snapshot]. */
internal fun interface ProbeTree {
    fun snapshot(displayId: Int): PhoneUiSnapshot?
}

/** What one bounded read of a display's tree found. */
internal data class ProbeTreeRead(val taken: Boolean, val nodes: Int, val labelled: Int)

internal val EMPTY_TREE_READ = ProbeTreeRead(taken = false, nodes = 0, labelled = 0)

/** The real helper, with its displays opened by the same session the executor uses. */
private class SessionProbeShell(
    private val shell: PhoneUiShell,
    private val attached: () -> Boolean,
) : ProbeShell {
    override fun openDisplay(): ProbeDisplay? =
        PhoneUiDisplaySession.open(
            shell,
            PhoneUiRules.DEFAULT_WIDTH,
            PhoneUiRules.DEFAULT_HEIGHT,
            PhoneUiRules.DEFAULT_DPI,
        )?.let(::SessionProbeDisplay)

    override fun launchApp(displayId: Int, packageName: String): Int =
        shell.launchApp(displayId, packageName)

    override fun topPackage(displayId: Int): String? = shell.topPackage(displayId)

    override fun topTaskId(displayId: Int): Int = shell.topTaskId(displayId)

    override fun packageOfTask(taskId: Int): String? = shell.packageOfTask(taskId)

    override fun moveTask(taskId: Int, displayId: Int): Boolean = shell.moveTask(taskId, displayId)

    override fun injectKey(displayId: Int, keyCode: Int): Boolean = shell.injectKey(displayId, keyCode)

    override fun isAttached(): Boolean = attached()
}

private class SessionProbeDisplay(private val session: PhoneUiDisplaySession) : ProbeDisplay {
    override val displayId: Int get() = session.displayId
    override val width: Int get() = session.width
    override val height: Int get() = session.height

    override fun close() = session.close()
}

/**
 * Opens one display, runs [body], and releases the display in a `finally` —
 * including when [body] throws. Null means the helper could not create a
 * display, in which case [body] never ran and nothing was opened.
 */
internal suspend fun <T> withProbeDisplay(shell: ProbeShell, body: suspend (ProbeDisplay) -> T): T? {
    val display = runCatching { shell.openDisplay() }.getOrNull() ?: return null
    return try {
        body(display)
    } finally {
        runCatching { display.close() }
    }
}

/**
 * The same contract for [count] displays at once, released in reverse order.
 * A display that cannot be created ends the call with null after releasing the
 * ones already open, so a half-built check never leaks the first display.
 */
internal suspend fun <T> withProbeDisplays(
    shell: ProbeShell,
    count: Int,
    body: suspend (List<ProbeDisplay>) -> T,
): T? {
    val opened = ArrayList<ProbeDisplay>(count)
    try {
        repeat(count) {
            val display = runCatching { shell.openDisplay() }.getOrNull() ?: return null
            opened += display
        }
        return body(opened)
    } finally {
        for (display in opened.asReversed()) runCatching { display.close() }
    }
}

/**
 * One probe per check, in the runner's order. The closures are read when each
 * probe runs, not when the map is built, so a run sees the helper and the
 * service as they are at that moment. The app list is one query per run and is
 * shared by the checks that ask which app to drive and how many are visible.
 */
internal fun phoneUiProbes(
    context: Context,
    shell: () -> PhoneUiShell?,
    accessibility: () -> PhoneUiAccessibilityService?,
): Map<PhoneUiCheck, Probe> {
    val app = context.applicationContext
    val launchable = lazy { launchablePackages(app.packageManager) }
    val benign = lazy { benignAppPackage(app.packageManager, launchable.value) }
    val browser = lazy { browserPackageOf(app.packageManager) }
    fun probeShell(): ProbeShell? = shell()?.let { helper ->
        SessionProbeShell(helper) { shell() != null }
    }
    fun tree(): ProbeTree? = accessibility()?.let { service ->
        ProbeTree { displayId -> service.snapshot(displayId) }
    }
    return mapOf(
        PhoneUiCheck.DEVICE to Probe { judgeDeviceWithHelper(deviceFacts(app), shell() != null) },
        PhoneUiCheck.PERMISSIONS to Probe { readPermissions(app, accessibility()) },
        PhoneUiCheck.HELPER to Probe {
            val helper = shell()
            judgeHelper(helper != null, helper?.let(::measureRoundTrip))
        },
        PhoneUiCheck.VIRTUAL_DISPLAY to Probe { displayProbe(probeShell()) },
        PhoneUiCheck.APP_LAUNCH to Probe { launchAppProbe(probeShell(), benign.value) },
        PhoneUiCheck.SCREEN_READING to Probe { readScreenProbe(probeShell(), tree(), benign.value) },
        PhoneUiCheck.ACTIONS to Probe { actProbe(probeShell(), benign.value) },
        PhoneUiCheck.STAYS_ALIVE to Probe { staysAliveProbe(probeShell()) },
        PhoneUiCheck.MAIN_SCREEN to Probe { readMainScreen(accessibility()) },
        PhoneUiCheck.BROWSER to Probe { browserProbe(probeShell(), browser.value) },
        PhoneUiCheck.SANDBOX to Probe { sandboxProbe(probeShell(), benign.value) },
        PhoneUiCheck.APP_COPIES to Probe { judgeAppCopies(launchable.value) },
    )
}

// MARK: - DEVICE

/**
 * [judgeDevice] plus the facts the shared judge does not print: the model (with
 * its manufacturer) and this app's version, so the row answers the whole
 * question. The helper's state is appended too, but it never changes the
 * verdict — an unattached helper is HELPER's row to fail, not the phone's.
 */
internal fun judgeDeviceWithHelper(facts: PhoneUiDeviceFacts, helperAttached: Boolean): ProbeOutcome {
    val outcome = judgeDevice(facts)
    val app = facts.appVersion.ifBlank { "unknown" }
    val helper = if (helperAttached) "helper attached" else "helper not attached"
    return outcome.copy(detail = "${outcome.detail}; ${facts.modelName}, app $app, $helper")
}

/**
 * The public system interfaces [PhoneUiDeviceFacts] asks for. Every read that
 * can fail falls back to the empty or zero value the judge already renders as
 * "unknown"; none of them throws out of a probe.
 *
 * [PhoneUiDeviceFacts.phoneControlUnavailable] stays false: this app always
 * has a developer-options page, and turning it on is a setting rather than a
 * missing capability. A phone that has not turned it on fails HELPER, which
 * names the page to open.
 */
private fun deviceFacts(context: Context): PhoneUiDeviceFacts {
    val memory = ActivityManager.MemoryInfo()
    runCatching { context.getSystemService(ActivityManager::class.java)?.getMemoryInfo(memory) }
    val info = runCatching {
        context.packageManager.getPackageInfo(context.packageName, 0)
    }.getOrNull()
    val metrics = context.resources.displayMetrics
    return PhoneUiDeviceFacts(
        manufacturer = Build.MANUFACTURER.orEmpty(),
        model = Build.MODEL.orEmpty(),
        androidRelease = Build.VERSION.RELEASE.orEmpty(),
        sdk = Build.VERSION.SDK_INT,
        abis = Build.SUPPORTED_ABIS.toList(),
        ramBytes = memory.totalMem,
        screenWidth = metrics.widthPixels,
        screenHeight = metrics.heightPixels,
        // The same global the controller reads to decide whether wireless
        // debugging is on; a failed read is "cannot say", not "off".
        wirelessDebugging = runCatching {
            Settings.Global.getInt(context.contentResolver, "adb_wifi_enabled", 0) == 1
        }.getOrNull(),
        appVersion = info?.versionName.orEmpty(),
        appBuild = info?.let { PackageInfoCompat.getLongVersionCode(it).toString() }.orEmpty(),
        developerOptionsPage = runCatching {
            Settings.Global.getInt(context.contentResolver, "development_settings_enabled", 0) != 0
        }.getOrNull(),
    )
}

// MARK: - PERMISSIONS

/**
 * The three grants the phone-UI slice needs, each read the way its own code
 * reads it. The detail lists all three either way, so a failing row still says
 * what the other two are.
 */
private fun readPermissions(
    context: Context,
    service: PhoneUiAccessibilityService?,
): ProbeOutcome {
    val enabled = runCatching {
        Settings.Secure.getInt(context.contentResolver, Settings.Secure.ACCESSIBILITY_ENABLED, 0) == 1 &&
            PhoneUiAccessibilityRepair.contains(
                Settings.Secure.getString(
                    context.contentResolver,
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
                ),
                ComponentName(context, PhoneUiAccessibilityService::class.java).flattenToString(),
            )
    }.getOrDefault(false)
    val notificationAccess = runCatching {
        NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.packageName)
    }.getOrDefault(false)
    val batteryExempt = runCatching {
        context.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(context.packageName)
    }.getOrNull() ?: false
    return judgePermissions(
        accessibilityEnabled = enabled,
        accessibilityBound = service != null,
        notificationAccess = notificationAccess,
        batteryExempt = batteryExempt,
    )
}

/**
 * The PERMISSIONS verdict from four booleans. Accessibility comes first because
 * nothing else in the slice works without it; a service the system lists but
 * does not run is a different fix from one that was never turned on.
 */
internal fun judgePermissions(
    accessibilityEnabled: Boolean,
    accessibilityBound: Boolean,
    notificationAccess: Boolean,
    batteryExempt: Boolean,
): ProbeOutcome {
    val detail = "accessibility " + when {
        accessibilityBound -> "on and bound"
        accessibilityEnabled -> "listed but not running"
        else -> "off"
    } + ", notification access " + (if (notificationAccess) "granted" else "not granted") +
        ", battery optimisation " + (if (batteryExempt) "exempt" else "not exempt")
    return when {
        !accessibilityEnabled -> ProbeOutcome.fail(
            "$detail; screen reading is off",
            "Turn on Luna Bot's screen-reading service in system settings → Accessibility.",
        )
        !accessibilityBound -> ProbeOutcome.fail(
            "$detail; the service is listed but not running",
            "Turn the screen-reading service off and on again in system settings → Accessibility.",
        )
        !notificationAccess -> ProbeOutcome.fail(
            "$detail; notification access is missing",
            "Allow Luna Bot notification access in system settings → Notification access.",
        )
        !batteryExempt -> ProbeOutcome.fail(
            "$detail; the battery may stop the helper in the background",
            "Let Luna Bot run without battery optimisation in system settings → Battery.",
        )
        else -> ProbeOutcome.pass(detail)
    }
}

// MARK: - HELPER

/**
 * How long one cheap binder round trip took, or null when the call failed.
 * [PhoneUiShell.topTaskId] is the cheapest content-free call the helper
 * exposes: an int for the top task on a display, no package, text or pixels.
 */
private fun measureRoundTrip(helper: PhoneUiShell): Long? {
    val startedAt = System.currentTimeMillis()
    return runCatching { helper.topTaskId(Display.DEFAULT_DISPLAY) }
        .map { (System.currentTimeMillis() - startedAt).coerceAtLeast(0L) }
        .getOrNull()
}

/** The HELPER verdict: attached or not, and how long its one round trip took when it answered. */
internal fun judgeHelper(attached: Boolean, roundTripMs: Long?): ProbeOutcome = when {
    !attached -> ProbeOutcome.fail(
        "the helper process is not attached",
        "Open the wireless-debugging page, keep it on, and re-pair if the helper still does not start.",
    )
    roundTripMs == null -> ProbeOutcome.fail(
        "the helper is attached but a round trip failed",
        "The helper stopped answering; re-pairing restarts it.",
    )
    else -> ProbeOutcome.pass("the helper is attached; one round trip took $roundTripMs ms")
}

// MARK: - VIRTUAL DISPLAY

/**
 * Create and release one display, the same way [PhoneUiTaskExecutor] opens its
 * session. The display is released in [withProbeDisplay]'s `finally`, so a
 * check never leaves one behind for the next task to trip over.
 */
internal suspend fun displayProbe(shell: ProbeShell?): ProbeOutcome {
    shell ?: return helperMissing("no display could be created")
    val created = withProbeDisplay(shell) { display -> display.displayId } ?: -1
    return judgeVirtualDisplay(created = created >= 0, sdk = Build.VERSION.SDK_INT)
}

/**
 * Whether a display could be created. On Android 14+ the row says that the
 * display's own focus is the helper's choice: the trusted flags live in
 * PhoneUiPolicy and this app cannot read them back from the helper.
 */
internal fun judgeVirtualDisplay(created: Boolean, sdk: Int): ProbeOutcome = when {
    !created -> ProbeOutcome.fail(
        "the helper could not create a virtual display",
        "Re-pair the phone-UI connection; a helper that cannot create a display cannot run tasks.",
    )
    sdk >= PhoneUiDeviceFacts.OWN_FOCUS_SDK ->
        ProbeOutcome.pass("a display was created and released; its own focus is the helper's choice")
    else -> ProbeOutcome.pass("a display was created and released")
}

// MARK: - APP LAUNCH

/**
 * Launch the benign app on a display of our own and wait for it to reach the
 * top. A launch the helper refuses is answered from its own code — "in use on
 * the person's screen" is the one case where the app is already somewhere the
 * check must not disturb. The display is released either way.
 */
internal suspend fun launchAppProbe(shell: ProbeShell?, app: String?): ProbeOutcome {
    if (shell == null) return judgeAppLaunch(false, false, NO_LAUNCH, null, app)
    if (app == null) return judgeAppLaunch(true, false, NO_LAUNCH, null, null)
    var launchCode = NO_LAUNCH
    var top: String? = null
    val opened = withProbeDisplay(shell) { display ->
        launchCode = runCatching { shell.launchApp(display.displayId, app) }.getOrDefault(LAUNCH_ERROR)
        if (launchCode == LAUNCH_OK) top = awaitTopPackage(shell, display.displayId, app)
    }
    return judgeAppLaunch(true, opened != null, launchCode, top, app)
}

/**
 * The APP_LAUNCH verdict. A launch that lands is a pass only when the package
 * is the one on top of our display: an app that stayed on the person's screen
 * (code 1) is the failure this check exists to catch, because every later
 * action would otherwise drive the wrong screen.
 */
internal fun judgeAppLaunch(
    helperAttached: Boolean,
    displayOpened: Boolean,
    launchCode: Int,
    topPackage: String?,
    app: String?,
): ProbeOutcome {
    if (!helperAttached) return helperMissing("no app could be launched")
    if (app == null) return missingAppFailure()
    if (!displayOpened) return ProbeOutcome.fail("the helper could not create a display for the launch")
    launchFailure(app, launchCode)?.let { return it }
    return when {
        topPackage == null -> ProbeOutcome.fail(
            "$app did not appear on the helper's display",
            "Run the check again; if it keeps not appearing, re-pairing restarts the helper's launcher.",
        )
        topPackage != app -> ProbeOutcome.fail("$topPackage stayed in front of $app on the helper's display")
        else -> ProbeOutcome.pass("$app launched on the helper's display and was released")
    }
}

// MARK: - SCREEN READING

/**
 * Launch the benign app on a display of our own, then read the accessibility
 * tree of that display until it holds a node with text or a resource id. An
 * app that just opened often exposes its root window before its content, which
 * is why the read is bounded and repeated rather than taken once.
 */
internal suspend fun readScreenProbe(shell: ProbeShell?, tree: ProbeTree?, app: String?): ProbeOutcome {
    if (shell == null) return judgeScreenReading(false, tree != null, false, NO_LAUNCH, EMPTY_TREE_READ, app)
    if (tree == null) return judgeScreenReading(true, false, false, NO_LAUNCH, EMPTY_TREE_READ, app)
    if (app == null) return judgeScreenReading(true, true, false, NO_LAUNCH, EMPTY_TREE_READ, null)
    var launchCode = NO_LAUNCH
    var read = EMPTY_TREE_READ
    val opened = withProbeDisplay(shell) { display ->
        launchCode = runCatching { shell.launchApp(display.displayId, app) }.getOrDefault(LAUNCH_ERROR)
        if (launchCode == LAUNCH_OK) {
            awaitTopPackage(shell, display.displayId, app)
            read = readTree(tree, display.displayId)
        }
    }
    return judgeScreenReading(true, true, opened != null, launchCode, read, app)
}

/**
 * The SCREEN_READING verdict. An empty tree on a display that holds an app
 * means the person's phone will not describe what a bot is looking at, so
 * every tap would be blind; "cannot read windows per display" is the Android
 * version, and an empty tree is the service.
 */
internal fun judgeScreenReading(
    helperAttached: Boolean,
    treeBound: Boolean,
    displayOpened: Boolean,
    launchCode: Int,
    read: ProbeTreeRead,
    app: String?,
): ProbeOutcome {
    if (!helperAttached) return helperMissing("no screen could be read")
    if (!treeBound) {
        return ProbeOutcome.fail(
            "the accessibility service is not bound, so the helper's display cannot be read",
            "Turn on Luna Bot's screen-reading service in system settings → Accessibility.",
        )
    }
    if (app == null) return missingAppFailure()
    if (!displayOpened) return ProbeOutcome.fail("the helper could not create a display to read")
    launchFailure(app, launchCode)?.let { return it }
    if (!read.taken) {
        return ProbeOutcome.fail(
            "this Android version cannot read windows per display",
            "Phone control needs Android 11 or newer.",
        )
    }
    if (read.nodes == 0) {
        return ProbeOutcome.fail(
            "the helper's display has no readable application window",
            "Turn the screen-reading service off and on again in system settings → Accessibility.",
        )
    }
    if (read.labelled == 0) {
        return ProbeOutcome.fail(
            "no node on the helper's display carries text or a resource id",
            "The app opened but exposed nothing to read; try the check again with the phone unlocked.",
        )
    }
    return ProbeOutcome.pass(
        "the helper's display is readable; ${read.labelled} of ${read.nodes} nodes carry text or a resource id",
    )
}

// MARK: - ACTIONS

/**
 * Send one back key to a display of our own after opening the benign app. Back
 * is the safe action: it changes nothing the person can see and no app-specific
 * outcome is asserted, only that the helper accepted the event. A tap on a node
 * would be less safe, because the node could be a switch.
 */
internal suspend fun actProbe(shell: ProbeShell?, app: String?): ProbeOutcome {
    if (shell == null) return judgeActions(false, false, NO_LAUNCH, false, app)
    if (app == null) return judgeActions(true, false, NO_LAUNCH, false, null)
    var launchCode = NO_LAUNCH
    var accepted = false
    val opened = withProbeDisplay(shell) { display ->
        launchCode = runCatching { shell.launchApp(display.displayId, app) }.getOrDefault(LAUNCH_ERROR)
        if (launchCode == LAUNCH_OK) {
            // Give the app a moment to be the front window. The wait never
            // decides the verdict: a back key on our own launcher is still a
            // valid event, and only the helper's answer is asserted.
            awaitTopPackage(shell, display.displayId, app)
            accepted = runCatching { shell.injectKey(display.displayId, PhoneUiKeys.BACK) }
                .getOrDefault(false)
        }
    }
    return judgeActions(true, opened != null, launchCode, accepted, app)
}

/** The ACTIONS verdict: one accepted synthetic event, and nothing about what the app did with it. */
internal fun judgeActions(
    helperAttached: Boolean,
    displayOpened: Boolean,
    launchCode: Int,
    accepted: Boolean,
    app: String?,
): ProbeOutcome {
    if (!helperAttached) return helperMissing("no action could be sent")
    if (app == null) return missingAppFailure()
    if (!displayOpened) return ProbeOutcome.fail("the helper could not create a display to act on")
    launchFailure(app, launchCode)?.let { return it }
    if (!accepted) {
        return ProbeOutcome.fail(
            "the helper refused a back key on its own display",
            "Re-pair the phone-UI connection; a helper that refuses input cannot drive an app.",
        )
    }
    return ProbeOutcome.pass("the helper accepted a back key on its own display")
}

// MARK: - STAYS ALIVE

/**
 * Create and release one display, ask the helper for a cheap answer, then
 * create and release a second one. This is the "the run did not wedge the
 * phone" check: after several probes have opened and released displays, the
 * helper still has to attach, answer, and hand out a fresh display.
 */
internal suspend fun staysAliveProbe(shell: ProbeShell?): ProbeOutcome {
    if (shell == null) return helperMissing("nothing could be checked for a wedged phone")
    if (!shell.isAttached()) return judgeStaysAlive(false, false, false, false)
    var first: ProbeDisplay? = null
    var second: ProbeDisplay? = null
    var firstOpened = false
    var secondOpened = false
    var answered = false
    try {
        first = runCatching { shell.openDisplay() }.getOrNull()
        firstOpened = first != null
        runCatching { first?.close() }
        first = null
        answered = runCatching { shell.topTaskId(Display.DEFAULT_DISPLAY) }.isSuccess
        second = runCatching { shell.openDisplay() }.getOrNull()
        secondOpened = second != null
    } finally {
        // The normal path releases each display above; this is the net for a
        // throw between opening one and closing it.
        runCatching { second?.close() }
        runCatching { first?.close() }
    }
    return judgeStaysAlive(
        helperAttached = runCatching { shell.isAttached() }.getOrDefault(false),
        answeredAfter = answered,
        firstOpened = firstOpened,
        secondOpened = secondOpened,
    )
}

/**
 * The STAYS_ALIVE verdict. Each failure names the step that broke: a helper
 * that detached, one that stopped answering, or one that could not hand out
 * another display after the first was released.
 */
internal fun judgeStaysAlive(
    helperAttached: Boolean,
    answeredAfter: Boolean,
    firstOpened: Boolean,
    secondOpened: Boolean,
): ProbeOutcome = when {
    !helperAttached -> ProbeOutcome.fail(
        "the helper detached during the check",
        "Re-pair the phone-UI connection; a helper that drops mid-run cannot finish a task.",
    )
    !firstOpened -> ProbeOutcome.fail(
        "the helper could not create a display after the earlier checks",
        "Re-pair the phone-UI connection; the helper is no longer handing out displays.",
    )
    !answeredAfter -> ProbeOutcome.fail(
        "the helper stopped answering after the first display was released",
        "Re-pair the phone-UI connection; the helper is attached but unresponsive.",
    )
    !secondOpened -> ProbeOutcome.fail(
        "the helper could not create a second display after releasing the first",
        "The helper may be wedged; re-pairing restarts it.",
    )
    else -> ProbeOutcome.pass("the helper stayed attached and a second display was created and released")
}

// MARK: - MAIN SCREEN

/** The person's own display, read through the accessibility service the way the executor reads a task display. */
private fun readMainScreen(service: PhoneUiAccessibilityService?): ProbeOutcome {
    if (service == null) return judgeMainScreen(null)
    val reading = runCatching { service.reading(Display.DEFAULT_DISPLAY) }.getOrNull()
    return judgeMainScreen(reading?.fingerprint)
}

/**
 * The MAIN_SCREEN verdict from a fingerprint in [PhoneUiAccessibilityService.fingerprint]'s
 * shape (`count:hash`). Null means the service is not bound; "unsupported"
 * means this Android version cannot read windows per display; a zero node
 * count means the display is locked or nothing on it is readable.
 */
internal fun judgeMainScreen(fingerprint: String?): ProbeOutcome {
    if (fingerprint == null) {
        return ProbeOutcome.fail(
            "the accessibility service is not bound, so the person's display cannot be read",
            "Turn on Luna Bot's screen-reading service in system settings → Accessibility.",
        )
    }
    if (fingerprint == "unsupported") {
        return ProbeOutcome.fail(
            "this Android version cannot read windows per display",
            "Phone control needs Android 11 or newer.",
        )
    }
    val nodes = fingerprint.substringBefore(':').toIntOrNull() ?: 0
    return if (nodes <= 0) {
        ProbeOutcome.fail(
            "no application window is readable on the person's display",
            "Unlock the phone and leave an app open, then run the check again.",
        )
    } else {
        ProbeOutcome.pass("the person's display is readable; $nodes nodes")
    }
}

// MARK: - BROWSER

/**
 * Launch the browser on a display of our own and wait for it to reach the top.
 * Driving a browser is the one thing most bot tasks need, so "no browser
 * installed" is a failure with a sentence rather than a skip: the person can
 * install one and run the check again.
 */
internal suspend fun browserProbe(shell: ProbeShell?, browser: String?): ProbeOutcome {
    if (shell == null) return judgeBrowser(false, browser, false, NO_LAUNCH, null)
    if (browser == null) return judgeBrowser(true, null, false, NO_LAUNCH, null)
    var launchCode = NO_LAUNCH
    var top: String? = null
    val opened = withProbeDisplay(shell) { display ->
        launchCode = runCatching { shell.launchApp(display.displayId, browser) }.getOrDefault(LAUNCH_ERROR)
        if (launchCode == LAUNCH_OK) top = awaitTopPackage(shell, display.displayId, browser)
    }
    return judgeBrowser(true, browser, opened != null, launchCode, top)
}

/** The BROWSER verdict: a browser the app can see, launched on our display and actually in front. */
internal fun judgeBrowser(
    helperAttached: Boolean,
    browser: String?,
    displayOpened: Boolean,
    launchCode: Int,
    topPackage: String?,
): ProbeOutcome {
    if (!helperAttached) return helperMissing("no browser could be started")
    if (browser == null) {
        return ProbeOutcome.fail(
            "no browser is installed on this phone",
            "Install or enable a browser, then run the check again.",
        )
    }
    if (!displayOpened) return ProbeOutcome.fail("the helper could not create a display for the browser")
    launchFailure(browser, launchCode)?.let { return it }
    return when {
        topPackage == null -> ProbeOutcome.fail(
            "the browser did not come to the front of the helper's display",
            "Run the check again; if it stays behind, re-pairing restarts the helper's launcher.",
        )
        topPackage != browser -> ProbeOutcome.fail("$topPackage stayed in front instead of $browser")
        else -> ProbeOutcome.pass("$browser opened on the helper's display and was released")
    }
}

// MARK: - SANDBOX

/**
 * Prove the helper's display is isolated: an app task appears on the display
 * the helper created, the task moves between two of the helper's own displays,
 * and the person's top task never changes. Nothing is injected into the primary
 * display, and no task is moved onto it — the move target is always the
 * helper's other display.
 */
internal suspend fun sandboxProbe(shell: ProbeShell?, app: String?): ProbeOutcome {
    if (shell == null) return judgeSandbox(false, false, NO_LAUNCH, false, null, false)
    if (app == null) return missingAppFailure()
    val mainBefore = runCatching { shell.topTaskId(Display.DEFAULT_DISPLAY) }.getOrNull()
    var launchCode = NO_LAUNCH
    var taskOnOwn = false
    var moved = false
    val opened = withProbeDisplays(shell, 2) { displays ->
        val first = displays[0]
        val second = displays[1]
        launchCode = runCatching { shell.launchApp(first.displayId, app) }.getOrDefault(LAUNCH_ERROR)
        if (launchCode == LAUNCH_OK) {
            val taskId = awaitTaskId(shell, first.displayId, LAUNCH_WAIT_MS)
            taskOnOwn = taskId >= 0 && runCatching { shell.packageOfTask(taskId) }.getOrNull() == app
            if (taskOnOwn) {
                moved = runCatching { shell.moveTask(taskId, second.displayId) }.getOrDefault(false) &&
                    awaitTaskMoved(shell, taskId, from = first.displayId, to = second.displayId)
            }
        }
    }
    val mainAfter = runCatching { shell.topTaskId(Display.DEFAULT_DISPLAY) }.getOrNull()
    // Null, not true, when the person's screen could not be read: the check
    // must not claim isolation it could not observe.
    val mainUntouched = if (mainBefore == null || mainAfter == null) null else mainBefore == mainAfter
    return judgeSandbox(true, opened != null, launchCode, taskOnOwn, mainUntouched, moved)
}

/**
 * The SANDBOX verdict. A task that will not stay on the helper's display, a
 * move the helper refuses, or a change on the person's screen all mean a bot
 * could act somewhere other than the screen it was told to drive.
 */
internal fun judgeSandbox(
    helperAttached: Boolean,
    displaysOpened: Boolean,
    launchCode: Int,
    taskOnOwn: Boolean,
    mainUntouched: Boolean?,
    moved: Boolean,
): ProbeOutcome {
    if (!helperAttached) return helperMissing("there is no sandbox to check")
    // The display comes before the launch code: a launch never attempted
    // because there was nowhere to launch is a display failure, not an app one.
    if (!displaysOpened) return ProbeOutcome.fail("the helper could not create the two displays the check needs")
    if (launchCode == NO_LAUNCH) return missingAppFailure()
    if (launchCode != LAUNCH_OK) {
        return ProbeOutcome.fail("the helper could not start an app on its own display (code $launchCode)")
    }
    if (!taskOnOwn) {
        return ProbeOutcome.fail(
            "the app did not appear as a task on the helper's own display",
            "Re-pair the phone-UI connection; a task that lands elsewhere cannot be driven.",
        )
    }
    if (mainUntouched == null) {
        return ProbeOutcome.fail(
            "the helper could not report the person's screen, so isolation could not be checked",
            "Re-pair the phone-UI connection and run the check again.",
        )
    }
    if (!mainUntouched) {
        return ProbeOutcome.fail(
            "the person's screen changed while the check ran",
            "Run the check again with the phone idle; nothing in it should touch the person's screen.",
        )
    }
    if (!moved) {
        return ProbeOutcome.fail(
            "the helper could not move a task between its own displays",
            "Re-pair the phone-UI connection; a task that cannot be moved cannot be kept in the sandbox.",
        )
    }
    return ProbeOutcome.pass(
        "the helper kept the app on a display it created and moved it between its own displays; " +
            "the person's screen was not touched",
    )
}

// MARK: - APP COPIES

/**
 * The apps this app can see, with a launcher entry — the same list
 * PHONE_LIST_APPS answers from. A phone that exposes none means the bot cannot
 * launch anything at all, whatever the rest of the slice says.
 */
internal fun judgeAppCopies(launchable: List<String>?): ProbeOutcome = when {
    launchable == null -> ProbeOutcome.fail(
        "the installed app list could not be read",
        "Run the check again; if it stays unreadable, reinstall Luna Bot.",
    )
    launchable.isEmpty() -> ProbeOutcome.fail(
        "this app can see no launchable app on the phone",
        "Package visibility is hiding every app; reinstalling Luna Bot restores its declared app query.",
    )
    else -> ProbeOutcome.pass("${launchable.size} launchable apps are visible to this app")
}

// MARK: - Package resolution

/** The app APP_LAUNCH, SCREEN_READING and ACTIONS drive: system settings, on every Android phone. */
internal const val BENIGN_APP_PACKAGE = "com.android.settings"

/**
 * Browsers people actually install. The system's own answer is preferred; this
 * list is the fallback for package visibility, which hides an intent handler
 * unless the manifest names that intent — and this app's manifest names the
 * launcher intent, not a browser one.
 */
private val KNOWN_BROWSER_PACKAGES = listOf(
    "com.android.chrome",
    "org.mozilla.firefox",
    "com.microsoft.emmx",
    "com.sec.android.app.sbrowser",
    "com.brave.browser",
    "com.opera.browser",
    "com.opera.mini.native",
    "com.duckduckgo.mobile.android",
    "com.vivaldi.browser",
    "com.UCMobile",
    "com.tencent.mtt",
    "com.android.browser",
    "com.miui.browser",
    "com.huawei.browser",
    "com.heytap.browser",
    "com.quark.browser",
    "com.baidu.searchbox",
)

/**
 * Every package with a launcher entry this app can see, or null when the
 * package manager refuses the query. Package visibility makes this the app's
 * view, not the phone's: that is the honest number for "what can a bot launch".
 */
internal fun launchablePackages(pm: PackageManager): List<String>? = runCatching {
    pm.getInstalledApplications(0)
        .filter { pm.getLaunchIntentForPackage(it.packageName) != null }
        .map { it.packageName }
        .sorted()
}.getOrNull()

/**
 * The app the display probes drive: system settings when it has a launcher
 * entry, otherwise the first launchable app. A phone whose settings app has no
 * launcher entry is unusual but not broken, and the check is "can an app be
 * launched", not "is it this particular app".
 */
internal fun benignAppPackage(pm: PackageManager, launchable: List<String>?): String? {
    if (runCatching { pm.getLaunchIntentForPackage(BENIGN_APP_PACKAGE) }.getOrNull() != null) {
        return BENIGN_APP_PACKAGE
    }
    return launchable?.firstOrNull()
}

/**
 * The package BROWSER drives. The system's resolution of an http(s) link wins;
 * "android" is the chooser, not a browser, so it is ignored. When package
 * visibility hides every handler the launcher list is matched against the
 * browsers above. Null means no browser this app can see.
 */
internal fun browserPackageOf(pm: PackageManager): String? {
    val resolved = runCatching {
        pm.resolveActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com"))
                .addCategory(Intent.CATEGORY_BROWSABLE),
            PackageManager.MATCH_DEFAULT_ONLY,
        )?.activityInfo?.packageName
    }.getOrNull()
    if (!resolved.isNullOrEmpty() && resolved != "android") return resolved
    val visible = launchablePackages(pm).orEmpty().toSet()
    return KNOWN_BROWSER_PACKAGES.firstOrNull { it in visible }
}

// MARK: - Bounded waits

/**
 * Waits for [expected] to be the top package of [displayId], for at most
 * [timeoutMs]. Returns the last package seen, so a timeout still says what was
 * there instead. Timeouts are coroutine timeouts, so a test's virtual clock
 * drives them and no probe can hang the run.
 */
private suspend fun awaitTopPackage(
    shell: ProbeShell,
    displayId: Int,
    expected: String,
    timeoutMs: Long = LAUNCH_WAIT_MS,
): String? {
    var last: String? = null
    withTimeoutOrNull(timeoutMs) {
        while (true) {
            last = runCatching { shell.topPackage(displayId) }.getOrNull()
            if (last == expected) return@withTimeoutOrNull
            delay(LAUNCH_POLL_MS)
        }
    }
    return last
}

/** Waits for any task to appear on [displayId]; -1 when none did within [timeoutMs]. */
private suspend fun awaitTaskId(
    shell: ProbeShell,
    displayId: Int,
    timeoutMs: Long = MOVE_WAIT_MS,
): Int {
    var last = -1
    withTimeoutOrNull(timeoutMs) {
        while (true) {
            last = runCatching { shell.topTaskId(displayId) }.getOrDefault(-1)
            if (last >= 0) return@withTimeoutOrNull
            delay(MOVE_POLL_MS)
        }
    }
    return last
}

/** Waits for [taskId] to top [to] and to have left [from]; false on timeout. */
private suspend fun awaitTaskMoved(shell: ProbeShell, taskId: Int, from: Int, to: Int): Boolean {
    var moved = false
    withTimeoutOrNull(MOVE_WAIT_MS) {
        while (!moved) {
            moved = runCatching { shell.topTaskId(to) }.getOrDefault(-1) == taskId &&
                runCatching { shell.topTaskId(from) }.getOrDefault(-1) == -1
            if (!moved) delay(MOVE_POLL_MS)
        }
    }
    return moved
}

/**
 * Reads [displayId]'s tree until it holds a node with text or a resource id,
 * for at most [timeoutMs]. A null snapshot ends the wait at once: that is the
 * Android version, not a slow screen, and retrying cannot change it.
 */
private suspend fun readTree(tree: ProbeTree, displayId: Int, timeoutMs: Long = SNAPSHOT_WAIT_MS): ProbeTreeRead {
    var read = EMPTY_TREE_READ
    withTimeoutOrNull(timeoutMs) {
        while (true) {
            val snapshot = runCatching { tree.snapshot(displayId) }.getOrNull()
            read = if (snapshot == null) {
                EMPTY_TREE_READ
            } else {
                ProbeTreeRead(
                    taken = true,
                    nodes = snapshot.elements.size,
                    labelled = snapshot.elements.count { !it.text.isNullOrBlank() || !it.viewId.isNullOrBlank() },
                )
            }
            if (!read.taken || read.labelled > 0) return@withTimeoutOrNull
            delay(SNAPSHOT_POLL_MS)
        }
    }
    return read
}

// MARK: - Shared verdict pieces

/** The failure every display probe answers when the helper is gone; one sentence names the fix. */
private fun helperMissing(consequence: String): ProbeOutcome = ProbeOutcome.fail(
    "the helper is not attached, so $consequence",
    "Open the wireless-debugging page, keep it on, and re-pair if the helper still does not start.",
)

/** The failure every display probe answers when the phone exposes no launchable app. */
private fun missingAppFailure(): ProbeOutcome = ProbeOutcome.fail(
    "no app with a launcher entry is visible to this app",
    "Package visibility or a stripped ROM is hiding every app; reinstall Luna Bot and run the check again.",
)

/**
 * The helper's launch codes as verdicts, or null when the app started. A code
 * of 1 is not a bug: the helper refuses to launch a package the person is
 * already looking at, and that refusal must not be retried or worked around.
 */
private fun launchFailure(app: String, code: Int): ProbeOutcome? = when (code) {
    LAUNCH_OK -> null
    LAUNCH_IN_USE -> ProbeOutcome.fail(
        "$app is open on the person's screen, so the helper did not start it here",
        "Close $app on the phone's own screen and run the check again.",
    )
    LAUNCH_NO_ENTRY -> ProbeOutcome.fail("$app has no launcher entry on this phone")
    else -> ProbeOutcome.fail("the helper could not start $app (code $code)")
}

/** The helper's launchApp answers, named so the verdicts read the same way the AIDL does. */
internal const val LAUNCH_OK = 0
internal const val LAUNCH_IN_USE = 1
internal const val LAUNCH_NO_ENTRY = 2
internal const val LAUNCH_ERROR = 3

/** No launch was attempted: the helper was absent, no display opened, or no app was known. */
internal const val NO_LAUNCH = -1

/** Longest a probe waits for an app to reach the top of its own display. */
private const val LAUNCH_WAIT_MS = 4_000L
private const val LAUNCH_POLL_MS = 150L

/** Longest a probe waits for a readable tree after an app opened. */
private const val SNAPSHOT_WAIT_MS = 2_000L
private const val SNAPSHOT_POLL_MS = 250L

/** Longest a probe waits for a task to appear or to move between its own displays. */
private const val MOVE_WAIT_MS = 2_000L
private const val MOVE_POLL_MS = 150L
