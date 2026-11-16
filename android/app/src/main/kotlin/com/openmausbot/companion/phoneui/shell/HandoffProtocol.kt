/*
 * Ported from Mika (https://github.com/wangzan101/Mika), file
 * core/src/main/kotlin/com/wangzan101/mika/core/shell/HelperHandoff.kt
 * (HelperHandoff, HandoffNonces).
 * Copyright 2026 wangzan101. The original is licensed under the Apache License,
 * Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 OpenMausBot contributors. Changes from the
 * original: repackaged under com.openmausbot.companion.phoneui.shell, comments
 * translated into English, and the USB-script / pairing-audit surface is not
 * ported — one launch nonce slot and one resume slot only. Plain Kotlin with
 * no Android imports so the rejection rules are unit-testable on the JVM.
 */
package com.openmausbot.companion.phoneui.shell

import java.security.MessageDigest

/**
 * The contract both sides of the helper handoff share: the provider method
 * name and Bundle keys, the helper's process name and app_process launch
 * command, and the checks the app applies before accepting the helper's
 * binder. The command is strictly the local app_process launch; the one-time
 * nonce travels on the exec stream's stdin, never in argv or the environment.
 */
object HandoffProtocol {
    const val SHELL_UID = 2000
    const val METHOD_ATTACH = "attach"
    const val HELPER_CLASS = "com.openmausbot.companion.phoneui.shell.PhoneUiHelperMain"

    // Helper -> app
    const val KEY_NONCE = "nonce"
    const val KEY_BINDER = "binder"
    const val KEY_UID = "uid"
    const val KEY_PID = "pid"
    const val KEY_APK = "apk"

    // App -> helper
    const val KEY_ACCEPTED = "accepted"
    const val KEY_NEXT = "next"
    const val KEY_TOKEN = "token"
    const val KEY_REASON = "reason"

    fun authority(packageName: String) = "$packageName.phoneui.helper"

    /** The helper's process name (app_process --nice-name); also how stale helper instances are recognized. */
    fun processName(packageName: String) = "$packageName:phoneui-helper"

    /**
     * The command the launch callback runs over its exec stream (adbd runs it
     * with `sh -c`). Closing the stream kills the process group, so the helper
     * detaches with setsid and a trailing `read` holds sh until the app has
     * received the handoff. The nonce is not in the command line (sibling
     * shell processes can read /proc/<pid>/cmdline): the caller writes one
     * [stdinLine] to the stream's stdin, sh reads it and pipes it into the
     * helper. [certPin] is the app's signing-certificate SHA-256 pin; it is
     * public, so it may be an argument.
     */
    fun command(apkPath: String, packageName: String, appUid: Int, certPin: String): String =
        "read n; (echo \"\$n\" | CLASSPATH=${quote(apkPath)} setsid app_process /system/bin " +
            "--nice-name=${quote(processName(packageName))} $HELPER_CLASS ${quote(packageName)} $appUid ${quote(certPin)} " +
            ">/dev/null 2>&1 &); read _"

    fun stdinLine(nonce: String): ByteArray = "$nonce\n".toByteArray(Charsets.UTF_8)

    /** SHA-256 fingerprint of each DER signing certificate, hex, sorted, comma-joined; null without certificates. */
    fun certPin(certs: List<ByteArray>?): String? {
        if (certs.isNullOrEmpty()) return null
        return certs.map { c -> MessageDigest.getInstance("SHA-256").digest(c).joinToString("") { "%02x".format(it) } }
            .sorted().joinToString(",")
    }

    private fun quote(s: String) = "'" + s.replace("'", "'\\''") + "'"

    enum class Reject {
        /** The caller is not shell (uid 2000). */
        NotShell,
        /** The uid/pid the helper reports about itself disagree with what Binder sees. */
        IdMismatch,
        /** The helper is not running the currently installed APK (the app was updated). */
        StaleApk,
        NoBinder,
        BadNonce,
        /** The binder is served by a different process than the one delivering the handoff. */
        BinderElsewhere,
    }

    /** The checks that do not touch the binder; passing returns null. The nonce is validated separately. */
    fun check(
        callingUid: Int,
        callingPid: Int,
        reportedUid: Int,
        reportedPid: Int,
        helperApk: String?,
        appApk: String,
        hasBinder: Boolean,
    ): Reject? = when {
        callingUid != SHELL_UID -> Reject.NotShell
        reportedUid != callingUid || reportedPid != callingPid -> Reject.IdMismatch
        helperApk != appApk -> Reject.StaleApk
        !hasBinder -> Reject.NoBinder
        else -> null
    }
}

/** The nonce slots as persisted: [resume] for a running helper's next handoff, [launch] for a freshly started one. */
data class NonceSlots(
    val resume: String? = null,
    val launch: String? = null,
    val launchAt: Long = 0,
)

interface NonceStore {
    fun load(): NonceSlots
    fun save(slots: NonceSlots)
}

/**
 * One-time handoff nonces the app issues. Any nonce being accepted voids the
 * others and mints a new resume nonce for the accepted helper; persisting them
 * lets a helper re-handoff into a restarted app process.
 */
class NonceGate(
    private val store: NonceStore,
    private val clock: () -> Long,
    private val random: () -> String = ::randomNonce,
) {
    @Synchronized
    fun issueLaunch(): String = random().also { store.save(store.load().copy(launch = it, launchAt = clock())) }

    @Synchronized
    fun matches(nonce: String?): Boolean {
        if (nonce == null) return false
        val s = store.load()
        // A launch nonce only covers the handoff wait; an unused one expires.
        val launch = s.launch?.takeIf { clock() - s.launchAt in 0..LAUNCH_TTL_MS }
        return same(nonce, s.resume) or same(nonce, launch)
    }

    /** Consumes the nonce and returns the rotated replacement, or null when it does not match. */
    @Synchronized
    fun accept(nonce: String?): String? {
        if (!matches(nonce)) return null
        return random().also { store.save(NonceSlots(resume = it)) }
    }

    @Synchronized
    fun clear() {
        store.save(NonceSlots())
    }

    private fun same(a: String, b: String?) =
        b != null && MessageDigest.isEqual(a.toByteArray(Charsets.UTF_8), b.toByteArray(Charsets.UTF_8))

    companion object {
        /** Covers the app holding the exec stream open while the helper starts and delivers. */
        const val LAUNCH_TTL_MS = 30_000L
        private val rng = java.security.SecureRandom()
        fun randomNonce(): String = ByteArray(32).also(rng::nextBytes).joinToString("") { "%02x".format(it) }
    }
}
