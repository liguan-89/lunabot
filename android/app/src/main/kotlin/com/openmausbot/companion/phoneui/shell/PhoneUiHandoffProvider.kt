/*
 * Ported from Mika (https://github.com/wangzan101/Mika), files
 * app/src/main/java/com/wangzan101/mika/cap/phone/shell/HelperHub.kt
 * (HelperHub, HandoffProvider) and
 * app/src/main/java/com/wangzan101/mika/cap/phone/shell/HelperProcess.kt.
 * Copyright 2026 wangzan101. The originals are licensed under the Apache
 * License, Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 OpenMausBot contributors. Changes from the
 * original: repackaged under com.openmausbot.companion.phoneui.shell, comments
 * translated into English, and trimmed to the display helper: no device-file
 * policy, restore reports, clipboard or USB-script plumbing. The hub is a
 * process singleton (see [PhoneUiHandoff.of]); the provider and
 * [PhoneUiShellBridge] share that one instance.
 */
package com.openmausbot.companion.phoneui.shell

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Where the shell helper's binder lands. The helper calls the handoff provider
 * with its binder; this hub validates the caller and, on accept, publishes the
 * interface on [shell]. The provider and [PhoneUiShellBridge] resolve the same
 * per-process instance through [PhoneUiHandoff.of].
 */
class PhoneUiHandoffHub internal constructor(context: Context) {
    private val app = context.applicationContext

    /**
     * Whether remote unlocking is allowed right now. Set by the app from the
     * person's switch (see [PhoneUiShellBridge.setUnlockAllowed]) and read on
     * every handoff, so a helper that re-attaches after an app restart learns
     * the current answer rather than a stale one. Off until set.
     */
    @Volatile
    private var unlockAllowed: () -> Boolean = { false }

    fun setUnlockAllowed(source: () -> Boolean) {
        unlockAllowed = source
    }

    private val _shell = MutableStateFlow<IPhoneUiShell?>(null)

    /** The helper interface in hand; null again as soon as the helper's binder dies. */
    val shell: StateFlow<IPhoneUiShell?> = _shell.asStateFlow()

    private val _lastHandoffRejection = MutableStateFlow<String?>(null)

    /** The latest handoff rejection of this startup attempt, without nonce, binder, path or numeric uid details. */
    val lastHandoffRejection: StateFlow<String?> = _lastHandoffRejection.asStateFlow()

    private val nonces: NonceGate by lazy { NonceGate(PrefsNonceStore(app), SystemClock::elapsedRealtime) }

    /** Called before the launch callback runs the app_process command: the one-time nonce goes over the stream's stdin. */
    fun issueLaunchNonce(): String {
        _lastHandoffRejection.value = null
        return nonces.issueLaunch()
    }

    /** Drop the helper interface and void every nonce; the still-running helper will be refused and exit. */
    fun detach() {
        nonces.clear()
        _lastHandoffRejection.value = null
        _shell.value = null
    }

