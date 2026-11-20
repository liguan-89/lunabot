/*
 * Ported from Mika (https://github.com/wangzan101/Mika), file
 * app/src/main/java/com/wangzan101/mika/cap/phone/shell/ShellService.kt.
 * Copyright 2026 wangzan101. The original is licensed under the Apache License,
 * Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 OpenMausBot contributors. Changes from the
 * original: repackaged under com.lunabot.companion.phoneui.shell, comments
 * translated into English, and trimmed to the IPhoneUiShell surface. No
 * clipboard, audio muting, device files, call audio, devtools sockets, shell
 * command endpoint, orientation watch or IME policy remain; task moving is kept
 * only as a bounded main-display <-> own-display move, and display keep-awake
 * only pokes the helper's own display group. Every display-bound input endpoint
 * requires a display this service created (ownDisplay), which excludes the
 * primary display from all event injection. The keyguard endpoints are the one
 * exception, and they name a window uid instead of a display: see
 * [PhoneUiUnlock].
 */
package com.lunabot.companion.phoneui.shell

import android.annotation.SuppressLint
import android.app.ActivityOptions
import android.content.ClipData
import android.content.ComponentName
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.Process
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.Display
import android.view.InputDevice
import android.view.InputEvent
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.Surface
import com.lunabot.companion.phoneui.PhoneUiUnlock
import kotlin.system.exitProcess

/**
 * Runs as shell (uid 2000), holds the app's virtual displays, inside the
 * helper process ([PhoneUiHelperMain]). The displays and the apps on them die
 * with this process, so it stays resident rather than serving one command.
 *
 * Hidden interfaces are reached by reflection; a reflection failure falls back
 * to the equivalent shell command for launch and input only. There is no
 * endpoint that runs an arbitrary command.
 */
