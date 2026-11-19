/*
 * Ported from Mika (https://github.com/wangzan101/Mika), files
 * core/src/main/kotlin/com/wangzan101/mika/core/selfcheck/SelfCheck.kt,
 * core/src/main/kotlin/com/wangzan101/mika/core/selfcheck/SelfCheckRunner.kt and
 * core/src/main/kotlin/com/wangzan101/mika/core/selfcheck/SelfCheckReport.kt.
 * Copyright 2026 wangzan101. The original is licensed under the Apache License,
 * Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 OpenMausBot contributors. Changes from the
 * original: repackaged under com.lunabot.companion.phoneui and translated
 * into English; no Android imports, no StateFlow and no progress stream — the
 * probes arrive as a map of [Probe], the clock as [runSelfCheck]'s parameter,
 * and the whole run is one suspend call returning a [SelfCheckReport], which is
 * what makes the order, the skips, the timeouts and the budget testable on the
 * JVM; Mika's three-way Pass/Partial/Fail becomes Pass/Fail/Skipped, so a
 * partial result is a Pass whose detail carries the caveat (Mika counted
 * Partial as passed for dependency purposes anyway); Mika's Advice enum, a key
 * into localized UI strings, becomes one optional fix sentence per probe,
 * because this module has no resources; Mika's release hook is gone because
 * nothing here owns a resource; and the minimum Android release is 11 (SDK 30),
 * the version PhoneUiController already refuses to run below, where Mika's
 * phone control starts at 12.
 *
 * This file is still only the runner and the judges: the probes arrive as a
 * map, and PhoneUiProbes.kt is where the Android reads live. The screen that
 * runs it is the 自检 row in Settings, which calls [runSelfCheck] with
 * [phoneUiProbes] on a background thread.
 */
package com.lunabot.companion.phoneui

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Every bound the self-check uses that is not a per-probe timeout; those live on
 * [PhoneUiCheck] so a caller rendering the list sees them.
 */
internal object PhoneUiSelfCheckLimits {
    /**
     * The whole run's budget, Mika's value: the per-probe timeouts add up to far
     * more than this, and a healthy run finishes well inside it. When it runs
     * out, the probes still pending are reported as skipped rather than dropped.
     */
    const val TOTAL_BUDGET_MS = 90_000L

    /** Longest detail kept in one report row; Mika's cap. */
    const val MAX_DETAIL = 200
}

/**
 * The checks a phone-UI self-check runs, in the order they run. [key] is the
 * English name a report prints, [timeoutMs] is how long one check may take (the
 * whole run has its own budget, [PhoneUiSelfCheckLimits.TOTAL_BUDGET_MS]), and
 * [needs] names the checks that must pass first: a check whose dependency did
 * not pass is skipped and its row says which one it was missing.
 *
 * The list and its order are Mika's, renamed onto this app's components. Each
 * check has a probe in PhoneUiProbes.kt; a caller that supplies no probe for
 * one reports it as skipped, which leaves the verdict [SelfCheckReport.Verdict.Incomplete]
 * rather than claiming a pass.
 */
internal enum class PhoneUiCheck(val key: String, val timeoutMs: Long) {
    /**
     * Model, OS release and SDK, ABI, memory, screen, whether wireless debugging
     * exists, and this app's version. Fails below [PhoneUiDeviceFacts.MIN_PHONE_SDK]
     * and when the environment has no way to start the helper at all.
     */
    DEVICE("device", 5_000),

    /**
     * The accessibility switch is on and [PhoneUiAccessibilityService] is
     * actually bound, notification access is granted, and the battery is
     * unrestricted.
     */
    PERMISSIONS("permissions", 5_000),

    /**
     * The shell helper answers: the process is up, how it was started, and one
     * round trip takes how long.
     */
    HELPER("helper", 15_000),

    /**
     * The helper can create a virtual display, and on Android 14+ the display
     * keeps its own focus (the trusted flags in PhoneUiPolicy).
     */
    VIRTUAL_DISPLAY("virtual display", 10_000),

    /**
     * Launching an app lands on the helper's display and not on the person's
     * screen. The check drives the system settings app, which every Android
     * phone has, and releases the display afterwards.
     */
    APP_LAUNCH("app launch", 20_000),

    /**
     * The accessibility tree of the helper's display is readable: at least one
     * node carries text or a resource id after an app was launched there.
     */
    SCREEN_READING("screen reading", 10_000),

    /**
     * One safe synthetic event — a back key — is accepted by the helper on its
     * own display. Nothing about the app's reaction is asserted.
     */
    ACTIONS("actions", 20_000),

