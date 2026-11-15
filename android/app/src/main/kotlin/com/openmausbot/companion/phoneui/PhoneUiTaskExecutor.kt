package com.openmausbot.companion.phoneui

import android.content.Context
import android.os.Bundle
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import com.openmausbot.companion.core.PhoneTool
import com.openmausbot.companion.phone.PhoneToolOutcome
import com.openmausbot.companion.phoneui.shell.PhoneUiShell
import com.openmausbot.companion.phoneui.shell.PhoneUiShellBridge
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

/**
 * The bot-facing half of the phone-UI slice: answers the `PHONE_UI_*` tools
 * by driving the helper's own virtual display ([PhoneUiDisplaySession]) and
 * the accessibility service ([PhoneUiAccessibilityService]).
 *
 * Contract for [com.openmausbot.companion.phone.PhoneJobRunner]:
 * `suspend fun execute(tool: PhoneTool, arguments: JsonObject): PhoneToolOutcome`,
 * dispatching on `tool.wire`; unknown wires answer `unsupported`. Every call
 * fails closed unless the helper is attached, the accessibility service is
 * connected and the helper could create its own display — there is no
 * fallback to the phone's primary display, no shell/ADB/network access and
 * no screen capture anywhere in this slice.
 *
 * The display session lives across calls (a launch followed by observes and
 * taps acts on the same display) and is released after an idle timeout or
 * [release]; every creation and teardown path releases both the ImageReader
 * surface and the display.
 */
internal class PhoneUiTaskExecutor(context: Context) {
    private val bridge = PhoneUiShellBridge.of(context)
    private val packageManager = context.applicationContext.packageManager
    private val lock = Any()

    private var session: PhoneUiDisplaySession? = null
    private var lastUsedAtMs = 0L

    private enum class Action { OBSERVE, LAUNCH, TAP, TYPE, SCROLL, BACK }

    internal suspend fun execute(tool: PhoneTool, arguments: JsonObject): PhoneToolOutcome = withContext(Dispatchers.IO) {
        val action = actionOf(tool.wire)
            ?: return@withContext PhoneToolOutcome.Failure("这个工具不属于手机 UI。", "unsupported")
        try {
            val shell = bridge.shell.value
                ?: return@withContext PhoneToolOutcome.Failure("手机 UI 助手未连接，无法操作屏幕。", "denied")
            val service = PhoneUiAccessibilityService.instance.value
                ?: return@withContext PhoneToolOutcome.Failure("无障碍服务没有开启，请在系统设置中允许。", "denied")
            val session = acquireSession(shell, arguments)
                ?: return@withContext PhoneToolOutcome.Failure("无法创建受控的虚拟显示器。", "denied")
            when (action) {
                Action.OBSERVE -> service.withLatestSnapshot { observe(shell, service, session) }
                Action.LAUNCH -> launch(shell, arguments, session)
                Action.TAP -> service.withLatestSnapshot { tap(service, session, arguments) }
                Action.TYPE -> service.withLatestSnapshot { type(service, session, arguments) }
                Action.SCROLL -> service.withLatestSnapshot { scroll(service, session, arguments) }
                Action.BACK -> back(shell, session)
            }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Throwable) {
            PhoneToolOutcome.Failure(error.message?.takeIf { it.isNotBlank() } ?: "手机 UI 操作失败。", "denied")
        }
    }

    /** Drop the session display immediately; the idle timeout covers the normal path. */
    fun release() {
        synchronized(lock) {
            session?.close()
            session = null
        }
    }

    private fun actionOf(wire: String): Action? = when (wire) {
        "PHONE_UI_OBSERVE" -> Action.OBSERVE
        "PHONE_UI_LAUNCH" -> Action.LAUNCH
        "PHONE_UI_TAP" -> Action.TAP
        "PHONE_UI_TYPE" -> Action.TYPE
        "PHONE_UI_SCROLL" -> Action.SCROLL
        "PHONE_UI_BACK" -> Action.BACK
        else -> null
    }

