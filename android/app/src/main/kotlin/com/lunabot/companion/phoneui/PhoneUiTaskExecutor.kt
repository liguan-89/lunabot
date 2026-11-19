package com.lunabot.companion.phoneui

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Bundle
import android.util.Base64
import android.view.accessibility.AccessibilityNodeInfo
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.FileProvider
import com.lunabot.companion.core.PhoneTool
import com.lunabot.companion.phone.PhoneFileStore
import com.lunabot.companion.phone.PhoneNoticeStore
import com.lunabot.companion.phone.PhoneToolOutcome
import com.lunabot.companion.storage.ChatPreferences
import com.lunabot.companion.phoneui.shell.PhoneUiPolicy
import com.lunabot.companion.phoneui.shell.PhoneUiShell
import com.lunabot.companion.phoneui.shell.PhoneUiShellBridge
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

/**
 * The bot-facing half of the phone-UI slice: answers the `PHONE_UI_*` tools
 * by driving the helper's own virtual display ([PhoneUiDisplaySession]) and
 * the accessibility service ([PhoneUiAccessibilityService]).
 *
 * Contract for [com.lunabot.companion.phone.PhoneJobRunner]:
 * `suspend fun execute(tool: PhoneTool, arguments: JsonObject): PhoneToolOutcome`,
 * dispatching on `tool.wire`; unknown wires answer `unsupported`. Screen
 * actions fail closed unless the helper is attached, the accessibility service
 * is connected and the helper could create its own display — there is no
 * fallback to the phone's primary display for input and no shell/ADB/network
 * access. File, notification and installed-app reads, and clipboard reads
 * through the helper, answer without a display, so a sleeping helper cannot
 * turn a read into a permission error. Pixels leave this slice only through
 * PHONE_UI_SCREENSHOT and PHONE_FILE_READ (a picture of the helper's display
 * or of a file the person allowed) and PHONE_UI_OCR (recognized text, never
 * the frame), and only when a bot asks for them.
 *
 * Every driving action follows the same shape: fingerprint the screen, run
 * the action, wait for the screen to actually change, then look at whether an
 * app escaped onto the person's own screen ([PhoneUiSpill]) and pull it back
 * when it did. The result carries the fresh screen so a bot does not need a
 * separate observe between steps.
 */
internal class PhoneUiTaskExecutor(context: Context) {
    private val appContext = context.applicationContext
    private val bridge = PhoneUiShellBridge.of(context)
    private val packageManager = appContext.packageManager
    private val files = PhoneFileStore(appContext)
    private val lock = Any()

    private var session: PhoneUiDisplaySession? = null
    private var lastUsedAtMs = 0L

    /** The bot's after-task choice, applied in [release]; null until it records one. */
    private val afterTask = PhoneUiAfterTask()

    /** The package the task drove most recently, for a choice that names none. */
    @Volatile
    private var lastPackage: String? = null

    /** Text on the screen the last action left behind, for the dwell's reading time. */
    @Volatile
    private var screenChars = 0

    /** How the screen is driven. FAST is the default and the old touch exactly: no waits, no jitter. */
    @Volatile
    private var pace = OperatingPace.FAST
    @Volatile
    private var gesturePace: GesturePace = GesturePace.Instant
    @Volatile
    private var typingPace: TypingPace = TypingPace.Instant
    @Volatile
    private var actionPace: ActionPace = ActionPace.Off

    /** Resolved once: which packages are the system's own questions, and which are home. */
    private val pickerPackages: Set<String> by lazy { PhoneUiSystemPickers.resolve(packageManager) }
    private val homePackages: Set<String> by lazy { PhoneUiSystemPickers.homePackages(packageManager) }

    private enum class Action {
        OBSERVE, COLLECT, QUERY, FIND, LAUNCH, LIST_APPS, TAP, TAP_AT, TYPE, SCROLL, SWIPE, KEY, BACK, RUN, WAIT,
        SCREENSHOT, OCR, CLIPBOARD_GET, CLIPBOARD_SET, NOTIF_LIST, FILE_LIST, FILE_READ, FILE_SEND, FILE_SHARE,
        SET_ALARM, SET_TIMER, OPEN_LINK, SHARE_TEXT, AFTER_TASK,
    }

    /** The pre-action fingerprint, plus the change verdict once an action has measured it. */
    private class Step(val before: String) {
        var changed: Boolean? = null
    }

    internal suspend fun execute(tool: PhoneTool, arguments: JsonObject): PhoneToolOutcome = withContext(Dispatchers.IO) {
        val action = actionOf(tool.wire)
            ?: return@withContext PhoneToolOutcome.Failure("这个工具不属于手机 UI。", CODE_UNSUPPORTED)
        try {
            // Reads that need neither the helper nor the screen answer first:
            // a sleeping helper must not turn them into a permission error.
            when (action) {
                Action.FILE_LIST -> return@withContext fileList(arguments)
                Action.FILE_READ -> return@withContext fileRead(arguments)
                Action.FILE_SEND -> return@withContext fileSend(arguments)
                Action.NOTIF_LIST -> return@withContext noticeList(arguments)
                Action.LIST_APPS -> return@withContext listApps(arguments)
                // An alarm and a timer are standard intents the Clock app answers
                // itself; neither the helper nor the screen is involved.
                Action.SET_ALARM -> return@withContext PhoneUiSystemActions.setAlarm(appContext, null, arguments)
                Action.SET_TIMER -> return@withContext PhoneUiSystemActions.setTimer(appContext, null, arguments)
                // Choosing what happens after the task touches nothing now: it
                // only records the choice release() applies, so it answers while
                // the helper is asleep too.
                Action.AFTER_TASK -> return@withContext afterTaskTool(arguments)
                else -> Unit
            }
            val shell = bridge.shell.value
                ?: return@withContext PhoneToolOutcome.Failure("手机 UI 助手未连接，无法操作屏幕。", CODE_DENIED)
            // The clipboard lives in a system service the helper reaches; the
            // screen is not involved.
            when (action) {
                Action.CLIPBOARD_GET -> return@withContext clipboardGet(shell)
                Action.CLIPBOARD_SET -> return@withContext clipboardSet(shell, arguments)
                // A link and shared text act on the display, so they need the
                // session, but not the accessibility service: they are plain intents.
                Action.OPEN_LINK, Action.SHARE_TEXT -> {
                    val opened = acquireSession(shell, arguments)
                        ?: return@withContext PhoneToolOutcome.Failure("无法创建受控的虚拟显示器。", CODE_DENIED)
                    return@withContext if (action == Action.OPEN_LINK) {
                        PhoneUiSystemActions.openLink(appContext, opened.displayId, arguments)
                    } else {
                        PhoneUiSystemActions.shareText(appContext, opened.displayId, arguments)
                    }
                }
                else -> Unit
            }
            val service = PhoneUiAccessibilityService.instance.value
                ?: return@withContext PhoneToolOutcome.Failure("无障碍服务没有开启，请在系统设置中允许。", CODE_DENIED)
            val session = acquireSession(shell, arguments)
                ?: return@withContext PhoneToolOutcome.Failure("无法创建受控的虚拟显示器。", CODE_DENIED)
            when (action) {
                Action.OBSERVE -> observe(shell, service, session)
                Action.QUERY -> query(service, session, arguments)
                Action.WAIT -> waitTool(shell, service, session, arguments)
                Action.SCREENSHOT -> screenshot(shell, service, session)
                Action.OCR -> ocr(session, arguments)
                Action.RUN -> PhoneUiRun(
                    snapshot = { service.snapshot(session.displayId) },
                    identify = { ref -> identityOf(service, session, ref) },
                    perform = { tool, args -> runStep(shell, service, session, tool, args) },
                    topPackage = { runCatching { shell.topPackage(session.displayId) }.getOrNull() },
                    elementJson = ::elementJson,
                ).execute(arguments)
                // Find is answered here rather than through write(): its refs come from
                // the snapshot the loop stopped on, and write() would take one more,
                // which rotates the registry and kills exactly those refs.
                Action.FIND -> find(shell, service, session, arguments)
                else -> write(shell, service, session) { step ->
                    when (action) {
                        Action.COLLECT -> collect(shell, service, session, arguments, step)
                        Action.LAUNCH -> launch(shell, arguments, session, step)
                        Action.TAP -> tap(shell, service, session, arguments, step)
                        Action.TAP_AT -> tapAt(shell, service, session, arguments, step)
                        Action.TYPE -> type(shell, service, session, arguments, step)
                        Action.SCROLL -> scroll(shell, service, session, arguments, step)
                        Action.SWIPE -> swipeTool(shell, service, session, arguments, step)
                        Action.KEY -> key(shell, service, session, arguments, step)
                        Action.FILE_SHARE -> shareFile(shell, service, session, arguments, step)
                        Action.BACK -> key(shell, service, session, buildJsonObject { put("key", "back") }, step)
                        else -> PhoneToolOutcome.Failure("这个工具不属于手机 UI。", CODE_UNSUPPORTED)
                    }
                }
            }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Throwable) {
            PhoneToolOutcome.Failure(
                error.message?.takeIf { it.isNotBlank() } ?: "手机 UI 操作失败。",
                CODE_DENIED,
            )
        }
    }

