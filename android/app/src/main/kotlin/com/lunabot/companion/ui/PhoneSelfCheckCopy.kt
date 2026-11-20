/*
 * The Chinese words the 自检 sheet prints.
 *
 * PhoneUiSelfCheck.kt is a port of Mika's self-check and, deliberately, has no
 * resources: its rows are English sentences (`3 helper: FAIL — ...`) so a report
 * pasted into an issue reads the same on every phone. This file is the display
 * half only. It maps a check's key to its Chinese name, a probe's status to
 * 通过/失败/跳过, and the fix sentence a failed probe carries to Chinese, and
 * leaves each row's *detail* in English — that half is a technical fact
 * (`Android 14 (SDK 34), arm64-v8a`) meant to be copied to a developer, and
 * translating it would lose the exact tokens they grep for.
 *
 * Nothing here touches the report itself: [SelfCheckReport.summary],
 * [SelfCheckReport.line] and `firstFix` stay as they are, English, for logs and
 * tests. The sheet calls these functions instead.
 *
 * A fix sentence that has no translation falls through unchanged rather than
 * being dropped, so a probe added later shows English until it is named here —
 * the same fail-open Mika's Advice enum could not do.
 */
package com.lunabot.companion.ui

import com.lunabot.companion.phoneui.PhoneUiCheck
import com.lunabot.companion.phoneui.ProbeResult
import com.lunabot.companion.phoneui.ProbeStatus
import com.lunabot.companion.phoneui.SelfCheckReport

/** The check's name as the sheet prints it. Keys stay English in the report. */
internal fun phoneUiCheckLabel(check: PhoneUiCheck): String = when (check) {
    PhoneUiCheck.DEVICE -> "设备"
    PhoneUiCheck.PERMISSIONS -> "权限"
    PhoneUiCheck.HELPER -> "辅助进程"
    PhoneUiCheck.VIRTUAL_DISPLAY -> "虚拟屏幕"
    PhoneUiCheck.APP_LAUNCH -> "应用启动"
    PhoneUiCheck.SCREEN_READING -> "屏幕读取"
    PhoneUiCheck.ACTIONS -> "操作注入"
    PhoneUiCheck.STAYS_ALIVE -> "持续在线"
    PhoneUiCheck.MAIN_SCREEN -> "主屏幕"
    PhoneUiCheck.BROWSER -> "浏览器"
    PhoneUiCheck.SANDBOX -> "隔离沙箱"
    PhoneUiCheck.APP_COPIES -> "应用列表"
}

internal fun phoneUiProbeStatusLabel(status: ProbeStatus): String = when (status) {
    ProbeStatus.Pass -> "通过"
    ProbeStatus.Fail -> "失败"
    ProbeStatus.Skipped -> "跳过"
}

private fun phoneUiVerdictLabel(verdict: SelfCheckReport.Verdict): String = when (verdict) {
    SelfCheckReport.Verdict.Pass -> "通过"
    SelfCheckReport.Verdict.Fail -> "未通过"
    SelfCheckReport.Verdict.Incomplete -> "未完成"
}

/**
 * The summary line: the verdict, the three counts, the elapsed time on the
 * caller's clock, and the first thing to fix. The counts are named rather than
 * positional so a skipped run cannot be read as a pass.
 */
internal fun selfCheckSummary(report: SelfCheckReport): String {
    fun count(status: ProbeStatus) = report.rows.count { it.status == status }
    val seconds = (report.elapsedMs + 500) / 1000
    val head = "自检${phoneUiVerdictLabel(report.verdict)}：" +
        "${count(ProbeStatus.Pass)} 项通过，" +
        "${count(ProbeStatus.Fail)} 项失败，" +
        "${count(ProbeStatus.Skipped)} 项跳过，用时 $seconds 秒"
    val fix = selfCheckFirstFix(report) ?: return head
    return "$head；先处理：$fix"
}

/** One row: `3 辅助进程：通过 — the helper is attached; one round trip took 4 ms`. */
internal fun selfCheckLine(row: ProbeResult): String {
    val head = "${row.check.number} ${phoneUiCheckLabel(row.check)}：" +
        phoneUiProbeStatusLabel(row.status)
    return if (row.detail.isEmpty()) head else "$head — ${row.detail}"
}

/**
 * The sentence under a failed row, or null when the probe did not name one.
 * A skip has nothing to fix — its row already says which earlier check blocked
 * it — so only failures carry a line.
 */
internal fun selfCheckFix(row: ProbeResult): String? {
    if (row.status != ProbeStatus.Fail) return null
    val fix = row.fix ?: return null
    return phoneUiFixText(fix)
}

/** The earliest failure's fix, or its row when the probe gave none. */
private fun selfCheckFirstFix(report: SelfCheckReport): String? {
    val row = report.rows.firstOrNull { it.status == ProbeStatus.Fail } ?: return null
    return row.fix?.let(::phoneUiFixText) ?: "${phoneUiCheckLabel(row.check)}：${row.detail}"
}

/**
 * The fix sentences PhoneUiProbes.kt and PhoneUiSelfCheck.kt hand in, keyed by
 * the English text they are written with. Three of them interpolate a value
 * (the app that is open, the Android release), so those are matched by their
 * prefix and suffix after the exact table misses.
 */
