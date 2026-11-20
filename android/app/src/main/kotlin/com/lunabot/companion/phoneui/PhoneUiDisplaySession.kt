package com.lunabot.companion.phoneui

import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.media.Image
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import com.lunabot.companion.phoneui.shell.PhoneUiShell
import kotlinx.coroutines.delay

/**
 * One helper-owned virtual display, backed by an ImageReader surface, that
 * lives for as long as a bot interaction needs it (created on demand, closed
 * by the executor's [close]). The reader keeps the newest frame in memory so a
 * screenshot of a still screen still has something to return; [capture] hands
 * out a copy and nothing else stores pixels.
 *
 * Both the reader and the display are released in [close]; the factory
 * closes the reader itself when the display could not be created.
 */
internal class PhoneUiDisplaySession private constructor(
    val shell: PhoneUiShell,
    val displayId: Int,
    val width: Int,
    val height: Int,
    private val reader: ImageReader,
) : AutoCloseable {
    private val frameLock = Any()

    /** The newest composed frame, replaced as frames arrive; null until the display draws once. */
    private var latest: Bitmap? = null

    init {
        reader.setOnImageAvailableListener({ source ->
            synchronized(frameLock) {
                val image = runCatching { source.acquireLatestImage() }.getOrNull()
                    ?: return@synchronized
                val bitmap = try {
                    runCatching { image.toBitmap() }.getOrNull()
                } finally {
                    image.close()
                }
                if (bitmap != null) {
                    latest?.recycle()
                    latest = bitmap
                }
            }
        }, drainHandler)
    }

    /**
     * A copy of the newest frame, waiting up to [timeoutMs] for the first one
     * after a display is created. Null when the display never drew.
     */
    suspend fun capture(timeoutMs: Long = FRAME_WAIT_MS): Bitmap? {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            val copy = synchronized(frameLock) {
                latest?.let { frame ->
                    runCatching { frame.copy(frame.config ?: Bitmap.Config.ARGB_8888, false) }.getOrNull()
                }
            }
            if (copy != null) return copy
            if (System.currentTimeMillis() >= deadline) return null
            delay(FRAME_POLL_MS)
        }
    }

    override fun close() {
        synchronized(frameLock) { latest?.recycle(); latest = null }
        runCatching { reader.close() }
        runCatching { shell.releaseDisplay(displayId) }
    }

    companion object {
        /** Opens a display, or null when the helper could not create one. */
        fun open(shell: PhoneUiShell, width: Int, height: Int, dpi: Int): PhoneUiDisplaySession? {
            var reader: ImageReader? = null
            var displayId = -1
            try {
                reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, READER_MAX_IMAGES)
                displayId = shell.createDisplay(reader.surface, width, height, dpi)
                if (displayId < 0) return null
                return PhoneUiDisplaySession(shell, displayId, width, height, reader)
            } finally {
                if (displayId < 0) runCatching { reader?.close() }
            }
        }

        private val drainHandler: Handler by lazy {
            val thread = HandlerThread("phoneui-surface")
            thread.start()
            Handler(thread.looper)
        }

        private const val READER_MAX_IMAGES = 2
        private const val FRAME_WAIT_MS = 2_000L
        private const val FRAME_POLL_MS = 50L
    }
}

/** Copies RGBA_8888 image planes into a bitmap, stripping the row padding the surface may carry. */
private fun Image.toBitmap(): Bitmap {
    val plane = planes[0]
    val pixelStride = plane.pixelStride
    val rowStride = plane.rowStride
    val rowPadding = rowStride - pixelStride * width
    val padded = Bitmap.createBitmap(width + rowPadding / pixelStride, height, Bitmap.Config.ARGB_8888)
    padded.copyPixelsFromBuffer(plane.buffer)
    val cropped = Bitmap.createBitmap(padded, 0, 0, width, height)
    if (cropped !== padded) padded.recycle()
    return cropped
}
