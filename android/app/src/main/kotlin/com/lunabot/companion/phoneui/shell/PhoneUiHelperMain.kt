/*
 * Ported from Mika (https://github.com/wangzan101/Mika), files
 * app/src/main/java/com/wangzan101/mika/cap/phone/shell/HelperProcess.kt and
 * app/src/main/java/com/wangzan101/mika/cap/phone/shell/ShellService.kt
 * (main entry).
 * Copyright 2026 wangzan101. The originals are licensed under the Apache
 * License, Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 OpenMausBot contributors. Changes from the
 * original: repackaged under com.openmausbot.companion.phoneui.shell, comments
 * translated into English, and the restore-wish / accessibility-repair /
 * uid-importance-watch machinery is not ported: after the app dies the helper
 * releases its displays and retries the handoff a few times with its resume
 * nonce, then exits. Nothing here writes secure settings, uses
 * AccessibilityService, root/su, or pairs on its own — a fresh helper is only
 * ever started by the app handing a one-time nonce over the exec stream's
 * stdin.
 */
package com.openmausbot.companion.phoneui.shell

import android.annotation.SuppressLint
import android.content.AttributionSource
import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.ProviderInfo
import android.os.Binder
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.Process
import android.util.Log
import java.io.File
import kotlin.system.exitProcess

/**
 * The helper process entry point, started by the app as shell (uid 2000) via
 * wireless debugging's adbd exec service:
 * `CLASSPATH=<base.apk> app_process /system/bin --nice-name=<package>:phoneui-helper
 * com.openmausbot.companion.phoneui.shell.PhoneUiHelperMain <package> <app uid> <cert sha256>`,
 * with the one-time nonce read from stdin (see [HandoffProtocol.command]).
 *
 * All privileged logic lives in [PhoneUiShellService]; this class only hands
 * its binder to the app through the app's handoff provider, and releases the
 * displays when the app goes away.
 */
object PhoneUiHelperMain {
    private const val TAG = "PhoneUiHelper"

    @JvmStatic
    fun main(args: Array<String>) {
        if (args.size < 3) {
            Log.e(TAG, "usage: PhoneUiHelperMain <package> <uid> <cert-sha256> (nonce on stdin)")
            exitProcess(2)
        }
        val packageName = args[0]
        val appUid = args[1].toIntOrNull() ?: exitProcess(2)
        val certPin = args[2]
        // Read once and close: stdin exists only to carry the nonce.
        val launchNonce = runCatching { System.`in`.bufferedReader().readLine()?.trim() }.getOrNull()
        runCatching { System.`in`.close() }
        if (launchNonce.isNullOrEmpty()) {
            Log.e(TAG, "no nonce on stdin")
            exitProcess(2)
        }
        // ShellContext builds an ActivityThread, which wants a main looper.
        Looper.prepareMainLooper()
        val service = PhoneUiShellService(allowedUid = appUid)
        Handoff(service, packageName, appUid, certPin).start(launchNonce)
        Looper.loop()
    }