    /**
     * Drop the session display immediately, then apply the bot's after-task
     * choice: keeping is the default and leaves the app running in the
     * background on its last page, while closing finishes it through the
     * helper. The display goes first either way, so closing never races the
     * display's own release.
     */
    fun release() {
        synchronized(lock) {
            session?.close()
            session = null
        }
        when (val decision = afterTask.decide(lastPackage, appContext.packageName)) {
            // Keeping is today's behaviour: the display is gone, the app is not.
            PhoneUiAfterTask.Decision.Keep, PhoneUiAfterTask.Decision.Nothing -> Unit
            is PhoneUiAfterTask.Decision.Close -> {
                bridge.shell.value?.let { shell -> runCatching { shell.forceStop(decision.packageName) } }
            }
        }
        // The choice is one task's; the next task starts from the default again.
        afterTask.clear()
    }

    /**
     * PHONE_UI_AFTER_TASK: record whether the app stays or is finished when
     * the task ends. The choice is per task and release() applies it; nothing
     * on the phone changes here.
     */
    private fun afterTaskTool(arguments: JsonObject): PhoneToolOutcome {
        val choice = PhoneUiAfterTask.Choice.parse(arguments.string("action"))
            ?: return PhoneToolOutcome.Failure("action 只支持 keep 或 close。", CODE_UNSUPPORTED)
        val requested = arguments.string("app")
        if (requested != null && !PhoneUiRules.isValidPackageName(requested)) {
            return PhoneToolOutcome.Failure("包名不合法。", CODE_UNSUPPORTED)
        }
        val pkg = requested ?: lastPackage
        // Closing a package the caller may not name would finish the wrong app
        // later; refuse it here, where the bot can still choose another.
        if (choice == PhoneUiAfterTask.Choice.CLOSE) {
            val decision = PhoneUiAfterTask.whatToDo(choice, pkg, appContext.packageName, PhoneUiAfterTask.SYSTEM_UI_PACKAGES)
            if (decision !is PhoneUiAfterTask.Decision.Close) {
                return PhoneToolOutcome.Failure(
                    if (pkg == null) "还不知道要关闭哪个应用：先打开一个应用，或者用 app 指明包名。" else "不能关闭这个应用。",
                    CODE_UNSUPPORTED,
                )
            }
        }
        // A named package is stored as named; an omitted one stays omitted, so
        // release acts on whatever app the task drove last by then. The answer
        // already says which package that is right now.
        afterTask.record(choice, requested)
        return PhoneToolOutcome.Success(
            buildJsonObject {
                put("afterTask", choice.wire)
                if (pkg == null) put("package", JsonNull) else put("package", pkg)
            },
        )
    }

    /**
     * Opt into a pacing level from outside the executor. FAST is the default
     * and the old behaviour; the caller owns any setting that selects one, so
     * no preference is read here.
     */
    internal fun setPace(pace: OperatingPace) {
        this.pace = pace
        gesturePace = this.pace.gesturePace()
        typingPace = this.pace.typingPace()
        actionPace = this.pace.actionPace()
    }

    private fun actionOf(wire: String): Action? = when (wire) {
        "PHONE_UI_OBSERVE" -> Action.OBSERVE
        "PHONE_UI_COLLECT" -> Action.COLLECT
        "PHONE_UI_QUERY" -> Action.QUERY
        "PHONE_UI_FIND" -> Action.FIND
        "PHONE_UI_LAUNCH" -> Action.LAUNCH
        "PHONE_LIST_APPS" -> Action.LIST_APPS
        "PHONE_UI_TAP" -> Action.TAP
        "PHONE_UI_TAP_AT" -> Action.TAP_AT
        "PHONE_UI_TYPE" -> Action.TYPE
        "PHONE_UI_SCROLL" -> Action.SCROLL
        "PHONE_UI_SWIPE" -> Action.SWIPE
        "PHONE_UI_KEY" -> Action.KEY
        "PHONE_UI_BACK" -> Action.BACK
        "PHONE_UI_RUN" -> Action.RUN
        "PHONE_UI_WAIT" -> Action.WAIT
        "PHONE_UI_SCREENSHOT" -> Action.SCREENSHOT
        "PHONE_UI_OCR" -> Action.OCR
        "PHONE_CLIPBOARD_GET" -> Action.CLIPBOARD_GET
        "PHONE_CLIPBOARD_SET" -> Action.CLIPBOARD_SET
        "PHONE_NOTIF_LIST" -> Action.NOTIF_LIST
        "PHONE_FILE_LIST" -> Action.FILE_LIST
        "PHONE_FILE_READ" -> Action.FILE_READ
        "PHONE_FILE_SEND" -> Action.FILE_SEND
        "PHONE_FILE_SHARE" -> Action.FILE_SHARE
        "PHONE_SET_ALARM" -> Action.SET_ALARM
        "PHONE_SET_TIMER" -> Action.SET_TIMER
        "PHONE_OPEN_LINK" -> Action.OPEN_LINK
        "PHONE_SHARE_TEXT" -> Action.SHARE_TEXT
        "PHONE_UI_AFTER_TASK" -> Action.AFTER_TASK
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

    // MARK: - Screen reading

    /**
     * A JPEG of the helper display's newest frame plus the accessibility
     * snapshot of the same moment, so a bot can tie what it sees to refs.
     * Read only: taking a picture changes nothing on the phone.
     */
    private suspend fun screenshot(shell: PhoneUiShell, service: PhoneUiAccessibilityService, session: PhoneUiDisplaySession): PhoneToolOutcome {
        val frame = session.capture()
            ?: return PhoneToolOutcome.Failure("受控显示器暂时没有画面，请稍后再试。", "no_frame")
        val scaled = scaleDown(frame, MAX_IMAGE_DIMENSION)
        try {
            val bytes = ByteArrayOutputStream().also {
                scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, it)
            }.toByteArray()
            if (bytes.size > MAX_IMAGE_BYTES) {
                return PhoneToolOutcome.Failure("这一帧太大，暂时没有发送。", "image_too_large")
            }
            val snapshot = service.snapshot(session.displayId)
            val top = runCatching { shell.topPackage(session.displayId) }.getOrNull()
            return PhoneToolOutcome.Success(
                buildJsonObject {
                    put("image", Base64.encodeToString(bytes, Base64.NO_WRAP))
                    put("mimeType", "image/jpeg")
                    put("width", scaled.width)
                    put("height", scaled.height)
                    put("scale", scaled.width.toFloat() / session.width)
                    top?.let { put("topPackage", it) }
                    if (snapshot != null) {
                        put("snapshot", snapshot.id)
                        put("elements", JsonArray(snapshot.elements.map(::elementJson)))
                    }
                },
            )
        } finally {
            if (scaled !== frame) scaled.recycle()
            frame.recycle()
        }
    }

    /**
     * Text recognized on the newest frame, with each line's box in display
     * pixels. For screens whose accessibility tree says nothing: image tabs,
     * canvas-drawn UI, games.
     */
    private suspend fun ocr(session: PhoneUiDisplaySession, arguments: JsonObject): PhoneToolOutcome {
        val maxLines = (arguments.int("maxLines") ?: 120).coerceIn(1, 200)
        val frame = session.capture()
            ?: return PhoneToolOutcome.Failure("受控显示器暂时没有画面，请稍后再试。", "no_frame")
        return try {
            val lines = PhoneUiOcr.read(frame, maxLines = maxLines)
            PhoneToolOutcome.Success(
                buildJsonObject {
                    put("count", lines.size)
                    put(
                        "lines",
                        JsonArray(
                            lines.map { line ->
                                buildJsonObject {
                                    put("text", line.text)
                                    if (line.bounds.size == 4) {
                                        put("bounds", JsonArray(line.bounds.map { JsonPrimitive(it) }))
                                    }
                                }
                            },
                        ),
                    )
                },
            )
        } catch (error: Throwable) {
            PhoneToolOutcome.Failure("文字识别失败：${error.message ?: "未知错误"}", "ocr_failed")
        } finally {
            frame.recycle()
        }
    }

    private fun scaleDown(source: Bitmap, maxDimension: Int): Bitmap {
        val longest = maxOf(source.width, source.height)
        if (longest <= maxDimension) return source
        val ratio = maxDimension.toFloat() / longest
        return Bitmap.createScaledBitmap(
            source,
            (source.width * ratio).toInt().coerceAtLeast(1),
            (source.height * ratio).toInt().coerceAtLeast(1),
            true,
        )
    }

    /** The clipboard's plain text; anything that is not text reports as no text rather than as a failure. */
    private fun clipboardGet(shell: PhoneUiShell): PhoneToolOutcome {
        val text = runCatching { shell.readClipboard() }.getOrNull()
        return PhoneToolOutcome.Success(
            buildJsonObject {
                if (text == null) {
                    put("hasText", false)
                } else {
                    put("hasText", true)
                    put("text", text)
                }
            },
        )
    }