    /**
     * The helper delivers its binder here. Accepted only from shell (uid 2000)
     * with self-reported uid/pid matching the caller, running the currently
     * installed APK, carrying a valid one-time nonce, and serving its binder
     * from the very process that delivered it. Binder death then clears
     * [shell]; the helper releases its own displays on the same signal.
     */
    @Synchronized
    fun offer(extras: Bundle?, callingUid: Int, callingPid: Int): Bundle {
        val binder = extras?.getBinder(HandoffProtocol.KEY_BINDER)
        HandoffProtocol.check(
            callingUid, callingPid,
            reportedUid = extras?.getInt(HandoffProtocol.KEY_UID, -1) ?: -1,
            reportedPid = extras?.getInt(HandoffProtocol.KEY_PID, -1) ?: -1,
            helperApk = extras?.getString(HandoffProtocol.KEY_APK),
            appApk = app.applicationInfo.sourceDir,
            hasBinder = binder != null,
        )?.let { return reject(it) }
        val nonce = extras?.getString(HandoffProtocol.KEY_NONCE)
        // An invalid nonce must not cause the caller's binder to be touched at all.
        if (!nonces.matches(nonce)) return reject(HandoffProtocol.Reject.BadNonce)
        val shell = IPhoneUiShell.Stub.asInterface(binder!!)
        val ids = runCatching { shell.identity() }.getOrNull()
        if (ids == null || ids.size < 2 || ids[0] != callingUid || ids[1] != callingPid) {
            return reject(HandoffProtocol.Reject.BinderElsewhere)
        }
        val next = nonces.accept(nonce) ?: return reject(HandoffProtocol.Reject.BadNonce)
        try {
            binder.linkToDeath({ _shell.compareAndSet(shell, null) }, 0)
        } catch (t: Throwable) {
            return reject(HandoffProtocol.Reject.NoBinder)
        }
        // A replacement helper has killed the older instance; its death notice is ignored because it is not current.
        _shell.value = shell
        _lastHandoffRejection.value = null
        Log.i(TAG, "helper pid $callingPid handed off")
        return Bundle().apply {
            putBoolean(HandoffProtocol.KEY_ACCEPTED, true)
            putString(HandoffProtocol.KEY_NEXT, next)
            putBinder(HandoffProtocol.KEY_TOKEN, Binder())
            // The switch, not the credential: the helper needs to know whether
            // the person allows a remote unlock, nothing more.
            putBoolean(HandoffProtocol.KEY_UNLOCK, runCatching { unlockAllowed() }.getOrDefault(false))
        }
    }

    private fun reject(why: HandoffProtocol.Reject): Bundle {
        // Diagnostics carry only the rejection class: no nonce, binder, path or numeric uid.
        Log.w(TAG, "helper handoff rejected: ${why.name}")
        _lastHandoffRejection.value = why.name
        return Bundle().apply {
            putBoolean(HandoffProtocol.KEY_ACCEPTED, false)
            putString(HandoffProtocol.KEY_REASON, why.name)
        }
    }

    companion object {
        private const val TAG = "PhoneUiHandoff"
        private const val PREFS = "phoneui_helper"
    }

    /** Synchronous writes: the app process can die right after the helper receives its rotated nonce. */
    private class PrefsNonceStore(context: Context) : NonceStore {
        private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        override fun load() = NonceSlots(
            resume = prefs.getString("resume", null),
            launch = prefs.getString("launch", null),
            launchAt = prefs.getLong("launchAt", 0),
        )
        override fun save(slots: NonceSlots) {
            prefs.edit()
                .putString("resume", slots.resume)
                .putString("launch", slots.launch)
                .putLong("launchAt", slots.launchAt)
                .commit()
        }
    }
}

/**
 * The per-process holder the provider and the bridge both resolve. The app
 * object exists before the provider, but the handoff call may arrive before or
 * alongside Application.onCreate: the holder's synchronized lazy creation and
 * the hub's synchronized [PhoneUiHandoffHub.offer] make the order irrelevant.
 */
object PhoneUiHandoff {
    @Volatile
    private var hub: PhoneUiHandoffHub? = null

    fun of(context: Context): PhoneUiHandoffHub =
        hub ?: synchronized(this) {
            hub ?: PhoneUiHandoffHub(context.applicationContext).also { hub = it }
        }

    /**
     * The first [PhoneUiShellBridge] created in this process, so of(context)
     * on the bridge side hands every consumer the same instance the provider
     * resolves its hub through.
     */
    @Volatile
    var ownerBridge: PhoneUiShellBridge? = null
}

/**
 * The handoff endpoint. Exported because shell must reach it; the manifest
 * gates it behind INTERACT_ACROSS_USERS_FULL, which shell holds and ordinary
 * apps do not — and [PhoneUiHandoffHub.offer] re-checks everything behind it.
 */
class PhoneUiHandoffProvider : ContentProvider() {
    override fun onCreate() = true

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
        if (method != HandoffProtocol.METHOD_ATTACH) return null
        val ctx = context ?: return null
        return PhoneUiHandoff.of(ctx).offer(extras, Binder.getCallingUid(), Binder.getCallingPid())
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
}
