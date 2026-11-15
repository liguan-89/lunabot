package com.openmausbot.companion.phoneui

import android.graphics.PixelFormat
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import com.openmausbot.companion.phoneui.shell.PhoneUiShell

/**
 * One helper-owned virtual display, backed by an ImageReader surface, that
 * lives for as long as a bot interaction needs it (created on demand, closed
 * by the executor's [close]). The reader only drains frames and discards
 * them: without a consumer the producer would stall, and nothing in this
 * slice captures or stores screen pixels.
 *
 * Both the reader and the display are released in [close]; the factory
 * closes the reader itself when the display could not be created.
 */
internal class PhoneUiDisplaySession private constructor(
    val shell: PhoneUiShell,
    val displayId: Int,
    private val reader: ImageReader,
) : AutoCloseable {
    override fun close() {
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
                reader.setOnImageAvailableListener({ it.acquireLatestImage()?.close() }, drainHandler)
                return PhoneUiDisplaySession(shell, displayId, reader)
            } finally {
                if (displayId < 0) runCatching { reader?.close() }
            }
        }

        private val drainHandler: Handler by lazy {
            val thread = HandlerThread("phoneui-surface-drain")
            thread.start()
            Handler(thread.looper)
        }

        private const val READER_MAX_IMAGES = 2
    }
}
