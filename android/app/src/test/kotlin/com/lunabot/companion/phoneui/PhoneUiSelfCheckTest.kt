/*
 * Pins the self-check runner: the probe order, a failing prerequisite skipping
 * its dependents, a probe that throws or hangs becoming a failed row rather
 * than a crash, the per-probe timeout sentence, the total budget turning the
 * rest into skipped rows, and every elapsed time coming from the injected
 * clock. The clock here is a local variable the probes advance, so nothing in
 * this suite waits on wall time and the numbers in the assertions are exact.
 */
package com.lunabot.companion.phoneui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest

class PhoneUiSelfCheckTest {
    private fun SelfCheckReport.row(check: PhoneUiCheck): ProbeResult = rows[check.ordinal]

    /** One passing probe per check; [onEach] runs before each answers, so a test can move the clock. */
    private fun allPassing(onEach: () -> Unit = {}): MutableMap<PhoneUiCheck, Probe> =
        PhoneUiCheck.entries.associateWith { Probe { onEach(); ProbeOutcome.pass("ok") } }.toMutableMap()

    @Test
    fun `every probe passing is an overall pass`() = runTest {
        var clock = 0L
        val report = runSelfCheck(allPassing { clock += 100 }, nowMs = { clock })

        assertEquals(SelfCheckReport.Verdict.Pass, report.verdict)
        assertEquals(PhoneUiCheck.entries.size, report.rows.size)
        assertEquals(PhoneUiCheck.entries.toList(), report.rows.map { it.check })
        assertTrue(report.rows.all { it.status == ProbeStatus.Pass }, "every row passed")
        assertEquals(PhoneUiCheck.entries.size * 100L, report.elapsedMs)
        assertEquals(100L, report.row(PhoneUiCheck.DEVICE).elapsedMs)
        assertNull(report.firstFix)
    }

    @Test
    fun `a failing prerequisite skips its dependents and the report names it`() = runTest {
        var clock = 0L
        val probes = allPassing { clock += 10 }
        probes[PhoneUiCheck.DEVICE] = Probe { ProbeOutcome.fail("Android 9 (SDK 28)", "Update the phone.") }

        val report = runSelfCheck(probes, nowMs = { clock })

        val helper = report.row(PhoneUiCheck.HELPER)
        assertEquals(ProbeStatus.Skipped, helper.status)
        assertEquals(PhoneUiCheck.DEVICE, helper.blockedBy)
        assertEquals("needs device (fail)", helper.detail)
        assertEquals(0L, helper.elapsedMs, "a skipped check did not run")

        // The skip travels: the next check is missing a dependency that itself never ran.
        val display = report.row(PhoneUiCheck.VIRTUAL_DISPLAY)
        assertEquals(ProbeStatus.Skipped, display.status)
        assertEquals(PhoneUiCheck.HELPER, display.blockedBy)
        assertEquals("needs helper (skipped)", display.detail)

        // Checks with no dependency still ran, and the failure still decides the verdict.
        assertEquals(ProbeStatus.Pass, report.row(PhoneUiCheck.PERMISSIONS).status)
        assertEquals(ProbeStatus.Pass, report.row(PhoneUiCheck.BROWSER).status)
        assertEquals(SelfCheckReport.Verdict.Fail, report.verdict)
        assertEquals("Update the phone.", report.firstFix)
    }

    @Test
    fun `a probe that throws is a failure and the run continues`() = runTest {
        var clock = 0L
        val probes = allPassing { clock += 10 }
        probes[PhoneUiCheck.PERMISSIONS] = Probe { throw IllegalStateException("binder died") }

        val report = runSelfCheck(probes, nowMs = { clock })

        val permissions = report.row(PhoneUiCheck.PERMISSIONS)
        assertEquals(ProbeStatus.Fail, permissions.status)
        assertEquals("threw IllegalStateException: binder died", permissions.detail)
        // The check after it that needs permissions is skipped; the ones that need nothing ran.
        assertEquals(PhoneUiCheck.PERMISSIONS, report.row(PhoneUiCheck.APP_LAUNCH).blockedBy)
        assertEquals(ProbeStatus.Pass, report.row(PhoneUiCheck.BROWSER).status)
        assertEquals(ProbeStatus.Pass, report.row(PhoneUiCheck.SANDBOX).status)
        assertEquals(SelfCheckReport.Verdict.Fail, report.verdict)
    }