private val PHONE_UI_FIXES: Map<String, String> = mapOf(
    "Turn on Luna Bot's screen-reading service in system settings → Accessibility." to
        "在系统设置 → 无障碍里打开 Luna Bot 的屏幕读取服务。",
    "Turn the screen-reading service off and on again in system settings → Accessibility." to
        "在系统设置 → 无障碍里把屏幕读取服务关掉再打开。",
    "Allow Luna Bot notification access in system settings → Notification access." to
        "在系统设置 → 通知使用权里允许 Luna Bot 读取通知。",
    "Let Luna Bot run without battery optimisation in system settings → Battery." to
        "在系统设置 → 电池里允许 Luna Bot 不受电池优化限制。",
    "Open the wireless-debugging page, keep it on, and re-pair if the helper still does not start." to
        "打开无线调试页面并保持开启；辅助进程仍起不来就重新配对。",
    "The helper stopped answering; re-pairing restarts it." to
        "辅助进程已停止响应；重新配对可重启它。",
    "Re-pair the phone-UI connection; a helper that cannot create a display cannot run tasks." to
        "重新配对手机界面连接；创建不了虚拟屏幕的辅助进程无法执行任务。",
    "Run the check again; if it keeps not appearing, re-pairing restarts the helper's launcher." to
        "再自检一次；如果仍不出现，重新配对可重启辅助进程的启动器。",
    "Phone control needs Android 11 or newer." to
        "手机操作需要 Android 11 或更高版本。",
    "The app opened but exposed nothing to read; try the check again with the phone unlocked." to
        "应用已打开但没有任何可读内容；请解锁手机后再自检。",
    "Re-pair the phone-UI connection; a helper that refuses input cannot drive an app." to
        "重新配对手机界面连接；拒绝注入输入的辅助进程无法操作应用。",
    "Re-pair the phone-UI connection; a helper that drops mid-run cannot finish a task." to
        "重新配对手机界面连接；中途掉线的辅助进程无法完成任务。",
    "Re-pair the phone-UI connection; the helper is no longer handing out displays." to
        "重新配对手机界面连接；辅助进程已不再分配虚拟屏幕。",
    "Re-pair the phone-UI connection; the helper is attached but unresponsive." to
        "重新配对手机界面连接；辅助进程已连接但无响应。",
    "The helper may be wedged; re-pairing restarts it." to
        "辅助进程可能已卡死；重新配对可重启它。",
    "Unlock the phone and leave an app open, then run the check again." to
        "解锁手机并让一个应用保持打开，然后重新自检。",
    "Install or enable a browser, then run the check again." to
        "安装或启用一个浏览器，然后重新自检。",
    "Run the check again; if it stays behind, re-pairing restarts the helper's launcher." to
        "再自检一次；如果仍停在后面，重新配对可重启辅助进程的启动器。",
    "Re-pair the phone-UI connection; a task that lands elsewhere cannot be driven." to
        "重新配对手机界面连接；落到别处的任务无法被操作。",
    "Re-pair the phone-UI connection and run the check again." to
        "重新配对手机界面连接，然后重新自检。",
    "Run the check again with the phone idle; nothing in it should touch the person's screen." to
        "在手机空闲时重新自检；自检不应碰到你自己的屏幕。",
    "Re-pair the phone-UI connection; a task that cannot be moved cannot be kept in the sandbox." to
        "重新配对手机界面连接；无法移动的任务无法留在隔离沙箱里。",
    "Run the check again; if it stays unreadable, reinstall Luna Bot." to
        "再自检一次；如果仍然读不到，重装 Luna Bot。",
    "Package visibility is hiding every app; reinstalling Luna Bot restores its declared app query." to
        "包可见性把所有应用都藏起来了；重装 Luna Bot 可恢复它声明的应用查询。",
    "Package visibility or a stripped ROM is hiding every app; reinstall Luna Bot and run the check again." to
        "包可见性或精简过的 ROM 把所有应用都藏起来了；重装 Luna Bot 后再自检。",
    "This environment has no way to start the phone-UI helper; pairing a computer or turning on developer options is what enables it." to
        "这个环境无法启动手机界面辅助进程；配对一台电脑或打开开发者选项才能启用。",
)

/** `Close $app on the phone's own screen and run the check again.` */
private const val CLOSE_APP_PREFIX = "Close "
private const val CLOSE_APP_SUFFIX = " on the phone's own screen and run the check again."

/** `Phone control needs Android 11 or newer; this phone runs Android 14.` */
private const val NEEDS_ANDROID_11_PREFIX = "Phone control needs Android 11 or newer; this phone runs "

/** The Chinese for one fix sentence, or the sentence itself when it has none yet. */
internal fun phoneUiFixText(fix: String): String {
    PHONE_UI_FIXES[fix]?.let { return it }
    if (fix.startsWith(CLOSE_APP_PREFIX) && fix.endsWith(CLOSE_APP_SUFFIX)) {
        val app = fix.removePrefix(CLOSE_APP_PREFIX).removeSuffix(CLOSE_APP_SUFFIX)
        return "请先在手机自己的屏幕上关闭 $app，再重新自检。"
    }
    if (fix.startsWith(NEEDS_ANDROID_11_PREFIX) && fix.endsWith(".")) {
        val release = fix.removePrefix(NEEDS_ANDROID_11_PREFIX).removeSuffix(".")
        return "手机操作需要 Android 11 或更高版本；这台手机运行的是 $release。"
    }
    return fix
}
