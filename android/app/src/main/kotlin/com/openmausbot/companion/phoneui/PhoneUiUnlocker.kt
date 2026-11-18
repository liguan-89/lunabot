// Adapted from Mika's DeviceUnlockInput and DeviceAccess (Apache-2.0).
package com.openmausbot.companion.phoneui

import android.util.Log
import com.openmausbot.companion.phoneui.shell.PhoneUiShell
import com.openmausbot.companion.storage.UnlockCredentialStore
import kotlinx.coroutines.delay

/** What this phone's KeyguardManager and PowerManager say about the lock screen right now. */
data class KeyguardSnapshot(
    val interactive: Boolean,
    val showing: Boolean,
    val deviceLocked: Boolean,
    val secure: Boolean,
) {
    val unlocked: Boolean get() = !showing && !deviceLocked
}

/** How one attempt ended. [unlocked] is the only success; the rest are the reasons Settings shows. */
enum class UnlockOutcome {
    /** This attempt typed the credential and the system then reported the phone unlocked. */
    Unlocked,

    /** The phone was already unlocked; nothing was typed. */
    AlreadyUnlocked,

    /** The person's remote-unlock switch is off, or no credential is stored. */
    Disabled,

    /** An earlier attempt never finished; the person unlocks by hand or saves the credential again. */
    Blocked,

    /** No helper is attached. */
    NoHelper,

    /** No secure keyguard: a swipe-only lock screen has nothing to type into. */
    UnsupportedKeyguard,

    /** The keyguard went away mid-sequence, or the attempt did not end in an unlock. */
    Failed,
    ;

    val unlocked: Boolean get() = this == Unlocked || this == AlreadyUnlocked
}

/**
 * One unlock attempt: wake if the screen is off, swipe the keyguard to its
 * credential page if it is still showing the notification/fingerprint page,
 * claim the attempt, type the stored credential, and clear the claim only once
 * the system reports the phone unlocked. The order and the bookkeeping are
 * Mika's `DeviceAccess.unlock`.
 *
 * A failed attempt leaves the claim in place, so nothing retries automatically
 * and the person can still unlock by hand. The credential bytes live only
 * between [UnlockCredentialStore.credential] and its `close`; nothing here makes
 * them a String or logs them.
 */
class PhoneUiUnlocker(
    private val store: UnlockCredentialStore,
    private val shell: () -> PhoneUiShell?,
    private val keyguard: () -> KeyguardSnapshot,
    private val pollMs: Long = 150,
    private val waitMs: Long = 5_000,
    /** How long the credential page gets to paint after the reveal swipe. */
    private val revealSettleMs: Long = 500,
    private val sleep: suspend (Long) -> Unit = { delay(it) },
) {
    /**
     * Try to unlock now. Never throws: this runs from a button now and from a
     * turn later, and neither can do anything with a crash.
     */
    suspend fun unlock(): UnlockOutcome {
        val state = store.state.value
        if (!state.configured || !state.remoteUnlockEnabled) return UnlockOutcome.Disabled
        if (state.blocked) return UnlockOutcome.Blocked
        val shell = shell() ?: return UnlockOutcome.NoHelper
        return try {
            attempt(shell)
        } catch (t: Throwable) {
            Log.w(TAG, "unlock failed: ${t.javaClass.simpleName}")
            UnlockOutcome.Failed
        }
    }

    private suspend fun attempt(shell: PhoneUiShell): UnlockOutcome {
        var state = keyguard()
        if (state.unlocked) return UnlockOutcome.AlreadyUnlocked
        // A swipe-only lock screen has no credential page, and this helper does
        // not own the gesture that would open one.
        if (!state.secure) return UnlockOutcome.UnsupportedKeyguard
        if (!state.interactive) {
            shell.wake()
            state = await { it.interactive } ?: return UnlockOutcome.Failed
        }
        if (state.unlocked) return UnlockOutcome.AlreadyUnlocked
        if (state.showing && state.deviceLocked) {
            shell.revealKeyguard()
            if (await { it.unlocked || !it.deviceLocked }?.unlocked == true) return UnlockOutcome.Unlocked
            sleep(revealSettleMs)
        }
        val current = keyguard()
        if (current.unlocked) return UnlockOutcome.Unlocked
        if (!current.showing || !current.deviceLocked) return UnlockOutcome.Failed

        val credential = store.credential() ?: return UnlockOutcome.Disabled
        val revision = credential.revision
        // `clear = 0`: the helper has no keyguard tree to count a half-typed
        // value with, and a blind DEL burst on an empty field closes the
        // password page on some ROMs (Mika's AndroidDeviceAccess only cleared
        // the length its screen reader could see).
        val typed = credential.use { held ->
            store.beginAttempt(held.revision) && shell.enterDeviceCredential(held.kind, held.value, clear = 0)
        }
        if (!typed) {
            // A ROM that submits on the last digit reports the injection as
            // failed after the unlock already happened; the system state, not
            // the return code, is what settles it (Mika's rule).
            val settled = keyguard().unlocked
            if (settled) store.completeAttempt(revision)
            return if (settled) UnlockOutcome.Unlocked else UnlockOutcome.Failed
        }
        val after = await { it.unlocked } ?: return UnlockOutcome.Failed
        if (!after.unlocked) return UnlockOutcome.Failed
        store.completeAttempt(revision)
        return UnlockOutcome.Unlocked
    }

    private suspend fun await(done: (KeyguardSnapshot) -> Boolean): KeyguardSnapshot? {
        var waited = 0L
        var snapshot = keyguard()
        while (!done(snapshot) && waited < waitMs) {
            sleep(pollMs)
            waited += pollMs
            snapshot = keyguard()
        }
        return snapshot
    }

    private companion object {
        private const val TAG = "PhoneUiUnlocker"
    }
}