    private fun acquireSession(shell: PhoneUiShell, arguments: JsonObject): PhoneUiDisplaySession? {
        synchronized(lock) {
            val now = System.currentTimeMillis()
            session?.let { current ->
                if (current.shell !== shell || now - lastUsedAtMs > PhoneUiRules.SESSION_IDLE_TIMEOUT_MS) {
                    current.close()
                    session = null
                }
            }
            session?.let { current ->
                lastUsedAtMs = now
                return current
            }
            val width = PhoneUiRules.clampedInt(arguments.string("width"), PhoneUiRules.DEFAULT_WIDTH, PhoneUiRules.MIN_WIDTH, PhoneUiRules.MAX_WIDTH)
            val height = PhoneUiRules.clampedInt(arguments.string("height"), PhoneUiRules.DEFAULT_HEIGHT, PhoneUiRules.MIN_HEIGHT, PhoneUiRules.MAX_HEIGHT)
            val dpi = PhoneUiRules.clampedInt(arguments.string("dpi"), PhoneUiRules.DEFAULT_DPI, PhoneUiRules.MIN_DPI, PhoneUiRules.MAX_DPI)
            val created = PhoneUiDisplaySession.open(shell, width, height, dpi) ?: return null
            session = created
            lastUsedAtMs = now
            return created
        }
    }

    // MARK: - Actions

    private fun observe(shell: PhoneUiShell, service: PhoneUiAccessibilityService, session: PhoneUiDisplaySession): PhoneToolOutcome {
        val snapshot = service.snapshot(session.displayId)
            ?: return PhoneToolOutcome.Failure("此 Android 版本无法按显示器读取窗口。", "unsupported")
        val topPackage = runCatching { shell.topPackage(session.displayId) }.getOrNull()
        return PhoneToolOutcome.Success(
            buildJsonObject {
                put("snapshot", snapshot.id)
                put("displayId", snapshot.displayId)
                topPackage?.let { put("topPackage", it) }
                put("truncated", snapshot.truncated)
                put("elements", JsonArray(snapshot.elements.map(::elementJson)))
            },
        )
    }

    private suspend fun launch(shell: PhoneUiShell, arguments: JsonObject, session: PhoneUiDisplaySession): PhoneToolOutcome {
        val pkg = arguments.string("app")
            ?: return PhoneToolOutcome.Failure("缺少参数 app。", "unsupported")
        if (!PhoneUiRules.isValidPackageName(pkg)) {
            return PhoneToolOutcome.Failure("包名不合法。", "unsupported")
        }
        if (packageManager.getLaunchIntentForPackage(pkg) == null) {
            return PhoneToolOutcome.Failure("这个应用没有安装，或者没有桌面入口。", "unsupported")
        }
        return when (shell.launchApp(session.displayId, pkg)) {
            0 -> settle(shell, pkg, session)
            1 -> PhoneToolOutcome.Failure("该应用正在主屏幕前台运行，请先在主屏幕退出它。", "foreground_required")
            2 -> PhoneToolOutcome.Failure("这个应用没有桌面入口。", "unsupported")
            else -> PhoneToolOutcome.Failure("启动应用失败。", "denied")
        }
    }

