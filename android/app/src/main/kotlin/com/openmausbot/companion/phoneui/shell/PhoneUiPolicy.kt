/*
 * Ported from Mika (https://github.com/wangzan101/Mika), file
 * app/src/main/java/com/wangzan101/mika/cap/phone/shell/ShellService.kt
 * (companion helpers) and core/src/main/kotlin/com/wangzan101/mika/core/uistate/
 * PressKeys.kt.
 * Copyright 2026 wangzan101. The original is licensed under the Apache License,
 * Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 OpenMausBot contributors. Changes from the
 * original: repackaged under com.openmausbot.companion.phoneui.shell, comments
 * translated into English, and reduced to the key whitelist this helper is
 * allowed to inject. Plain Kotlin with no Android imports so the whitelist and
 * the display-flag fallback rules are unit-testable on the JVM.
 */
package com.openmausbot.companion.phoneui.shell

/**
 * Rules the shell helper applies before touching the system, kept free of
 * Android imports so they can be tested and so the security invariants live in
 * one place both sides of the whitelist can read.
 */
object PhoneUiPolicy {
    /**
     * Keys the helper may inject: navigation and editing only. Volume, power,
     * sleep, Home, recents and media keys act on the whole phone rather than
     * the helper's displays, and are refused even if the caller asks for one.
     */
    val ALLOWED_KEYS: Set<Int> = setOf(
        19, // KEYCODE_DPAD_UP
        20, // KEYCODE_DPAD_DOWN
        21, // KEYCODE_DPAD_LEFT
        22, // KEYCODE_DPAD_RIGHT
        61, // KEYCODE_TAB
        66, // KEYCODE_ENTER
        4, // KEYCODE_BACK
        67, // KEYCODE_DEL
        112, // KEYCODE_FORWARD_DEL
    )

    fun isKeyAllowed(keyCode: Int): Boolean = keyCode in ALLOWED_KEYS

    // DisplayManager.VIRTUAL_DISPLAY_FLAG_*; several are hidden constants.
    private const val FLAG_PUBLIC = 1 shl 0
    private const val FLAG_OWN_CONTENT_ONLY = 1 shl 3
    private const val FLAG_SUPPORTS_TOUCH = 1 shl 6
    private const val FLAG_ROTATES_WITH_CONTENT = 1 shl 7
    private const val FLAG_DESTROY_CONTENT_ON_REMOVAL = 1 shl 8
    private const val FLAG_TRUSTED = 1 shl 10
    private const val FLAG_OWN_DISPLAY_GROUP = 1 shl 11
    private const val FLAG_ALWAYS_UNLOCKED = 1 shl 12
    private const val FLAG_TOUCH_FEEDBACK_DISABLED = 1 shl 13
    private const val FLAG_OWN_FOCUS = 1 shl 14
    private const val FLAG_STEAL_TOP_FOCUS_DISABLED = 1 shl 16

    const val SDK_TIRAMISU = 33
    const val SDK_UPSIDE_DOWN_CAKE = 34

    /**
     * Flags for the helper's own virtual displays. The display is
     * private/own-content: PUBLIC + OWN_CONTENT_ONLY means other apps cannot
     * mirror it and it cannot mirror the main screen, SUPPORTS_TOUCH routes
     * touches to it, and DESTROY_CONTENT_ON_REMOVAL kills the apps on it when
     * the display goes away with the helper process.
     *
     * [trusted] adds the flags that need ADD_TRUSTED_DISPLAY: the display
     * keeps its own focus without stealing the main screen's
     * (OWN_FOCUS + STEAL_TOP_FOCUS_DISABLED), and forms its own display group.
     * Some systems deny shell that permission with a SecurityException; the
     * caller retries once without those flags — the display then shares focus
     * handling, but never gains any new capability.
     */
    fun displayFlags(sdk: Int, trusted: Boolean): Int {
        var flags = FLAG_PUBLIC or FLAG_OWN_CONTENT_ONLY or FLAG_SUPPORTS_TOUCH or
            FLAG_ROTATES_WITH_CONTENT or FLAG_DESTROY_CONTENT_ON_REMOVAL
        if (sdk >= SDK_TIRAMISU) {
            flags = flags or FLAG_TOUCH_FEEDBACK_DISABLED
            if (trusted) flags = flags or FLAG_TRUSTED or FLAG_OWN_DISPLAY_GROUP or FLAG_ALWAYS_UNLOCKED
        }
        if (sdk >= SDK_UPSIDE_DOWN_CAKE && trusted) {
            flags = flags or FLAG_OWN_FOCUS or FLAG_STEAL_TOP_FOCUS_DISABLED
        }
        return flags
    }

    /** Only a permission denial (SecurityException, e.g. no ADD_TRUSTED_DISPLAY) is worth a non-trusted retry. */
    fun retryWithoutTrust(t: Throwable): Boolean = t is SecurityException

    // InputManager inject modes (the INJECT_INPUT_EVENT_MODE_* constants).
    private const val INJECT_MODE_ASYNC = 0
    private const val INJECT_MODE_WAIT_FOR_RESULT = 1
    private const val INJECT_MODE_WAIT_FOR_FINISH = 2

    /**
     * Keys wait for the system to decide a target window (WAIT_FOR_RESULT): a
     * key with no window to receive it then reports failure instead of being
     * dropped. Touches stay async so a timed stroke is not distorted by
     * waiting on each point's dispatch.
     */
    fun injectMode(key: Boolean, waitForFinish: Boolean): Int = when {
        waitForFinish -> INJECT_MODE_WAIT_FOR_FINISH
        key -> INJECT_MODE_WAIT_FOR_RESULT
        else -> INJECT_MODE_ASYNC
    }

    // A stroke's limits: point count and total press-to-lift duration.
    const val STROKE_MAX_POINTS = 1_024
    const val STROKE_MAX_MS = 10_000L

    /** A stroke needs at least a press and a lift, matching arrays, a zero first time, non-decreasing times within budget. */
    fun strokeValid(xs: IntArray, ys: IntArray, times: LongArray): Boolean {
        val n = times.size
        if (n < 2 || n > STROKE_MAX_POINTS || xs.size != n || ys.size != n || times[0] != 0L ||
            times.last() > STROKE_MAX_MS || (1 until n).any { times[it] < times[it - 1] }
        ) return false
        return true
    }
}
