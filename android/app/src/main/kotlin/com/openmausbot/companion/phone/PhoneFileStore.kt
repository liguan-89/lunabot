package com.openmausbot.companion.phone

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Base64
import androidx.core.content.ContextCompat
import androidx.documentfile.provider.DocumentFile
import com.openmausbot.companion.phoneui.PhoneUiOcr
import com.openmausbot.companion.storage.ChatPreferences
import java.io.ByteArrayOutputStream

/**
 * The phone's photos and one granted folder, as a bot can see them.
 *
 * Two sources, both deliberate:
 * - photos in the system media library, readable only with the media grant the
 *   person gave after turning the switch on;
 * - files under the one folder the person picked with the system folder picker
 *   (a persisted tree grant). Nothing outside that tree is readable, and the
 *   system enforces that on every open.
 *
 * Ids are opaque to the bot: `photo:<media id>` or `tree:<base64 url>`. Reading
 * returns either an image to look at, recognized text (text files, and PDF
 * pages through the same OCR used for screenshots), or a refusal naming the
 * type. Nothing is uploaded here; the executor puts the result in one job
 * answer.
 */
internal class PhoneFileStore(private val context: Context) {
    private val preferences = ChatPreferences(context)
    private val resolver = context.contentResolver

    data class Entry(
        val fileId: String,
        val name: String,
        val mime: String?,
        val sizeBytes: Long,
        val modifiedAt: Long,
        val source: String,
    )

    sealed interface Content {
        class Image(val name: String, val mime: String, val bytes: ByteArray, val width: Int, val height: Int) : Content
        class Text(val name: String, val text: String, val truncated: Boolean) : Content
        class Unsupported(val name: String, val mime: String?, val sizeBytes: Long) : Content
        class Bytes(val name: String, val mime: String, val data: ByteArray) : Content
    }

    class FileProblem(message: String, val code: String) : Exception(message)

    fun enabled(): Boolean = preferences.phoneFiles.value