    private suspend fun settle(shell: PhoneUiShell, pkg: String, session: PhoneUiDisplaySession): PhoneToolOutcome {
        val deadline = System.currentTimeMillis() + PhoneUiRules.LAUNCH_SETTLE_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            if (runCatching { shell.topPackage(session.displayId) }.getOrNull() == pkg) {
                return PhoneToolOutcome.Success(
                    buildJsonObject {
                        put("launched", true)
                        put("package", pkg)
                        put("displayId", session.displayId)
                    },
                )
            }
            delay(PhoneUiRules.LAUNCH_POLL_INTERVAL_MS)
        }
        return PhoneToolOutcome.Failure("应用没有在受控显示器上出现在前台。", "timeout")
    }

    private fun tap(service: PhoneUiAccessibilityService, session: PhoneUiDisplaySession, arguments: JsonObject): PhoneToolOutcome {
        val node = resolvedNode(service, session, arguments)
            ?: return PhoneToolOutcome.Failure("元素引用无效或已过期，请先重新观察。", "denied")
        var target = node
        var hops = 0
        while (!target.isClickable) {
            if (hops++ >= PhoneUiRules.MAX_ANCESTOR_HOPS) {
                return PhoneToolOutcome.Failure("该元素及其上层元素都不可点击。", "denied")
            }
            val parent = target.parent
                ?: return PhoneToolOutcome.Failure("该元素及其上层元素都不可点击。", "denied")
            if (parent.windowId != node.windowId) {
                return PhoneToolOutcome.Failure("最近的可点击元素不在目标窗口内。", "denied")
            }
            target = parent
        }
        val performed = runCatching { target.performAction(AccessibilityNodeInfo.ACTION_CLICK) }.getOrDefault(false)
        return when {
            performed -> PhoneToolOutcome.Success(buildJsonObject { put("clicked", true) })
            else -> PhoneToolOutcome.Failure("点击没有被执行。", "denied")
        }
    }

    private fun type(service: PhoneUiAccessibilityService, session: PhoneUiDisplaySession, arguments: JsonObject): PhoneToolOutcome {
        val ref = arguments.string("ref")
            ?: return PhoneToolOutcome.Failure("必须先观察并提供目标输入框的 ref。", "unsupported")
        val text = arguments.string("text")
            ?: return PhoneToolOutcome.Failure("缺少参数 text。", "unsupported")
        if (text.length > PhoneUiRules.MAX_TYPE_TEXT) {
            return PhoneToolOutcome.Failure("要输入的文本过长。", "unsupported")
        }
        val node = resolvedNode(service, session, arguments)
            ?: return PhoneToolOutcome.Failure("元素引用无效或已过期，请先重新观察。", "denied")
        if (node.isPassword) {
            return PhoneToolOutcome.Failure("不能写入密码字段。", "denied")
        }
        val supportsSetText = node.actionList.any { it.id == AccessibilityNodeInfo.ACTION_SET_TEXT }
        if (!node.isEditable || !supportsSetText) {
            return PhoneToolOutcome.Failure("该元素不是可编辑输入框。", "denied")
        }
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        val performed = runCatching {
            node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        }.getOrDefault(false)
        return when {
            performed -> PhoneToolOutcome.Success(buildJsonObject { put("typed", true) })
            else -> PhoneToolOutcome.Failure("写入没有生效。", "denied")
        }
    }

    private fun scroll(service: PhoneUiAccessibilityService, session: PhoneUiDisplaySession, arguments: JsonObject): PhoneToolOutcome {
        val node = resolvedNode(service, session, arguments)
            ?: return PhoneToolOutcome.Failure("元素引用无效或已过期，请先重新观察。", "denied")
        if (!node.isScrollable) {
            return PhoneToolOutcome.Failure("该元素不可滚动。", "denied")
        }
        val action = when (arguments.string("direction")?.lowercase()) {
            null, "", "down", "forward" -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
            "up", "backward" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
            else -> return PhoneToolOutcome.Failure("direction 只支持 up 或 down。", "unsupported")
        }
        val performed = runCatching { node.performAction(action) }.getOrDefault(false)
        return when {
            performed -> PhoneToolOutcome.Success(buildJsonObject { put("scrolled", true) })
            else -> PhoneToolOutcome.Failure("滚动没有生效。", "denied")
        }
    }

    private fun back(shell: PhoneUiShell, session: PhoneUiDisplaySession): PhoneToolOutcome {
        // The helper refuses every key outside its whitelist; BACK is on it,
        // and the display id here is always one this slice created.
        val performed = runCatching { shell.injectKey(session.displayId, KeyEvent.KEYCODE_BACK) }.getOrDefault(false)
        return when {
            performed -> PhoneToolOutcome.Success(buildJsonObject { put("back", true) })
            else -> PhoneToolOutcome.Failure("返回键没有生效。", "denied")
        }
    }

    /** The node a ref points at, refreshed; null when the ref is not from the latest snapshot. */
    private fun resolvedNode(
        service: PhoneUiAccessibilityService,
        session: PhoneUiDisplaySession,
        arguments: JsonObject,
    ): AccessibilityNodeInfo? {
        val ref = arguments.string("ref") ?: return null
        val node = service.resolveNode(ref, session.displayId) ?: return null
        // refresh() re-reads the node in place; false means the window is gone.
        val refreshed = runCatching { node.refresh() }.getOrDefault(false)
        return if (refreshed) node else null
    }

    private fun elementJson(element: PhoneUiElement): JsonObject = buildJsonObject {
        put("ref", element.ref)
        element.viewId?.let { put("viewId", it) }
        element.className?.let { put("class", it) }
        element.text?.let { put("text", it) }
        element.description?.let { put("description", it) }
        put("bounds", JsonArray(element.bounds.map { JsonPrimitive(it) }))
        if (element.clickable) put("clickable", true)
        if (element.editable) put("editable", true)
        if (element.scrollable) put("scrollable", true)
        if (element.password) put("password", true)
    }
}

private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