    /**
     * After the display probes have run, the helper is still attached and can
     * create and release a second display: the run did not wedge the phone.
     */
    STAYS_ALIVE("stays alive", 25_000),

    /** The task at the top of the person's own screen did not change. */
    MAIN_SCREEN("main screen", 5_000),

    /** The default browser launches on the helper's display and comes to the front there. */
    BROWSER("browser", 15_000),

    /**
     * A task an app created on the helper's display stays there and can be
     * moved between the helper's own displays, while the person's top task is
     * unchanged: the sandbox really is isolated.
     */
    SANDBOX("sandbox", 20_000),

    /** How many launchable apps this app can see; counted only, and a pass needs at least one. */
    APP_COPIES("app copies", 10_000),
    ;

    /** The number the report prints, from 1. */
    val number: Int get() = ordinal + 1

    /** The checks that must pass before this one runs. */
    val needs: List<PhoneUiCheck>
        get() = when (this) {
            DEVICE, PERMISSIONS, BROWSER, SANDBOX -> emptyList()
            HELPER -> listOf(DEVICE)
            VIRTUAL_DISPLAY -> listOf(HELPER)
            APP_LAUNCH -> listOf(PERMISSIONS, VIRTUAL_DISPLAY)
            SCREEN_READING -> listOf(APP_LAUNCH)
            ACTIONS -> listOf(SCREEN_READING)
            STAYS_ALIVE -> listOf(SCREEN_READING)
            MAIN_SCREEN -> listOf(VIRTUAL_DISPLAY)
            APP_COPIES -> listOf(HELPER)
        }
}

/** What one probe answered. Only [Pass] lets the checks that need it run. */
internal enum class ProbeStatus { Pass, Fail, Skipped }

/**
 * One probe's answer. [detail] is the one line the report prints: a fact, in
 * English, with no account, package list, user content or serial number in it.
 * [fix] is the sentence shown when this probe failed — what the person should
 * do about it; when it is null the report falls back to the key and the detail.
 */
internal data class ProbeOutcome(val status: ProbeStatus, val detail: String, val fix: String? = null) {
    companion object {
        fun pass(detail: String) = ProbeOutcome(ProbeStatus.Pass, detail)
        fun fail(detail: String, fix: String? = null) = ProbeOutcome(ProbeStatus.Fail, detail, fix)
        fun skip(detail: String) = ProbeOutcome(ProbeStatus.Skipped, detail)
    }
}

/**
 * One check's implementation, supplied by the caller. Everything a probe needs
 * — the shell helper, the accessibility service, this app's own settings — comes
 * from the caller's closure, so this file never touches Android. A probe may
 * throw or hang: the runner records a throw as a failure and a hang as a
 * timeout, and neither stops the run.
 */
internal fun interface Probe {
    suspend fun run(): ProbeOutcome
}

/**
 * The device facts the DEVICE row is judged from, all read from public system
 * interfaces by the caller. [wirelessDebugging] is null when the system cannot
 * say; [developerOptionsPage] likewise. [phoneControlUnavailable] is the same
 * judgement the pairing flow makes: no way to start the helper in this
 * environment at all.
 */
internal data class PhoneUiDeviceFacts(
    val manufacturer: String,
    val model: String,
    val androidRelease: String,
    val sdk: Int,
    val abis: List<String>,
    val ramBytes: Long,
    val screenWidth: Int,
    val screenHeight: Int,
    val wirelessDebugging: Boolean?,
    val appVersion: String,
    val appBuild: String,
    val developerOptionsPage: Boolean? = null,
    val phoneControlUnavailable: Boolean = false,
) {
    /** The model, without repeating the manufacturer when the model already starts with it. */
    val modelName: String
        get() = if (model.startsWith(manufacturer, ignoreCase = true)) model.trim() else "$manufacturer $model".trim()

    val arm64: Boolean get() = ARM64 in abis

    companion object {
        const val ARM64 = "arm64-v8a"

        /** The oldest Android release PhoneUiController will run phone control on (11). */
        const val MIN_PHONE_SDK = 30

        /** From Android 14 a virtual display can keep its own focus. */
        const val OWN_FOCUS_SDK = 34
    }
}

/**
 * The DEVICE row's verdict, as a pure function of [PhoneUiDeviceFacts], so a
 * caller that can read the system builds its probe as `Probe { judgeDevice(facts()) }`.
 *
 * The order matters: too old is unfixable here and is named first; an
 * environment with no way to start the helper cannot be repaired by turning
 * anything on; missing wireless debugging leaves the helper startable over USB
 * only, which Mika treated as a partial result and this three-status module
 * records as a pass whose detail says so.
 */