    private fun clipboardSet(shell: PhoneUiShell, arguments: JsonObject): PhoneToolOutcome {
        val text = arguments.string("text")
            ?: return PhoneToolOutcome.Failure("缺少参数 text。", CODE_UNSUPPORTED)
        if (text.isEmpty()) return PhoneToolOutcome.Failure("不能写入空文本。", CODE_UNSUPPORTED)
        if (text.length > PhoneUiPolicy.MAX_CLIPBOARD_CHARS) {
            return PhoneToolOutcome.Failure("剪贴板文本最长 ${PhoneUiPolicy.MAX_CLIPBOARD_CHARS} 字符。", CODE_UNSUPPORTED)
        }
        if (!runCatching { shell.writeClipboard(text) }.getOrDefault(false)) {
            return PhoneToolOutcome.Failure("写入剪贴板失败。", CODE_DENIED)
        }
        return PhoneToolOutcome.Success(
            buildJsonObject {
                put("written", true)
                put("length", text.length)
            },
        )
    }

    /**
     * The last notifications other apps posted, newest first. Refuses to
     * answer while the person has not granted notification access, so a
     * missing grant can never look like "nothing arrived".
     */
    private fun noticeList(arguments: JsonObject): PhoneToolOutcome {
        if (!ChatPreferences(appContext).phoneNotices.value) {
            return PhoneToolOutcome.Failure("机器人读取通知还没有开启。请在设置的「手机界面」里打开。", CODE_DENIED)
        }
        val enabled = runCatching {
            NotificationManagerCompat.getEnabledListenerPackages(appContext).contains(appContext.packageName)
        }.getOrDefault(false)
        if (!enabled) {
            return PhoneToolOutcome.Failure(
                "通知读取还没有授权。请在系统设置的通知使用权里允许 Luna Bot。",
                CODE_DENIED,
            )
        }
        val limit = (arguments.int("limit") ?: 10).coerceIn(1, 20)
        val sinceMinutes = arguments.int("sinceMinutes")?.coerceIn(1, 1_440)
        val since = sinceMinutes?.let { System.currentTimeMillis() - it * 60_000L } ?: 0L
        val notices = PhoneNoticeStore.recent(arguments.string("package"), since, limit)
        return PhoneToolOutcome.Success(
            buildJsonObject {
                put("count", notices.size)
                put(
                    "notifications",
                    JsonArray(
                        notices.map { notice ->
                            buildJsonObject {
                                put("package", notice.packageName)
                                notice.title?.let { put("title", it) }
                                notice.text?.let { put("text", it) }
                                put("postedAt", notice.postedAt)
                            }
                        },
                    ),
                )
            },
        )
    }

    /**
     * The apps PHONE_UI_LAUNCH would accept, with the labels a person sees.
     * The same launch-intent test launch() applies is the filter here, so this
     * list can never offer an app the next call refuses; nothing about the
     * screen, the helper or a session is needed to answer it.
     */
    private fun listApps(arguments: JsonObject): PhoneToolOutcome {
        val query = arguments.string("query")
        if ((query?.length ?: 0) > PhoneUiRules.MAX_APP_QUERY) {
            return PhoneToolOutcome.Failure("查询条件过长。", CODE_UNSUPPORTED)
        }
        val limit = PhoneUiRules.clampedLimit(
            arguments.int("limit"),
            PhoneUiRules.DEFAULT_APP_LIMIT,
            PhoneUiRules.MAX_APP_LIMIT,
        )
        val apps = runCatching {
            packageManager.getInstalledApplications(0)
                .filter { packageManager.getLaunchIntentForPackage(it.packageName) != null }
                .map { packageManager.getApplicationLabel(it).toString() to it.packageName }
        }.getOrElse { return PhoneToolOutcome.Failure("读取应用列表失败。", CODE_DENIED) }
        val matched = apps
            .filter { (label, pkg) ->
                query == null ||
                    label.contains(query, ignoreCase = true) ||
                    pkg.contains(query, ignoreCase = true)
            }
            // Case-insensitive so an app named "alarm" sorts by the label a
            // person reads, not by the case it happens to use.
            .sortedWith(compareBy<Pair<String, String>>({ it.first.lowercase() }, { it.second }))
        return PhoneToolOutcome.Success(
            buildJsonObject {
                put(
                    "apps",
                    JsonArray(
                        matched.take(limit).map { (label, pkg) ->
                            buildJsonObject {
                                put("package", pkg)
                                put("label", label)
                            }
                        },
                    ),
                )
                put("count", matched.size)
                put("truncated", matched.size > limit)
            },
        )
    }

    /**
     * Files the person allowed: gallery photos and the folder they granted.
     * Refuses while the switch is off or no source is readable, so an empty
     * answer never has to stand in for a missing permission.
     */
    private fun fileList(arguments: JsonObject): PhoneToolOutcome {
        if (!files.enabled()) {
            return PhoneToolOutcome.Failure("机器人读取文件还没有开启。请在设置的「手机界面」里打开。", CODE_DENIED)
        }
        val kind = (arguments.string("kind") ?: "any").lowercase()
        if (kind !in setOf("any", "image", "document")) {
            return PhoneToolOutcome.Failure("kind 只支持 any、image、document。", CODE_UNSUPPORTED)
        }
        if (!files.photosGranted() && files.treeUri() == null) {
            return PhoneToolOutcome.Failure(
                "还没有可读的来源：请允许相册权限，或在设置里授权一个文件夹。",
                CODE_DENIED,
            )
        }
        val limit = (arguments.int("limit") ?: 10).coerceIn(1, 12)
        val entries = runCatching { files.list(arguments.string("query"), kind, limit) }
            .getOrElse { return PhoneToolOutcome.Failure("列文件失败：${it.message ?: "未知错误"}", CODE_DENIED) }
        return PhoneToolOutcome.Success(
            buildJsonObject {
                put("count", entries.size)
                put(
                    "files",
                    JsonArray(
                        entries.map { entry ->
                            buildJsonObject {
                                put("fileId", entry.fileId)
                                put("name", entry.name)
                                entry.mime?.let { put("mime", it) }
                                put("size", entry.sizeBytes)
                                put("modifiedAt", entry.modifiedAt)
                                put("source", entry.source)
                            }
                        },
                    ),
                )
            },
        )
    }

    private suspend fun fileRead(arguments: JsonObject): PhoneToolOutcome {
        if (!files.enabled()) {
            return PhoneToolOutcome.Failure("机器人读取文件还没有开启。请在设置的「手机界面」里打开。", CODE_DENIED)
        }
        val fileId = arguments.string("fileId")
            ?: return PhoneToolOutcome.Failure("缺少参数 fileId。", CODE_UNSUPPORTED)
        val pages = (arguments.int("pages") ?: 3).coerceIn(1, 5)
        return try {
            when (val content = files.read(fileId, pages)) {
                is PhoneFileStore.Content.Image -> PhoneToolOutcome.Success(
                    buildJsonObject {
                        put("name", content.name)
                        put("mimeType", content.mime)
                        put("image", Base64.encodeToString(content.bytes, Base64.NO_WRAP))
                        put("width", content.width)
                        put("height", content.height)
                    },
                )
                is PhoneFileStore.Content.Text -> PhoneToolOutcome.Success(
                    buildJsonObject {
                        put("name", content.name)
                        put("text", content.text)
                        put("truncated", content.truncated)
                    },
                )
                is PhoneFileStore.Content.Unsupported -> PhoneToolOutcome.Failure(
                    "「${content.name}」是 ${content.mime ?: "未知类型"}，目前只能读图片、文本和 PDF。",
                    CODE_UNSUPPORTED,
                )
                is PhoneFileStore.Content.Bytes -> PhoneToolOutcome.Failure(
                    "PHONE_FILE_READ 不返回原始文件内容。",
                    CODE_UNSUPPORTED,
                )
            }
        } catch (problem: PhoneFileStore.FileProblem) {
            PhoneToolOutcome.Failure(problem.message ?: "读取文件失败。", problem.code)
        }
    }

    // MARK: - The shape every driving action shares

    private suspend fun write(
        shell: PhoneUiShell,
        service: PhoneUiAccessibilityService,
        session: PhoneUiDisplaySession,
        body: suspend (Step) -> PhoneToolOutcome,
    ): PhoneToolOutcome {
        // The dwell the last action still owes, plus reading time for the
        // screen it left behind. FAST owes zero, so this costs nothing until
        // someone opts into a slower pace. It runs before the fingerprint, so
        // a change during the wait is not mistaken for this action's.
        actionPace.waitBefore(screenChars).takeIf { it > 0 }?.let { delay(it) }
        val before = service.reading(session.displayId)
        val topBefore = runCatching { shell.topTaskId(MAIN_DISPLAY) }.getOrDefault(-1)
        val startedAt = System.currentTimeMillis()
        val step = Step(before.fingerprint)
        val outcome = body(step)
        // A spill verdict already says what happened on the person's screen;
        // re-checking it would move the same task twice. A failure is answered
        // as-is rather than costing another stabilization window.
        if (outcome is PhoneToolOutcome.Failure) return outcome
        if (step.changed == null) {
            step.changed = awaitChange(service, session, step.before)
        }
        val answer = spillAfter(shell, service, session, startedAt, topBefore)?.let { spill ->
            withScreen(spill, shell, service, session, step.changed)
        } ?: withScreen(outcome, shell, service, session, step.changed)
        // A screen that changed starts the dwell the next action waits out. It
        // is noted after the answer, so the app named is the one now in front.
        if (step.changed == true) actionPace.noteAction(lastPackage, newScreen = true)
        return answer
    }

