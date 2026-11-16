/*
 * Pins the helper's one-time WRITE_SECURE_SETTINGS grant. The permission is
 * what lets the app keep `adb_wifi_enabled` on after a reboot without asking
 * the helper again, so the interesting properties are the ones an ordinary
 * implementation would get wrong: the argv is exactly one fixed command, a
 * package the caller's uid does not own never reaches it, and every failure
 * mode (malformed name, `pm` refusing, a runner that throws) is a false return
 * rather than an exception or a spawned process.
 *
 * Robolectric because the implementation logs through android.util.Log, as the
 * rest of this suite does.
 */
package com.openmausbot.companion.phoneui.shell

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PhoneUiGrantTest {

    private val own = "com.lunabot.companion"

    /** What the real runner would see; null means the runner was never called. */
    private var seen: Array<String>? = null

    private fun grant(
        packageName: String,
        owned: Array<String>? = arrayOf(own),
        exit: Int = 0,
    ): Boolean = PhoneUiShellService.grantWriteSecureSettings(
        packageName = packageName,
        callerUid = 10_123,
        packagesForUid = { owned },
        run = { argv ->
            seen = argv
            exit
        },
    )

    @Test
    fun `the argv is exactly one fixed pm grant`() {
        assertEquals(
            listOf("/system/bin/pm", "grant", own, "android.permission.WRITE_SECURE_SETTINGS"),
            PhoneUiShellService.pmGrantCommand(own).toList(),
        )
        assertEquals(
            "android.permission.WRITE_SECURE_SETTINGS",
            PhoneUiShellService.GRANTED_PERMISSION,
            "the only permission this endpoint may grant",
        )
    }

    @Test
    fun `the transaction number stays 19 and destroy keeps its sentinel`() {
        // AIDL ids are offsets from FIRST_CALL_TRANSACTION; 19 is the id written
        // in the .aidl file, after putSecureSetting's 18.
        assertEquals(19, IPhoneUiShell.Stub.TRANSACTION_grantOwnWriteSecureSettings - android.os.IBinder.FIRST_CALL_TRANSACTION)
        assertEquals(16777114, IPhoneUiShell.Stub.TRANSACTION_destroy - android.os.IBinder.FIRST_CALL_TRANSACTION)
    }

    @Test
    fun `a package the caller uid does not own is refused before pm runs`() {
        assertFalse(grant("com.other.app", owned = arrayOf(own)))
        assertEquals(null, seen, "an unowned package must never reach a process")
        // An unknown uid resolves to no packages at all, and a null answer is
        // not ownership either.
        assertFalse(grant(own, owned = null))
        assertEquals(null, seen)
    }

    @Test
    fun `a non-zero exit is false and a zero exit is true`() {
        assertFalse(grant(own, exit = 1))
        assertEquals(PhoneUiShellService.pmGrantCommand(own).toList(), seen?.toList())
        seen = null
        assertTrue(grant(own, exit = 0))
        assertEquals(PhoneUiShellService.pmGrantCommand(own).toList(), seen?.toList())
    }

    @Test
    fun `a runner that throws is a false return, not an exception`() {
        val result = runCatching {
            PhoneUiShellService.grantWriteSecureSettings(
                packageName = own,
                callerUid = 10_123,
                packagesForUid = { arrayOf(own) },
                run = { throw IllegalStateException("pm is gone") },
            )
        }
        assertTrue(result.isSuccess, "the throw must not cross the binder")
        assertFalse(result.getOrThrow())
    }

    @Test
    fun `a package list that cannot be read fails closed`() {
        val result = runCatching {
            PhoneUiShellService.grantWriteSecureSettings(
                packageName = own,
                callerUid = 10_123,
                packagesForUid = { throw IllegalStateException("package manager is gone") },
                run = { seen = it; 0 },
            )
        }
        assertTrue(result.isSuccess)
        assertFalse(result.getOrThrow())
        assertEquals(null, seen)
    }

    @Test
    fun `a malformed package name is refused before any process`() {
        for (bad in listOf(
            "",
            "com.x;pm",
            "../../x",
            "com.x grant android.permission.WRITE_SECURE_SETTINGS",
            "-r",
            "com.x\n",
            "a".repeat(201),
        )) {
            assertFalse(PhoneUiShellService.packageNameAllowed(bad), "'$bad' must not be a package name")
            // The uid "owns" it in this call, so only the shape check can be
            // what refuses it.
            assertFalse(grant(bad, owned = arrayOf(bad)), "'$bad' must be refused")
            assertEquals(null, seen, "'$bad' must never reach a process")
        }
        // Exactly at the bound is still a name a package could have.
        val atBound = "a".repeat(200)
        assertTrue(PhoneUiShellService.packageNameAllowed(atBound))
    }

    @Test
    fun `the preview application id is accepted when the caller owns it`() {
        // The only reason the package is a parameter: a debug/preview build has
        // a suffixed applicationId and must be granted its own name, not ours.
        val preview = "com.lunabot.companion.preview"
        assertTrue(PhoneUiShellService.packageNameAllowed(preview))
        assertTrue(grant(preview, owned = arrayOf(own, preview)))
        assertEquals(
            listOf("/system/bin/pm", "grant", preview, "android.permission.WRITE_SECURE_SETTINGS"),
            seen?.toList(),
        )
        // Owned by the uid, but the caller asked for a name that is not its
        // own: still refused.
        seen = null
        assertFalse(grant(preview, owned = arrayOf(own)))
        assertEquals(null, seen)
    }
}
