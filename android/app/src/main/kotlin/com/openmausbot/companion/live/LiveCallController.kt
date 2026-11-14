package com.openmausbot.companion.live

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.openmausbot.companion.core.LiveRelay
import com.openmausbot.companion.core.Session
import com.openmausbot.companion.dictation.SpeechDictation
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString

/**
 * One socket-relay Live call: mic → PCM 16 kHz → `/api/live/relay` → provider,
 * provider PCM 24 kHz → speaker. The Android half of the desktop's
 * `openPcmCall`, over the same bearer-authenticated WebSocket the viewer
 * relay already uses.
 *
 * Audio runs on two plain threads — [AudioRecord.read] and [AudioTrack.write]
 * block by design — while the socket's own reader thread feeds the playback
 * queue. Dropping the queue's oldest chunk keeps a slow player from turning
 * into delay. [stop] is idempotent and safe from any thread.
 */
@Stable
internal class LiveCallController(
    context: Context,
    private val session: Session,
    private val botId: String,
    private val threadId: String,
    private val hasRecordAudio: () -> Boolean,
    private val requestRecordAudio: (onResult: (Boolean) -> Unit) -> Unit,
) {
    sealed interface State {
        data object Connecting : State
        data object Live : State
        data object Ending : State
        data object Ended : State
        data class Failed(val message: String) : State
    }

    private val audioManager = context.applicationContext
        .getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val mainHandler = Handler(Looper.getMainLooper())

    var state by mutableStateOf<State>(State.Connecting)
        private set
    /** The bot's live transcript, newest tail only — `caption` on the desktop. */
    var caption by mutableStateOf("")
        private set
    /** What the relay heard the person say, cleared shortly after each line. */
    var heard by mutableStateOf("")
        private set
    var muted by mutableStateOf(false)
        private set
    /** Voice calls default to the loudspeaker; earpiece is opt-in. */
    var speakerOn by mutableStateOf(true)
        private set

    private var socket: WebSocket? = null
    private var recordThread: Thread? = null
    private var playbackThread: Thread? = null
    private var recorder: AudioRecord? = null
    private var player: AudioTrack? = null
    private var focusRequest: AudioFocusRequest? = null
    private var previousMode = AudioManager.MODE_NORMAL
    private var previousSpeakerphone = false
    private var audioActive = false
    @Volatile private var capturing = false
    @Volatile private var playing = false
    @Volatile private var closed = false
    private var started = false
    private val heardClear = Runnable { heard = "" }

    private val playbackQueue = LinkedBlockingQueue<ByteArray>(PLAYBACK_QUEUE_CHUNKS)

    fun start() {
        if (started) return
        started = true
        if (!hasRecordAudio()) {
            requestRecordAudio { granted ->
                if (granted) open() else fail(SpeechDictation.MIC_DENIED_MESSAGE)
            }
            return
        }
        open()
    }

    fun mute(next: Boolean) {
        muted = next
    }

    fun setSpeaker(next: Boolean) {
        speakerOn = next
        if (audioActive) routeAudio(next)
    }

    /** API 31+ ignores isSpeakerphoneOn once a comm device is picked; the
     * explicit device call is what actually reaches the loudspeaker there. */
    private fun routeAudio(on: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (!on) {
                audioManager.clearCommunicationDevice()
                return
            }
            audioManager.availableCommunicationDevices
                .firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                ?.let { audioManager.setCommunicationDevice(it) }
        } else {
            audioManager.isSpeakerphoneOn = on
        }
    }

    /** The red button: say goodbye, then take the audio and socket down. */
    fun hangUp() {
        if (state !is State.Live && state !is State.Connecting) return
        Log.d(TAG, "hangUp from $state")
        state = State.Ending
        val ws = socket
        runCatching { ws?.send(LiveRelay.END_MESSAGE) }
        releaseAudio()
        runCatching { ws?.close(1000, null) }
    }

    /** Screen gone: same teardown as hanging up, without a goodbye to send. */
    fun stop() {
        if (closed) return
        Log.d(TAG, "stop from $state")
        closed = true
        mainHandler.removeCallbacks(heardClear)
        releaseAudio()
        runCatching { socket?.close(1000, null) }
        socket = null
    }

    private fun open() {
        if (closed) return
        val opened = session.openLiveCallSocket(botId, threadId, RelayListener())
        if (opened == null) {
            fail("无法连接到此电脑。")
            return
        }
        socket = opened
    }

    private fun onEvent(event: LiveRelay.Event) {
        when (event) {
            is LiveRelay.Event.Ready -> {
                state = State.Live
                startAudio()
            }
            is LiveRelay.Event.Transcript -> {
                if (event.user) {
                    heard = (heard + event.delta).takeLast(HEARD_CHARS)
                    mainHandler.removeCallbacks(heardClear)
                    mainHandler.postDelayed(heardClear, HEARD_CLEAR_MILLIS)
                } else {
                    caption = (caption + event.delta).takeLast(CAPTION_CHARS)
                }
            }
            is LiveRelay.Event.Named -> {
                // The relay emits "interrupted" on barge-in: drop every queued and
                // in-flight PCM frame so the assistant cannot talk over the person.
                if (event.name == "interrupted") flushPlayback()
            }
            is LiveRelay.Event.Failure -> {
                Log.w(TAG, "relay failure: ${event.message}")
                fail(event.message)
            }
            LiveRelay.Event.End -> {
                Log.i(TAG, "relay end")
                runCatching { socket?.close(1000, null) }
            }
        }
    }

    private fun startAudio() {
        previousMode = audioManager.mode
        previousSpeakerphone = audioManager.isSpeakerphoneOn
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setOnAudioFocusChangeListener { change ->
                Log.d(TAG, "audio focus change $change")
                // A ping or navigation cue steals focus only for a moment; a
                // voice call rides those out and ends only on a lasting loss.
                if (change == AudioManager.AUDIOFOCUS_LOSS) hangUp()
            }
            .build()
        if (audioManager.requestAudioFocus(request) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            fail("无法取得音频焦点。")
            runCatching { socket?.close(1000, null) }
            return
        }
        focusRequest = request
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        routeAudio(speakerOn)
        audioActive = true

        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setSampleRate(LiveRelay.OUTPUT_HZ)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build(),
            )
            .setBufferSizeInBytes(playbackBufferBytes())
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        player = track
        playing = true
        playbackThread = thread(name = "live-call-playback", isDaemon = true) {
            track.play()
            try {
                while (playing) {
                    val data = playbackQueue.poll(200, TimeUnit.MILLISECONDS) ?: continue
                    track.write(data, 0, data.size)
                }
            } finally {
                runCatching { track.stop() }
                track.release()
            }
        }

        val record = openRecorder() ?: run {
            fail(SpeechDictation.START_FAILED_MESSAGE)
            runCatching { socket?.close(1000, null) }
            return
        }
        recorder = record
        capturing = true
        recordThread = thread(name = "live-call-capture", isDaemon = true) {
            val chunk = ByteArray(CAPTURE_CHUNK_BYTES)
            runCatching { record.startRecording() }
            try {
                while (capturing) {
                    val read = record.read(chunk, 0, chunk.size)
                    if (read <= 0) break
                    if (!muted && !closed) {
                        socket?.send(chunk.copyOf(read).toByteString())
                    }
                }
            } finally {
                runCatching { record.stop() }
                record.release()
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun openRecorder(): AudioRecord? {
        val bufferBytes = captureBufferBytes()
        for (source in listOf(MediaRecorder.AudioSource.VOICE_COMMUNICATION, MediaRecorder.AudioSource.MIC)) {
            val record = runCatching {
                AudioRecord(
                    source,
                    LiveRelay.INPUT_HZ,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    bufferBytes,
                )
            }.getOrNull() ?: continue
            if (record.state == AudioRecord.STATE_INITIALIZED) return record
            record.release()
        }
        return null
    }

    private fun flushPlayback() {
        playbackQueue.clear()
        player?.let { track ->
            runCatching {
                track.pause()
                track.flush()
                track.play()
            }
        }
    }

    private fun releaseAudio() {
        capturing = false
        playing = false
        recorder = null
        player = null
        playbackQueue.clear()
        if (audioActive) {
            audioActive = false
            audioManager.mode = previousMode
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                audioManager.clearCommunicationDevice()
            } else {
                audioManager.isSpeakerphoneOn = previousSpeakerphone
            }
        }
        focusRequest?.let { runCatching { audioManager.abandonAudioFocusRequest(it) } }
        focusRequest = null
    }

    private fun fail(message: String) {
        if (closed) return
        releaseAudio()
        state = State.Failed(message.ifBlank { "通话连接失败。" })
    }

    private fun finish() {
        if (closed) return
        releaseAudio()
        if (state !is State.Failed) state = State.Ended
    }

    private inner class RelayListener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            Log.d(TAG, "socket open")
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            if (closed) return
            val data = bytes.toByteArray()
            if (data.isNotEmpty() && !playbackQueue.offer(data)) {
                playbackQueue.poll()
                playbackQueue.offer(data)
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (closed) return
            LiveRelay.decodeEvent(text)?.let(::onEvent)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            Log.i(TAG, "socket closing $code $reason")
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            Log.i(TAG, "socket closed $code $reason")
            finish()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.w(TAG, "socket failure ${response?.code ?: "-"}", t)
            if (closed) return
            fail(t.message?.takeIf { it.isNotBlank() } ?: "通话连接失败。")
        }
    }

    private companion object {
        const val TAG = "LiveCall"
        /** 20 ms of 16 kHz mono PCM16 — small enough to keep mouth-to-wire latency low. */
        const val CAPTURE_CHUNK_BYTES = 640
        /** Provider audio bursts can be minutes of PCM; dropping the oldest mid-utterance
         * skips speech and desyncs the server's playback clock. Stale backlogs are cleared
         * by the "interrupted" flush instead of the bound. */
        const val PLAYBACK_QUEUE_CHUNKS = 4096
        const val CAPTION_CHARS = 240
        const val HEARD_CHARS = 160
        const val HEARD_CLEAR_MILLIS = 2_500L

        fun captureBufferBytes(): Int {
            val minimum = AudioRecord.getMinBufferSize(
                LiveRelay.INPUT_HZ,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
            )
            return maxOf(minimum, CAPTURE_CHUNK_BYTES * 4)
        }

        fun playbackBufferBytes(): Int {
            val minimum = AudioTrack.getMinBufferSize(
                LiveRelay.OUTPUT_HZ,
                AudioFormat.CHANNEL_OUT_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
            )
            return maxOf(minimum, 4_800)
        }
    }
}
