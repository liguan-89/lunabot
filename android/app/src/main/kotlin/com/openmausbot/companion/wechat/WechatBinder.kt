// Adapted from Mika's WechatApi and WechatRuntime (Apache-2.0).
package com.openmausbot.companion.wechat

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers

/** What the bind sheet is showing. The QR payload is held in memory only. */
internal sealed interface WechatBindState {
    data object Idle : WechatBindState
    data object Preparing : WechatBindState

    /** Waiting for a scan. [content] is what to draw; [savedPath] says where a save landed. */
    data class Waiting(val content: String, val savedPath: String? = null) : WechatBindState
    data class Bound(val ownerId: String) : WechatBindState
    data class Failed(val message: String) : WechatBindState
}

/**
 * The scan-to-bind flow, apart from the composable that draws it.
 *
 * iLink's `qrcode_img_content` is a payload to encode, not an image: WeChat's
 * scanner reads the same text from a saved picture, which is why "save to the
 * album" is a first-class action here rather than a convenience. The QR is
 * rendered locally and never leaves the phone.
 *
 * The polling key is never logged and never persisted; only the confirmed
 * token is, and that goes straight into [WechatStore]'s encrypted slot.
 */
internal class WechatBinder(
    private val runtime: WechatRuntime,
    private val scope: CoroutineScope,
    /** Called after a scan confirms, so the caller can start the service. */
    private val onBound: () -> Unit = {},
) {
    private val _state = MutableStateFlow<WechatBindState>(WechatBindState.Idle)
    val state: StateFlow<WechatBindState> = _state.asStateFlow()

    private var job: Job? = null

    /** Fetch a QR and start polling. A second call while running is a no-op. */
    fun start() {
        if (job?.isActive == true) return
        _state.value = WechatBindState.Preparing
        job = scope.launch {
            try {
                val start = runtime.startLogin()
                val key = start.qrcode?.takeIf { it.isNotBlank() }
                val content = start.qrContent?.takeIf { it.isNotBlank() }
                if (key == null || content == null) {
                    _state.value = WechatBindState.Failed("微信返回的二维码不完整，请重试。")
                    return@launch
                }
                // Prove the payload encodes before showing it: a QR that cannot
                // be drawn is a bind the person cannot complete.
                runCatching { encodeQr(content) }.onFailure {
                    _state.value = WechatBindState.Failed("二维码内容无法绘制，请重试。")
                    return@launch
                }
                _state.value = WechatBindState.Waiting(content)
                val account = runtime.awaitLogin(key)
                _state.value = when {
                    account != null -> WechatBindState.Bound(account.ownerId)
                    // Cancelled by the person, who already reset the state.
                    !currentCoroutineContext().isActive -> WechatBindState.Idle
                    else -> WechatBindState.Failed("二维码已过期，请重新获取。")
                }
                if (account != null) onBound()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                Log.w(TAG, "wechat bind failed: ${error::class.simpleName}")
                _state.value = WechatBindState.Failed("绑定失败，请检查网络后重试。")
            } finally {
                job = null
            }
        }
    }

    /** Stop waiting for a scan. A confirmed binding is unaffected. */
    fun cancel() {
        job?.cancel()
        job = null
        _state.value = WechatBindState.Idle
    }

    /**
     * Render the QR to a PNG in the shared pictures collection, so the person
     * can pick it from WeChat's own album scanner.
     *
     * API 29+ needs no permission for this (the app writes its own media); on
     * 26–28 it needs WRITE_EXTERNAL_STORAGE, which the caller must have
     * granted. Returns the display path, or null on failure.
     */
    suspend fun saveQrToAlbum(context: Context, content: String): String? = withContext(Dispatchers.IO) {
        val waiting = _state.value as? WechatBindState.Waiting ?: return@withContext null
        if (waiting.content != content) return@withContext null
        val bitmap = runCatching { qrBitmap(encodeQr(content)) }.getOrNull() ?: return@withContext null
        try {
            val path = writeImage(context, bitmap)
            if (path != null) _state.value = waiting.copy(savedPath = path)
            path
        } finally {
            bitmap.recycle()
        }
    }

    private fun qrBitmap(matrix: QrMatrix, target: Int = 1024): Bitmap {
        val quiet = 4
        val modules = matrix.size + quiet * 2
        val scale = (target / modules).coerceAtLeast(2)
        val size = modules * scale
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(Color.WHITE)
        val pixels = IntArray(size * size) { Color.WHITE }
        for (y in 0 until matrix.size) {
            for (x in 0 until matrix.size) {
                if (!matrix[x, y]) continue
                val left = (x + quiet) * scale
                val top = (y + quiet) * scale
                for (dy in 0 until scale) {
                    val row = (top + dy) * size
                    for (dx in 0 until scale) pixels[row + left + dx] = Color.BLACK
                }
            }
        }
        bitmap.setPixels(pixels, 0, size, 0, 0, size, size)
        return bitmap
    }

    private fun writeImage(context: Context, bitmap: Bitmap): String? {
        val name = "lunabot-wechat-qr-${System.currentTimeMillis()}.png"
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, name)
                put(MediaStore.Images.Media.MIME_TYPE, "image/png")
                put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/Luna Bot")
                put(MediaStore.Images.Media.IS_PENDING, 1)
            }
            val resolver = context.contentResolver
            val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return null
            try {
                resolver.openOutputStream(uri)?.use { out ->
                    if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)) throw IOException("compress failed")
                } ?: throw IOException("no output stream")
                values.clear()
                values.put(MediaStore.Images.Media.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
                "Pictures/Luna Bot/$name"
            } catch (error: Exception) {
                Log.w(TAG, "wechat qr save failed: ${error::class.simpleName}")
                runCatching { resolver.delete(uri, null, null) }
                null
            }
        } else {
            @Suppress("DEPRECATION")
            val directory = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "Luna Bot")
            runCatching {
                if (!directory.isDirectory && !directory.mkdirs()) throw IOException("no directory")
                val file = File(directory, name)
                file.outputStream().use { out ->
                    if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)) throw IOException("compress failed")
                }
                MediaScannerConnection.scanFile(context, arrayOf(file.absolutePath), arrayOf("image/png"), null)
                "Pictures/Luna Bot/$name"
            }.getOrElse {
                Log.w(TAG, "wechat qr save failed: ${it::class.simpleName}")
                null
            }
        }
    }

    private companion object {
        const val TAG = "WechatBinder"
    }
}
