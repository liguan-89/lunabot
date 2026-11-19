package com.openmausbot.companion.ui

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.SystemClock
import java.io.File
import java.io.RandomAccessFile
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlin.math.abs
import kotlin.math.sqrt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** One recording, already read off disk so the temp file can be removed. */
data class VoiceClip(
    val data: ByteArray,
    /** What the computer shows the file as: `语音 09-41.wav`. */
    val name: String,
    val durationMs: Long,
)

/**
 * The 44-byte RIFF/WAVE header for 16 kHz mono PCM16, little-endian.
 *
 * Pure JVM on purpose: the unit test reads the fields back without a device.
 * Written once as a zero-length placeholder when the file opens, then
 * re-written with the real data size when capture stops — the length is the
 * one field a stream cannot know up front.
 *
 * 16 kHz mono PCM16 is the one layout both consumers accept: the on-device
 * recognizer eats raw PCM at that rate, and the computer's transcribe route
 * (`/api/tts/transcribe`) takes `audio/wav` — which every browser plays too.
 */
internal object WavHeader {
    const val BYTES = 44
    const val SAMPLE_RATE = 16_000

    fun write(file: RandomAccessFile, dataBytes: Long) {
        file.seek(0)
        file.writeBytes("RIFF")
        u32(file, 36 + dataBytes)
        file.writeBytes("WAVE")
        file.writeBytes("fmt ")
        u32(file, 16) // PCM sub-chunk size
        u16(file, 1) // linear PCM
        u16(file, 1) // mono
        u32(file, SAMPLE_RATE.toLong())
        u32(file, SAMPLE_RATE * 2L) // byte rate: samples * channels * 2 bytes
        u16(file, 2) // block align
        u16(file, 16) // bits per sample
        file.writeBytes("data")
        u32(file, dataBytes)
    }

    private fun u16(file: RandomAccessFile, value: Int) {
        file.writeByte(value and 0xFF)
        file.writeByte((value ushr 8) and 0xFF)
    }

    private fun u32(file: RandomAccessFile, value: Long) {
        u16(file, (value and 0xFFFF).toInt())
        u16(file, ((value ushr 16) and 0xFFFF).toInt())
    }
}

/**
 * Hold-to-talk capture, the phone's own half of the feature.
 *
 * A voice message is a WAV clip sent through the same authenticated
 * attachment route as a PDF. The clip lives in the app cache only until it is
 * read: sending the bytes clears the file, and [cancel] removes it without
 * ever handing it anywhere.
 *
 * [start] takes an optional [onChunk]: each PCM block [AudioRecord] returns
 * is handed to it as well as to the file, so an on-device recognizer can hear
 * the same audio the clip keeps — no second microphone client.
 */
class VoiceRecorder(private val context: Context) {
    private var thread: Thread? = null
    private var file: File? = null
    private var startedAt = 0L
    @Volatile private var capturing = false
    @Volatile private var dataBytes = 0L
    private val peak = AtomicInteger(0)

    val isRecording: Boolean get() = thread != null

    @SuppressLint("MissingPermission") // Callers gate this on RECORD_AUDIO.
    fun start(onChunk: ((ByteArray) -> Unit)? = null): Boolean {
        if (thread != null) return true
        val target = File(context.cacheDir, "voice-${UUID.randomUUID()}.wav")
        val record = openRecorder() ?: return false
        val wav = runCatching {
            RandomAccessFile(target, "rw").also { WavHeader.write(it, 0) }
        }.getOrElse {
            record.release()
            return false
        }
        return try {
            dataBytes = 0
            peak.set(0)
            record.startRecording()
            capturing = true
            file = target
            startedAt = SystemClock.elapsedRealtime()
            thread = thread(name = "voice-clip-capture", isDaemon = true) {
                captureLoop(record, wav, onChunk)
            }
            true
        } catch (_: Exception) {
            runCatching { record.stop() }
            record.release()
            runCatching { wav.close() }
            target.delete()
            false
        }
    }