    private class Handoff(
        private val service: PhoneUiShellService,
        private val packageName: String,
        private val appUid: Int,
        private val certPin: String,
    ) {
        private val context: Context = ShellContext.create()
        private val authority = HandoffProtocol.authority(packageName)
        private val userId = appUid / PER_USER_RANGE

        /** Handoff, app-death handling and redelivery are serialized on this thread. */
        private val worker = Handler(HandlerThread("phoneui-handoff").apply { start() }.looper)

        /** The nonce for the next handoff (rotated by the app on every accept). */
        private var nonce: String? = null

        /** The app process's token; null means the app is not currently connected. */
        private var appToken: IBinder? = null

        /** Incremented per app death: a wait superseded by a newer death is void. */
        private var deaths = 0

        fun start(launchNonce: String) = worker.post {
            when (deliver(launchNonce)) {
                Outcome.Accepted -> killOtherInstances()
                Outcome.Rejected -> exitProcess(0)
                Outcome.Failed -> exitProcess(1)
            }
        }

        private enum class Outcome { Accepted, Rejected, Failed }

        /**
         * Fetch the app's provider through ActivityManager (the same path the
         * `content call` command uses) and hand over the binder plus the
         * self-reported uid/pid and APK path. The app only accepts shell
         * callers with a valid one-time nonce, and re-checks the binder's
         * process by calling [PhoneUiShellService.identity].
         */
        @SuppressLint("PrivateApi", "DiscouragedPrivateApi")
        private fun deliver(n: String?): Outcome {
            if (n == null) return Outcome.Rejected
            // A reinstall under the same package with a different key must not receive the binder.
            if (!signedAsPinned()) {
                Log.e(TAG, "$packageName is missing or not signed with the pinned certificate; exiting")
                runCatching { service.releaseAll() }
                exitProcess(0)
            }
            val am = Class.forName("android.app.ActivityManager").getMethod("getService").invoke(null)!!
            val token = Binder()
            val holder = try {
                am.javaClass.getMethod(
                    "getContentProviderExternal", String::class.java, Int::class.javaPrimitiveType,
                    IBinder::class.java, String::class.java,
                ).invoke(am, authority, userId, token, TAG)
            } catch (t: Throwable) {
                Log.w(TAG, "getContentProviderExternal failed", t)
                return Outcome.Failed
            } ?: return Outcome.Failed
            try {
                // One authority belongs to one package; verify anyway before handing the binder over.
                val info = holder.javaClass.getField("info").get(holder) as? ProviderInfo
                if (info == null || info.packageName != packageName || info.applicationInfo?.uid != appUid) {
                    Log.e(TAG, "provider $authority does not belong to $packageName/$appUid")
                    return Outcome.Rejected
                }
                val provider = holder.javaClass.getField("provider").get(holder)!!
                val extras = Bundle().apply {
                    putString(HandoffProtocol.KEY_NONCE, n)
                    putBinder(HandoffProtocol.KEY_BINDER, service)
                    putInt(HandoffProtocol.KEY_UID, Process.myUid())
                    putInt(HandoffProtocol.KEY_PID, Process.myPid())
                    putString(HandoffProtocol.KEY_APK, System.getProperty("java.class.path"))
                }
                val result = callProvider(provider, authority, extras) ?: return Outcome.Failed
                if (result.getBoolean(HandoffProtocol.KEY_ACCEPTED) != true) {
                    Log.w(TAG, "handoff rejected: ${result.getString(HandoffProtocol.KEY_REASON)}")
                    return Outcome.Rejected
                }
                val appBinder = result.getBinder(HandoffProtocol.KEY_TOKEN) ?: return Outcome.Rejected
                // Set before the app is told the handoff succeeded, so no call
                // can arrive while the switch still holds an older answer.
                service.setUnlockEnabled(result.getBoolean(HandoffProtocol.KEY_UNLOCK, false))
                nonce = result.getString(HandoffProtocol.KEY_NEXT)
                appToken = appBinder
                try {
                    appBinder.linkToDeath({ worker.post { onAppDied(appBinder) } }, 0)
                } catch (t: Throwable) {
                    worker.post { onAppDied(appBinder) }
                }
                Log.i(TAG, "handed off to $packageName")
                return Outcome.Accepted
            } catch (t: Throwable) {
                Log.w(TAG, "handoff failed", t)
                return Outcome.Failed
            } finally {
                runCatching {
                    am.javaClass.getMethod(
                        "removeContentProviderExternalAsUser", String::class.java, IBinder::class.java, Int::class.javaPrimitiveType,
                    ).invoke(am, authority, token, userId)
                }
            }
        }

        /**
         * IContentProvider.call changed shape across releases; pick whichever
         * exists and invoke it with the matching argument list.
         */
        @Suppress("ReturnCount")
        private fun callProvider(provider: Any, authority: String, extras: Bundle): Bundle? {
            val methods = provider.javaClass.methods.filter { it.name == "call" }
            // API 31+: call(AttributionSource, String authority, String method, String arg, Bundle)
            methods.firstOrNull { it.parameterTypes.size == 5 && it.parameterTypes[0] == AttributionSource::class.java }?.let { m ->
                val caller = AttributionSource.Builder(Process.myUid())
                    .setPackageName(ShellContext.SHELL_PACKAGE).build()
                return m.invoke(provider, caller, authority, HandoffProtocol.METHOD_ATTACH, null, extras) as? Bundle
            }
            // API 29-30: call(String authority, String method, String arg, Bundle)
            methods.firstOrNull { it.parameterTypes.size == 4 && it.parameterTypes[0] == String::class.java }?.let { m ->
                return m.invoke(provider, authority, HandoffProtocol.METHOD_ATTACH, null, extras) as? Bundle
            }
            // Older: call(String method, String arg, Bundle)
            methods.firstOrNull { it.parameterTypes.size == 3 }?.let { m ->
                return m.invoke(provider, HandoffProtocol.METHOD_ATTACH, null, extras) as? Bundle
            }
            return null
        }

        /**
         * The app process died: its displays and everything the helper holds
         * for it go away. The helper stays briefly for the app to come back
         * and re-handoff with the resume nonce; an app that does not return
         * leaves the helper to exit, and a new one is started on demand.
         */
        private fun onAppDied(token: IBinder) {
            if (appToken !== token) return
            appToken = null
            runCatching { service.releaseAll() }.onFailure { Log.w(TAG, "cleanup failed", it) }
            if (!installed()) {
                Log.i(TAG, "$packageName is gone; exiting")
                exitProcess(0)
            }
            Log.i(TAG, "$packageName died; waiting for it to come back")
            val death = ++deaths
            worker.postDelayed({ if (death == deaths) redeliver(0) }, GRACE_MS)
        }

        @SuppressLint("DiscouragedPrivateApi")
        private fun installed(): Boolean = runCatching {
            val pm = context.packageManager
            val result = pm.javaClass.getMethod(
                "getPackageUidAsUser", String::class.java, Int::class.javaPrimitiveType, Int::class.javaPrimitiveType,
            ).invoke(pm, packageName, 0, userId)
            result as Int >= 0
        }.getOrElse { t ->
            // Only an uninstalled package makes it exit; unreadable state counts as still there.
            val cause = (t as? java.lang.reflect.InvocationTargetException)?.targetException ?: t
            cause !is PackageManager.NameNotFoundException
        }

        /** Retry the handoff with the resume nonce; the provider being momentarily unavailable buys a few retries. */
        private fun redeliver(attempt: Int) {
            if (appToken != null) return
            when (deliver(nonce)) {
                Outcome.Accepted -> Unit
                // The app no longer accepts this helper (reinstalled, nonce voided): exit.
                Outcome.Rejected -> exitProcess(0)
                Outcome.Failed -> if (attempt + 1 < RETRY_DELAYS_MS.size) {
                    worker.postDelayed({ redeliver(attempt + 1) }, RETRY_DELAYS_MS[attempt + 1])
                }
            }
        }

        /** The installed [packageName] is still this uid and still signed with the pinned certificate. Unreadable counts as not matching. */
        @SuppressLint("DiscouragedPrivateApi")
        private fun signedAsPinned(): Boolean = runCatching {
            val pm = context.packageManager
            val flags = PackageManager.GET_SIGNING_CERTIFICATES
            val info = if (userId == 0) pm.getPackageInfo(packageName, flags)
            else pm.javaClass.getMethod(
                "getPackageInfoAsUser", String::class.java, Int::class.javaPrimitiveType, Int::class.javaPrimitiveType,
            ).invoke(pm, packageName, flags, userId) as PackageInfo
            val signers = info.signingInfo?.apkContentsSigners?.map { it.toByteArray() }
            info.applicationInfo?.uid == appUid && HandoffProtocol.certPin(signers) == certPin
        }.getOrElse { t ->
            Log.w(TAG, "cannot read signing info of $packageName", t)
            false
        }

        /** Only instances with exactly this process name: never kill another app_process. */
        private fun killOtherInstances() {
            val me = Process.myPid()
            val name = HandoffProtocol.processName(packageName)
            File("/proc").listFiles()?.forEach { dir ->
                val pid = dir.name.toIntOrNull() ?: return@forEach
                if (pid == me) return@forEach
                val cmdline = runCatching { File(dir, "cmdline").readBytes() }.getOrNull() ?: return@forEach
                val argv0 = String(cmdline.takeWhile { it != 0.toByte() }.toByteArray())
                if (argv0 == name) {
                    Log.i(TAG, "stopping older helper $pid")
                    Process.killProcess(pid)
                }
            }
        }

        companion object {
            private const val PER_USER_RANGE = 100_000

            /** One redelivery window after an app death, then the helper exits. */
            private const val GRACE_MS = 10_000L
            private val RETRY_DELAYS_MS = longArrayOf(0, 1_000, 3_000, 10_000)
        }
    }
}
