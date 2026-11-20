/*
 * Adapted from Mika (https://github.com/wangzan101/Mika), file
 * app/src/main/java/com/wangzan101/mika/cap/phone/shell/DisplayAwake.kt.
 * Copyright 2026 wangzan101. The original is licensed under the Apache License,
 * Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 OpenMausBot contributors: repackaged under
 * com.lunabot.companion.phoneui.shell, comments translated into English,
 * and reduced to one thread per display instead of their injected scheduler.
 */
package com.lunabot.companion.phoneui.shell

import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import java.lang.reflect.Method

/**
 * Keeps the helper's own display awake.
 *
 * A display created with OWN_DISPLAY_GROUP (Android 13+ trusted displays) has
 * its own screen-off timer, and injected input does not count as user
 * activity. Left alone, that group sleeps: frames stop being composed, a
 * screenshot would repeat, and taps in it fail. While the display exists this
 * reports one touch for it every [PERIOD_MS] — far below any system screen-off
 * timeout. If the system has no per-display activity call, it gives up once
 * and the display keeps working as before.
 *
 * The report is always addressed to the created display's id, never the
 * default group: reporting to the default group would keep the person's own
 * screen on.
 */
internal class PhoneUiDisplayAwake {
    private val runners = HashMap<Int, Thread>()
    private var unavailable = false

    /** Nothing to do for a display that does not form its own group. */
    fun needed(flags: Int): Boolean = flags and OWN_DISPLAY_GROUP_FLAG != 0

    fun start(displayId: Int) {
        synchronized(runners) {
            if (unavailable || displayId in runners) return
            val runnable = object : Runnable {
                override fun run() {
                    while (true) {
                        if (synchronized(runners) { runners[displayId] !== Thread.currentThread() }) return
                        if (!poke(displayId)) {
                            giveUp()
                            return
                        }
                        try {
                            Thread.sleep(PERIOD_MS)
                        } catch (interrupted: InterruptedException) {
                            return
                        }
                    }
                }
            }
            val thread = Thread(runnable, "phoneui-awake-$displayId")
            thread.isDaemon = true
            runners[displayId] = thread
            thread.start()
        }
    }

    fun stop(displayId: Int) {
        synchronized(runners) { runners.remove(displayId) }?.interrupt()
    }

    fun stopAll() {
        val all = synchronized(runners) { runners.values.toList().also { runners.clear() } }
        all.forEach { it.interrupt() }
    }

    private fun giveUp() {
        synchronized(runners) { unavailable = true }
        stopAll()
        Log.w(TAG, "per-display user activity unavailable; display may sleep")
    }

    @Suppress("PrivateApi")
    private fun poke(displayId: Int): Boolean = runCatching {
        val method = userActivityMethod() ?: return false
        method.invoke(powerManager(), displayId, SystemClock.uptimeMillis(), USER_ACTIVITY_EVENT_TOUCH, 0)
        true
    }.getOrElse {
        Log.w(TAG, "userActivity failed", it)
        false
    }

    private fun powerManager(): Any {
        val binder = Class.forName("android.os.ServiceManager")
            .getMethod("getService", String::class.java)
            .invoke(null, "power") as IBinder
        return Class.forName("android.os.IPowerManager\$Stub")
            .getMethod("asInterface", IBinder::class.java)
            .invoke(null, binder)!!
    }

    /** The per-display overload exists from Android 12; the old one reports to the default group. */
    private fun userActivityMethod(): Method? = runCatching {
        Class.forName("android.os.IPowerManager").methods.firstOrNull {
            it.name == "userActivity" && it.parameterTypes.contentEquals(PER_DISPLAY)
        }
    }.getOrNull()

    companion object {
        private const val TAG = "PhoneUiAwake"
        const val PERIOD_MS = 4_000L

        /** PowerManager.USER_ACTIVITY_EVENT_TOUCH */
        private const val USER_ACTIVITY_EVENT_TOUCH = 2

        /** DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_DISPLAY_GROUP, hidden constant. */
        const val OWN_DISPLAY_GROUP_FLAG = 1 shl 11

        private val PER_DISPLAY = arrayOf(
            Int::class.javaPrimitiveType!!,
            Long::class.javaPrimitiveType!!,
            Int::class.javaPrimitiveType!!,
            Int::class.javaPrimitiveType!!,
        )
    }
}