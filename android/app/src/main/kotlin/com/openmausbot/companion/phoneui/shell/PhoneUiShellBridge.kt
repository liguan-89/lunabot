/*
 * The app-side wrapper around the shell helper's binder, designed against the
 * PhoneUiShellBridge API agreed for the OpenMausBot/DEX BOT integration.
 *
 * The handoff protocol underneath is ported from Mika
 * (https://github.com/wangzan101/Mika), files
 * app/src/main/java/com/wangzan101/mika/cap/phone/shell/HelperHub.kt and
 * core/src/main/kotlin/com/wangzan101/mika/core/shell/HelperHandoff.kt.
 * Copyright 2026 wangzan101. The originals are licensed under the Apache
 * License, Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 OpenMausBot contributors: repackaged under
 * com.openmausbot.companion.phoneui.shell, comments in English, no USB-script
 * or pairing-audit surface, and the launch command reaches the caller only
 * through the callback set with [setLaunchCallback] — this class never talks
 * to adbd itself.
 */
package com.openmausbot.companion.phoneui.shell

import android.content.Context
import android.content.pm.PackageManager
import android.os.Process
import android.view.Surface
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * The app's view of the phone-UI shell helper. A helper process is started
 * externally (over wireless debugging's exec stream) by the callback registered
 * with [setLaunchCallback]; once that process hands its binder to the handoff
 * provider, [shell] carries a [PhoneUiShell] and stays non-null until the
 * helper's binder dies or [detach] is called.
 *
 * This class holds no pairing, discovery or settings logic: the launch callback
 * owner (the ADB layer) runs the command this bridge builds, and writes the
 * nonce to the stream's stdin as one line ([HandoffProtocol.stdinLine]).
 */
class PhoneUiShellBridge(context: Context, scope: CoroutineScope) {
    private val app = context.applicationContext
    private val hub = PhoneUiHandoff.of(app)

    private val _shell = MutableStateFlow<PhoneUiShell?>(null)

    /** The helper interface in hand; null while no helper is attached. */
    val shell: StateFlow<PhoneUiShell?> = _shell.asStateFlow()

    /** The latest handoff rejection, as a diagnostic label without nonce, binder, path or numeric uid. */
    val lastHandoffRejection: StateFlow<String?> get() = hub.lastHandoffRejection

    @Volatile
    private var launchCallback: ((command: String, nonce: String) -> Unit)? = null

    init {
        // The bridge is the owner of the process-wide singleton: the provider
        // must resolve the same hub, and of(context) must hand back this
        // instance once one exists.
        synchronized(PhoneUiHandoff) { if (PhoneUiHandoff.ownerBridge == null) PhoneUiHandoff.ownerBridge = this }
        scope.launch { hub.shell.collect { _shell.value = it?.let(::PhoneUiShell) } }
    }

    /**
     * Register the executor that starts the helper process. It receives the
     * ready-made app_process command and the one-time nonce; the nonce must
     * reach the helper over the exec stream's stdin, never argv. Registering
     * does not launch anything.
     */
    fun setLaunchCallback(exec: ((command: String, nonce: String) -> Unit)?) {
        launchCallback = exec
    }

    /**
     * Start the helper through the registered callback: issue a fresh one-time
     * nonce and hand the command plus that nonce to it. Returns false — and
     * launches nothing — when no callback is registered, the helper is already
     * attached, or the app's signing certificate cannot be pinned.
     */
    fun ensureHelper(): Boolean {
        if (hub.shell.value != null) return false
        val exec = launchCallback ?: return false
        val pin = HandoffProtocol.certPin(signingCertificates()) ?: return false
        val nonce = hub.issueLaunchNonce()
        val command = HandoffProtocol.command(app.applicationInfo.sourceDir, app.packageName, Process.myUid(), pin)
        exec(command, nonce)
        return true
    }

    /**
     * Detach: drop the helper interface and void every nonce. The running
     * helper notices on its next handoff attempt and exits after releasing its
     * displays; a fresh helper requires a new launch nonce.
     */
    fun detach() {
        val attached = hub.shell.value
        hub.detach()
        runCatching { attached?.destroy() }
    }

    private fun signingCertificates(): List<ByteArray>? = runCatching {
        app.packageManager.getPackageInfo(app.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
            .signingInfo?.apkContentsSigners?.map { it.toByteArray() }
    }.getOrNull()

    companion object {
        @Volatile
        private var defaultBridge: PhoneUiShellBridge? = null

        /**
         * The bridge instance every consumer in this process shares. When the
         * app object provides one of its own it wins; otherwise a default
         * bridge with its own scope is created once.
         */
        fun of(context: Context): PhoneUiShellBridge =
            PhoneUiHandoff.ownerBridge ?: defaultBridge ?: synchronized(this) {
                PhoneUiHandoff.ownerBridge ?: defaultBridge ?: PhoneUiShellBridge(
                    context.applicationContext,
                    CoroutineScope(SupervisorJob() + Dispatchers.IO),
                ).also { defaultBridge = it }
            }
    }
}

/** Typed facade over the helper's AIDL surface; every call can fail with a binder exception. */
class PhoneUiShell(private val aidl: IPhoneUiShell) {
    /** -1 means the display could not be created (no trusted flags were usable either). */
    fun createDisplay(surface: Surface, width: Int, height: Int, dpi: Int): Int = aidl.createDisplay(surface, width, height, dpi)

    fun releaseDisplay(displayId: Int) = aidl.releaseDisplay(displayId)

    /** 0=launched 1=in use on the main display 2=no launcher entry 3=error */
    fun launchApp(displayId: Int, packageName: String): Int = aidl.launchApp(displayId, packageName)

    fun injectTap(displayId: Int, x: Int, y: Int): Boolean = aidl.injectTap(displayId, x, y)

    fun injectStroke(displayId: Int, xs: IntArray, ys: IntArray, times: LongArray): Boolean =
        aidl.injectStroke(displayId, xs, ys, times)

    fun injectKey(displayId: Int, keyCode: Int): Boolean = aidl.injectKey(displayId, keyCode)

    /** Printable ASCII into the focused field; the helper refuses anything else. */
    fun typeText(displayId: Int, text: String): Boolean = aidl.typeText(displayId, text)

    fun topPackage(displayId: Int): String? = aidl.topPackage(displayId)

    /** Task id of the top task on [displayId]; -1 when it has no task. */
    fun topTaskId(displayId: Int): Int = aidl.topTaskId(displayId)

    fun packageOfTask(taskId: Int): String? = aidl.packageOfTask(taskId)

    /** Move a root task to one of our displays or the main display. */
    fun moveTask(taskId: Int, displayId: Int): Boolean = aidl.moveTask(taskId, displayId)

    fun readClipboard(): String? = aidl.readClipboard()

    fun writeClipboard(text: String): Boolean = aidl.writeClipboard(text)

    /** 0=opened 2=no handler 3=error; the helper validates the URI, mime and package shape. */
    fun shareIntent(displayId: Int, contentUri: String, mime: String, packageName: String): Int =
        aidl.shareIntent(displayId, contentUri, mime, packageName)
}
