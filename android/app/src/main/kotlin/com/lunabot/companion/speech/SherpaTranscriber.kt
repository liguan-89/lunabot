package com.lunabot.companion.speech

import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig

/**
 * Streaming on-device transcription for one voice clip at a time.
 *
 * The recognizer is built lazily — the first construction loads the onnx
 * runtime and the three model files, which costs a few hundred milliseconds,
 * so callers run [ensureEngine] off the main thread ahead of the hold. One
 * recording owns the stream at a time: [begin] refuses a second while one is
 * open, and every public method takes [lock] so the capture consumer and the
 * sheet's stop path can never interleave inside native code.
 */
class SherpaTranscriber(private val models: ModelManager) {
    private val lock = Any()
    private var recognizer: OnlineRecognizer? = null
    private var stream: OnlineStream? = null

    /** Whole utterances the endpoint detector has already closed. */
    private val segments = StringBuilder()

    /** The still-open utterance's latest partial, deduplicated. */
    private var partial = ""
    private var onPartial: ((String) -> Unit)? = null

    /** True once the native engine is up; false when the model is absent or broken. */
    fun ensureEngine(): Boolean = synchronized(lock) {
        if (recognizer != null) return@synchronized true
        val resolved = models.resolved() ?: return@synchronized false
        try {
            recognizer = OnlineRecognizer(config = recognizerConfig(resolved))
            true
        } catch (_: Throwable) {
            false
        }
    }

    /**
     * Open a stream for one clip. [onPartial] receives the accumulated text —
     * closed segments plus the live partial — on the thread [accept] runs on.
     */
    fun begin(onPartial: (String) -> Unit): Boolean = synchronized(lock) {
        val engine = recognizer ?: return@synchronized false
        if (stream != null) return@synchronized false
        stream = runCatching { engine.createStream() }.getOrNull() ?: return@synchronized false
        segments.clear()
        partial = ""
        this.onPartial = onPartial
        true
    }

    /** Feed one little-endian PCM16 block at [SAMPLE_RATE]; called on a single-thread consumer. */
    fun accept(pcm: ByteArray) {
        synchronized(lock) {
            val engine = recognizer ?: return
            val stream = stream ?: return
            val count = pcm.size / 2
            val samples = FloatArray(count) { i ->
                val lo = pcm[2 * i].toInt() and 0xFF
                val hi = pcm[2 * i + 1].toInt()
                ((hi shl 8) or lo).toShort() / 32_768f
            }
            stream.acceptWaveform(samples, SAMPLE_RATE)
            while (engine.isReady(stream)) engine.decode(stream)
            if (engine.isEndpoint(stream)) {
                closeSegment(engine, stream)
                engine.reset(stream)
            }
            val now = engine.getResult(stream).text.trim()
            if (now != partial) {
                partial = now
                onPartial?.invoke(heard())
            }
        }
    }

    /** Stop feeding, flush the decoder, and take the final text. */
    fun finish(): String {
        synchronized(lock) {
            val engine = recognizer
            val stream = stream
            this.stream = null
            val text = if (engine != null && stream != null) {
                try {
                    stream.inputFinished()
                    while (engine.isReady(stream)) engine.decode(stream)
                    closeSegment(engine, stream)
                    segments.toString()
                } finally {
                    runCatching { stream.release() }
                }
            } else {
                ""
            }
            clear()
            return text
        }
    }

    /** Abandon the open stream without reading a result (cancel / lifecycle stop). */
    fun cancel() {
        synchronized(lock) {
            stream?.let { runCatching { it.release() } }
            stream = null
            clear()
        }
    }

    /** Free the native engine too; the sheet calls this when it leaves composition. */
    fun release() {
        synchronized(lock) {
            cancel()
            recognizer?.let { runCatching { it.release() } }
            recognizer = null
        }
    }

    private fun closeSegment(engine: OnlineRecognizer, stream: OnlineStream) {
        val text = engine.getResult(stream).text.trim()
        if (text.isNotEmpty()) {
            if (segments.isNotEmpty()) segments.append(' ')
            segments.append(text)
        }
        partial = ""
    }

    private fun heard(): String =
        if (segments.isEmpty()) partial
        else if (partial.isEmpty()) segments.toString()
        else "$segments $partial"

    private fun clear() {
        segments.clear()
        partial = ""
        onPartial = null
    }

    private fun recognizerConfig(resolved: ModelManager.Resolved): OnlineRecognizerConfig =
        OnlineRecognizerConfig(
            featConfig = FeatureConfig(sampleRate = SAMPLE_RATE, featureDim = 80),
            modelConfig = OnlineModelConfig(
                transducer = OnlineTransducerModelConfig(
                    encoder = resolved.encoder.absolutePath,
                    decoder = resolved.decoder.absolutePath,
                    joiner = resolved.joiner.absolutePath,
                ),
                tokens = resolved.tokens.absolutePath,
                numThreads = 2,
                provider = "cpu",
                // zipformer-zh-14M is a first-generation transducer: setting
                // "zipformer2" makes the native loader demand metadata the
                // model does not carry, and its failure path exits the
                // process outright — there is no Java-side error to catch.
                modelType = "zipformer",
                modelingUnit = "cjkchar",
            ),
            enableEndpoint = true,
            decodingMethod = "greedy_search",
        )

    private companion object {
        const val SAMPLE_RATE = 16_000
    }
}
