package com.openmausbot.companion.ui

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import android.os.SystemClock
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import kotlin.math.sqrt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** One recording, already read off disk so the temp file can be removed. */
data class VoiceClip(
    val data: ByteArray,
    /** What the computer shows the file as: `语音 09-41.m4a`. */
    val name: String,
    val durationMs: Long,
)

/**
 * Hold-to-talk capture, the phone's own half of the feature.
 *
 * The computer already accepts audio as an ordinary file — its upload route
 * lists `audio/mp4` and the desktop plays it with `<audio>` — so a voice message
 * is an AAC clip in an MP4 container sent through the same authenticated
 * attachment route as a PDF. Nothing here talks to the harness directly.
 *
 * The clip lives in the app cache only until it is read: sending the bytes
 * clears the file, and [cancel] removes it without ever handing it anywhere.
 */
class VoiceRecorder(private val context: Context) {
    private var recorder: MediaRecorder? = null
    private var file: File? = null
    private var startedAt = 0L

    val isRecording: Boolean get() = recorder != null

    fun start(): Boolean {
        if (recorder != null) return true
        val target = File(context.cacheDir, "voice-${UUID.randomUUID()}.m4a")
        return try {
            val media = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(context)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }
            media.setAudioSource(MediaRecorder.AudioSource.MIC)
            // AAC in MP4: the one combination every Android device records and
            // every desktop browser can play without a codec pack.
            media.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            media.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            media.setAudioChannels(1)
            media.setAudioSamplingRate(44_100)
            media.setAudioEncodingBitRate(64_000)
            media.setOutputFile(target.absolutePath)
            media.prepare()
            media.start()
            recorder = media
            file = target
            startedAt = SystemClock.elapsedRealtime()
            true
        } catch (_: Exception) {
            runCatching { recorder?.release() }
            recorder = null
            file = null
            target.delete()
            false
        }
    }

    fun elapsedMs(): Long =
        if (recorder == null) 0L else SystemClock.elapsedRealtime() - startedAt

    /**
     * The meter, already softened: speech is much quieter than the peak the
     * encoder allows, and a linear 0..1 reading would sit at the bottom of the
     * bars for a normal voice.
     */
    fun level(): Float {
        val peak = runCatching { recorder?.maxAmplitude ?: 0 }.getOrDefault(0)
        if (peak <= 0) return 0f
        return sqrt(peak / 32_767f).coerceIn(0f, 1f)
    }

    /** Stops, reads, and removes the clip. Null when nothing usable was recorded. */
    suspend fun stop(): VoiceClip? = withContext(Dispatchers.IO) {
        val media = recorder ?: return@withContext null
        val target = file
        val duration = elapsedMs()
        recorder = null
        file = null
        try {
            media.stop()
        } catch (_: RuntimeException) {
            // MediaRecorder throws when stopped before the encoder's first
            // frame. There is no clip to send, and no file worth keeping.
            runCatching { media.release() }
            target?.delete()
            return@withContext null
        }
        media.release()
        if (target == null || !target.exists()) return@withContext null
        val bytes = runCatching { target.readBytes() }.getOrNull()
        target.delete()
        if (bytes == null || bytes.isEmpty()) {
            null
        } else {
            VoiceClip(bytes, name(), duration)
        }
    }

    fun cancel() {
        val media = recorder ?: return
        recorder = null
        runCatching { media.stop() }
        runCatching { media.release() }
        file?.delete()
        file = null
    }

    fun release() = cancel()

    private fun name(): String {
        val stamp = SimpleDateFormat("HH-mm", Locale.SIMPLIFIED_CHINESE).format(Date())
        return "语音 $stamp.m4a"
    }
}
