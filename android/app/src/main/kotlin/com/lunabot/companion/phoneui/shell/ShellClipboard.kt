/*
 * Adapted from Mika (https://github.com/wangzan101/Mika), file
 * app/src/main/java/com/wangzan101/mika/cap/phone/shell/ShellClipboard.kt.
 * Copyright 2026 wangzan101. The original is licensed under the Apache License,
 * Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 OpenMausBot contributors: repackaged under
 * com.lunabot.companion.phoneui.shell, comments translated into English,
 * and trimmed to plain-text read and write; the framework ClipboardManager is
 * still the write path, only the read path bypasses the extra Settings query
 * a process without an app registration cannot answer.
 */
package com.lunabot.companion.phoneui.shell

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Process
import java.lang.reflect.Method

/**
 * The system clipboard as shell. Reading through the framework would first
 * read Settings, which this process cannot resolve; the binder call keeps the
 * same permission checks and skips that query. Writing uses the framework's
 * own path so the clip is prepared and announced as usual.
 */
@SuppressLint("PrivateApi")
internal class ShellClipboard(private val context: Context) {
    private val manager: ClipboardManager by lazy {
        ClipboardManager::class.java.getDeclaredConstructor(Context::class.java, Handler::class.java)
            .apply { isAccessible = true }
            .newInstance(context, Handler(Looper.getMainLooper() ?: Looper.myLooper()!!))
    }

    private val service: Any? by lazy {
        runCatching {
            val binder = Class.forName("android.os.ServiceManager")
                .getMethod("getService", String::class.java)
                .invoke(null, "clipboard") as IBinder
            Class.forName("android.content.IClipboard\$Stub")
                .getMethod("asInterface", IBinder::class.java)
                .invoke(null, binder)
        }.getOrNull()
    }

    private val getClip: Method? by lazy { method("getPrimaryClip") }

    /** The plain text of the primary clip, or null when there is none or it is not text. */
    fun primaryText(): String? {
        val clip = runCatching { readClip() }.getOrNull() ?: return null
        if (clip.description?.hasMimeType("text/plain") != true) return null
        return clip.getItemAt(0)?.text?.toString()
    }

    fun setText(text: String): Boolean = runCatching {
        manager.setPrimaryClip(ClipData.newPlainText(CLIP_LABEL, text))
        true
    }.getOrDefault(false)

    private fun readClip(): ClipData? {
        val method = getClip ?: return manager.primaryClip
        return call(method) as? ClipData
    }

    /** The read overloads differ by API level; every signature that ships is tried before the framework path. */
    private fun method(name: String): Method? {
        if (service == null) return null
        val type = runCatching { Class.forName("android.content.IClipboard") }.getOrNull() ?: return null
        val s = String::class.java
        val i = Int::class.javaPrimitiveType!!
        val candidates = listOf(
            arrayOf(s, s, i, i),
            arrayOf(s, s, i),
            arrayOf(s, s, s, s, i, i, Boolean::class.javaPrimitiveType!!),
        )
        return candidates.firstNotNullOfOrNull { args -> runCatching { type.getMethod(name, *args) }.getOrNull() }
    }

    private fun call(method: Method): Any? {
        val userId = Process.myUid() / 100_000
        val label = runCatching {
            val pm = context.packageManager
            pm.getApplicationLabel(pm.getApplicationInfo(ShellContext.SHELL_PACKAGE, 0)).toString()
        }.getOrDefault(ShellContext.SHELL_PACKAGE)
        val args: Array<Any?> = when (method.parameterTypes.size) {
            7 -> arrayOf(ShellContext.SHELL_PACKAGE, label, "", null, userId, 0, false)
            4 -> arrayOf(ShellContext.SHELL_PACKAGE, null, userId, 0)
            else -> arrayOf(ShellContext.SHELL_PACKAGE, null, userId)
        }
        return method.invoke(service, *args)
    }

    private companion object {
        const val CLIP_LABEL = "Luna Bot"
    }
}