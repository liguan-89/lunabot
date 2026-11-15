/*
 * Ported from Mika (https://github.com/wangzan101/Mika), file
 * app/src/main/java/com/wangzan101/mika/cap/phone/shell/ShellService.kt.
 * Copyright 2026 wangzan101. The original is licensed under the Apache License,
 * Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 OpenMausBot contributors. Changes from the
 * original: repackaged under com.openmausbot.companion.phoneui.shell, comments
 * translated into English, and trimmed to the IPhoneUiShell surface. No
 * clipboard, audio muting, device unlock, device files, call audio, devtools
 * sockets, shell command endpoint, orientation watch or IME policy remain;
 * task moving is kept only as a bounded main-display <-> own-display move, and
 * display keep-awake only pokes the helper's own display group. Every
 * display-bound input endpoint requires a display this service created
 * (ownDisplay), which excludes the primary display from all event injection.
 */
package com.openmausbot.companion.phoneui.shell

import android.annotation.SuppressLint
import android.app.ActivityOptions
import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.Process
import android.os.SystemClock
import android.util.Log
import android.view.Display
import android.view.InputDevice
import android.view.InputEvent
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.Surface
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

    override fun identity(): IntArray = intArrayOf(Process.myUid(), Process.myPid())

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

        private val TASK_INFO: Class<*> by lazy { Class.forName("android.app.TaskInfo") }
        private const val VIRTUAL_KEYBOARD = -1 // KeyCharacterMap.VIRTUAL_KEYBOARD
        private const val USER_CURRENT = -2 // UserHandle.USER_CURRENT
    }
}