    /**
     * One PHONE_UI_RUN step, through the path its own tool takes: the write
     * wrapper fingerprints, acts, waits and checks for a spill, so the step's
     * answer carries `changed` exactly as a single call would.
     */
    private suspend fun runStep(
        shell: PhoneUiShell,
        service: PhoneUiAccessibilityService,
        session: PhoneUiDisplaySession,
        tool: PhoneTool,
        arguments: JsonObject,
    ): PhoneToolOutcome {
        val action = actionOf(tool.wire)
            ?: return PhoneToolOutcome.Failure("这个工具不属于手机 UI。", CODE_UNSUPPORTED)
        return when (action) {
            Action.WAIT -> waitTool(shell, service, session, arguments)
            Action.LAUNCH -> write(shell, service, session) { step -> launch(shell, arguments, session, step) }
            Action.TAP -> write(shell, service, session) { step -> tap(shell, service, session, arguments, step) }
            Action.TYPE -> write(shell, service, session) { step -> type(shell, service, session, arguments, step) }
            Action.SCROLL -> write(shell, service, session) { step -> scroll(shell, service, session, arguments, step) }
            Action.SWIPE -> write(shell, service, session) { step -> swipeTool(shell, service, session, arguments, step) }
            Action.KEY -> write(shell, service, session) { step -> key(shell, service, session, arguments, step) }
            Action.BACK -> write(shell, service, session) { step ->
                key(shell, service, session, buildJsonObject { put("key", "back") }, step)
            }
            else -> PhoneToolOutcome.Failure("这个工具不属于手机 UI。", CODE_UNSUPPORTED)
        }
    }

    /**
     * What the element behind [ref] looks like now, for PHONE_UI_RUN to find
     * again after its next snapshot issues new refs. Read before that snapshot,
     * since taking one invalidates the ref. Null when the ref no longer
     * resolves; password fields report no text, as the snapshot does.
     */
    private fun identityOf(
        service: PhoneUiAccessibilityService,
        session: PhoneUiDisplaySession,
        ref: String,
    ): PhoneUiRun.Identity? {
        val node = service.resolveNode(ref, session.displayId) ?: return null
        val bounds = nodeBoundsOf(node) ?: return null
        val password = runCatching { node.isPassword }.getOrDefault(false)
        return PhoneUiRun.Identity(
            text = if (password) null else runCatching { PhoneUiRules.clampText(node.text?.toString()) }.getOrNull(),
            description = if (password) null else runCatching { PhoneUiRules.clampText(node.contentDescription?.toString()) }.getOrNull(),
            viewId = runCatching { node.viewIdResourceName?.takeIf { it.isNotEmpty() } }.getOrNull(),
            bounds = listOf(bounds.left, bounds.top, bounds.right, bounds.bottom),
        )
    }

    private suspend fun awaitChange(
        service: PhoneUiAccessibilityService,
        session: PhoneUiDisplaySession,
        before: String,
        capMs: Long = PhoneUiStability.CAP_MS,
    ): Boolean = PhoneUiStability.awaitChange(
        now = { System.currentTimeMillis() },
        sleep = { delay(it) },
        read = { service.reading(session.displayId) },
        before = before,
        capMs = capMs,
    )

    /**
     * An app started from a background context lands on the person's own
     * screen where our display cannot see it. If that happened during this
     * action, move the task back to our display (it keeps its own launching
     * app, unlike a relaunch) or stop for a system picker.
     */
    private suspend fun spillAfter(
        shell: PhoneUiShell,
        service: PhoneUiAccessibilityService,
        session: PhoneUiDisplaySession,
        since: Long,
        topBefore: Int,
    ): PhoneToolOutcome? {
        val arrival = awaitMainArrival(shell, topBefore) ?: return null
        val pkg = arrival.packageName ?: return null
        val decision = PhoneUiSpill.decide(
            arrivals = listOf(arrival),
            since = since,
            topBefore = topBefore,
            userTouchedAt = service.lastMainScreenTouchAtMs.takeIf { it > 0 },
            excludedPackages = setOf(appContext.packageName),
            pickerPackages = pickerPackages,
            homePackages = homePackages,
        )
        return when (decision.verdict) {
            PhoneUiSpill.Verdict.None -> null
            PhoneUiSpill.Verdict.LeaveForUser -> PhoneToolOutcome.Failure(
                "「$pkg」在用户的屏幕上问要用哪个应用。停在这里，让用户自己选；不要再点。",
                CODE_NEEDS_USER,
            )
            PhoneUiSpill.Verdict.PullBack -> {
                val before = service.reading(session.displayId)
                val moved = runCatching { shell.moveTask(arrival.taskId, session.displayId) }.getOrDefault(false)
                if (!moved) {
                    return PhoneToolOutcome.Failure(
                        "「$pkg」开到了用户的屏幕上，但这个系统不允许把它移回来。别再在这里操作，告诉用户屏幕上的情况。",
                        CODE_OPENED_ELSEWHERE,
                    )
                }
                awaitChange(service, session, before.fingerprint)
                PhoneToolOutcome.Success(
                    buildJsonObject {
                        put("pulledBack", pkg)
                        put("note", "这个应用本来开在用户的屏幕上，已经移回受控显示器；接着在这里操作。")
                    },
                )
            }
        }
    }

    private suspend fun awaitMainArrival(shell: PhoneUiShell, topBefore: Int): PhoneUiSpill.Arrival? {
        mainArrival(shell, topBefore)?.let { return it }
        val deadline = System.currentTimeMillis() + SPILL_PROBE_MS
        while (System.currentTimeMillis() < deadline) {
            delay(SPILL_POLL_MS)
            mainArrival(shell, topBefore)?.let { return it }
        }
        return null
    }

    private fun mainArrival(shell: PhoneUiShell, topBefore: Int): PhoneUiSpill.Arrival? {
        val top = runCatching { shell.topTaskId(MAIN_DISPLAY) }.getOrDefault(-1)
        if (top < 0 || top == topBefore) return null
        val pkg = runCatching { shell.packageOfTask(top) }.getOrNull()
        return PhoneUiSpill.Arrival(top, pkg, System.currentTimeMillis())
    }

    // MARK: - Actions