    fun photosGranted(): Boolean = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED
    } else {
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
    }

    fun treeUri(): Uri? = preferences.phoneFilesTree.value?.let(Uri::parse)

    /** Photos and (when granted) the folder's files, newest first. */
    fun list(query: String?, kind: String, limit: Int): List<Entry> {
        val out = ArrayList<Entry>(limit)
        if (kind != "document" && photosGranted()) out.addAll(listPhotos(query, limit - out.size))
        if (kind != "image" && out.size < limit) out.addAll(listTree(query, limit - out.size))
        return out
    }

    /**
     * The file's bytes for putting it into the conversation, read whole and
     * bounded: the chat transport carries base64 JSON, so a small cap keeps one
     * attachment from stalling the job.
     */
    fun bytesFor(fileId: String, maxBytes: Long = MAX_ATTACH_BYTES): Content.Bytes {
        val uri = uriOf(fileId)
        val name = displayName(uri) ?: "文件"
        val mime = mimeOf(uri, name)
        val size = sizeOf(uri)
        if (size > maxBytes) throw FileProblem("$name 超过 ${maxBytes / (1_024 * 1_024)} MB，不能放进对话。", "too_large")
        val data = runCatching { resolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull()
            ?: throw FileProblem("DEX BOT 无法读取 $name。", "denied")
        if (data.size > maxBytes) throw FileProblem("$name 超过 ${maxBytes / (1_024 * 1_024)} MB，不能放进对话。", "too_large")
        return Content.Bytes(name, mime, data)
    }

    fun uriFor(fileId: String): Uri = uriOf(fileId)

    /** True for a file inside the granted folder, whose URI cannot be re-delegated. */
    fun isFolderFile(fileId: String): Boolean = fileId.startsWith(TREE_PREFIX)

    /**
     * Copies a file out of the granted folder into the share cache and returns
     * the copy. A SAF document URI's grant belongs to this app and cannot be
     * handed on, so the share provider serves the copy instead. Old copies are
     * swept first so the directory never holds more than a few.
     */
    fun copyForShare(fileId: String): java.io.File {
        val uri = uriOf(fileId)
        val name = displayName(uri) ?: "文件"
        val safe = name.replace(Regex("[^\\p{L}\\p{N}._-]"), "_").take(80).ifEmpty { "file" }
        val dir = java.io.File(context.cacheDir, SHARE_DIR)
        if (!dir.exists() && !dir.mkdirs()) throw FileProblem("无法准备分享缓存。", "denied")
        sweepShareCache(dir)
        val copy = java.io.File(dir, "${java.util.UUID.randomUUID()}-$safe")
        val written = runCatching {
            resolver.openInputStream(uri)?.use { input ->
                copy.outputStream().use { output ->
                    var total = 0L
                    val buffer = ByteArray(64 * 1_024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read <= 0) break
                        total += read
                        if (total > MAX_SHARE_BYTES) throw FileProblem("$name 超过 25 MB，没有分享。", "too_large")
                        output.write(buffer, 0, read)
                    }
                    total > 0
                }
            }
        }.getOrElse { error ->
            copy.delete()
            if (error is FileProblem) throw error else throw FileProblem("DEX BOT 无法读取 $name。", "denied")
        }
        if (written != true) {
            copy.delete()
            throw FileProblem("DEX BOT 无法读取 $name。", "denied")
        }
        return copy
    }

    /** At most [SHARE_KEEP] copies, nothing older than an hour. */
    private fun sweepShareCache(dir: java.io.File) {
        val cutoff = System.currentTimeMillis() - SHARE_TTL_MS
        val files = dir.listFiles()?.sortedByDescending { it.lastModified() } ?: return
        files.forEachIndexed { index, file ->
            if (index >= SHARE_KEEP || file.lastModified() < cutoff) runCatching { file.delete() }
        }
    }

    fun mimeOf(uri: Uri, name: String): String = (runCatching { resolver.getType(uri) }.getOrNull()
        ?.takeIf { it.isNotBlank() && it != "*/*" }
        ?: guessMime(name)
        ?: "application/octet-stream").lowercase()

    suspend fun read(fileId: String, pages: Int): Content {
        val uri = uriOf(fileId)
        val mime = runCatching { resolver.getType(uri) }.getOrNull()?.takeIf { it.isNotBlank() && it != "*/*" }
        val name = displayName(uri) ?: "该文件"
        val size = sizeOf(uri)
        val type = (mime ?: guessMime(name) ?: "application/octet-stream").lowercase()
        return when {
            type.startsWith("image/") -> readImage(uri, name, type, size)
            type == "application/pdf" -> readPdf(uri, name, pages)
            type.startsWith("text/") || type in TEXTUAL_TYPES -> readText(uri, name, size)
            else -> Content.Unsupported(name, mime, size)
        }
    }

    // MARK: - Listing

    private fun listPhotos(query: String?, limit: Int): List<Entry> {
        if (limit <= 0) return emptyList()
        val projection = arrayOf(
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.MIME_TYPE,
            MediaStore.Images.Media.SIZE,
            MediaStore.Images.Media.DATE_MODIFIED,
        )
        val selection = if (query.isNullOrBlank()) null else "${MediaStore.Images.Media.DISPLAY_NAME} LIKE ?"
        val args = query?.takeIf { it.isNotBlank() }?.let { arrayOf("%${it.take(80)}%") }
        val out = ArrayList<Entry>(limit)
        runCatching {
            resolver.query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                projection,
                selection,
                args,
                "${MediaStore.Images.Media.DATE_MODIFIED} DESC",
            )?.use { cursor ->
                while (cursor.moveToNext() && out.size < limit) {
                    val id = cursor.getLong(0)
                    out.add(
                        Entry(
                            fileId = "photo:$id",
                            name = cursor.getString(1) ?: "照片",
                            mime = cursor.getString(2),
                            sizeBytes = cursor.getLong(3),
                            modifiedAt = cursor.getLong(4) * 1_000L,
                            source = "photos",
                        ),
                    )
                }
            }
        }
        return out
    }

    private fun listTree(query: String?, limit: Int): List<Entry> {
        if (limit <= 0) return emptyList()
        val root = treeUri()?.let { runCatching { DocumentFile.fromTreeUri(context, it) }.getOrNull() } ?: return emptyList()
        val out = ArrayList<Entry>(limit)
        walk(root, 0, query, limit, out)
        return out
    }

    private fun walk(dir: DocumentFile, depth: Int, query: String?, limit: Int, out: MutableList<Entry>) {
        if (depth > MAX_DEPTH || out.size >= limit) return
        val children = runCatching { dir.listFiles().take(MAX_CHILDREN) }.getOrDefault(emptyList())
        for (child in children) {
            if (out.size >= limit) return
            if (child.isDirectory) {
                walk(child, depth + 1, query, limit, out)
                continue
            }
            val name = child.name ?: continue
            if (!query.isNullOrBlank() && !name.contains(query, ignoreCase = true)) continue
            out.add(
                Entry(
                    fileId = "tree:" + Base64.encodeToString(child.uri.toString().toByteArray(), Base64.URL_SAFE or Base64.NO_WRAP),
                    name = name,
                    mime = child.type,
                    sizeBytes = child.length(),
                    modifiedAt = child.lastModified(),
                    source = "folder",
                ),
            )
        }
    }

    // MARK: - Reading

    private fun uriOf(fileId: String): Uri = when {
        fileId.startsWith(PHOTO_PREFIX) -> {
            val id = fileId.removePrefix(PHOTO_PREFIX).toLongOrNull()
                ?: throw FileProblem("文件编号无效，请重新列出文件。", "unsupported")
            android.content.ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
        }
        fileId.startsWith(TREE_PREFIX) -> {
            val raw = runCatching {
                String(Base64.decode(fileId.removePrefix(TREE_PREFIX), Base64.URL_SAFE or Base64.NO_WRAP))
            }.getOrNull()?.takeIf { it.startsWith("content://") }
                ?: throw FileProblem("文件编号无效，请重新列出文件。", "unsupported")
            Uri.parse(raw)
        }
        else -> throw FileProblem("文件编号无效，请重新列出文件。", "unsupported")
    }

    private fun displayName(uri: Uri): String? {
        if (uri.authority == MediaStore.AUTHORITY) {
            return runCatching {
                resolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) cursor.getString(0) else null
                }
            }.getOrNull()
        }
        return runCatching { DocumentFile.fromSingleUri(context, uri)?.name }.getOrNull()
    }

    private fun sizeOf(uri: Uri): Long = runCatching {
        resolver.query(uri, arrayOf(MediaStore.MediaColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getLong(0) else 0L
        }
    }.getOrNull() ?: 0L

    private fun readImage(uri: Uri, name: String, mime: String, size: Long): Content {
        if (size > MAX_IMAGE_BYTES) throw FileProblem("这张图片超过 25 MB，没有读取。", "too_large")
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        val opened = runCatching {
            resolver.openInputStream(uri)?.use { stream ->
                // A bounds-only decode returns null by design; the stream opening is the success signal.
                BitmapFactory.decodeStream(stream, null, bounds)
                true
            }
        }.getOrNull() ?: false
        if (!opened) throw FileProblem("DEX BOT 无法读取 $name。", "denied")
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw FileProblem("$name 不是可识别的图片。", "unsupported")
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > MAX_IMAGE_DIMENSION) sample *= 2
        val decoded = runCatching {
            resolver.openInputStream(uri)?.use { stream ->
                BitmapFactory.decodeStream(stream, null, BitmapFactory.Options().apply { inSampleSize = sample })
            }
        }.getOrNull() ?: throw FileProblem("DEX BOT 无法读取 $name。", "denied")
        val scaled = scaleDown(decoded, MAX_IMAGE_DIMENSION)
        try {
            val bytes = ByteArrayOutputStream().also {
                scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, it)
            }.toByteArray()
            if (bytes.size > MAX_IMAGE_OUTPUT_BYTES) throw FileProblem("这张图片编码后仍然过大。", "too_large")
            return Content.Image(name, "image/jpeg", bytes, scaled.width, scaled.height)
        } finally {
            if (scaled !== decoded) scaled.recycle()
            decoded.recycle()
        }
    }

    /**
     * A PDF's text, page by page, through the same on-device recognizer the
     * screen uses. The framework renders; no PDF text layer is assumed, which
     * also covers scans.
     */
    private suspend fun readPdf(uri: Uri, name: String, pages: Int): Content {
        val bounded = pages.coerceIn(1, MAX_PDF_PAGES)
        return try {
            resolver.openFileDescriptor(uri, "r")?.use { pfd ->
                val renderer = PdfRenderer(pfd)
                try {
                    val count = minOf(renderer.pageCount, bounded)
                    val text = StringBuilder()
                    for (index in 0 until count) {
                        val page = renderer.openPage(index)
                        try {
                            val width = minOf(page.width * 2, MAX_PDF_RENDER_WIDTH)
                            val height = (page.height.toFloat() * width / page.width).toInt().coerceAtLeast(1)
                            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                            bitmap.eraseColor(Color.WHITE)
                            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                            val lines = PhoneUiOcr.read(bitmap, maxLines = 80, maxChars = 3_000)
                            bitmap.recycle()
                            text.append("--- 第 ").append(index + 1).append(" 页 ---\n")
                            lines.forEach { text.append(it.text).append('\n') }
                        } finally {
                            page.close()
                        }
                    }
                    val body = text.toString().trim()
                    if (body.isEmpty()) {
                        Content.Text(name, "这一份 PDF 没有识别出文字（可能是纯图形页面）。", false)
                    } else {
                        Content.Text(name, body.take(MAX_TEXT_CHARS), body.length > MAX_TEXT_CHARS)
                    }
                } finally {
                    renderer.close()
                }
            } ?: throw FileProblem("DEX BOT 无法打开 $name。", "denied")
        } catch (problem: FileProblem) {
            throw problem
        } catch (error: Throwable) {
            throw FileProblem("读取 $name 失败：${error.message ?: "未知错误"}", "denied")
        }
    }

    private fun readText(uri: Uri, name: String, size: Long): Content {
        if (size > MAX_TEXT_BYTES) throw FileProblem("$name 超过 64 KB，没有整份读取。", "too_large")
        val bytes = resolver.openInputStream(uri)?.use { it.readBytes() }
            ?: throw FileProblem("DEX BOT 无法读取 $name。", "denied")
        if (bytes.any { it == 0.toByte() }) throw FileProblem("$name 不是文本文件。", "unsupported")
        val text = bytes.toString(Charsets.UTF_8)
        return Content.Text(
            name = name,
            text = text.take(MAX_TEXT_CHARS),
            truncated = text.length > MAX_TEXT_CHARS,
        )
    }

    private fun guessMime(name: String): String? = when (name.substringAfterLast('.', "").lowercase()) {
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "webp" -> "image/webp"
        "gif" -> "image/gif"
        "pdf" -> "application/pdf"
        "txt", "md", "log" -> "text/plain"
        "json" -> "application/json"
        "csv" -> "text/csv"
        else -> null
    }

    private fun scaleDown(source: Bitmap, maxDimension: Int): Bitmap {
        val longest = maxOf(source.width, source.height)
        if (longest <= maxDimension) return source
        val ratio = maxDimension.toFloat() / longest
        return Bitmap.createScaledBitmap(
            source,
            (source.width * ratio).toInt().coerceAtLeast(1),
            (source.height * ratio).toInt().coerceAtLeast(1),
            true,
        )
    }

    private companion object {
        const val PHOTO_PREFIX = "photo:"
        const val TREE_PREFIX = "tree:"
        const val MAX_DEPTH = 3
        const val MAX_CHILDREN = 200
        const val MAX_IMAGE_BYTES = 25L * 1_024 * 1_024
        const val MAX_IMAGE_DIMENSION = 1024
        const val MAX_IMAGE_OUTPUT_BYTES = 1_500_000
        const val JPEG_QUALITY = 80
        const val MAX_TEXT_BYTES = 64L * 1_024
        const val MAX_TEXT_CHARS = 20_000
        const val MAX_PDF_PAGES = 5
        const val MAX_PDF_RENDER_WIDTH = 1024
        val TEXTUAL_TYPES = setOf("application/json", "application/xml", "text/csv", "text/tab-separated-values")
        const val SHARE_DIR = "bot-share"
        const val MAX_SHARE_BYTES = 25L * 1_024 * 1_024
        const val SHARE_KEEP = 3
        const val SHARE_TTL_MS = 60L * 60 * 1_000
        const val MAX_ATTACH_BYTES = 8L * 1_024 * 1_024
    }
}