class PhoneUiShellService(
    /** Only calls from this uid (the app) are accepted. */
    private val allowedUid: Int,
) : IPhoneUiShell.Stub() {
    private val context: Context = ShellContext.create()

    /** Display id -> VirtualDisplay; the authority for every display-bound call. */
    private val displays = HashMap<Int, VirtualDisplay>()

    // getSystemService would hand back a DisplayManager bound to the system context, whose
    // package name does not match the shell uid.
    @SuppressLint("PrivateApi")
    private val displayManager: DisplayManager =
        DisplayManager::class.java.getDeclaredConstructor(Context::class.java)
            .apply { isAccessible = true }.newInstance(context) as DisplayManager

    private val taskManager: Any by lazy {
        Class.forName("android.app.ActivityTaskManager").getMethod("getService").invoke(null)!!
    }

    /** Launch occupancy check and launch cannot interleave with another launch. */
    private val launchLock = Any()

    /** Keeps every display that forms its own group from timing out. */
    private val awake = PhoneUiDisplayAwake()

    /** Clipboard access as shell; reads skip the framework's Settings query. */
    private val clipboard by lazy { ShellClipboard(context) }

    /**
     * The person's "allow remote unlock" switch, as the app reported it during
     * the handoff that attached this helper ([HandoffProtocol.KEY_UNLOCK]).
     * Off until that says otherwise, so a helper whose handoff carried no
     * answer unlocks nothing. Flipping the switch off while attached is
     * enforced by the app, which re-reads the switch before every call; this
     * snapshot can only ever be as permissive as what the app sent.
     */
    @Volatile
    private var unlockEnabled = false

    /** Called once per accepted handoff, before the app can reach the binder. */
    fun setUnlockEnabled(enabled: Boolean) {
        unlockEnabled = enabled
    }

    /** Wake, keyguard reveal, credential typing and the fallback tap; see [PhoneUiUnlock]. */
    private val unlock by lazy {
        PhoneUiUnlock.of(
            context = context,
            enabled = { unlockEnabled },
            inject = { event -> inject(event, Display.DEFAULT_DISPLAY) },
            injectTo = ::injectToWindow,
        )
    }

    override fun createDisplay(surface: Surface, width: Int, height: Int, dpi: Int): Int = try {
        createVirtualDisplay(surface, width, height, dpi, trusted = true)
    } catch (t: Throwable) {
        if (!PhoneUiPolicy.retryWithoutTrust(t)) {
            Log.e(TAG, "createDisplay failed", t)
            -1
        } else {
            try {
                createVirtualDisplay(surface, width, height, dpi, trusted = false)
            } catch (t: Throwable) {
                Log.e(TAG, "createDisplay failed", t)
                -1
            }
        }
    }

    private fun createVirtualDisplay(surface: Surface, width: Int, height: Int, dpi: Int, trusted: Boolean): Int {
        val flags = PhoneUiPolicy.displayFlags(Build.VERSION.SDK_INT, trusted)
        val vd = displayManager.createVirtualDisplay("phoneui-agent", width, height, dpi, surface, flags)
        val id = vd.display.displayId
        synchronized(displays) { displays[id] = vd }
        setFullscreenWindowingMode(id)
        if (awake.needed(flags)) awake.start(id)
        return id
    }

    /**
     * Set once, right after creating this helper's display, before any app
     * launch: some systems default external/virtual displays to freeform and
     * shrink apps into windows. Only ever targets the display just created;
     * the main display's windowing mode is not touched.
     */
    @SuppressLint("PrivateApi")
    private fun setFullscreenWindowingMode(displayId: Int) {
        runCatching {
            val wm = Class.forName("android.view.WindowManagerGlobal").getMethod("getWindowManagerService").invoke(null)!!
            // WindowConfiguration.WINDOWING_MODE_FULLSCREEN = 1 (hidden constant)
            wm.javaClass.getMethod("setWindowingMode", Int::class.java, Int::class.java).invoke(wm, displayId, 1)
        }.onFailure {
            Log.w(TAG, "setWindowingMode failed, falling back to wm", it)
            sh("wm", "set-display-windowing-mode", "-d", "$displayId", "1")
        }
    }

    /**
     * Every display-bound call goes through this: the id must be one this
     * service itself created and still holds. Wrong ids (the primary display
     * included) are refused before anything touches the system.
     */
    private fun ownDisplay(displayId: Int): Boolean = synchronized(displays) { displayId in displays }

    override fun releaseDisplay(displayId: Int) {
        awake.stop(displayId)
        val vd = synchronized(displays) { displays.remove(displayId) }
        vd?.release()
    }

    /**
     * Launch [packageName]'s launcher activity on [displayId]. Refuses when
     * the package has a visible task on the primary display: launching would
     * move or interrupt what the user is looking at. If that check cannot be
     * made, the launch is refused (fail closed). Only package-manager launcher
     * entries are started — no arbitrary intents, no system settings.
     */
    override fun launchApp(displayId: Int, packageName: String): Int = synchronized(launchLock) {
        if (!ownDisplay(displayId)) return START_ERROR
        try {
            if (inUseOnMainScreen(packageName)) return START_IN_USE_ON_MAIN
        } catch (t: Throwable) {
            Log.e(TAG, "cannot inspect main-screen tasks", t)
            return START_ERROR
        }
        val intent = context.packageManager.getLaunchIntentForPackage(packageName) ?: return START_NOT_FOUND
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val options = ActivityOptions.makeBasic().setLaunchDisplayId(displayId).toBundle()
        val ok = try {
            val start = taskManager.javaClass.methods.first { it.name == "startActivityAsUser" && it.parameterTypes.size == 12 }
            // (caller, callingPackage, callingFeatureId, intent, resolvedType, resultTo, resultWho,
            //  requestCode, flags, profilerInfo, options, userId)
            val result = start.invoke(
                taskManager, null, ShellContext.SHELL_PACKAGE, null, intent, null, null, null,
                0, 0, null, options, USER_CURRENT,
            ) as Int
            if (result < 0) Log.w(TAG, "startActivityAsUser($packageName) -> $result")
            result >= 0
        } catch (t: Throwable) {
            Log.w(TAG, "startActivityAsUser unavailable, falling back to am start", t)
            val component = intent.component?.flattenToShortString() ?: return START_NOT_FOUND
            sh("am", "start", "--display", "$displayId", "-n", component).first == 0
        }
        if (ok) START_OK else START_ERROR
    }

    /**
     * The package has a visible task on the primary display, or is the top
     * task there: the user is using it. [TaskInfo.isVisible] when readable,
     * otherwise top-of-list as the fallback.
     */
    private fun inUseOnMainScreen(packageName: String): Boolean {
        val visibleField = runCatching { TASK_INFO.getField("isVisible") }.getOrNull()
        return tasksOn(Display.DEFAULT_DISPLAY).withIndex().any { (index, task) ->
            packageName in packagesOf(task) && (visibleField?.getBoolean(task) ?: (index == 0))
        }
    }

    private fun packagesOf(task: Any): List<String> = listOf("baseActivity", "topActivity").mapNotNull {
        (TASK_INFO.getField(it).get(task) as? android.content.ComponentName)?.packageName
    }

    /**
     * IActivityTaskManager.getTasks, most-recent first; shell holds
     * REAL_GET_TASKS so it sees every app's tasks. API 33+ has the overload
     * with a displayId; earlier versions take everything and filter here.
     */
    private fun tasksOn(displayId: Int): List<Any> {
        val methods = taskManager.javaClass.methods.filter { it.name == "getTasks" }
        val withDisplay = methods.firstOrNull { it.parameterTypes.size == 4 }
        val tasks = if (withDisplay != null) {
            withDisplay.invoke(taskManager, MAX_TASKS, false, false, displayId)
        } else {
            methods.first { it.parameterTypes.size == 3 }.invoke(taskManager, MAX_TASKS, false, false)
        } as List<*>
        val displayField = TASK_INFO.getField("displayId")
        return tasks.filterNotNull().filter { displayField.getInt(it) == displayId }
    }

    /**
     * One task by id, looked up on the main display and on every display this
     * helper holds. The per-display query is the only one that exists on
     * current systems, so there is no "all tasks" call to make.
     */
    private fun task(taskId: Int): Any? {
        val idField = TASK_INFO.getField("taskId")
        val displays = synchronized(displays) { displays.keys.toList() } + Display.DEFAULT_DISPLAY
        for (displayId in displays) {
            tasksOn(displayId).firstOrNull { idField.getInt(it) == taskId }?.let { return it }
        }
        return null
    }

    override fun injectKey(displayId: Int, keyCode: Int): Boolean {
        if (!ownDisplay(displayId)) return false
        if (!PhoneUiPolicy.isKeyAllowed(keyCode)) {
            Log.w(TAG, "refused key $keyCode")
            return false
        }
        val now = SystemClock.uptimeMillis()
        val down = KeyEvent(now, now, KeyEvent.ACTION_DOWN, keyCode, 0, 0, VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD)
        val up = KeyEvent.changeAction(down, KeyEvent.ACTION_UP)
        return sendPair({ inject(down, displayId) }, { inject(up, displayId) }) {
            sh("input", "-d", "$displayId", "keyevent", "$keyCode").first == 0
        }
    }

    override fun injectTap(displayId: Int, x: Int, y: Int): Boolean {
        if (!ownDisplay(displayId)) return false
        val now = SystemClock.uptimeMillis()
        val down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, x.toFloat(), y.toFloat(), 0)
        val up = MotionEvent.obtain(now, now + TAP_MS, MotionEvent.ACTION_UP, x.toFloat(), y.toFloat(), 0)
        return try {
            down.source = InputDevice.SOURCE_TOUCHSCREEN
            up.source = InputDevice.SOURCE_TOUCHSCREEN
            sendPair({ inject(down, displayId) }, { inject(up, displayId) }) {
                sh("input", "-d", "$displayId", "tap", "$x", "$y").first == 0
            }
        } finally {
            down.recycle()
            up.recycle()
        }
    }

    /**
     * One finger stroke: press, move through the points at their [times],
     * lift at the last point. Each event is injected when its moment arrives,
     * so the app sees the pace the caller chose. After a successful press,
     * every remaining point is still followed by a lift even if a move fails —
     * a finger must never stay down.
     */
    override fun injectStroke(displayId: Int, xs: IntArray, ys: IntArray, times: LongArray): Boolean {
        if (!ownDisplay(displayId)) return false
        if (!PhoneUiPolicy.strokeValid(xs, ys, times)) return false
        val n = times.size
        val down = SystemClock.uptimeMillis()
        fun event(i: Int, action: Int): MotionEvent {
            val props = MotionEvent.PointerProperties().apply { id = 0; toolType = MotionEvent.TOOL_TYPE_FINGER }
            val coords = MotionEvent.PointerCoords().apply { x = xs[i].toFloat(); y = ys[i].toFloat(); pressure = 1f; size = 1f }
            return MotionEvent.obtain(down, down + times[i], action, 1, arrayOf(props), arrayOf(coords), 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0)
        }
        fun send(i: Int, action: Int): Boolean {
            val wait = down + times[i] - SystemClock.uptimeMillis()
            if (wait > 0) SystemClock.sleep(wait)
            val e = event(i, action)
            return try { inject(e, displayId) } finally { e.recycle() }
        }
        if (!send(0, MotionEvent.ACTION_DOWN)) return false
        for (i in 1 until n) send(i, MotionEvent.ACTION_MOVE)
        return send(n - 1, MotionEvent.ACTION_UP) || send(n - 1, MotionEvent.ACTION_UP)
    }

    override fun topPackage(displayId: Int): String? = try {
        if (!ownDisplay(displayId)) null else tasksOn(displayId).firstOrNull()?.let {
            (TASK_INFO.getField("topActivity").get(it) as? android.content.ComponentName)?.packageName
        }
    } catch (t: Throwable) {
        Log.e(TAG, "topPackage failed", t)
        null
    }

    /**
     * Reading the main display is allowed: spill detection has to know which
     * task sits on the person's screen. Nothing here injects into it.
     */
    override fun topTaskId(displayId: Int): Int = try {
        if (displayId != Display.DEFAULT_DISPLAY && !ownDisplay(displayId)) {
            -1
        } else {
            tasksOn(displayId).firstOrNull()?.let { TASK_INFO.getField("taskId").getInt(it) } ?: -1
        }
    } catch (t: Throwable) {
        Log.e(TAG, "topTaskId failed", t)
        -1
    }

    override fun packageOfTask(taskId: Int): String? = try {
        task(taskId)?.let { packagesOf(it).firstOrNull() }
    } catch (t: Throwable) {
        Log.e(TAG, "packageOfTask failed", t)
        null
    }

    /**
     * IActivityTaskManager.moveRootTaskToDisplay(taskId, displayId), the call
     * behind `am display move-stack`. Used for the two directions this slice
     * needs: an app that opened on the person's screen is moved back to the
     * helper's display, and a task the person chose is left alone. Targets are
     * this helper's display or the main display, nothing else.
     */
    override fun moveTask(taskId: Int, displayId: Int): Boolean {
        if (taskId < 0) return false
        if (displayId != Display.DEFAULT_DISPLAY && !ownDisplay(displayId)) return false
        return try {
            taskManager.javaClass.getMethod("moveRootTaskToDisplay", Int::class.java, Int::class.java)
                .invoke(taskManager, taskId, displayId)
            true
        } catch (t: Throwable) {
            Log.w(TAG, "moveRootTaskToDisplay unavailable, falling back to am", t)
            sh("am", "display", "move-stack", "$taskId", "$displayId").first == 0
        }
    }

    /**
     * Type printable ASCII into the focused field on [displayId]. Key events
     * are synthesized from the virtual keyboard map, so the field sees normal
     * typing (and its listeners) instead of a set-text jump; control
     * characters and non-ASCII are refused by policy rather than mistyped.
     */
    override fun typeText(displayId: Int, text: String): Boolean {
        if (!ownDisplay(displayId)) return false
        if (!PhoneUiPolicy.isTextAllowed(text)) return false
        return try {
            val map = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD)
            var sent = true
            for (ch in text) {
                val events = map.getEvents(charArrayOf(ch)) ?: return false
                for (event in events) {
                    val now = SystemClock.uptimeMillis()
                    val copy = KeyEvent(
                        now, now, event.action, event.keyCode, 0, event.metaState,
                        VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD,
                    )
                    sent = inject(copy, displayId) && sent
                }
            }
            sent
        } catch (t: Throwable) {
            Log.w(TAG, "typeText failed", t)
            false
        }
    }

    override fun readClipboard(): String? = try {
        clipboard.primaryText()?.take(PhoneUiPolicy.MAX_CLIPBOARD_CHARS)
    } catch (t: Throwable) {
        Log.w(TAG, "readClipboard failed", t)
        null
    }

    override fun writeClipboard(text: String): Boolean {
        if (!PhoneUiPolicy.isClipboardTextAllowed(text)) return false
        return clipboard.setText(text)
    }

    /**
     * Hands a content URI to another app's share screen on our display.
     * Shell already holds storage access, so the read grant it issues is one
     * the target can use; the app itself need not be in the foreground.
     */
    override fun shareIntent(displayId: Int, contentUri: String, mime: String, packageName: String): Int {
        if (!ownDisplay(displayId)) return START_ERROR
        if (!PhoneUiPolicy.isShareAllowed(contentUri, mime, packageName)) return START_ERROR
        synchronized(launchLock) {
            val uri = Uri.parse(contentUri)
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = mime
                putExtra(Intent.EXTRA_STREAM, uri)
                clipData = ClipData.newRawUri("Luna Bot", uri)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                setPackage(packageName)
            }
            // The app granted the target read access before asking; shell
            // cannot delegate a grant it does not hold, so the flag is not set.
            val handles = runCatching {
                context.packageManager.queryIntentActivities(intent, 0)
                    .any { it.activityInfo?.packageName == packageName }
            }.getOrDefault(false)
            if (!handles) return START_NOT_FOUND
            // The framework call rejects a SEND intent carrying a stream for a
            // virtual display (START_NOT_CURRENT_USER_ACTIVITY), so the share
            // goes through `am`, exactly as a shell user would start it.
            val component = queryShareComponent(packageName, intent) ?: return START_NOT_FOUND
            val started = sh(
                "am", "start", "--display", "$displayId",
                "-a", Intent.ACTION_SEND, "-t", mime,
                "--eu", Intent.EXTRA_STREAM, uri.toString(),
                "-n", component,
            )
            return if (started.first == 0) START_OK else START_FALLBACK_FAILED
        }
    }

    private fun queryShareComponent(packageName: String, intent: Intent): String? = runCatching {
        context.packageManager.queryIntentActivities(intent, 0)
            .firstOrNull { it.activityInfo?.packageName == packageName }
            ?.activityInfo
            ?.let { ComponentName(it.packageName, it.name).flattenToShortString() }
    }.getOrNull()

    /**
     * Finish an app the bot chose to close: its tasks and process go away, as
     * `am force-stop` does. Only a well-formed package that is not the system,
     * the system UI or this helper is accepted; the caller has already checked
     * that it is not its own package.
     */
    override fun forceStop(packageName: String): Boolean {
        if (!forceStoppable(packageName)) return false
        return try {
            val am = Class.forName("android.app.ActivityManager").getMethod("getService").invoke(null)!!
            am.javaClass.getMethod("forceStopPackage", String::class.java, Int::class.javaPrimitiveType)
                .invoke(am, packageName, USER_CURRENT)
            true
        } catch (t: Throwable) {
            Log.w(TAG, "forceStopPackage($packageName) unavailable, falling back to am", t)
            sh("am", "force-stop", packageName).first == 0
        }
    }

    /** A package name this helper may finish: the PackageManager shape, never the system's own processes. */
    private fun forceStoppable(packageName: String): Boolean =
        packageName.length in 3..200 && packageName.count { it == '.' } >= 1 &&
            packageName.all { it.isLetterOrDigit() || it == '.' || it == '_' } &&
            packageName !in PROTECTED_PACKAGES

    /**
     * Write one of [ALLOWED_SECURE_SETTINGS] as shell, or delete it when
     * [value] is null. Shell holds WRITE_SECURE_SETTINGS, but the allow-list
     * belongs to this helper, not to the caller: a name outside it is refused
     * before the system is touched, so the endpoint cannot be turned into a
     * general secure-settings writer. There is deliberately no `settings put`
     * fallback, because that command would accept any key.
     */
    override fun putSecureSetting(name: String, value: String?): Boolean =
        writeSecureSetting(context.contentResolver, name, value)

    /**
     * Grant our own package WRITE_SECURE_SETTINGS, once, so the app itself can
     * keep the wireless-debugging switch on after a reboot without asking the
     * helper again. This is the only permission the endpoint can grant, and
     * only to a package the calling uid owns: [Binder.getCallingUid] is
     * already gated by [onTransact], and the helper re-resolves that uid's
     * packages instead of trusting the name. An unowned package, a malformed
     * name, `pm` refusing or `pm` missing all come back as false.
     *
     * Safe to keep in a helper with no shell endpoint: the argv is built here
     * from a fixed binary, a fixed verb and a fixed permission, so there is
     * nothing a caller can add to it.
     */
    override fun grantOwnWriteSecureSettings(packageName: String): Boolean =
        grantWriteSecureSettings(
            packageName,
            Binder.getCallingUid(),
            { uid -> context.packageManager.getPackagesForUid(uid) },
            { argv -> runPmGrant(argv) },
        )

    override fun identity(): IntArray = intArrayOf(Process.myUid(), Process.myPid())

    /**
     * The four keyguard calls. Each re-reads the person's switch through
     * [unlock] (whose `enabled` predicate reads [unlockEnabled]) and refuses
     * when it is off; [PhoneUiUnlock] itself refuses when there is no secure
     * keyguard, so a swipe-only lock screen is not a typing target.
     */
    override fun wakeDevice(): Boolean = unlock.wake()

    override fun revealKeyguard(): Boolean = unlock.reveal()

    override fun enterDeviceCredential(kind: Int, credential: ByteArray, clear: Int): Boolean =
        unlock.enter(kind, credential, clear)

    override fun tapKeyguard(x: Int, y: Int): Boolean = unlock.tap(x, y)

    override fun releaseAll() {
        awake.stopAll()
        val all = synchronized(displays) {
            displays.values.toList().also { displays.clear() }
        }
        all.forEach { it.release() }
    }

    override fun destroy() {
        releaseAll()
        exitProcess(0)
    }

    override fun onTransact(code: Int, data: android.os.Parcel, reply: android.os.Parcel?, flags: Int): Boolean {
        // The helper process outlives its client and the binder could reach
        // other callers: only the app that received the handoff may call it.
        if (code in FIRST_CALL_TRANSACTION..LAST_CALL_TRANSACTION && Binder.getCallingUid() != allowedUid) {
            throw SecurityException("caller ${Binder.getCallingUid()} is not allowed")
        }
        return super.onTransact(code, data, reply, flags)
    }

    @SuppressLint("PrivateApi")
    private fun inject(event: InputEvent, displayId: Int): Boolean = try {
        event.javaClass.getMethod("setDisplayId", Int::class.java).invoke(event, displayId)
        val manager = inputManager()
        manager.javaClass.getMethod("injectInputEvent", InputEvent::class.java, Int::class.java)
            .invoke(manager, event, PhoneUiPolicy.injectMode(event is KeyEvent, waitForFinish = false)) as Boolean
    } catch (t: Throwable) {
        Log.w(TAG, "injectInputEvent failed", t)
        false
    }

    /** API 34 moved the injection entry to InputManagerGlobal; earlier versions have it on InputManager. */
    @SuppressLint("PrivateApi")
    private fun inputManager(): Any = runCatching {
        Class.forName("android.hardware.input.InputManagerGlobal").getMethod("getInstance").invoke(null)
    }.getOrNull() ?: Class.forName("android.hardware.input.InputManager").getMethod("getInstance").invoke(null)!!

    /**
     * Inject only into a window owned by [targetUid], waiting for the system to
     * finish dispatch. This is the Android 13+ overload
     * `injectInputEvent(InputEvent, int, int)`: if the focus is not a window of
     * that uid — another app over the keyguard, or the app itself after the
     * phone unlocked mid-sequence — the system refuses the event instead of
     * delivering it somewhere else. On an older platform, or if the overload is
     * absent, nothing is injected and the answer is false.
     *
     * Failures log the exception class only: the events on this path carry the
     * device credential.
     */
    @SuppressLint("PrivateApi")
    private fun injectToWindow(event: InputEvent, targetUid: Int): Boolean = try {
        val manager = inputManager()
        manager.javaClass
            .getMethod("injectInputEvent", InputEvent::class.java, Int::class.java, Int::class.java)
            .invoke(manager, event, INJECT_MODE_WAIT_FOR_FINISH, targetUid) as Boolean
    } catch (t: Throwable) {
        Log.w(TAG, "targeted injectInputEvent failed: ${(t.cause ?: t).javaClass.simpleName}")
        false
    }

    /**
     * A press/lift pair: only an unsuccessful press falls back to a shell
     * command; after a delivered press a fallback would add an extra full
     * click/key, so only the lift is re-sent (once).
     */
    private inline fun sendPair(down: () -> Boolean, up: () -> Boolean, fallback: () -> Boolean): Boolean {
        if (!down()) return fallback()
        return up() || up()
    }

    /**
     * One shell command for the launch/input fallbacks above; runs as shell
     * (uid 2000) because this process already is shell. Not an endpoint: the
     * AIDL surface never hands commands here.
     */
    private fun sh(vararg cmd: String): Pair<Int, String> {
        val p = try {
            ProcessBuilder(*cmd).redirectErrorStream(true).start()
        } catch (t: Throwable) {
            Log.w(TAG, "exec ${cmd.joinToString(" ")} failed", t)
            return -1 to ""
        }
        val output = java.util.concurrent.atomic.AtomicReference("")
        val reader = Thread { output.set(runCatching { p.inputStream.bufferedReader().readText() }.getOrDefault("")) }
            .apply { isDaemon = true; start() }
        if (!p.waitFor(CMD_TIMEOUT_S, java.util.concurrent.TimeUnit.SECONDS)) {
            p.destroyForcibly()
            Log.w(TAG, "exec ${cmd.joinToString(" ")} timed out")
            return -1 to ""
        }
        reader.join(READER_JOIN_MS)
        return p.exitValue() to output.get()
    }

    companion object {
        private const val TAG = "PhoneUiShell"
        private const val MAX_TASKS = 100
        private const val TAP_MS = 50L
        private const val CMD_TIMEOUT_S = 10L
        private const val READER_JOIN_MS = 1_000L

        const val START_OK = 0
        const val START_IN_USE_ON_MAIN = 1
        const val START_NOT_FOUND = 2
        const val START_ERROR = 3

        /** The `am start` fallback did not report success. */
        const val START_FALLBACK_FAILED = 5

        private val TASK_INFO: Class<*> by lazy { Class.forName("android.app.TaskInfo") }

        /** Packages force-stop must never touch: the framework, the system UI and this helper's own shell. */
        private val PROTECTED_PACKAGES = setOf("android", "com.android.systemui", ShellContext.SHELL_PACKAGE)
        private const val VIRTUAL_KEYBOARD = -1 // KeyCharacterMap.VIRTUAL_KEYBOARD
        private const val USER_CURRENT = -2 // UserHandle.USER_CURRENT

        /** InputManager.INJECT_INPUT_EVENT_MODE_WAIT_FOR_FINISH: return only after the window handled it. */
        private const val INJECT_MODE_WAIT_FOR_FINISH = 2

        /**
         * The only settings [putSecureSetting] will write, each mapped to its
         * own namespace. `adb_wifi_enabled` is a global setting (the wireless
         * debugging switch the self-repair turns back on);
         * `enabled_accessibility_services` is a secure setting (the colon
         * separated service list the accessibility repair rewrites). The
         * namespace is part of the entry, so a name can never fall through to
         * the wrong table.
         */
        private val ALLOWED_SECURE_SETTINGS = mapOf(
            "adb_wifi_enabled" to SecureSettingNamespace.GLOBAL,
            "enabled_accessibility_services" to SecureSettingNamespace.SECURE,
        )

        /** A value longer than this is not a setting any repair needs. */
        internal const val MAX_SECURE_SETTING_CHARS = 4_096

        /**
         * Whether [name] may be written at all: it has to be one of
         * [ALLOWED_SECURE_SETTINGS]. Everything else is refused, so the
         * endpoint stays a two-key capability rather than a settings writer.
         */
        internal fun secureSettingAllowed(name: String): Boolean = name in ALLOWED_SECURE_SETTINGS

        /**
         * Whether [value] may be stored. A null value is a delete and needs no
         * shape. Otherwise the value must be bounded and consist of the
         * characters a component list and a "1" use: ASCII letters, digits,
         * `_`, `/`, `.`, `:` and `,`. Control characters are therefore
         * refused, and so is anything that could not name a component.
         */
        internal fun secureSettingValueAllowed(value: String?): Boolean =
            value == null || (value.length <= MAX_SECURE_SETTING_CHARS && value.all {
                it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' ||
                    it == '_' || it == '/' || it == '.' || it == ':' || it == ','
            })

        /**
         * The write itself, as shell (uid 2000), which holds
         * WRITE_SECURE_SETTINGS. The allow-list and the value shape are checked
         * here, before the resolver is touched; a SecurityException is the
         * system's refusal and comes back as false rather than as a throw
         * across the binder.
         */
        internal fun writeSecureSetting(resolver: ContentResolver, name: String, value: String?): Boolean {
            val namespace = ALLOWED_SECURE_SETTINGS[name]
            if (namespace == null) {
                // The name is caller data and is not echoed: it was not one of
                // the two keys, so there is nothing useful to log but the fact.
                Log.w(TAG, "refused a secure setting outside the allow-list")
                return false
            }
            if (!secureSettingValueAllowed(value)) {
                Log.w(TAG, "refused value for secure setting $name")
                return false
            }
            return try {
                when (namespace) {
                    SecureSettingNamespace.GLOBAL -> Settings.Global.putString(resolver, name, value)
                    SecureSettingNamespace.SECURE -> Settings.Secure.putString(resolver, name, value)
                }
            } catch (t: SecurityException) {
                Log.w(TAG, "putString($name) refused", t)
                false
            } catch (t: RuntimeException) {
                Log.w(TAG, "putString($name) failed", t)
                false
            }
        }

        /** Which Settings table a name lives in; spelled out per key, never guessed. */
        private enum class SecureSettingNamespace { GLOBAL, SECURE }

        /** `pm grant` gets a shorter leash than the display fallbacks: it either answers quickly or not at all. */
        internal const val PM_GRANT_TIMEOUT_S = 5L

        /**
         * The one permission [grantOwnWriteSecureSettings] may grant. Spelled
         * out as a constant so no caller-supplied string can reach the argv.
         */
        internal const val GRANTED_PERMISSION = "android.permission.WRITE_SECURE_SETTINGS"

        /**
         * Whether [packageName] is a plain package name: ASCII letters, digits,
         * `.` and `_`, non-empty and bounded. This runs before any ownership
         * lookup and before any process, so a name that could be read as an
         * option (`-r`), a path or a second command never gets that far.
         */
        internal fun packageNameAllowed(packageName: String): Boolean =
            packageName.length in 1..200 && packageName.all {
                it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '.' || it == '_'
            }

        /**
         * The exact argv for the grant: a fixed binary, a fixed verb, the
         * caller's (already validated and ownership-checked) package, and the
         * one fixed permission. Exists as its own function so tests can pin the
         * argv without spawning anything.
         */
        internal fun pmGrantCommand(packageName: String): Array<String> =
            arrayOf("/system/bin/pm", "grant", packageName, GRANTED_PERMISSION)

        /**
         * Grant [packageName] WRITE_SECURE_SETTINGS if, and only if, the
         * calling [callerUid] owns it.
         *
         * Order matters: the name shape is checked first (no ownership lookup,
         * no process), then [packagesForUid] — never the caller's word — decides
         * whether this uid may be granted at all, and only then is `pm` run.
         * A refused or unowned name is logged as a fact without the name itself:
         * the caller may have sent anything, and it is not worth echoing.
         *
         * [run] is injected so tests never execute `pm`; the real one is
         * [runPmGrant]. Every failure — not owned, interrupted, timed out,
         * non-zero exit, `pm` missing — is false, never an exception across the
         * binder.
         */
        internal fun grantWriteSecureSettings(
            packageName: String,
            callerUid: Int,
            packagesForUid: (Int) -> Array<String>?,
            run: (Array<String>) -> Int,
        ): Boolean {
            if (!packageNameAllowed(packageName)) {
                Log.w(TAG, "refused a package name that is not a plain package")
                return false
            }
            val owned = try {
                packagesForUid(callerUid)?.contains(packageName) == true
            } catch (t: RuntimeException) {
                // An unreadable package list is not ownership; fail closed.
                Log.w(TAG, "cannot resolve the caller's packages", t)
                false
            }
            if (!owned) {
                Log.w(TAG, "refused a grant for a package the caller does not own")
                return false
            }
            return try {
                run(pmGrantCommand(packageName)) == 0
            } catch (t: Throwable) {
                // A runner that throws (interruption, missing pm, I/O) is a
                // refusal, not something the caller should see as a crash.
                Log.w(TAG, "pm grant failed", t)
                false
            }
        }

        /**
         * The real `pm grant` runner. Bounded at [PM_GRANT_TIMEOUT_S]; on
         * timeout the process is destroyed and the answer is -1, which
         * [grantWriteSecureSettings] reads as false. Output is drained and
         * dropped rather than read: it is `pm`'s diagnostic, it may quote the
         * package (caller data), and nothing here needs it.
         */
        internal fun runPmGrant(argv: Array<String>): Int {
            val process = try {
                ProcessBuilder(*argv).redirectErrorStream(true).start()
            } catch (t: Throwable) {
                Log.w(TAG, "pm grant could not start", t)
                return -1
            }
            val drain = Thread {
                runCatching { process.inputStream.use { while (it.read() >= 0) Unit } }
            }.apply { isDaemon = true; start() }
            return try {
                if (process.waitFor(PM_GRANT_TIMEOUT_S, java.util.concurrent.TimeUnit.SECONDS)) {
                    drain.join(1_000L)
                    process.exitValue()
                } else {
                    process.destroyForcibly()
                    Log.w(TAG, "pm grant timed out")
                    -1
                }
            } catch (t: InterruptedException) {
                process.destroyForcibly()
                Thread.currentThread().interrupt()
                Log.w(TAG, "pm grant interrupted")
                -1
            }
        }
    }
}