internal fun judgeDevice(facts: PhoneUiDeviceFacts): ProbeOutcome {
    val detail = "Android ${facts.androidRelease} (SDK ${facts.sdk})" +
        ", ${facts.abis.firstOrNull() ?: "unknown ABI"}" +
        ", wireless debugging " + when (facts.wirelessDebugging) {
            true -> "present"
            false -> "missing"
            null -> "unknown"
        }
    return when {
        facts.sdk < PhoneUiDeviceFacts.MIN_PHONE_SDK -> ProbeOutcome.fail(
            "$detail; phone control needs Android 11+",
            "Phone control needs Android 11 or newer; this phone runs Android ${facts.androidRelease}.",
        )
        facts.phoneControlUnavailable -> ProbeOutcome.fail(
            "$detail, developer options page missing; phone control unavailable in this environment",
            "This environment has no way to start the phone-UI helper; pairing a computer or turning on developer options is what enables it.",
        )
        facts.wirelessDebugging == false -> ProbeOutcome.pass("$detail; the helper can only be started over USB")
        else -> ProbeOutcome.pass(detail)
    }
}

/**
 * One row of the report. [elapsedMs] is 0 for a check that never ran;
 * [blockedBy] is the dependency that made a skip happen; [fix] is the sentence
 * that names what to do about a failure.
 */
internal data class ProbeResult(
    val check: PhoneUiCheck,
    val status: ProbeStatus,
    val detail: String,
    val elapsedMs: Long = 0L,
    val blockedBy: PhoneUiCheck? = null,
    val fix: String? = null,
)

/**
 * What a self-check found: one row per check in [PhoneUiCheck] order, how long
 * the run took on the caller's clock, and the overall answer.
 */
internal data class SelfCheckReport(
    val rows: List<ProbeResult>,
    val elapsedMs: Long,
    val verdict: Verdict,
) {
    /**
     * Any failure fails the run. No failure but a skip means the run did not
     * finish everything it wanted to (a dependency broke, a probe is missing, or
     * the budget ran out), so it is neither a pass nor a fail.
     */
    enum class Verdict { Pass, Fail, Incomplete }

    /**
     * One sentence naming the first thing to fix, or null when nothing failed.
     * A probe may hand in its own sentence ([ProbeOutcome.fix]); otherwise the
     * row's key and detail stand in for it. "First" is the order the checks ran,
     * so the earliest broken prerequisite is the one named.
     */
    val firstFix: String?
        get() = rows.firstOrNull { it.status == ProbeStatus.Fail }?.let { row ->
            row.fix ?: "${row.check.key}: ${row.detail}"
        }

    /**
     * One line for a log or a settings screen: the verdict, the counts, the
     * elapsed time on the caller's clock, and what to fix first. Stable: two
     * runs that saw the same clock and the same outcomes print the same line.
     */
    fun summary(): String {
        val counts = ProbeStatus.entries.joinToString(", ") { status ->
            "${rows.count { it.status == status }} ${status.name.lowercase()}"
        }
        val head = "Self-check ${verdict.name.uppercase()}: $counts in ${nearestSeconds(elapsedMs)} s"
        val fix = firstFix ?: return head
        return "$head; first fix: $fix"
    }

    /** One row, in Mika's shape: `3 helper: FAIL — the helper is not running`. */
    fun line(row: ProbeResult): String {
        val head = "${row.check.number} ${row.check.key}: ${row.status.name.uppercase()}"
        return if (row.detail.isEmpty()) head else "$head — ${row.detail}"
    }

    /** The summary line, then one line per row; what a diagnostic log carries. */
    fun render(): String = buildString {
        appendLine(summary())
        for (row in rows) appendLine(line(row))
    }.trimEnd()
}

/**
 * Runs every check in [PhoneUiCheck] order and returns the report.
 *
 * - A check whose dependency did not pass is skipped, and the row names the
 *   dependency and what it did.
 * - Each check runs under its own timeout, further capped by what is left of
 *   [budgetMs]; overrunning either is a failure with a sentence, never an
 *   exception escaping this function.
 * - Once the budget is gone, every remaining check is a skipped row, not a
 *   silent omission.
 * - A probe that throws is recorded as a failure with its message clipped, and
 *   the run goes on. Only cancellation of the calling coroutine stops the run.
 * - A check with no probe in [probes] is skipped with "no probe supplied", so an
 *   incomplete map can never read as a pass.
 *
 * [nowMs] is the clock the report measures with, and in a test using `runTest`
 * the coroutine timeouts are driven by that same virtual clock.
 */
