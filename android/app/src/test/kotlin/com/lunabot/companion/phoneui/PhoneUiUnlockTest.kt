// Adapted from Mika's DeviceUnlockInput and DeviceAccess (Apache-2.0).
package com.lunabot.companion.phoneui

import android.os.SystemClock
import android.view.InputDevice
import android.view.InputEvent
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.MotionEvent
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The helper's keyguard input, driven through its injected fakes so the
 * assertions are about what it would send rather than about a device.
 *
 * The invariants under test: nothing is injected for a value the credential
 * rules reject (and the caller's buffer is still wiped), the buffer is wiped
 * after a real attempt too, only the requested number of DELs is sent, every
 * key goes to the SystemUI uid and never to an untargeted inject, and a
 * platform without the targeted overload fails closed.
 *
 * Events are recorded as their interesting fields at injection time: the
 * implementation recycles each `MotionEvent` in a `finally`, so the object
 * itself is not readable afterwards.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PhoneUiUnlockTest {
    private class Key(val code: Int, val action: Int, val uid: Int)
    private class Touch(val action: Int, val uid: Int)

    private val keys = mutableListOf<Key>()
    private val touches = mutableListOf<Touch>()
    private val untargeted = mutableListOf<InputEvent>()

    private var interactive = true
    private var keyguardLocked = true
    private var deviceLocked = true
    private var secure = true
    private var enabled = true
    private var wakeLocked = false

    private fun unlock(
        sdk: Int = 34,
        charEvents: (CharArray) -> Array<KeyEvent>? = { chars ->
            chars.map { c ->
                val code = if (c == ' ') KeyEvent.KEYCODE_SPACE else KeyEvent.KEYCODE_A
                KeyEvent(
                    SystemClock.uptimeMillis(), SystemClock.uptimeMillis(), KeyEvent.ACTION_DOWN, code, 0, 0,
                    KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD,
                )
            }.toTypedArray()
        },
    ) = PhoneUiUnlock(
        enabled = { enabled },
        interactive = { interactive },
        keyguardLocked = { keyguardLocked },
        deviceLocked = { deviceLocked },
        secureKeyguard = { secure },
        systemUiUid = { SYSTEM_UI_UID },
        screenBounds = { android.graphics.Rect(0, 0, 1080, 2400) },
        acquireWakeLock = { wakeLocked = true; true },
        inject = { event -> untargeted += event; true },
        injectTo = { event, uid ->
            when (event) {
                is KeyEvent -> keys += Key(event.keyCode, event.action, uid)
                is MotionEvent -> touches += Touch(event.actionMasked, uid)
            }
            true
        },
        charEvents = charEvents,
        sdk = sdk,
        now = SystemClock::uptimeMillis,
        sleep = {},
    )

    /** Key codes of the presses only: a key is a down/up pair, and the pair is what gets sent. */
    private fun pressedKeys(): List<Int> = keys.filter { it.action == KeyEvent.ACTION_DOWN }.map { it.code }

    private fun touchActions(): List<Int> = touches.map { it.action }

    @Test
    fun `a pin sends exactly the requested dels and then the digits`() {
        val bytes = "1234".toByteArray()

        assertTrue(unlock().enter(UnlockCredential.KIND_PIN, bytes, clear = 2))

        assertEquals(
            listOf(
                KeyEvent.KEYCODE_DEL, KeyEvent.KEYCODE_DEL,
                KeyEvent.KEYCODE_1, KeyEvent.KEYCODE_2, KeyEvent.KEYCODE_3, KeyEvent.KEYCODE_4,
                KeyEvent.KEYCODE_ENTER,
            ),
            pressedKeys(),
        )
        assertTrue(keys.all { it.uid == SYSTEM_UI_UID }, "every key must target the SystemUI uid")
        assertTrue(untargeted.isEmpty(), "a credential never takes the untargeted path")
        assertContentEquals(ByteArray(4), bytes, "the caller's buffer is wiped")
    }

    @Test
    fun `clear zero sends no del at all`() {
        assertTrue(unlock().enter(UnlockCredential.KIND_PIN, "9876".toByteArray(), clear = 0))
        assertFalse(KeyEvent.KEYCODE_DEL in pressedKeys())
    }

    @Test
    fun `clear is clamped so a caller cannot spray dels`() {
        assertTrue(unlock().enter(UnlockCredential.KIND_PIN, "9876".toByteArray(), clear = 1_000))
        assertEquals(PhoneUiUnlock.MAX_CLEAR, pressedKeys().count { it == KeyEvent.KEYCODE_DEL })
    }

    @Test
    fun `the clear burst stops when the phone stops being locked`() {
        // The first DEL is delivered and the phone then reports itself unlocked
        // (a ROM that accepts the credential early, or the person unlocking by
        // hand): the remaining DELs and every digit must not be sent.
        var dels = 0
        val guarded = PhoneUiUnlock(
            enabled = { true },
            interactive = { true },
            keyguardLocked = { true },
            deviceLocked = { dels < 1 },
            secureKeyguard = { true },
            systemUiUid = { SYSTEM_UI_UID },
            screenBounds = { android.graphics.Rect(0, 0, 1080, 2400) },
            acquireWakeLock = { true },
            inject = { true },
            injectTo = { event, uid ->
                if (event is KeyEvent) {
                    keys += Key(event.keyCode, event.action, uid)
                    if (event.keyCode == KeyEvent.KEYCODE_DEL && event.action == KeyEvent.ACTION_DOWN) dels++
                }
                true
            },
            charEvents = { null },
            sdk = 34,
            now = SystemClock::uptimeMillis,
            sleep = {},
        )

        assertFalse(guarded.enter(UnlockCredential.KIND_PIN, "1234".toByteArray(), clear = 4))

        assertEquals(
            listOf(KeyEvent.KEYCODE_DEL),
            pressedKeys(),
            "the first DEL is sent; the re-check refuses the next one, and no digit follows",
        )
    }

    @Test
    fun `a password goes through the character map, select-all first`() {
        assertTrue(unlock().enter(UnlockCredential.KIND_PASSWORD, "ab cd".toByteArray(), clear = 0))
        val codes = pressedKeys()
        assertEquals(KeyEvent.KEYCODE_A, codes[0], "select-all")
        assertEquals(KeyEvent.KEYCODE_DEL, codes[1], "then clear the selection")
        // The fake map sends KEYCODE_A for every non-space character, so the
        // five characters are five presses after the select-all and its DEL.
        assertEquals(5, codes.drop(2).count { it == KeyEvent.KEYCODE_A || it == KeyEvent.KEYCODE_SPACE })
        assertEquals(KeyEvent.KEYCODE_ENTER, codes.last())
    }

    @Test
    fun `non-printable bytes are refused without injecting anything`() {
        for (bytes in listOf(
            byteArrayOf(49, 50, 51, 0x00),
            byteArrayOf(49, 50, 51, 0x09),
            byteArrayOf(49, 50, 51, 0x7f),
            byteArrayOf(-1, 49, 50, 51),
        )) {
            val copy = bytes.copyOf()
            assertFalse(unlock().enter(UnlockCredential.KIND_PASSWORD, bytes, clear = 0), "must refuse ${copy.toList()}")
            assertContentEquals(ByteArray(copy.size), bytes, "the buffer is wiped even when refused")
        }
        assertTrue(keys.isEmpty(), "a refused value must not reach the keyguard")
        assertTrue(touches.isEmpty())
        assertTrue(untargeted.isEmpty())
    }

    @Test
    fun `oversized and malformed values are refused without injecting anything`() {
        assertFalse(unlock().enter(UnlockCredential.KIND_PIN, "123".toByteArray(), 0))
        assertFalse(unlock().enter(UnlockCredential.KIND_PIN, "1".repeat(17).toByteArray(), 0))
        assertFalse(unlock().enter(UnlockCredential.KIND_PIN, "12a4".toByteArray(), 0))
        assertFalse(unlock().enter(UnlockCredential.KIND_PASSWORD, "x".repeat(65).toByteArray(), 0))
        assertFalse(unlock().enter(UnlockCredential.KIND_PASSWORD, "    ".toByteArray(), 0))
        assertFalse(unlock().enter(3, "1234".toByteArray(), 0))
        assertTrue(keys.isEmpty())
        assertTrue(touches.isEmpty())
    }

    @Test
    fun `an unlocked phone gets nothing`() {
        keyguardLocked = false
        deviceLocked = false
        assertFalse(unlock().enter(UnlockCredential.KIND_PIN, "1234".toByteArray(), 0))
        assertTrue(keys.isEmpty())
    }

    @Test
    fun `a swipe-only keyguard is not a typing target`() {
        secure = false
        assertFalse(unlock().enter(UnlockCredential.KIND_PIN, "1234".toByteArray(), 0))
        assertTrue(keys.isEmpty())
    }

    @Test
    fun `the switch off means no input at all`() {
        enabled = false
        assertFalse(unlock().enter(UnlockCredential.KIND_PIN, "1234".toByteArray(), 0))
        assertFalse(unlock().reveal())
        assertFalse(unlock().tap(10, 20))
        assertFalse(unlock().wake())
        assertTrue(keys.isEmpty())
        assertTrue(touches.isEmpty())
        assertTrue(untargeted.isEmpty())
    }

    @Test
    fun `an older platform fails closed instead of injecting untargeted`() {
        assertFalse(unlock(sdk = 32).enter(UnlockCredential.KIND_PIN, "1234".toByteArray(), 0))
        assertFalse(unlock(sdk = 32).reveal())
        assertFalse(unlock(sdk = 32).tap(10, 20))
        assertTrue(keys.isEmpty())
        assertTrue(touches.isEmpty())
        assertTrue(untargeted.isEmpty(), "no targeted overload means no event at all")
    }

    @Test
    fun `reveal swipes to the SystemUI uid only while locked`() {
        assertTrue(unlock().reveal())
        assertTrue(touches.isNotEmpty())
        assertTrue(touches.all { it.uid == SYSTEM_UI_UID })
        assertEquals(MotionEvent.ACTION_DOWN, touchActions().first())
        assertEquals(MotionEvent.ACTION_UP, touchActions().last())

        touches.clear()
        deviceLocked = false
        assertFalse(unlock().reveal())
        assertTrue(touches.isEmpty())
    }

    @Test
    fun `tap is a press and lift at the SystemUI uid`() {
        assertTrue(unlock().tap(540, 1800))
        assertEquals(listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP), touchActions())
        assertTrue(touches.all { it.uid == SYSTEM_UI_UID })
    }

    @Test
    fun `wake uses the wake lock and never sends a credential`() {
        interactive = false
        assertTrue(unlock().wake())
        assertTrue(wakeLocked)
        // The wake key is the one untargeted event this class may send, and it
        // carries no content.
        assertTrue(untargeted.all { (it as KeyEvent).keyCode == KeyEvent.KEYCODE_WAKEUP })
        assertTrue(keys.isEmpty())
    }

    @Test
    fun `wake sends no untargeted key when the phone is already unlocked`() {
        interactive = false
        keyguardLocked = false
        deviceLocked = false
        unlock().wake()
        assertTrue(untargeted.isEmpty(), "with nothing locked there is nothing to wake for")
    }

    private companion object {
        const val SYSTEM_UI_UID = 10_123
    }
}