    fun elapsedMs(): Long =
        if (thread == null) 0L else SystemClock.elapsedRealtime() - startedAt

    /**
     * The meter, already softened: speech is much quieter than the peak the
     * format allows, and a linear 0..1 reading would sit at the bottom of the
     * bars for a normal voice. Like MediaRecorder's maxAmplitude, reading it
     * resets it — each bar shows the loudest moment since the last one.
     */
    fun level(): Float {
        val peak = this.peak.getAndSet(0)
        if (peak <= 0) return 0f
        return sqrt(peak / 32_767f).coerceIn(0f, 1f)
    }

    /** Stops, reads, and removes the clip. Null when nothing usable was recorded. */
    suspend fun stop(): VoiceClip? = withContext(Dispatchers.IO) {
        val worker = thread ?: return@withContext null
        val target = file
        val duration = elapsedMs()
        thread = null
        file = null
        capturing = false
        // The read loop drains at most one 40 ms block before noticing the
        // flag, so a join this long can only fail on a wedged driver — in
        // which case whatever bytes landed are still a valid clip.
        worker.join(STOP_JOIN_MS)
        if (target == null || !target.exists()) return@withContext null
        val bytes = runCatching { target.readBytes() }.getOrNull()
        target.delete()
        if (bytes == null || bytes.size <= WavHeader.BYTES) {
            null
        } else {
            VoiceClip(bytes, name(), duration)
        }
    }

    fun cancel() {
        val worker = thread ?: return
        val target = file
        thread = null
        file = null
        capturing = false
        worker.join(STOP_JOIN_MS)
        target?.delete()
    }

    fun release() = cancel()

    private fun openRecorder(): AudioRecord? {
        val bufferBytes = maxOf(
            AudioRecord.getMinBufferSize(
                WavHeader.SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
            ),
            CHUNK_BYTES * 4,
        )
        val record = runCatching {
            AudioRecord(
                MediaRecorder.AudioSource.MIC,
                WavHeader.SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferBytes,
            )
        }.getOrNull() ?: return null
        if (record.state == AudioRecord.STATE_INITIALIZED) return record
        record.release()
        return null
    }

    private fun captureLoop(
        record: AudioRecord,
        wav: RandomAccessFile,
        onChunk: ((ByteArray) -> Unit)?,
    ) {
        val chunk = ByteArray(CHUNK_BYTES)
        try {
            while (capturing) {
                val read = record.read(chunk, 0, chunk.size)
                if (read <= 0) break
                wav.write(chunk, 0, read)
                dataBytes += read
                trackPeak(chunk, read)
                onChunk?.invoke(chunk.copyOf(read))
            }
        } catch (_: Exception) {
            // Whatever bytes landed are still a clip: the header is patched
            // with the count that was actually written, so the file stays
            // honest even when a write fails mid-capture.
        } finally {
            runCatching { record.stop() }
            record.release()
            runCatching {
                WavHeader.write(wav, dataBytes)
                wav.close()
            }
        }
    }

    /** PCM16 little-endian: the low byte first, so the sign lives in chunk[i+1]. */
    private fun trackPeak(chunk: ByteArray, read: Int) {
        var max = 0
        var i = 0
        while (i + 1 < read) {
            val sample = abs((chunk[i + 1].toInt() shl 8) or (chunk[i].toInt() and 0xFF))
            if (sample > max) max = sample
            i += 2
        }
        peak.accumulateAndGet(max) { a, b -> maxOf(a, b) }
    }

    private fun name(): String {
        val stamp = SimpleDateFormat("HH-mm", Locale.SIMPLIFIED_CHINESE).format(Date())
        return "语音 $stamp.wav"
    }

    private companion object {
        /** 40 ms of 16 kHz mono PCM16 — small enough for near-live transcription. */
        const val CHUNK_BYTES = 1_280
        const val STOP_JOIN_MS = 2_000L
    }
}
