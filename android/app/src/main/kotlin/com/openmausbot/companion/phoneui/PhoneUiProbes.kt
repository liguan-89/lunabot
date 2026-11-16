/*
 * The probes this app can actually answer for [runSelfCheck].
 *
 * PhoneUiSelfCheck.kt is the ported runner and the judge; it deliberately knows
 * nothing about Android. This file is the other half: it reads the system the
 * way PhoneUiController and PhoneUiTaskExecutor already do, and hands the
 * runner a probe for each check whose answer exists on this phone.
 *
 * Five checks have an answer here — DEVICE, PERMISSIONS, HELPER, VIRTUAL_DISPLAY
 * and MAIN_SCREEN. The rest are left out on purpose: this app has no in-app
 * browser (BROWSER), no on-device sandbox (SANDBOX), no profile enumeration
 * (APP_COPIES), and the checks that drive a display (APP_LAUNCH,
 * SCREEN_READING, ACTIONS, STAYS_ALIVE) would open an app or tap on the
 * person's behalf from a settings screen, which is not something a diagnostic
 * should do without being asked. A missing probe is reported as a skipped row
 * and the verdict as Incomplete, which is the honest answer.
 *
 * Every decision that is not a direct system read lives in a small pure
 * function below ([judgeDeviceWithHelper], [judgePermissions], [judgeHelper],
 * [judgeVirtualDisplay], [judgeMainScreen]) so the JVM tests pin the verdicts
 * without a phone.
 */
package com.openmausbot.companion.phoneui

import android.app.ActivityManager
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.view.Display
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.pm.PackageInfoCompat
import com.openmausbot.companion.phoneui.shell.PhoneUiShell

/**
 * One probe per check this app can answer, in the runner's order. The closures
 * are read when each probe runs, not when the map is built, so a run sees the
 * helper and the service as they are at that moment.
 */
internal fun phoneUiProbes(
    context: Context,
    shell: () -> PhoneUiShell?,
    accessibility: () -> PhoneUiAccessibilityService?,
): Map<PhoneUiCheck, Probe> {
    val app = context.applicationContext
    return mapOf(
        PhoneUiCheck.DEVICE to Probe { judgeDeviceWithHelper(deviceFacts(app), shell() != null) },
        PhoneUiCheck.PERMISSIONS to Probe { readPermissions(app, accessibility()) },
        PhoneUiCheck.HELPER to Probe {
            val helper = shell()
            judgeHelper(helper != null, helper?.let(::measureRoundTrip))
        },
        PhoneUiCheck.VIRTUAL_DISPLAY to Probe { openAndReleaseDisplay(shell()) },
        PhoneUiCheck.MAIN_SCREEN to Probe { readMainScreen(accessibility()) },
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
 * session: [PhoneUiDisplaySession.open] with the default size and density. The
 * display is released as soon as it exists, so a check never leaves one behind
 * for the next task to trip over.
 */
private fun openAndReleaseDisplay(helper: PhoneUiShell?): ProbeOutcome {
    helper ?: return ProbeOutcome.fail("the helper is not attached, so no display could be created")
    val opened = runCatching {
        PhoneUiDisplaySession.open(
            helper,
            PhoneUiRules.DEFAULT_WIDTH,
            PhoneUiRules.DEFAULT_HEIGHT,
            PhoneUiRules.DEFAULT_DPI,
        )
    }.getOrNull()
    val created = opened?.displayId ?: -1
    // Released either way: the check must not leave a display behind.
    runCatching { opened?.close() }
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
