// Adapted from Mika's DeviceUnlockInput and DeviceAccess (Apache-2.0).
package com.openmausbot.companion.phoneui.shell

import android.os.IBinder
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The four keyguard transactions were appended after `grantOwnWriteSecureSettings`
 * (19) and must never reuse a number: a collision silently renumbers an endpoint
 * the helper already answers, and the old app's call would land on the new one.
 *
 * In this package because the generated `TRANSACTION_*` fields are
 * package-private, as `PhoneUiGrantTest` already relies on.
 */
class PhoneUiUnlockTransactionsTest {
    private fun id(transaction: Int) = transaction - IBinder.FIRST_CALL_TRANSACTION

    private val keyguard = mapOf(
        "wakeDevice" to id(IPhoneUiShell.Stub.TRANSACTION_wakeDevice),
        "revealKeyguard" to id(IPhoneUiShell.Stub.TRANSACTION_revealKeyguard),
        "enterDeviceCredential" to id(IPhoneUiShell.Stub.TRANSACTION_enterDeviceCredential),
        "tapKeyguard" to id(IPhoneUiShell.Stub.TRANSACTION_tapKeyguard),
    )

    private val existing = mapOf(
        "createDisplay" to id(IPhoneUiShell.Stub.TRANSACTION_createDisplay),
        "releaseDisplay" to id(IPhoneUiShell.Stub.TRANSACTION_releaseDisplay),
        "launchApp" to id(IPhoneUiShell.Stub.TRANSACTION_launchApp),
        "injectTap" to id(IPhoneUiShell.Stub.TRANSACTION_injectTap),
        "injectStroke" to id(IPhoneUiShell.Stub.TRANSACTION_injectStroke),
        "injectKey" to id(IPhoneUiShell.Stub.TRANSACTION_injectKey),
        "topPackage" to id(IPhoneUiShell.Stub.TRANSACTION_topPackage),
        "identity" to id(IPhoneUiShell.Stub.TRANSACTION_identity),
        "releaseAll" to id(IPhoneUiShell.Stub.TRANSACTION_releaseAll),
        "topTaskId" to id(IPhoneUiShell.Stub.TRANSACTION_topTaskId),
        "packageOfTask" to id(IPhoneUiShell.Stub.TRANSACTION_packageOfTask),
        "moveTask" to id(IPhoneUiShell.Stub.TRANSACTION_moveTask),
        "typeText" to id(IPhoneUiShell.Stub.TRANSACTION_typeText),
        "readClipboard" to id(IPhoneUiShell.Stub.TRANSACTION_readClipboard),
        "writeClipboard" to id(IPhoneUiShell.Stub.TRANSACTION_writeClipboard),
        "shareIntent" to id(IPhoneUiShell.Stub.TRANSACTION_shareIntent),
        "forceStop" to id(IPhoneUiShell.Stub.TRANSACTION_forceStop),
        "putSecureSetting" to id(IPhoneUiShell.Stub.TRANSACTION_putSecureSetting),
        "grantOwnWriteSecureSettings" to id(IPhoneUiShell.Stub.TRANSACTION_grantOwnWriteSecureSettings),
    )

    @Test
    fun `the keyguard endpoints are 20 through 23`() {
        assertEquals(20, keyguard.getValue("wakeDevice"))
        assertEquals(21, keyguard.getValue("revealKeyguard"))
        assertEquals(22, keyguard.getValue("enterDeviceCredential"))
        assertEquals(23, keyguard.getValue("tapKeyguard"))
    }

    @Test
    fun `no existing transaction number moved`() {
        assertEquals((1..19).toList(), existing.values.sorted())
        assertEquals(16777114, id(IPhoneUiShell.Stub.TRANSACTION_destroy))
    }

    @Test
    fun `every keyguard id is distinct from every other id`() {
        val all = keyguard.values + existing.values + id(IPhoneUiShell.Stub.TRANSACTION_destroy)
        assertEquals(all.size, all.toSet().size, "a reused transaction id would answer the wrong call")
        assertTrue(keyguard.values.none { it in existing.values })
    }
}
