package com.openmausbot.companion.phoneui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.WindowManager
import android.widget.ImageView
import com.openmausbot.companion.phoneui.shell.PhoneUiShellBridge
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The floating, read-only view of the controlled display: while a task holds
 * a session, the person's overlay switch is on, and the system overlay grant
 * stands, a small ImageView in the bottom corner replays the display's newest
 * frames. The window takes no touches and no focus, so the person keeps using
 * the phone normally underneath it.
 *
 * Visibility is derived, never commanded: [PhoneUiMirror.display] going null
 * (session released or idled out), the helper detaching, the switch turning
 * off, or the grant being revoked all remove the window on the next emission.
 * The grant is also re-checked inside the frame loop because revoking it does
 * not emit anything. No Service is needed — the process that executes phone
 * jobs is alive for as long as a session exists.
 */
internal class PhoneUiScreenOverlay(
    context: Context,
    private val scope: CoroutineScope,
    private val enabled: StateFlow<Boolean>,
) {
    private val app = context.applicationContext
    private val bridge = PhoneUiShellBridge.of(app)
    private val windowManager = app.getSystemService(WindowManager::class.java)
    private val mainHandler = Handler(Looper.getMainLooper())

    @Volatile
    private var view: ImageView? = null
    private var pump: Job? = null

    init {
        scope.launch {
            combine(PhoneUiMirror.display, bridge.shell, enabled) { display, shell, on ->
                if (display != null && shell != null && on && Settings.canDrawOverlays(app)) display else null
            }.distinctUntilChanged().collect { display ->
                // A null display only detaches; a different one is detached
                // first too, so the frame loop never keeps a released session.
                hide()
                if (display != null) show(display)
            }
        }
    }

    private fun show(display: PhoneUiDisplaySession) = mainHandler.post {
        if (view != null) return@post
        val metrics = app.resources.displayMetrics
        val width = metrics.widthPixels / OVERLAY_WIDTH_DIVISOR
        val image = ImageView(app).apply { scaleType = ImageView.ScaleType.FIT_CENTER }
        val params = WindowManager.LayoutParams(
            width,
            width * display.height / display.width,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.BOTTOM or Gravity.END
        }
        runCatching { windowManager.addView(image, params) }.onSuccess {
            view = image
            pump = scope.launch { pumpFrames(image, display) }
        }
    }

    private fun hide() = mainHandler.post {
        pump?.cancel()
        pump = null
        view?.let { runCatching { windowManager.removeView(it) } }
        view = null
    }

    private suspend fun pumpFrames(target: ImageView, display: PhoneUiDisplaySession) {
        var shown: Bitmap? = null
        try {
            withContext(Dispatchers.IO) {
                while (isActive && view === target) {
                    if (!Settings.canDrawOverlays(app)) {
                        hide()
                        return@withContext
                    }
                    val frame = display.capture(FRAME_WAIT_MS)
                    if (frame != null) {
                        withContext(Dispatchers.Main) { target.setImageBitmap(frame) }
                        shown?.recycle()
                        shown = frame
                    }
                    delay(FRAME_INTERVAL_MS)
                }
            }
        } finally {
            shown?.recycle()
        }
    }

    private companion object {
        const val OVERLAY_WIDTH_DIVISOR = 3
        const val FRAME_INTERVAL_MS = 330L
        const val FRAME_WAIT_MS = 500L
    }
}
