package com.lunabot.companion.ui

import com.lunabot.companion.phoneui.PhoneUiCheck
import com.lunabot.companion.phoneui.ProbeResult
import com.lunabot.companion.phoneui.ProbeStatus
import com.lunabot.companion.phoneui.SelfCheckReport
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The 自检 sheet's Chinese half. `PhoneUiSelfCheck.kt` deliberately prints
 * English (a report pasted into an issue reads the same on every phone), so the
 * translation lives in [PhoneSelfCheckCopy] and is applied only at the sheet.
 *
 * Two things are worth pinning beyond the obvious mappings:
 *
 * - **Every check has a name.** A new [PhoneUiCheck] would otherwise fall out of
 *   the `when` as a compile error — but only if the `when` stays exhaustive, so
 *   the count assertion below fails first with a readable message.
 * - **Every fix sentence a probe can hand in has a translation.** The table is
 *   keyed by the English text, which no compiler checks against the probes, so
 *   a source scan compares the two: a probe sentence with no entry would print
 *   English under a Chinese row and nobody would notice until it failed on a
 *   real phone.
 */
class PhoneSelfCheckCopyTest {

    private val fixed = ProbeResult(
        check = PhoneUiCheck.PERMISSIONS,
        status = ProbeStatus.Fail,
        detail = "accessibility off, notification access on",
        elapsedMs = 12L,
        fix = "Turn on Luna Bot's screen-reading service in system settings → Accessibility.",
    )

    private fun report(vararg rows: ProbeResult) = SelfCheckReport(
        rows = rows.toList(),
        elapsedMs = 2_400L,
        verdict = when {
            rows.any { it.status == ProbeStatus.Fail } -> SelfCheckReport.Verdict.Fail
            rows.any { it.status == ProbeStatus.Skipped } -> SelfCheckReport.Verdict.Incomplete
            else -> SelfCheckReport.Verdict.Pass
        },
    )

    private fun passed(check: PhoneUiCheck) = ProbeResult(check, ProbeStatus.Pass, "ok")

    @Test
    fun `every check has a Chinese name`() {
        val names = PhoneUiCheck.entries.map(::phoneUiCheckLabel)
        assertEquals(PhoneUiCheck.entries.size, names.size)
        assertTrue(names.all { it.isNotBlank() }, "no check may print an empty name")
        assertTrue(names.all { name -> name.any { it.code in 0x4E00..0x9FFF } }, "every name is Chinese: $names")
        assertEquals(names.size, names.toSet().size, "two checks may not share a name: $names")
    }

    @Test
    fun `a passed row prints its number name and verdict`() {
        val row = ProbeResult(PhoneUiCheck.HELPER, ProbeStatus.Pass, "the helper is attached; one round trip took 4 ms")
        assertEquals("3 辅助进程：通过 — the helper is attached; one round trip took 4 ms", selfCheckLine(row))
    }

    @Test
    fun `a skipped row says it was skipped and carries no fix`() {
        val row = ProbeResult(
            check = PhoneUiCheck.VIRTUAL_DISPLAY,
            status = ProbeStatus.Skipped,
            detail = "needs helper (fail)",
            blockedBy = PhoneUiCheck.HELPER,
        )
        assertEquals("4 虚拟屏幕：跳过 — needs helper (fail)", selfCheckLine(row))
        assertNull(selfCheckFix(row), "a skip is explained by its row, not by a fix sentence")
    }

    @Test
    fun `the summary counts all three statuses and names the first fix`() {
        val report = report(
            passed(PhoneUiCheck.DEVICE),
            fixed,
            ProbeResult(PhoneUiCheck.HELPER, ProbeStatus.Skipped, "needs device (pass)", blockedBy = PhoneUiCheck.DEVICE),
        )
        assertEquals(
            "自检未通过：1 项通过，1 项失败，1 项跳过，用时 2 秒；先处理：在系统设置 → 无障碍里打开 Luna Bot 的屏幕读取服务。",
            selfCheckSummary(report),
        )
    }

    @Test
    fun `a clean run reads as a pass with no fix sentence`() {
        val report = report(passed(PhoneUiCheck.DEVICE), passed(PhoneUiCheck.PERMISSIONS))
        assertEquals("自检通过：2 项通过，0 项失败，0 项跳过，用时 2 秒", selfCheckSummary(report))
    }