    @Test
    fun `a thrown message is clipped to one line of bounded length`() = runTest {
        var clock = 0L
        val probes = allPassing { clock += 10 }
        probes[PhoneUiCheck.PERMISSIONS] = Probe {
            throw IllegalStateException("line one\n" + "x".repeat(500))
        }

        val detail = runSelfCheck(probes, nowMs = { clock }).row(PhoneUiCheck.PERMISSIONS).detail

        assertEquals(PhoneUiSelfCheckLimits.MAX_DETAIL, detail.length)
        assertTrue(detail.endsWith("…"), "a clipped detail says so")
        assertTrue(!detail.contains('\n'), "the detail is one line")
    }

    @Test
    fun `a probe that outlives its timeout fails with the timeout sentence`() = runTest {
        var clock = 0L
        val probes = allPassing { clock += 10 }
        probes[PhoneUiCheck.DEVICE] = Probe {
            delay(Long.MAX_VALUE)
            ProbeOutcome.pass("unreachable")
        }

        val report = runSelfCheck(probes, nowMs = { clock })

        val device = report.row(PhoneUiCheck.DEVICE)
        assertEquals(ProbeStatus.Fail, device.status)
        assertEquals("timed out after 5 s", device.detail)
        // The run carried on: the dependents are skipped, the independent checks still ran.
        assertEquals(PhoneUiCheck.DEVICE, report.row(PhoneUiCheck.HELPER).blockedBy)
        assertEquals(ProbeStatus.Pass, report.row(PhoneUiCheck.PERMISSIONS).status)
        assertEquals(SelfCheckReport.Verdict.Fail, report.verdict)
    }

    @Test
    fun `the budget running out marks the rest skipped for budget`() = runTest {
        var clock = 0L
        val probes = allPassing { clock += 10 }
        probes[PhoneUiCheck.DEVICE] = Probe { clock += 1_000; ProbeOutcome.pass("spent the budget") }

        val report = runSelfCheck(probes, nowMs = { clock }, budgetMs = 1_000)

        assertEquals(ProbeStatus.Pass, report.row(PhoneUiCheck.DEVICE).status)
        val permissions = report.row(PhoneUiCheck.PERMISSIONS)
        assertEquals(ProbeStatus.Skipped, permissions.status)
        assertEquals("out of time after 1 s", permissions.detail)
        assertNull(permissions.blockedBy, "the budget, not a dependency, stopped it")

        // A check whose dependency passed but which has no time left is also a budget skip.
        val helper = report.row(PhoneUiCheck.HELPER)
        assertEquals(ProbeStatus.Skipped, helper.status)
        assertEquals("out of time after 1 s", helper.detail)

        // A dependency that never ran still wins, because that is the more specific reason.
        assertEquals(PhoneUiCheck.HELPER, report.row(PhoneUiCheck.VIRTUAL_DISPLAY).blockedBy)

        // Nothing failed, so the run is incomplete rather than failed or passed.
        assertEquals(SelfCheckReport.Verdict.Incomplete, report.verdict)
        assertEquals(1_000L, report.elapsedMs)
    }

    @Test
    fun `elapsed times come from the injected clock`() = runTest {
        var clock = 5_000L
        val probes = PhoneUiCheck.entries.associateWith { check ->
            Probe { clock += check.ordinal + 1L; ProbeOutcome.pass("ok") }
        }

        val report = runSelfCheck(probes, nowMs = { clock })

        assertEquals(1L, report.row(PhoneUiCheck.DEVICE).elapsedMs)
        assertEquals(2L, report.row(PhoneUiCheck.PERMISSIONS).elapsedMs)
        assertEquals(PhoneUiCheck.entries.sumOf { it.ordinal + 1L }, report.elapsedMs)
    }

    @Test
    fun `the summary names the first failure in run order`() = runTest {
        var clock = 0L
        val probes = allPassing { clock += 10 }
        probes[PhoneUiCheck.DEVICE] = Probe { ProbeOutcome.fail("Android 9 (SDK 28)", "Update the phone.") }
        probes[PhoneUiCheck.PERMISSIONS] = Probe {
            ProbeOutcome.fail("accessibility off", "Turn on accessibility.")
        }

        val report = runSelfCheck(probes, nowMs = { clock })

        assertEquals("Update the phone.", report.firstFix, "the earliest failing check is the one to fix first")
        assertEquals(
            "Self-check FAIL: 2 pass, 2 fail, 8 skipped in 0 s; first fix: Update the phone.",
            report.summary(),
        )
    }

    @Test
    fun `the summary is stable when everything passes`() = runTest {
        var clock = 0L
        val report = runSelfCheck(allPassing { clock += 100 }, nowMs = { clock })

        assertEquals("Self-check PASS: 12 pass, 0 fail, 0 skipped in 1 s", report.summary())
        assertEquals(report.summary(), report.summary(), "no timestamps or ordering leaks into the line")
        assertEquals(
            report.summary() + "\n" + report.rows.joinToString("\n") { report.line(it) },
            report.render(),
        )
    }