internal suspend fun runSelfCheck(
    probes: Map<PhoneUiCheck, Probe>,
    nowMs: () -> Long = System::currentTimeMillis,
    budgetMs: Long = PhoneUiSelfCheckLimits.TOTAL_BUDGET_MS,
): SelfCheckReport {
    val start = nowMs()
    val rows = mutableListOf<ProbeResult>()
    for (check in PhoneUiCheck.entries) {
        rows += runOne(check, probes[check], rows, start, nowMs, budgetMs)
    }
    return SelfCheckReport(
        rows = rows,
        elapsedMs = (nowMs() - start).coerceAtLeast(0L),
        verdict = verdictOf(rows),
    )
}

/**
 * Runs one check against the rows already recorded. [done] holds every earlier
 * check in list order, and [PhoneUiCheck.needs] only points backwards, so a
 * dependency's status is always there to read.
 */
private suspend fun runOne(
    check: PhoneUiCheck,
    probe: Probe?,
    done: List<ProbeResult>,
    start: Long,
    nowMs: () -> Long,
    budgetMs: Long,
): ProbeResult {
    val blocker = check.needs.firstOrNull { need -> done.first { it.check == need }.status != ProbeStatus.Pass }
    if (blocker != null) {
        val blockerStatus = done.first { it.check == blocker }.status
        return ProbeResult(
            check = check,
            status = ProbeStatus.Skipped,
            detail = "needs ${blocker.key} (${blockerStatus.name.lowercase()})",
            blockedBy = blocker,
        )
    }
    val left = budgetMs - (nowMs() - start)
    if (left <= 0) {
        return ProbeResult(check, ProbeStatus.Skipped, "out of time after ${ceilingSeconds(budgetMs)} s")
    }
    if (probe == null) return ProbeResult(check, ProbeStatus.Skipped, "no probe supplied")
    val startedAt = nowMs()
    val limit = minOf(check.timeoutMs, left)
    val outcome = try {
        withTimeoutOrNull(limit) { probe.run() }
            ?: ProbeOutcome.fail("timed out after ${ceilingSeconds(limit)} s")
    } catch (e: TimeoutCancellationException) {
        // The probe's own inner timeout fired; either way the check did not finish.
        ProbeOutcome.fail("timed out inside the check")
    } catch (e: CancellationException) {
        // The caller's coroutine was cancelled: that must reach the caller.
        throw e
    } catch (e: Exception) {
        ProbeOutcome.fail(threw(e))
    }
    return ProbeResult(
        check = check,
        status = outcome.status,
        detail = clip(outcome.detail),
        elapsedMs = (nowMs() - startedAt).coerceAtLeast(0L),
        fix = outcome.fix?.let(::clip),
    )
}

private fun verdictOf(rows: List<ProbeResult>): SelfCheckReport.Verdict = when {
    rows.any { it.status == ProbeStatus.Fail } -> SelfCheckReport.Verdict.Fail
    rows.any { it.status == ProbeStatus.Skipped } -> SelfCheckReport.Verdict.Incomplete
    else -> SelfCheckReport.Verdict.Pass
}

/** `threw IllegalStateException: the binder died`, with the message clipped. */
private fun threw(e: Exception): String {
    val name = e.javaClass.simpleName.ifEmpty { e.javaClass.name }
    val message = e.message?.takeIf { it.isNotBlank() }
    return if (message == null) "threw $name" else "threw $name: $message"
}

/** Mika's report rule: one line, and no longer than [PhoneUiSelfCheckLimits.MAX_DETAIL]. */
private fun clip(text: String): String {
    val flat = text.replace(WHITESPACE, " ").trim()
    return if (flat.length <= PhoneUiSelfCheckLimits.MAX_DETAIL) {
        flat
    } else {
        flat.take(PhoneUiSelfCheckLimits.MAX_DETAIL - 1) + "…"
    }
}

private val WHITESPACE = Regex("\\s+")

/** A timeout is rounded up: 1_001 ms is "2 s", because it did take more than one. */
private fun ceilingSeconds(ms: Long): Long = (ms + 999) / 1000

/** The summary rounds to the nearest second, as Mika's did. */
private fun nearestSeconds(ms: Long): Long = (ms + 500) / 1000
