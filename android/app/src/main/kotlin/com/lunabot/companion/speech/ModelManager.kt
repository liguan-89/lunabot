package com.lunabot.companion.speech

import android.content.Context
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * The on-device streaming recognizer's model files, kept under filesDir so
 * Android never wipes them as cache.
 *
 * The model is `sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23` — a 14M
 * Chinese zipformer2 transducer. It ships as a 70 MB tar.bz2 on GitHub, but
 * the Hugging Face repo carries the same files individually; downloading only
 * the int8 trio plus tokens.txt is ~25 MB and needs no archive dependency.
 * hf-mirror.com is tried first because huggingface.co is unreachable from
 * most Chinese networks; both pin the same frozen commit.
 */
class ModelManager internal constructor(private val root: File) {
    constructor(context: Context) : this(File(context.filesDir, "asr"))

    /** The four files a zipformer2 transducer session is built from. */
    data class Resolved(
        val encoder: File,
        val decoder: File,
        val joiner: File,
        val tokens: File,
    )

    private data class ModelFile(val name: String, val bytes: Long)

    private val gate = Mutex()
    private val _progress = MutableStateFlow<Float?>(null)

    /** null = 空闲；0..1 = 正在下载。 */
    val progress: StateFlow<Float?> = _progress.asStateFlow()

    fun directory(): File = File(root, MODEL_DIR)

    /**
     * The model files resolved against whatever epoch suffix is on disk:
     * int8 preferred, fp32 accepted. Null while any piece is missing, which
     * is also the "model not downloaded" answer the sheet reads.
     */
    fun resolved(): Resolved? {
        val dir = directory()
        val names = dir.list()?.toList() ?: return null
        fun pick(stem: String): File? {
            val candidates = names.filter { it.startsWith(stem) && it.endsWith(".onnx") }
            val chosen = candidates.firstOrNull { it.endsWith(".int8.onnx") } ?: candidates.firstOrNull()
            return chosen?.let { File(dir, it) }?.takeIf { it.isFile && it.length() > 0 }
        }
        val tokens = File(dir, "tokens.txt").takeIf { it.isFile && it.length() > 0 } ?: return null
        return Resolved(
            encoder = pick("encoder-") ?: return null,
            decoder = pick("decoder-") ?: return null,
            joiner = pick("joiner-") ?: return null,
            tokens = tokens,
        )
    }

    fun isReady(): Boolean = resolved() != null

    /**
     * Download every missing file into a staging directory, then swap it in
     * atomically — a half-downloaded model never reads as ready. Concurrent
     * callers queue behind one download and share its outcome.
     */
    suspend fun ensure(): Boolean = withContext(Dispatchers.IO) {
        if (isReady()) return@withContext true
        gate.withLock {
            if (isReady()) return@withLock true
            val staging = File(root, "$MODEL_DIR.download")
            staging.deleteRecursively()
            staging.mkdirs()
            val total = FILES.sumOf { it.bytes }
            try {
                var finished = 0L
                for (spec in FILES) {
                    val target = File(staging, spec.name)
                    fetch(spec, target) { received ->
                        _progress.value = (finished + received).toFloat() / total
                    }
                    if (target.length() != spec.bytes) throw IOException("模型文件不完整：${spec.name}")
                    finished += spec.bytes
                    _progress.value = finished.toFloat() / total
                }
                directory().deleteRecursively()
                if (!staging.renameTo(directory())) throw IOException("模型目录落位失败")
                isReady()
            } catch (_: Exception) {
                staging.deleteRecursively()
                false
            } finally {
                _progress.value = null
            }
        }
    }

    fun delete() {
        directory().deleteRecursively()
        File(root, "$MODEL_DIR.download").deleteRecursively()
    }

    /** Try each mirror in order; first complete file wins, the rest are not asked. */
    private fun fetch(spec: ModelFile, target: File, onBytes: (Long) -> Unit) {
        var failure: IOException? = null
        for (host in MIRRORS) {
            try {
                download("$host/$MODEL_REPO/resolve/$MODEL_REV/${spec.name}", target, onBytes)
                return
            } catch (error: IOException) {
                failure = error
            }
        }
        throw failure ?: IOException("模型下载失败")
    }

    private fun download(url: String, target: File, onBytes: (Long) -> Unit) {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.instanceFollowRedirects = true
        connection.connectTimeout = CONNECT_TIMEOUT_MS
        connection.readTimeout = READ_TIMEOUT_MS
        try {
            if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                throw IOException("HTTP ${connection.responseCode}")
            }
            connection.inputStream.use { input ->
                target.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var received = 0L
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        output.write(buffer, 0, read)
                        received += read
                        onBytes(received)
                    }
                }
            }
        } finally {
            connection.disconnect()
        }
    }

    private companion object {
        const val MODEL_DIR = "zipformer-zh-14M"
        const val MODEL_REPO = "csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23"
        // Pinned commit: a repo update can never swap bytes under the same name.
        const val MODEL_REV = "204ad334e2e683fd295359930cc16fc0432a23ac"
        const val CONNECT_TIMEOUT_MS = 15_000
        const val READ_TIMEOUT_MS = 30_000
        val MIRRORS = listOf("https://hf-mirror.com", "https://huggingface.co")
        val FILES = listOf(
            ModelFile("encoder-epoch-99-avg-1.int8.onnx", 21_621_684L),
            ModelFile("decoder-epoch-99-avg-1.int8.onnx", 1_888_682L),
            ModelFile("joiner-epoch-99-avg-1.int8.onnx", 1_795_562L),
            ModelFile("tokens.txt", 48_697L),
        )
    }
}
