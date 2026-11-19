// Adapted from Mika's DeviceUnlockInput and DeviceAccess (Apache-2.0).
package com.openmausbot.companion.phoneui

import android.os.IBinder
import com.openmausbot.companion.phoneui.shell.IPhoneUiShell
import com.openmausbot.companion.phoneui.shell.PhoneUiShell
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The app-side gate: with the person's remote-unlock switch off, the facade
 * must not reach the helper at all — not the wake, not the swipe, not the
 * credential — and a credential buffer handed to it must still be wiped.
 *
 * Robolectric because the generated AIDL stub attaches its interface in its
 * constructor, which needs a real `android.os.Binder`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PhoneUiShellUnlockGateTest {
    private class RecordingShell : IPhoneUiShell.Stub() {
        val calls = mutableListOf<String>()
        var enterBytes: ByteArray? = null

        override fun createDisplay(surface: android.view.Surface?, width: Int, height: Int, dpi: Int) = 0
        override fun releaseDisplay(displayId: Int) = Unit
        override fun launchApp(displayId: Int, packageName: String?) = 0
        override fun injectTap(displayId: Int, x: Int, y: Int) = true
        override fun injectStroke(displayId: Int, xs: IntArray?, ys: IntArray?, times: LongArray?) = true
        override fun injectKey(displayId: Int, keyCode: Int) = true
        override fun topPackage(displayId: Int): String? = null
        override fun identity(): IntArray = intArrayOf(0, 0)
        override fun topTaskId(displayId: Int) = -1
        override fun packageOfTask(taskId: Int): String? = null
        override fun moveTask(taskId: Int, displayId: Int) = true
        override fun typeText(displayId: Int, text: String?) = true
        override fun readClipboard(): String? = null
        override fun writeClipboard(text: String?) = true
        override fun shareIntent(displayId: Int, contentUri: String?, mime: String?, packageName: String?) = 0
        override fun forceStop(packageName: String?) = true
        override fun putSecureSetting(name: String?, value: String?) = true
        override fun grantOwnWriteSecureSettings(packageName: String?) = true
        override fun wakeDevice(): Boolean {
            calls += "wake"
            return true
        }

        override fun revealKeyguard(): Boolean {
            calls += "reveal"
            return true
        }

        override fun enterDeviceCredential(kind: Int, credential: ByteArray?, clear: Int): Boolean {
            calls += "enter"
            enterBytes = credential?.copyOf()
            return true
        }

        override fun tapKeyguard(x: Int, y: Int): Boolean {
            calls += "tap"
            return true
        }

        override fun releaseAll() = Unit
        override fun destroy() = Unit
        override fun asBinder(): IBinder = throw UnsupportedOperationException("not used")
    }

    @Test
    fun `the switch off refuses every keyguard call before the binder`() {
        val helper = RecordingShell()
        val shell = PhoneUiShell(helper) { false }

        assertFalse(shell.wake())
        assertFalse(shell.revealKeyguard())
        assertFalse(shell.tapKeyguard(10, 20))
        val bytes = "1234".toByteArray()
        assertFalse(shell.enterDeviceCredential(UnlockCredential.KIND_PIN, bytes, 0))

        assertTrue(helper.calls.isEmpty(), "nothing may reach the helper while the switch is off")
        assertTrue(bytes.all { it == 0.toByte() }, "the credential buffer is wiped even when refused")
    }

    @Test
    fun `the switch on forwards all four calls`() {
        val helper = RecordingShell()
        val shell = PhoneUiShell(helper) { true }

        assertTrue(shell.wake())
        assertTrue(shell.revealKeyguard())
        assertTrue(shell.tapKeyguard(10, 20))
        assertTrue(shell.enterDeviceCredential(UnlockCredential.KIND_PIN, "1234".toByteArray(), 2))

        assertEquals(listOf("wake", "reveal", "tap", "enter"), helper.calls)
        assertEquals("1234", helper.enterBytes?.let { String(it, Charsets.US_ASCII) })
    }

    @Test
    fun `a facade nobody wired unlocks nothing`() {
        val helper = RecordingShell()
        val shell = PhoneUiShell(helper)
        assertFalse(shell.wake())
        assertTrue(helper.calls.isEmpty())
    }
}
