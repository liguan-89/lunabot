// Adapted from Mika's WechatApi and WechatRuntime (Apache-2.0).
package com.lunabot.companion.wechat

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

/** A decoded image prepared for both the local store and the event payload. */
internal data class StoredWechatImage(
    /** Relative to [WechatImageFiles.root]; this is what the event names. */
    val name: String,
    val mime: String,
    val bytes: ByteArray,
)

/**
 * Inbound WeChat images, on this phone.
 *
 * The pipeline is Mika's: download over the CDN path (no bot token attached),
 * decrypt AES-128-ECB, sniff the signature rather than trust a header, cap the
 * size, decode with a sampling factor so a huge image never allocates full
 * size, and re-encode until it fits the budget.
 *
 * The difference is where the bytes end up. Mika imported them into a task
 * workspace it owns; this build has no such workspace on the phone, so they go
 * to a private directory under `filesDir` — readable only by this app, excluded
 * from backup — and the event carries base64 of the prepared bytes. A batch is
 * staged in a temp directory and only moved into place once every image
 * succeeded, so a partial batch leaves nothing behind.
 */
internal class WechatImageFiles(
    private val root: File,
    private val download: suspend (WechatImage) -> WechatDownloadedImage,
    private val prepare: (WechatDownloadedImage) -> PreparedImage = ::prepareWechatImage,
) {
    /**
     * Download and store every image of one message.
     *
     * @throws IOException when any image is rejected, so the caller reports a
     * failed attachment rather than a message with silently missing pictures.
     */
    suspend fun receive(sendId: String, images: List<WechatImage>): List<StoredWechatImage> =
        withContext(Dispatchers.IO) {
            if (images.isEmpty()) return@withContext emptyList()
            if (images.size > WechatImages.MAX_IMAGES) throw IOException("Too many images in one message")
            val batch = File(root, "staging-${UUID.randomUUID()}")
            if (!batch.mkdirs()) throw IOException("Cannot stage images")
            try {
                val staged = images.mapIndexed { index, image ->
                    currentCoroutineContext().ensureActive()
                    val prepared = prepare(download(image))
                    currentCoroutineContext().ensureActive()
                    val name = "wechat-${index + 1}.${prepared.extension}"
                    File(batch, name).writeBytes(prepared.bytes)
                    StoredWechatImage(name, prepared.mime, prepared.bytes)
                }
                val target = directoryFor(sendId)
                if (!target.mkdirs() && !target.isDirectory) throw IOException("Cannot store images")
                for (image in staged) {
                    val from = File(batch, image.name)
                    val to = File(target, image.name)
                    if (!from.renameTo(to)) throw IOException("Cannot store images")
                }
                staged
            } finally {
                batch.deleteRecursively()
            }
        }

    /** Drop the stored copy once the event is acknowledged; missing files are fine. */
    suspend fun release(sendId: String) = withContext(Dispatchers.IO) {
        runCatching { directoryFor(sendId).deleteRecursively() }
        Unit
    }

    /** A crash mid-batch leaves staging directories behind; they are worthless. */
    suspend fun pruneStaging() = withContext(Dispatchers.IO) {
        root.listFiles()?.filter { it.isDirectory && it.name.startsWith("staging-") }
            ?.forEach { runCatching { it.deleteRecursively() } }
        Unit
    }

    /** The on-disk name of one stored image, for a caller that wants the file. */
    fun file(sendId: String, name: String): File = File(directoryFor(sendId), name)

    private fun directoryFor(sendId: String): File =
        File(root, sendId.filter { it.isLetterOrDigit() || it == '-' || it == '_' }.take(64).ifEmpty {
            "unknown"
        })

    companion object {
        const val DIRECTORY = "wechat-images"

        fun root(context: android.content.Context): File = File(context.filesDir, DIRECTORY)
    }
}

/** The prepared bytes and the extension they belong to. */
internal data class PreparedImage(val bytes: ByteArray, val mime: String, val extension: String)

/**
 * Keep an image inside a budget the event payload and the model input can
 * afford, without allocating the full-size remote bitmap: bounds first, then a
 * power-of-two sample, then halve until the encoding fits.
 */
internal fun prepareWechatImage(image: WechatDownloadedImage): PreparedImage {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(image.bytes, 0, image.bytes.size, bounds)
    val width = bounds.outWidth
    val height = bounds.outHeight
    if (width <= 0 || height <= 0 || width.toLong() * height > MAX_SOURCE_PIXELS) {
        throw IOException("Invalid image dimensions")
    }
    var sample = 1
    // Round up: an odd dimension such as 8193 must not decode to 4097 at sample 2.
    while ((width + sample - 1) / sample > MAX_EDGE || (height + sample - 1) / sample > MAX_EDGE ||
        ((width + sample - 1) / sample).toLong() * ((height + sample - 1) / sample) > MAX_DECODED_PIXELS
    ) {
        sample *= 2
    }
    val options = BitmapFactory.Options().apply { inSampleSize = sample }
    var bitmap = BitmapFactory.decodeByteArray(image.bytes, 0, image.bytes.size, options)
        ?: throw IOException("Cannot decode image")
    try {
        // Already small enough and already in a format the server accepts: pass
        // the original bytes through rather than recompressing them.
        if (sample == 1 && image.bytes.size <= MODEL_IMAGE_BYTES &&
            image.extension in setOf("png", "jpg", "webp")
        ) {
            return PreparedImage(image.bytes, image.mimeType, image.extension)
        }
        val keepAlpha = bitmap.hasAlpha()
        while (true) {
            val output = ByteArrayOutputStream()
            if (!bitmap.compress(if (keepAlpha) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, 90, output)) {
                throw IOException("Cannot prepare image")
            }
            if (output.size() <= MODEL_IMAGE_BYTES) {
                val bytes = output.toByteArray()
                return if (keepAlpha) {
                    PreparedImage(bytes, "image/png", "png")
                } else {
                    PreparedImage(bytes, "image/jpeg", "jpg")
                }
            }
            val smaller = Bitmap.createScaledBitmap(
                bitmap,
                (bitmap.width / 2).coerceAtLeast(1),
                (bitmap.height / 2).coerceAtLeast(1),
                true,
            )
            if (smaller === bitmap) throw IOException("Cannot fit image into the event payload")
            bitmap.recycle()
            bitmap = smaller
        }
    } finally {
        bitmap.recycle()
    }
}

/** 4096 on the long edge and 8 megapixels decoded: enough to read, small enough to hold. */
private const val MAX_EDGE = 4096
private const val MAX_DECODED_PIXELS = 8L * 1024 * 1024

/** Refuse absurd source dimensions before any decode allocates them. */
private const val MAX_SOURCE_PIXELS = 64L * 1024 * 1024

/** The per-image budget the prepared bytes must fit, matching the model's own image limit. */
private const val MODEL_IMAGE_BYTES = 5 * 1024 * 1024
