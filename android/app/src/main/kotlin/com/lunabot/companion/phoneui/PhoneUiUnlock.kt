// Adapted from Mika's DeviceUnlockInput and DeviceAccess (Apache-2.0).
package com.openmausbot.companion.phoneui

import android.app.KeyguardManager
import android.content.Context
import android.graphics.Rect
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.InputEvent
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.WindowManager

/**
 * The keyguard half of the shell helper: wake the screen, swipe the keyguard up,
 * type the credential the person stored on the phone, and tap a fallback button.
 *
 * Every credential key is injected through [injectTo], which targets the
 * SystemUI *window uid*, never a display: while any other window owns the focus
 * (an app over the keyguard, a call, a full-screen notification) or after the
 * phone unlocked back to an app, the system refuses the event, so a keystroke
 * cannot land anywhere else. [inject] is used only for the screen wake key,
 * which carries no content.
 *
 * Nothing here is logged beyond an exception class name: this is the one path
 * where a PIN or password crosses a process boundary, and it must not also
 * reach logcat, a crash report or a job result.
 */
internal class PhoneUiUnlock(
    private val enabled: () -> Boolean,
    private val interactive: () -> Boolean,
    private val keyguardLocked: () -> Boolean,
    private val deviceLocked: () -> Boolean,
    private val secureKeyguard: () -> Boolean,
    private val systemUiUid: () -> Int?,
    private val screenBounds: () -> Rect?,
    private val acquireWakeLock: () -> Boolean,
    private val inject: (InputEvent) -> Boolean,
    private val injectTo: (InputEvent, Int) -> Boolean,
    private val charEvents: (CharArray) -> Array<KeyEvent>? = {
        KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(it)
    },
    private val sdk: Int = Build.VERSION.SDK_INT,
    private val now: () -> Long = SystemClock::uptimeMillis,
    private val sleep: (Long) -> Unit = SystemClock::sleep,
) {
    /**
     * WakeLock + ACQUIRE_CAUSES_WAKEUP is the old but portable way to light the
     * screen; KEYCODE_WAKEUP alone is ignored by some ROMs (Mika #618). The wake
     * key is the only event here that is not addressed to a window uid, so it is
     * sent only while the screen is off *and* the keyguard is up: with the phone
     * already unlocked there is nothing to wake for.
     */
    @Suppress("DEPRECATION")
    fun wake(): Boolean = try {
        if (!enabled() || !secureKeyguard()) false else {
            val woken = runCatching { acquireWakeLock() }.getOrDefault(false)
            val key = if (interactive() || !keyguardLocked() || !deviceLocked()) {
                false
            } else {
                key(KeyEvent.KEYCODE_WAKEUP, send = inject)
            }
            woken || key || interactive()
        }
    } catch (t: Throwable) {
        Log.w(TAG, "wakeDevice failed: ${t.javaClass.simpleName}")
        false
    }

    /**
     * Swipe up from 85% to 45% of the screen height while a secure keyguard is
     * still up, so a notification/fingerprint page shows the credential page.
     * Each move is injected to SystemUI and re-checks the keyguard first, so a
     * swipe that finishes (or loses) the unlock never continues into the app.
     */
    fun reveal(): Boolean {
        return try {
            val target = if (enabled()) systemUiUid() else null
            val bounds = screenBounds()
            if (target == null || bounds == null || !canReachKeyguard()) {
                false
            } else {
                val x = bounds.exactCenterX()
                val startY = bounds.bottom - bounds.height() * 0.15f
                val endY = bounds.top + bounds.height() * 0.45f
                val downAt = now()
                fun send(action: Int, at: Long, y: Float): Boolean {
                    val event = MotionEvent.obtain(downAt, at, action, x, y, 0)
                    return try {
                        event.source = InputDevice.SOURCE_TOUCHSCREEN
                        injectTo(event, target)
                    } finally {
                        event.recycle()
                    }
                }
                if (!send(MotionEvent.ACTION_DOWN, downAt, startY)) {
                    false
                } else {
                    var completed = false
                    try {
                        for (step in 0 until REVEAL_STEPS) {
                            if (!canReachKeyguard()) return false
                            sleep(REVEAL_STEP_MS)
                            val progress = (step + 1) / REVEAL_STEPS.toFloat()
                            if (!send(MotionEvent.ACTION_MOVE, now(), startY + (endY - startY) * progress)) return false
                        }
                        if (!canReachKeyguard()) return false
                        completed = send(MotionEvent.ACTION_UP, now(), endY)
                        completed
                    } finally {
                        if (!completed) send(MotionEvent.ACTION_CANCEL, now(), endY)
                    }
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "revealKeyguard failed: ${t.javaClass.simpleName}")
            false
        }
    }

    /** One tap for a "use PIN" style fallback button on the keyguard; carries no credential. */
    fun tap(x: Int, y: Int): Boolean = try {
        val target = if (enabled()) systemUiUid() else null
        if (target == null || !canReachKeyguard()) {
            false
        } else {
            val downAt = now()
            fun send(action: Int, eventTime: Long): Boolean {
                val event = MotionEvent.obtain(downAt, eventTime, action, x.toFloat(), y.toFloat(), 0)
                return try {
                    event.source = InputDevice.SOURCE_TOUCHSCREEN
                    injectTo(event, target)
                } finally {
                    event.recycle()
                }
            }
            send(MotionEvent.ACTION_DOWN, downAt) && send(MotionEvent.ACTION_UP, downAt + TAP_MS)
        }
    } catch (t: Throwable) {
        Log.w(TAG, "tapKeyguard failed: ${t.javaClass.simpleName}")
        false
    }

    /**
     * Type [bytes] into the keyguard and submit it. The buffer is zeroized on
     * every path, valid or not.
     *
     * PIN: [clear] DEL presses first, then one KEYCODE_0..9 per digit.
     * Password: select-all then DEL, then the key events the virtual keyboard
     * map produces for the characters. Only an already-typed length is cleared
     * — a blind DEL burst on an empty field closes the password page on some
     * ROMs and swallows the digits that follow (Mika's note).
     *
     * Android 13 is the first release with the targeted `injectInputEvent`
     * overload; earlier releases return false and inject nothing, because an
     * untargeted key would land in whatever has focus.
     */
    fun enter(kind: Int, bytes: ByteArray, clear: Int): Boolean = try {
        if (!enabled() || !UnlockCredential.validBytes(kind, bytes)) false else enterValidated(kind, bytes, clear)
    } catch (t: Throwable) {
        Log.w(TAG, "enterDeviceCredential failed: ${t.javaClass.simpleName}")
        false
    } finally {
        bytes.fill(0)
    }

    private fun enterValidated(kind: Int, bytes: ByteArray, clear: Int): Boolean {
        val target = systemUiUid()
        var chars = CharArray(0)
        var sent = false
        val deadline = now() + ENTER_DEADLINE_MS
        fun toKeyguard(event: InputEvent): Boolean {
            sent = true
            return injectTo(event, target!!)
        }
        return try {
            if (target == null || !canReachKeyguard()) return false
            chars = CharArray(bytes.size) { bytes[it].toInt().toChar() }
            val events = if (kind == UnlockCredential.KIND_PASSWORD) charEvents(chars) ?: return false else null
            if (kind == UnlockCredential.KIND_PIN) {
                repeat(clear.coerceIn(0, MAX_CLEAR)) {
                    // Each DEL is a key like any other: the phone may unlock (or
                    // another window may take focus) between two of them.
                    if (now() > deadline || !canReachKeyguard()) return false
                    if (!key(KeyEvent.KEYCODE_DEL, send = ::toKeyguard)) return false
                }
            } else {
                if (now() > deadline || !canReachKeyguard()) return false
                if (!key(KeyEvent.KEYCODE_A, KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON, ::toKeyguard) ||
                    !canReachKeyguard() ||
                    !key(KeyEvent.KEYCODE_DEL, send = ::toKeyguard)
                ) {
                    return false
                }
            }
            if (kind == UnlockCredential.KIND_PIN) {
                for (c in chars) {
                    if (now() > deadline || !canReachKeyguard()) return false
                    if (!key(KeyEvent.KEYCODE_0 + (c - '0'), send = ::toKeyguard)) return false
                }
            } else {
                for (event in events!!) {
                    event.source = InputDevice.SOURCE_KEYBOARD
                    if (now() > deadline || !canReachKeyguard() || !toKeyguard(event)) return false
                }
            }
            // Some systems submit on the last digit. Enter is still addressed to
            // SystemUI: if the phone unlocked in the meantime the system refuses
            // it rather than typing a newline into the app underneath.
            sleep(SUBMIT_SETTLE_MS)
            !keyguardLocked() || !deviceLocked() || key(KeyEvent.KEYCODE_ENTER, send = ::toKeyguard)
        } finally {
            chars.fill('\u0000')
            // A password may have held Shift/Alt; release them only if a key was
            // sent, and still only to SystemUI.
            if (sent && target != null) for (code in MODIFIERS) {
                val at = now()
                injectTo(
                    KeyEvent(
                        at, at, KeyEvent.ACTION_UP, code, 0, 0,
                        KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD,
                    ),
                    target,
                )
            }
        }
    }

    private fun key(code: Int, meta: Int = 0, send: (InputEvent) -> Boolean): Boolean {
        val at = now()
        val down = KeyEvent(
            at, at, KeyEvent.ACTION_DOWN, code, 0, meta,
            KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD,
        )
        return send(down) && send(KeyEvent.changeAction(down, KeyEvent.ACTION_UP))
    }

    /**
     * The keyguard is a secure one, is up, the screen is on, and a targeted
     * inject can reach SystemUI at all. A swipe-only keyguard has nothing to
     * type into, so it is refused here rather than after a wake and a swipe.
     */
    private fun canReachKeyguard(): Boolean =
        sdk >= TARGETED_INJECTION_SDK && secureKeyguard() && interactive() && keyguardLocked() && deviceLocked()

    companion object {
        private const val TAG = "PhoneUiUnlock"

        /** Android 13 (TIRAMISU) added `injectInputEvent(InputEvent, int, int)`. */
        const val TARGETED_INJECTION_SDK = 33

        const val MAX_CLEAR = 16
        private const val ENTER_DEADLINE_MS = 8_000L
        private const val SUBMIT_SETTLE_MS = 200L
        private const val REVEAL_STEPS = 6
        private const val REVEAL_STEP_MS = 24L
        private const val TAP_MS = 30L
        private const val SYSTEM_UI = "com.android.systemui"

        private val MODIFIERS = intArrayOf(
            KeyEvent.KEYCODE_SHIFT_LEFT,
            KeyEvent.KEYCODE_SHIFT_RIGHT,
            KeyEvent.KEYCODE_ALT_LEFT,
            KeyEvent.KEYCODE_ALT_RIGHT,
        )

        /** Wires the helper's real services and event injection. */
        @Suppress("DEPRECATION")
        fun of(
            context: Context,
            enabled: () -> Boolean,
            inject: (InputEvent) -> Boolean,
            injectTo: (InputEvent, Int) -> Boolean,
        ): PhoneUiUnlock {
            val keyguard = context.getSystemService(KeyguardManager::class.java)
            val power = context.getSystemService(PowerManager::class.java)
            val systemUiUid = runCatching { context.packageManager.getPackageUid(SYSTEM_UI, 0) }.getOrNull()
            return PhoneUiUnlock(
                enabled = enabled,
                interactive = { power.isInteractive },
                keyguardLocked = { keyguard.isKeyguardLocked },
                deviceLocked = { keyguard.isDeviceLocked },
                secureKeyguard = { keyguard.isDeviceSecure },
                systemUiUid = { systemUiUid },
                screenBounds = {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                        runCatching {
                            context.getSystemService(WindowManager::class.java).currentWindowMetrics.bounds
                        }.getOrNull()
                    } else {
                        null
                    }
                },
                acquireWakeLock = {
                    power.newWakeLock(
                        PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
                        WAKE_LOCK_TAG,
                    ).acquire(WAKE_LOCK_MS)
                    true
                },
                inject = inject,
                injectTo = injectTo,
            )
        }

        private const val WAKE_LOCK_TAG = "lunabot:unlock"
        private const val WAKE_LOCK_MS = 1_000L
    }
}