    @Test
    fun `a failed row with no fix falls back to its name and detail`() {
        val row = ProbeResult(PhoneUiCheck.BROWSER, ProbeStatus.Fail, "no browser installed")
        assertEquals("浏览器：no browser installed", selfCheckSummary(report(row)).substringAfter("先处理："))
    }

    @Test
    fun `the fix line translates a known sentence`() {
        assertEquals(
            "在系统设置 → 无障碍里打开 Luna Bot 的屏幕读取服务。",
            selfCheckFix(fixed),
        )
    }

    @Test
    fun `an interpolated fix keeps its value`() {
        assertEquals(
            "请先在手机自己的屏幕上关闭 com.android.settings，再重新自检。",
            phoneUiFixText("Close com.android.settings on the phone's own screen and run the check again."),
        )
        assertEquals(
            "手机操作需要 Android 11 或更高版本；这台手机运行的是 Android 14。",
            phoneUiFixText("Phone control needs Android 11 or newer; this phone runs Android 14."),
        )
    }

    @Test
    fun `a fix with no translation is shown as written, not dropped`() {
        val sentence = "A sentence a future probe wrote and nobody translated."
        assertEquals(sentence, phoneUiFixText(sentence))
    }

    @Test
    fun `every fix sentence in the probes has a translation`() {
        val probes = sourceOf("phoneui/PhoneUiProbes.kt") + "\n" + sourceOf("phoneui/PhoneUiSelfCheck.kt")
        val sentences = fixSentencesIn(probes)
        assertTrue(sentences.size >= 20, "the scan found ${sentences.size} sentences, which is too few to trust")

        val untranslated = sentences.filter { phoneUiFixText(it) == it }
        assertEquals(emptyList(), untranslated, "these fix sentences would print English in the Chinese sheet")
    }

    /**
     * The second argument of every `ProbeOutcome.fail(detail, fix)` call, as
     * written in the source. A plain string literal only: an interpolated fix
     * (`"Close $app ..."`) is matched by prefix in [phoneUiFixText], not by the
     * table, so it is skipped here rather than reported as missing.
     *
     * Parsed rather than regexed because the first argument is often itself a
     * multi-line interpolated string with commas in it; a pattern that split on
     * commas would mistake a detail for a fix.
     */
    private fun fixSentencesIn(source: String): Set<String> {
        val found = mutableSetOf<String>()
        val lines = source.lines()
        var i = 0
        while (i < lines.size) {
            val open = lines[i].indexOf("ProbeOutcome.fail(")
            if (open < 0 || lines[i].trimEnd().endsWith(")")) {
                i++
                continue
            }
            // Collect the call's body up to the parenthesis that closes it.
            val body = StringBuilder()
            var depth = 1
            var j = i + 1
            while (j < lines.size && depth > 0) {
                for (ch in lines[j]) {
                    if (ch == '(') depth++
                    if (ch == ')') depth--
                    if (depth == 0) break
                    body.append(ch)
                }
                if (depth > 0) body.append('\n')
                j++
            }
            val args = splitTopLevelCommas(body.toString())
            if (args.size >= 2) {
                val fix = args[1].trim()
                if (fix.startsWith('"') && fix.endsWith('"') && '$' !in fix) {
                    found += fix.removeSurrounding("\"")
                }
            }
            i = j
        }
        return found
    }

    private fun splitTopLevelCommas(body: String): List<String> {
        val parts = mutableListOf<String>()
        var depth = 0
        var inString = false
        val current = StringBuilder()
        for (ch in body) {
            when {
                ch == '"' -> { inString = !inString; current.append(ch) }
                inString -> current.append(ch)
                ch == '(' || ch == '[' -> { depth++; current.append(ch) }
                ch == ')' || ch == ']' -> { depth--; current.append(ch) }
                ch == ',' && depth == 0 -> { parts += current.toString(); current.clear() }
                else -> current.append(ch)
            }
        }
        if (current.isNotBlank()) parts += current.toString()
        return parts
    }

    private fun sourceOf(relative: String): String {
        var directory: File? = File(".").absoluteFile
        while (directory != null) {
            for (prefix in listOf("", "app/")) {
                val file = File(directory, prefix + "src/main/kotlin/com/lunabot/companion/$relative")
                if (file.isFile) return file.readText()
            }
            directory = directory.parentFile
        }
        error("could not find $relative from ${File(".").absolutePath}")
    }
}