    private fun observe(shell: PhoneUiShell, service: PhoneUiAccessibilityService, session: PhoneUiDisplaySession): PhoneToolOutcome {
        val snapshot = service.snapshot(session.displayId)
            ?: return PhoneToolOutcome.Failure("此 Android 版本无法按显示器读取窗口。", CODE_UNSUPPORTED)
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

    /**
     * PHONE_UI_FIND: scroll one step at a time until the target appears or the
     * content stops changing, and answer with the matches and their refs.
     *
     * It is a screen write (it scrolls), so it opens the display and follows
     * the same pacing and spill rules as [write], but it does not go through
     * [write] itself: that wrapper takes one more snapshot at the end, which
     * would rotate the ref registry and invalidate the very refs the loop just
     * returned. The loop's own last snapshot is the newest one, so the refs it
     * issues are the ones PHONE_UI_TAP will resolve.
     */
    private suspend fun find(
        shell: PhoneUiShell,
        service: PhoneUiAccessibilityService,
        session: PhoneUiDisplaySession,
        arguments: JsonObject,
    ): PhoneToolOutcome {
        // The dwell the last action still owes, exactly as write() pays it.
        actionPace.waitBefore(screenChars).takeIf { it > 0 }?.let { delay(it) }
        val topBefore = runCatching { shell.topTaskId(MAIN_DISPLAY) }.getOrDefault(-1)
        val startedAt = System.currentTimeMillis()
        val answer = PhoneUiFind(
            snapshot = { service.snapshot(session.displayId) },
            topPackage = { runCatching { shell.topPackage(session.displayId) }.getOrNull() },
            // The same matcher PHONE_UI_QUERY uses, so the two tools cannot disagree.
            query = { target, elements -> elements.filter { matches(it, target.text, target.resourceId, target.role) } },
            scroll = { direction ->
                val one = Step(service.reading(session.displayId).fingerprint)
                val ref = service.snapshot(session.displayId)?.elements?.firstOrNull { it.scrollable }?.ref
                if (ref != null) {
                    scroll(shell, service, session, buildJsonObject { put("direction", direction); put("ref", ref) }, one) is PhoneToolOutcome.Success
                } else {
                    // The same stroke PHONE_UI_SCROLL falls back to with no scrollable element.
                    gesture(shell, session, if (direction == "down") "up" else "down", null)
                        .also { if (it) one.changed = awaitChange(service, session, one.before) }
                }
            },
            now = { System.currentTimeMillis() },
            fingerprint = { elements -> PhoneUiFind.fingerprint(elements) },
            elementJson = ::elementJson,
        ).execute(arguments)
        if (answer !is PhoneToolOutcome.Success) return answer
        val scrolled = (answer.result["scrolls"] as? JsonPrimitive)?.intOrNull ?: 0
        // The app the task drove last, for an after-task choice that names none.
        (answer.result["topPackage"] as? JsonPrimitive)?.contentOrNull?.let { lastPackage = it }
        // A scroll that moved the screen starts the next action's dwell, as any write does.
        if (scrolled > 0) actionPace.noteAction(lastPackage, newScreen = true)
        // Scrolling stays inside our display; this only catches an app that opened
        // a picker on the person's own screen along the way. A spill answer carries a
        // fresh screen through withScreen, whose refs are the ones then valid.
        spillAfter(shell, service, session, startedAt, topBefore)?.let { spill ->
            return withScreen(spill, shell, service, session, null)
        }
        return answer
    }

    /** PHONE_UI_COLLECT: several screens read by one call, through the scroll and settle the other actions use. */
    private suspend fun collect(
        shell: PhoneUiShell,
        service: PhoneUiAccessibilityService,
        session: PhoneUiDisplaySession,
        arguments: JsonObject,
        step: Step,
    ): PhoneToolOutcome {
        var before = step.before
        var moved = false
        val answer = PhoneUiCollect(
            snapshot = { service.snapshot(session.displayId) },
            scroll = { direction ->
                val one = Step(before)
                val ref = service.snapshot(session.displayId)?.elements?.firstOrNull { it.scrollable }?.ref
                val done = if (ref != null) {
                    scroll(shell, service, session, buildJsonObject { put("direction", direction); put("ref", ref) }, one) is PhoneToolOutcome.Success
                } else {
                    // The same stroke PHONE_UI_SCROLL falls back to on a screen with no scrollable element.
                    gesture(shell, session, if (direction == "down") "up" else "down", null)
                        .also { if (it) one.changed = awaitChange(service, session, one.before) }
                }
                before = service.reading(session.displayId).fingerprint
                moved = one.changed == true
                done
            },
            // The scroll already waited for its change; this only reports it.
            settle = { moved },
            topPackage = { runCatching { shell.topPackage(session.displayId) }.getOrNull() },
            height = session.height,
            elementJson = ::elementJson,
        ).execute(arguments)
        if (answer is PhoneToolOutcome.Success) step.changed = moved
        return answer
    }

    /**
     * The same snapshot PHONE_UI_OBSERVE reads, narrowed to the elements whose
     * text, view id or class matches what the bot asked. `count` is the total
     * before `limit`, so "nothing there" and "more than shown" stay distinct.
     */
    private fun query(
        service: PhoneUiAccessibilityService,
        session: PhoneUiDisplaySession,
        arguments: JsonObject,
    ): PhoneToolOutcome {
        val text = arguments.string("text")
        val resourceId = arguments.string("resourceId")
        val role = arguments.string("role")
        if (text == null && resourceId == null && role == null) {
            return PhoneToolOutcome.Failure("至少要给 text、resourceId 或 role 中的一个。", CODE_UNSUPPORTED)
        }
        if ((text?.length ?: 0) > PhoneUiRules.MAX_QUERY_TEXT ||
            (resourceId?.length ?: 0) > PhoneUiRules.MAX_QUERY_RESOURCE_ID ||
            (role?.length ?: 0) > PhoneUiRules.MAX_QUERY_ROLE
        ) {
            return PhoneToolOutcome.Failure("查询条件过长。", CODE_UNSUPPORTED)
        }
        val limit = PhoneUiRules.clampedLimit(
            arguments.int("limit"),
            PhoneUiRules.DEFAULT_QUERY_LIMIT,
            PhoneUiRules.MAX_QUERY_LIMIT,
        )
        val snapshot = service.snapshot(session.displayId)
            ?: return PhoneToolOutcome.Failure("此 Android 版本无法按显示器读取窗口。", CODE_UNSUPPORTED)
        val matched = snapshot.elements.filter { matches(it, text, resourceId, role) }
        return PhoneToolOutcome.Success(
            buildJsonObject {
                put("snapshot", snapshot.id)
                put(
                    // Only the selectors that actually narrowed the answer:
                    // `limit` is a bound, reported through count/truncated.
                    "query",
                    buildJsonObject {
                        text?.let { put("text", it) }
                        resourceId?.let { put("resourceId", it) }
                        role?.let { put("role", it) }
                    },
                )
                put("count", matched.size)
                put("truncated", matched.size > limit)
                put("elements", JsonArray(matched.take(limit).map(::elementJson)))
            },
        )
    }

    /**
     * Every filter that arrived has to hold: text against the element's own
     * text or description, resourceId against its view id, role against its
     * class name. Comparison is a case-insensitive substring, the way a person
     * would recognize a label.
     */
    private fun matches(element: PhoneUiElement, text: String?, resourceId: String?, role: String?): Boolean {
        if (text != null && !PhoneUiWait.textMatches(element, text)) return false
        if (resourceId != null && element.viewId?.contains(resourceId, ignoreCase = true) != true) return false
        if (role != null && element.className?.contains(role, ignoreCase = true) != true) return false
        return true
    }

    private suspend fun launch(
        shell: PhoneUiShell,
        arguments: JsonObject,
        session: PhoneUiDisplaySession,
        step: Step,
    ): PhoneToolOutcome {
        val pkg = arguments.string("app")
            ?: return PhoneToolOutcome.Failure("缺少参数 app。", CODE_UNSUPPORTED)
        if (!PhoneUiRules.isValidPackageName(pkg)) {
            return PhoneToolOutcome.Failure("包名不合法。", CODE_UNSUPPORTED)
        }
        if (packageManager.getLaunchIntentForPackage(pkg) == null) {
            return PhoneToolOutcome.Failure("这个应用没有安装，或者没有桌面入口。", CODE_UNSUPPORTED)
        }
        return when (shell.launchApp(session.displayId, pkg)) {
            0 -> settle(shell, pkg, session, step)
            1 -> PhoneToolOutcome.Failure("该应用正在主屏幕前台运行，请先在主屏幕退出它。", "foreground_required")
            2 -> PhoneToolOutcome.Failure("这个应用没有桌面入口。", CODE_UNSUPPORTED)
            else -> PhoneToolOutcome.Failure("启动应用失败。", CODE_DENIED)
        }
    }

    private suspend fun settle(
        shell: PhoneUiShell,
        pkg: String,
        session: PhoneUiDisplaySession,
        step: Step,
    ): PhoneToolOutcome {
        val deadline = System.currentTimeMillis() + PhoneUiRules.LAUNCH_SETTLE_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            if (runCatching { shell.topPackage(session.displayId) }.getOrNull() == pkg) {
                step.changed = true
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

    private suspend fun tapAt(
        shell: PhoneUiShell,
        service: PhoneUiAccessibilityService,
        session: PhoneUiDisplaySession,
        arguments: JsonObject,
        step: Step,
    ): PhoneToolOutcome {
        val x = arguments.int("x") ?: return PhoneToolOutcome.Failure("缺少参数 x。", CODE_UNSUPPORTED)
        val y = arguments.int("y") ?: return PhoneToolOutcome.Failure("缺少参数 y。", CODE_UNSUPPORTED)
        if (x !in 0 until session.width || y !in 0 until session.height) {
            return PhoneToolOutcome.Failure("坐标超出受控屏幕（${session.width}x${session.height}）。", CODE_UNSUPPORTED)
        }
        if (!injectTap(shell, session, gesturePace.tapAt(x, y))) {
            return PhoneToolOutcome.Failure("点击没有被执行。", CODE_DENIED)
        }
        step.changed = awaitChange(service, session, step.before)
        return PhoneToolOutcome.Success(
            buildJsonObject {
                put("tapped", true)
                put("x", x)
                put("y", y)
            },
        )
    }

    /**
     * Node click first; when that cannot work, a coordinate tap on the same
     * element, then a node click on the smallest target under that point.
     * Controls that look outward or like a toggle are never retried: a second
     * tap could send twice or flip the state back.
     */
    private suspend fun tap(
        shell: PhoneUiShell,
        service: PhoneUiAccessibilityService,
        session: PhoneUiDisplaySession,
        arguments: JsonObject,
        step: Step,
    ): PhoneToolOutcome {
        val ref = arguments.string("ref")
            ?: return PhoneToolOutcome.Failure("缺少参数 ref。", CODE_UNSUPPORTED)
        // Resolve the caller's ref before taking a fresh snapshot: a snapshot
        // rotates the registry, so the ref must be turned into a node first.
        val node = service.resolveNode(ref, session.displayId)
            ?: return PhoneToolOutcome.Failure(STALE_REF, CODE_DENIED)
        val label = runCatching { node.text?.toString() ?: node.contentDescription?.toString() }.getOrNull()
        val viewId = runCatching { node.viewIdResourceName }.getOrNull()
        val bounds = nodeBoundsOf(node)
        val outward = PhoneUiClickFallback.mayBeOutward(label, viewId)
        // Fresh refs for the target-under-the-point channel and the answer.
        val snapshot = service.snapshot(session.displayId)
            ?: return PhoneToolOutcome.Failure("此 Android 版本无法按显示器读取窗口。", CODE_UNSUPPORTED)

        val clickable = clickableAncestor(node)
        val clicked = clickable != null && perform(clickable, AccessibilityNodeInfo.ACTION_CLICK)
        if (clicked) {
            step.changed = awaitChange(service, session, step.before)
            return PhoneToolOutcome.Success(
                buildJsonObject {
                    put("clicked", true)
                    put("channel", "node")
                },
            )
        }
        // Nothing was clicked, so a coordinate tap cannot double-fire an
        // already-delivered click. Outward and toggle controls are still left
        // alone: their handlers ignore accessibility clicks but honour touches.
        if (outward) {
            return PhoneToolOutcome.Failure("这个按钮像发送、支付或确认一类的动作，没有改用坐标再点一次。", CODE_DENIED)
        }
        if (bounds == null) return PhoneToolOutcome.Failure("点击没有被执行。", CODE_DENIED)
        // The paced tap on the element; its Instant point is the element's centre.
        val coordinate = gesturePace.tap(bounds.left, bounds.top, bounds.right, bounds.bottom)
        val x = coordinate.x
        val y = coordinate.y
        if (!injectTap(shell, session, coordinate)) return PhoneToolOutcome.Failure("点击没有被执行。", CODE_DENIED)
        val changedByTap = awaitChange(service, session, step.before)
        step.changed = changedByTap
        if (changedByTap) {
            return PhoneToolOutcome.Success(
                buildJsonObject {
                    put("clicked", true)
                    put("channel", "coordinate")
                },
            )
        }
        // Last channel: the smallest clickable node under the point, never the
        // same element again. A custom drawing that ignores injected touches
        // often still answers a click on the node that owns it.
        val pick = PhoneUiClickFallback.pickTarget(
            x = x,
            y = y,
            screenWidth = session.width,
            screenHeight = session.height,
            candidates = snapshot.elements.mapNotNull { candidate ->
                val rect = boundsOf(candidate) ?: return@mapNotNull null
                if (!candidate.clickable) return@mapNotNull null
                // Never the same element again: its click was already tried and
                // the coordinate tap already landed on that same spot.
                if (rect == bounds) return@mapNotNull null
                PhoneUiClickFallback.Candidate(
                    item = candidate,
                    left = rect.left,
                    top = rect.top,
                    right = rect.right,
                    bottom = rect.bottom,
                    label = candidate.text ?: candidate.description,
                    viewId = candidate.viewId,
                    scrollable = candidate.scrollable,
                )
            },
        )
        if (pick != null) {
            val pickNode = service.resolveNode(pick.ref, session.displayId)
            if (pickNode != null && perform(pickNode, AccessibilityNodeInfo.ACTION_CLICK)) {
                step.changed = awaitChange(service, session, step.before)
                if (step.changed == true) {
                    return PhoneToolOutcome.Success(
                        buildJsonObject {
                            put("clicked", true)
                            put("channel", "fallback")
                        },
                    )
                }
            }
        }
        return PhoneToolOutcome.Success(
            buildJsonObject {
                put("clicked", true)
                put("channel", "none")
            },
        )
    }

    private suspend fun type(
        shell: PhoneUiShell,
        service: PhoneUiAccessibilityService,
        session: PhoneUiDisplaySession,
        arguments: JsonObject,
        step: Step,
    ): PhoneToolOutcome {
        val ref = arguments.string("ref")
            ?: return PhoneToolOutcome.Failure("必须先观察并提供目标输入框的 ref。", CODE_UNSUPPORTED)
        val text = arguments.string("text")
            ?: return PhoneToolOutcome.Failure("缺少参数 text。", CODE_UNSUPPORTED)
        if (text.length > PhoneUiRules.MAX_TYPE_TEXT) {
            return PhoneToolOutcome.Failure("要输入的文本过长。", CODE_UNSUPPORTED)
        }
        val node = resolvedNode(service, session, arguments)
            ?: return PhoneToolOutcome.Failure(STALE_REF, CODE_DENIED)
        if (node.isPassword) {
            return PhoneToolOutcome.Failure("不能写入密码字段。", CODE_DENIED)
        }
        val supportsSetText = node.actionList.any { it.id == AccessibilityNodeInfo.ACTION_SET_TEXT }
        if (node.isEditable && supportsSetText) {
            // A native field takes growing prefixes; a paced run writes them
            // with the planned waits, and FAST still writes the whole string once.
            if (setTextPaced(node, text)) {
                step.changed = awaitChange(service, session, step.before)
                return PhoneToolOutcome.Success(
                    buildJsonObject {
                        put("typed", true)
                        put("channel", "set_text")
                    },
                )
            }
        }
        // Web views and custom editors expose focus but not set-text; typed key
        // events reach them the way a person's keyboard would. Non-ASCII needs
        // an IME, which this slice does not own, so it is refused rather than
        // written as something else.
        if (!PhoneUiKeys.typeableText(text)) {
            return PhoneToolOutcome.Failure(
                "这个输入框不接受直接写入，而这段文本不是纯英文或数字；手机端还没有输入法接管。",
                CODE_UNSUPPORTED,
            )
        }
        runCatching { node.performAction(AccessibilityNodeInfo.ACTION_FOCUS) }
        val focused = runCatching { node.refresh() && node.isFocused }.getOrDefault(false)
        if (!focused) {
            return PhoneToolOutcome.Failure("这个输入框无法获得焦点，不能输入。", CODE_DENIED)
        }
        if (!typeKeysPaced(shell, session, text)) {
            return PhoneToolOutcome.Failure("写入没有生效。", CODE_DENIED)
        }
        step.changed = awaitChange(service, session, step.before)
        return PhoneToolOutcome.Success(
            buildJsonObject {
                put("typed", true)
                put("channel", "keys")
            },
        )
    }

    /**
     * Write [text] into a field that takes ACTION_SET_TEXT. A paced run writes
     * growing prefixes, each replacing the last, so the field's value is always
     * the prefix a person would have typed so far; [TypingPace.Instant] (FAST)
     * writes the whole string once, which is the old call exactly.
     *
     * [TypingPace.forField] is not consulted: its paste-only rule is about
     * fields that lose earlier writes, and this channel rewrites the whole
     * value on every step, so it never relies on one.
     */
    private suspend fun setTextPaced(node: AccessibilityNodeInfo, text: String): Boolean {
        val typing = typingPace
        if (!typing.paced) return setText(node, text)
        var previous = ""
        for (step in typing.plan(text)) {
            if (step.delayBeforeMs > 0) delay(step.delayBeforeMs)
            if (!setText(node, step.prefix)) return false
            previous = step.prefix
        }
        return previous == text
    }

    private fun setText(node: AccessibilityNodeInfo, text: String): Boolean {
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        return performWith(node, AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    /**
     * Type [text] through the helper's key events. A paced run sends each
     * segment's incremental suffix after the planned wait, so the field grows
     * the way a person's typing does; [TypingPace.Instant] sends the whole
     * string in one call, as before.
     *
     * [TypingPace.forField] is not consulted here: its paste-only rule covers
     * set-text writes into a web view, and key events are exactly what such a
     * field does accept.
     */
    private suspend fun typeKeysPaced(
        shell: PhoneUiShell,
        session: PhoneUiDisplaySession,
        text: String,
    ): Boolean {
        val typing = typingPace
        if (!typing.paced) return runCatching { shell.typeText(session.displayId, text) }.getOrDefault(false)
        var previous = ""
        for (step in typing.plan(text)) {
            if (step.delayBeforeMs > 0) delay(step.delayBeforeMs)
            val suffix = step.prefix.substring(previous.length)
            if (suffix.isNotEmpty() && !runCatching { shell.typeText(session.displayId, suffix) }.getOrDefault(false)) {
                return false
            }
            previous = step.prefix
        }
        return previous == text
    }

    private suspend fun scroll(
        shell: PhoneUiShell,
        service: PhoneUiAccessibilityService,
        session: PhoneUiDisplaySession,
        arguments: JsonObject,
        step: Step,
    ): PhoneToolOutcome {
        val forward = when (arguments.string("direction")?.lowercase()) {
            null, "", "down", "forward" -> true
            "up", "backward" -> false
            else -> return PhoneToolOutcome.Failure("direction 只支持 up 或 down。", CODE_UNSUPPORTED)
        }
        val node = resolvedNode(service, session, arguments)
            ?: return PhoneToolOutcome.Failure(STALE_REF, CODE_DENIED)
        val scrollable = scrollableAncestor(node)
        if (scrollable != null) {
            val action = if (forward) {
                AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
            } else {
                AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
            }
            if (perform(scrollable, action)) {
                step.changed = awaitChange(service, session, step.before)
                return PhoneToolOutcome.Success(
                    buildJsonObject {
                        put("scrolled", true)
                        put("channel", "node")
                    },
                )
            }
        }
        // Lists in web views, launchers and short-video apps ignore the scroll
        // action; a real finger stroke is what their own gesture handling sees.
        val area = scrollable?.let { nodeBoundsOf(it) }
        if (!gesture(shell, session, if (forward) "up" else "down", area)) {
            return PhoneToolOutcome.Failure("滚动没有生效。", CODE_DENIED)
        }
        step.changed = awaitChange(service, session, step.before)
        return PhoneToolOutcome.Success(
            buildJsonObject {
                put("scrolled", true)
                put("channel", "gesture")
            },
        )
    }

    private suspend fun swipeTool(
        shell: PhoneUiShell,
        service: PhoneUiAccessibilityService,
        session: PhoneUiDisplaySession,
        arguments: JsonObject,
        step: Step,
    ): PhoneToolOutcome {
        val direction = arguments.string("direction")?.lowercase()
            ?: return PhoneToolOutcome.Failure("缺少参数 direction。", CODE_UNSUPPORTED)
        if (direction !in setOf("up", "down", "left", "right")) {
            return PhoneToolOutcome.Failure("direction 只支持 up、down、left、right。", CODE_UNSUPPORTED)
        }
        if (!gesture(shell, session, direction, null)) {
            return PhoneToolOutcome.Failure("滑动手势没有生效。", CODE_DENIED)
        }
        step.changed = awaitChange(service, session, step.before)
        return PhoneToolOutcome.Success(
            buildJsonObject {
                put("swiped", true)
                put("direction", direction)
            },
        )
    }

    private fun fileSend(arguments: JsonObject): PhoneToolOutcome {
        if (!files.enabled()) {
            return PhoneToolOutcome.Failure("机器人读取文件还没有开启。请在设置的「手机界面」里打开。", CODE_DENIED)
        }
        val fileId = arguments.string("fileId")
            ?: return PhoneToolOutcome.Failure("缺少参数 fileId。", CODE_UNSUPPORTED)
        val content = try {
            files.bytesFor(fileId)
        } catch (problem: PhoneFileStore.FileProblem) {
            return PhoneToolOutcome.Failure(problem.message ?: "读取文件失败。", problem.code)
        }
        return PhoneToolOutcome.Success(
            buildJsonObject {
                put(
                    "attachment",
                    buildJsonObject {
                        put("name", content.name)
                        put("mime", content.mime)
                        put("data", Base64.encodeToString(content.data, Base64.NO_WRAP))
                    },
                )
            },
        )
    }

    private suspend fun shareFile(
        shell: PhoneUiShell,
        service: PhoneUiAccessibilityService,
        session: PhoneUiDisplaySession,
        arguments: JsonObject,
        step: Step,
    ): PhoneToolOutcome {
        if (!files.enabled()) {
            return PhoneToolOutcome.Failure("机器人读取文件还没有开启。请在设置的「手机界面」里打开。", CODE_DENIED)
        }
        val fileId = arguments.string("fileId")
            ?: return PhoneToolOutcome.Failure("缺少参数 fileId。", CODE_UNSUPPORTED)
        val requested = arguments.string("package")
        if (requested != null && !PhoneUiRules.isValidPackageName(requested)) {
            return PhoneToolOutcome.Failure("包名不合法。", CODE_UNSUPPORTED)
        }
        val uri = try {
            files.uriFor(fileId)
        } catch (problem: PhoneFileStore.FileProblem) {
            return PhoneToolOutcome.Failure(problem.message ?: "文件编号无效。", problem.code)
        }
        val mime = files.mimeOf(uri, "文件")
        // The helper opens the share screen as shell (which already holds
        // storage access), so the file grant works while this app is in the
        // background — a start from here would be blocked as a background
        // activity launch. The target must hold a URI grant first: shell cannot
        // delegate one it does not own.
        val target = requested ?: runCatching {
            packageManager.resolveActivity(
                Intent(Intent.ACTION_SEND).setType(mime),
                PackageManager.MATCH_DEFAULT_ONLY,
            )?.activityInfo?.packageName
        }.getOrNull() ?: return PhoneToolOutcome.Failure(
            "没有能接收 $mime 的默认应用；请指定接收的应用包名。",
            CODE_UNSUPPORTED,
        )
        if (requested != null) {
            val resolvesTo = runCatching {
                packageManager.queryIntentActivities(
                    Intent(Intent.ACTION_SEND).setType(mime).setPackage(requested),
                    0,
                )
            }.getOrNull()?.any { it.activityInfo?.packageName == requested } ?: false
            if (!resolvesTo) {
                return PhoneToolOutcome.Failure("「$requested」没有能接收 $mime 的分享入口。", CODE_UNSUPPORTED)
            }
        }
        val granted = runCatching {
            // A folder document's grant belongs to this app and cannot be
            // handed on; the copy served by our own provider can.
            val shareUri = if (files.isFolderFile(fileId)) {
                val copy = files.copyForShare(fileId)
                FileProvider.getUriForFile(appContext, "${appContext.packageName}.share", copy)
            } else {
                uri
            }
            appContext.grantUriPermission(target, shareUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            shareUri
        }.getOrNull() ?: return PhoneToolOutcome.Failure("无法把这个文件授权给「$target」。", CODE_DENIED)
        val shareCode = runCatching { shell.shareIntent(session.displayId, granted.toString(), mime, target) }.getOrDefault(-1)
        when (shareCode) {
            0 -> Unit
            2 -> return PhoneToolOutcome.Failure("「$target」没有能接收 $mime 的分享入口。", CODE_UNSUPPORTED)
            4 -> return PhoneToolOutcome.Failure("系统拒绝把这个文件交给「$target」。", CODE_DENIED)
            5 -> return PhoneToolOutcome.Failure("系统没有在受控屏幕上启动「$target」。", CODE_DENIED)
            else -> return PhoneToolOutcome.Failure("无法在受控屏幕上打开分享（$shareCode）。", CODE_DENIED)
        }
        // A start the system silently dropped looks like success; a compose
        // screen appearing is the only proof it landed on our display.
        val changed = awaitChange(service, session, step.before)
        step.changed = changed
        if (!changed) {
            return PhoneToolOutcome.Failure(
                "分享没有开在受控屏幕上（系统可能拦截了后台启动）。",
                CODE_DENIED,
            )
        }
        return PhoneToolOutcome.Success(
            buildJsonObject {
                put("shared", true)
                put("mime", mime)
                put("package", target)
                put("note", "分享面板已开在受控屏幕上：接着观察、选目标、填收件人；发送按钮仍需审批。")
            },
        )
    }

    private suspend fun key(
        shell: PhoneUiShell,
        service: PhoneUiAccessibilityService,
        session: PhoneUiDisplaySession,
        arguments: JsonObject,
        step: Step,
    ): PhoneToolOutcome {
        val name = arguments.string("key") ?: "back"
        val code = PhoneUiKeys.codeOf(name)
            ?: return PhoneToolOutcome.Failure("不支持的按键。可选：back、enter、del、tab、up、down、left、right。", CODE_UNSUPPORTED)
        if (!runCatching { shell.injectKey(session.displayId, code) }.getOrDefault(false)) {
            return PhoneToolOutcome.Failure("按键没有生效。", CODE_DENIED)
        }
        step.changed = awaitChange(service, session, step.before)
        return PhoneToolOutcome.Success(buildJsonObject { put("key", name) })
    }

    private suspend fun waitTool(
        shell: PhoneUiShell,
        service: PhoneUiAccessibilityService,
        session: PhoneUiDisplaySession,
        arguments: JsonObject,
    ): PhoneToolOutcome {
        val mode = (arguments.string("mode") ?: "change").lowercase()
        val timeout = (arguments.int("timeoutMs") ?: DEFAULT_WAIT_MS).coerceIn(MIN_WAIT_MS, MAX_WAIT_MS).toLong()
        val read = { service.reading(session.displayId) }
        return when (mode) {
            "settle" -> {
                PhoneUiStability.awaitSettled({ System.currentTimeMillis() }, { delay(it) }, read, timeout)
                withScreen(
                    PhoneToolOutcome.Success(buildJsonObject { put("settled", true) }),
                    shell, service, session, null,
                )
            }
            "change" -> {
                val before = read().fingerprint
                val changed = PhoneUiStability.awaitChange(
                    now = { System.currentTimeMillis() },
                    sleep = { delay(it) },
                    read = read,
                    before = before,
                    capMs = timeout,
                )
                withScreen(
                    PhoneToolOutcome.Success(buildJsonObject { put("changed", changed) }),
                    shell, service, session, null,
                )
            }
            // The text conditions are polled from snapshots: this slice has no
            // accessibility event stream to wake on, so a bounded poll is what
            // Mika's event-driven wait becomes here. A snapshot is what carries
            // text and content descriptions; reading() only fingerprints them.
            // Each poll rotates the ref registry, which costs nothing extra:
            // withScreen below takes the snapshot whose refs the answer carries.
            // An unmet wait is a success with met=false, the way change answers
            // changed=false at its cap.
            "appear", "disappear" -> {
                val text = arguments.string("text")
                    ?: return PhoneToolOutcome.Failure("appear 和 disappear 需要 text。", CODE_UNSUPPORTED)
                if (text.length > PhoneUiRules.MAX_QUERY_TEXT) {
                    return PhoneToolOutcome.Failure("查询条件过长。", CODE_UNSUPPORTED)
                }
                val met = PhoneUiWait.await(
                    mode = mode,
                    text = text,
                    timeoutMs = timeout,
                    now = { System.currentTimeMillis() },
                    sleep = { delay(it) },
                    read = { service.snapshot(session.displayId)?.elements },
                ) ?: return PhoneToolOutcome.Failure("此 Android 版本无法按显示器读取窗口。", CODE_UNSUPPORTED)
                withScreen(
                    PhoneToolOutcome.Success(
                        buildJsonObject {
                            put("met", met)
                            put("condition", mode)
                            put("text", text)
                        },
                    ),
                    shell, service, session, null,
                )
            }
            else -> PhoneToolOutcome.Failure("mode 只支持 change、settle、appear 或 disappear。", CODE_UNSUPPORTED)
        }
    }

    // MARK: - Screen and gesture plumbing

    private fun withScreen(
        outcome: PhoneToolOutcome,
        shell: PhoneUiShell,
        service: PhoneUiAccessibilityService,
        session: PhoneUiDisplaySession,
        changed: Boolean?,
    ): PhoneToolOutcome {
        if (outcome !is PhoneToolOutcome.Success) return outcome
        val snapshot = service.snapshot(session.displayId) ?: return outcome
        val top = runCatching { shell.topPackage(session.displayId) }.getOrNull()
        // The app in front is the one the task drove last, so an after-task
        // choice that names no package acts on it.
        if (top != null) lastPackage = top
        // The screen the answer carries is the one the next action reads, so
        // its text is what the dwell's reading time is measured against.
        screenChars = snapshot.elements.sumOf { (it.text?.length ?: 0) + (it.description?.length ?: 0) }
        return PhoneToolOutcome.Success(
            buildJsonObject {
                outcome.result.forEach { (key, value) -> put(key, value) }
                changed?.let { put("changed", it) }
                put("snapshot", snapshot.id)
                top?.let { put("topPackage", it) }
                // A tool that answers with its own `truncated` (PHONE_UI_COLLECT
                // cuts its line list) keeps that meaning; for the rest this says
                // the snapshot itself was cut.
                if (snapshot.truncated && outcome.result["truncated"] == null) put("truncated", true)
                put("elements", JsonArray(snapshot.elements.map(::elementJson)))
            },
        )
    }

    /**
     * One finger stroke across [area] (or the whole display). [finger] is the
     * direction the finger travels; the screen content moves the other way.
     *
     * The stroke is built by the pacing profile: FAST hands back
     * [GesturePace.Instant], whose eight segments, linear interpolation and
     * fixed 280 ms are the old stroke exactly; a human pace bows it slightly
     * and keeps every point inside the same area.
     */
    private fun gesture(shell: PhoneUiShell, session: PhoneUiDisplaySession, finger: String, area: Rect?): Boolean {
        val rect = area ?: Rect(0, 0, session.width, session.height)
        if (rect.width() <= 0 || rect.height() <= 0) return false
        val cx = rect.centerX()
        val cy = rect.centerY()
        val dx = (rect.width() * GESTURE_TRAVEL).toInt().coerceAtLeast(20)
        val dy = (rect.height() * GESTURE_TRAVEL).toInt().coerceAtLeast(20)
        val (fx, fy, tx, ty) = when (finger) {
            "up" -> listOf(cx, cy + dy, cx, cy - dy)
            "down" -> listOf(cx, cy - dy, cx, cy + dy)
            "left" -> listOf(cx + dx, cy, cx - dx, cy)
            "right" -> listOf(cx - dx, cy, cx + dx, cy)
            else -> return false
        }
        val stroke = gesturePace.swipe(
            fromX = fx,
            fromY = fy,
            toX = tx,
            toY = ty,
            durationMs = GESTURE_MS,
            // A human stroke bows, so it is clamped into the area it belongs
            // to. Instant's points are already inside it, and no area keeps the
            // old arrays exact even for an area too narrow for the travel.
            area = if (gesturePace.paced) GesturePace.Area(rect.left, rect.top, rect.right, rect.bottom) else null,
        )
        return runCatching {
            shell.injectStroke(session.displayId, stroke.xs, stroke.ys, stroke.times)
        }.getOrDefault(false)
    }

    /**
     * A paced tap: the approach pause, then the press-to-lift stroke the tap
     * became. FAST's tap is the helper's own down/up pair, so an opted-out run
     * keeps that call (and its shell fallback) exactly.
     */
    private suspend fun injectTap(shell: PhoneUiShell, session: PhoneUiDisplaySession, tap: GesturePace.Tap): Boolean {
        if (tap.approachMs > 0) delay(tap.approachMs)
        if (!gesturePace.paced) {
            return runCatching { shell.injectTap(session.displayId, tap.x, tap.y) }.getOrDefault(false)
        }
        val stroke = tap.stroke()
        return runCatching {
            shell.injectStroke(session.displayId, stroke.xs, stroke.ys, stroke.times)
        }.getOrDefault(false)
    }

    private fun clickableAncestor(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var target = node
        var hops = 0
        while (!target.isClickable) {
            if (hops++ >= PhoneUiRules.MAX_ANCESTOR_HOPS) return null
            val parent = target.parent ?: return null
            if (parent.windowId != node.windowId) return null
            target = parent
        }
        return target
    }

    private fun scrollableAncestor(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var target: AccessibilityNodeInfo? = node
        var hops = 0
        while (target != null) {
            if (target.isScrollable) return target
            if (hops++ >= PhoneUiRules.MAX_ANCESTOR_HOPS) return null
            val parent = target.parent ?: return null
            if (parent.windowId != node.windowId) return null
            target = parent
        }
        return null
    }

    private fun perform(node: AccessibilityNodeInfo, action: Int): Boolean =
        runCatching { node.performAction(action) }.getOrDefault(false)

    private fun performWith(node: AccessibilityNodeInfo, action: Int, args: Bundle): Boolean =
        runCatching { node.performAction(action, args) }.getOrDefault(false)

    private fun boundsOf(element: PhoneUiElement): Rect? {
        val bounds = element.bounds
        if (bounds.size != 4) return null
        val rect = Rect(bounds[0], bounds[1], bounds[2], bounds[3])
        return if (rect.width() > 0 && rect.height() > 0) rect else null
    }

    private fun nodeBoundsOf(node: AccessibilityNodeInfo): Rect? =
        runCatching { Rect().also(node::getBoundsInScreen) }.getOrNull()

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

    private companion object {
        /** The person's own display; readable for spill detection, never injected into. */
        const val MAIN_DISPLAY = 0

        /** How long a main-screen arrival may take after an action before it is missed. */
        const val SPILL_PROBE_MS = 1_200L
        const val SPILL_POLL_MS = 150L

        /** PHONE_UI_WAIT's budget: the schema's band, and the old 2.5 s when the call names none. */
        const val MIN_WAIT_MS = 300
        const val MAX_WAIT_MS = 6_000
        const val DEFAULT_WAIT_MS = 2_500

        /** A stroke covers this share of the area it runs in; its points come from the pacing profile. */
        const val GESTURE_TRAVEL = 0.3f
        const val GESTURE_MS = 280L

        /** Screenshots are scaled to this longest side and JPEG-compressed below [MAX_IMAGE_BYTES]. */
        const val MAX_IMAGE_DIMENSION = 1024
        const val JPEG_QUALITY = 75
        const val MAX_IMAGE_BYTES = 1_500_000

        const val CODE_DENIED = "denied"
        const val CODE_UNSUPPORTED = "unsupported"
        const val CODE_NEEDS_USER = "needs_user"
        const val CODE_OPENED_ELSEWHERE = "opened_elsewhere"
        const val STALE_REF = "元素引用无效或已过期，请先重新观察。"
    }
}

private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }

private fun JsonObject.int(key: String): Int? =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.intOrNull

/**
 * PHONE_UI_WAIT's text conditions, `appear` and `disappear`: whether a text or
 * content description is on the screen, or is gone from it.
 *
 * Mika waits on an accessibility event stream and re-checks the screen only
 * when an event wakes it. This slice has no event stream — the service takes
 * snapshots on demand — so the condition is polled at [POLL_MS], the same
 * cadence the change/settle waits use, and never past [timeoutMs]. The clock
 * and sleep are injected so the decision and the budget are pinned by JVM
 * tests without a device.
 *
 * `activity` is not ported: a snapshot carries no activity class name, so a
 * condition on one could not be observed here rather than being faked.
 */
internal object PhoneUiWait {
    /** The cadence of the other screen waits; a screen is cheap to re-read, a busy loop is not. */
    const val POLL_MS = PhoneUiStability.POLL_MS

    /** The matching rule PHONE_UI_QUERY and PHONE_UI_FIND use: text or description, case-insensitive substring. */
    fun textMatches(element: PhoneUiElement, text: String): Boolean =
        listOfNotNull(element.text, element.description).any { it.contains(text, ignoreCase = true) }

    /** Whether [mode]'s condition holds on one reading: appear when the text is there, disappear when it is not. */
    fun isMet(elements: List<PhoneUiElement>, mode: String, text: String): Boolean =
        elements.any { textMatches(it, text) } == (mode == "appear")

    /**
     * Poll the screen until the condition holds or the budget is spent. True
     * when it held, false when [timeoutMs] passed without it — the same
     * "answered, just not met" shape `change` reports as `changed=false`. Null
     * only when the screen could not be read at all, which is a refusal rather
     * than an unmet wait.
     */
    suspend fun await(
        mode: String,
        text: String,
        timeoutMs: Long,
        now: () -> Long,
        sleep: suspend (Long) -> Unit,
        read: () -> List<PhoneUiElement>?,
    ): Boolean? {
        val deadline = now() + timeoutMs
        while (true) {
            val elements = read() ?: return null
            if (isMet(elements, mode, text)) return true
            if (now() >= deadline) return false
            // Never zero: the deadline check above already returned, so there
            // is at least one millisecond left to wait out.
            sleep(minOf(POLL_MS, (deadline - now()).coerceAtLeast(1)))
        }
    }
}