    @Test
    fun `a check with no probe is skipped, not passed`() = runTest {
        var clock = 0L
        val probes = allPassing { clock += 10 }
        probes.remove(PhoneUiCheck.MAIN_SCREEN)

        val report = runSelfCheck(probes, nowMs = { clock })

        val mainScreen = report.row(PhoneUiCheck.MAIN_SCREEN)
        assertEquals(ProbeStatus.Skipped, mainScreen.status)
        assertEquals("no probe supplied", mainScreen.detail)
        assertEquals(SelfCheckReport.Verdict.Incomplete, report.verdict)
    }

    @Test
    fun `the probe list is the ordered one the report renders`() {
        assertEquals(
            listOf(
                "device", "permissions", "helper", "virtual display", "app launch",
                "screen reading", "actions", "stays alive", "main screen",
                "browser", "sandbox", "app copies",
            ),
            PhoneUiCheck.entries.map { it.key },
        )
        assertEquals(
            listOf(
                5_000L, 5_000L, 15_000L, 10_000L, 20_000L, 10_000L,
                20_000L, 25_000L, 5_000L, 15_000L, 20_000L, 10_000L,
            ),
            PhoneUiCheck.entries.map { it.timeoutMs },
        )
        assertEquals((1..12).toList(), PhoneUiCheck.entries.map { it.number })

        assertEquals(emptyList<PhoneUiCheck>(), PhoneUiCheck.DEVICE.needs)
        assertEquals(listOf(PhoneUiCheck.DEVICE), PhoneUiCheck.HELPER.needs)
        assertEquals(listOf(PhoneUiCheck.HELPER), PhoneUiCheck.VIRTUAL_DISPLAY.needs)
        assertEquals(
            listOf(PhoneUiCheck.PERMISSIONS, PhoneUiCheck.VIRTUAL_DISPLAY),
            PhoneUiCheck.APP_LAUNCH.needs,
        )
        assertEquals(listOf(PhoneUiCheck.APP_LAUNCH), PhoneUiCheck.SCREEN_READING.needs)
        assertEquals(listOf(PhoneUiCheck.SCREEN_READING), PhoneUiCheck.ACTIONS.needs)
        assertEquals(listOf(PhoneUiCheck.SCREEN_READING), PhoneUiCheck.STAYS_ALIVE.needs)
        assertEquals(listOf(PhoneUiCheck.VIRTUAL_DISPLAY), PhoneUiCheck.MAIN_SCREEN.needs)
        assertEquals(listOf(PhoneUiCheck.HELPER), PhoneUiCheck.APP_COPIES.needs)
        assertTrue(
            PhoneUiCheck.entries.all { check -> check.needs.all { it.ordinal < check.ordinal } },
            "a dependency is always an earlier check, which is what makes one pass enough",
        )
    }

    @Test
    fun `the device verdict names a too-old Android and a helper that cannot start`() {
        val old = judgeDevice(facts(sdk = 29, release = "10"))
        assertEquals(ProbeStatus.Fail, old.status)
        assertTrue(old.detail.contains("phone control needs Android 11+"), old.detail)
        assertTrue(old.fix!!.contains("Android 11"), old.fix!!)

        val noWay = judgeDevice(facts(phoneControlUnavailable = true))
        assertEquals(ProbeStatus.Fail, noWay.status)
        assertTrue(noWay.detail.contains("phone control unavailable"), noWay.detail)

        // Missing wireless debugging is usable over USB: a pass whose detail says so.
        val noWireless = judgeDevice(facts(wirelessDebugging = false))
        assertEquals(ProbeStatus.Pass, noWireless.status)
        assertTrue(noWireless.detail.contains("wireless debugging missing"), noWireless.detail)
        assertTrue(noWireless.detail.contains("over USB"), noWireless.detail)

        val fine = judgeDevice(facts())
        assertEquals(ProbeStatus.Pass, fine.status)
        assertTrue(fine.detail.startsWith("Android 14 (SDK 34), arm64-v8a"), fine.detail)
    }

    private fun facts(
        sdk: Int = 34,
        release: String = "14",
        wirelessDebugging: Boolean? = true,
        phoneControlUnavailable: Boolean = false,
    ) = PhoneUiDeviceFacts(
        manufacturer = "Google",
        model = "Pixel 8",
        androidRelease = release,
        sdk = sdk,
        abis = listOf("arm64-v8a"),
        ramBytes = 8L * 1024 * 1024 * 1024,
        screenWidth = 1080,
        screenHeight = 2400,
        wirelessDebugging = wirelessDebugging,
        appVersion = "2.0.1",
        appBuild = "201",
        phoneControlUnavailable = phoneControlUnavailable,
    )
}
