package com.lunabot.companion.ui

import android.content.Context
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.R
import com.lunabot.companion.speech.SherpaTranscriber
import com.lunabot.companion.storage.VoiceAsrMode
import java.util.Locale
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** One minute is the ceiling; the server's own file limit is far above this. */
private const val VOICE_MAX_MS = 60_000L

/** Shorter than this is a mis-tap, not a message — the same rule chat apps use. */
private const val VOICE_MIN_MS = 600L

private const val VOICE_METER_BARS = 28

/**
 * The recording half of a voice message, owned by the chat rather than by the
 * card that shows it. Splitting it off is what lets one press gesture feed two
 * flows: the card is open before the finger decides whether this is a tap or a
 * hold, and either outcome talks to the same capture.
 *
 * Tap: the press releases early, the card stays up and keeps recording until
 * the person presses send. Hold: the press outlives the long-press threshold,
 * the release sends and the card is gone. Either way the recorder, the PCM
 * feed into sherpa, the level meter and the transcription fallback live here.
 */
internal class VoiceCapture(
    context: Context,
    private val environment: CompanionEnvironment,
    private val scope: CoroutineScope,
    private val haptics: Haptics,
    private val onResult: (clip: VoiceClip, transcript: String) -> Unit,
) {
    private val recorder = VoiceRecorder(context)
    // The phone-side recognizer: fed the same PCM the recorder writes, so it
    // needs no second microphone client.
    private val sherpa = SherpaTranscriber(environment.speechModels)
    private val asrMode: VoiceAsrMode
        get() = environment.chatPreferences.voiceAsrMode.value

    // null while the system permission sheet is up, so the card explains
    // itself instead of silently doing nothing.
    var permission by mutableStateOf<Boolean?>(null)
    var recording by mutableStateOf(false)
        private set
    var transcribing by mutableStateOf(false)
        private set
    var elapsed by mutableLongStateOf(0L)
        private set
    var levels by mutableStateOf(List(VOICE_METER_BARS) { 0f })
        private set
    var heard by mutableStateOf("")
        private set
    var hint by mutableStateOf<String?>(null)
        private set
    /** Slide-up-to-cancel during a hold; the card reads it to go red. */
    var cancelling by mutableStateOf(false)
    /** The recognizer ran once; loaded lazily on the first capture. */
    private var engineWarmed = false

    private val pcmChunks = AtomicReference<Channel<ByteArray>?>(null)
    private val pcmJob = AtomicReference<Job?>(null)
    private var meterJob: Job? = null

    /** Load the native engine before the hold, not during it. */
    fun warmUp() {
        if (engineWarmed) return
        engineWarmed = true
        if (asrMode == VoiceAsrMode.DEVICE && environment.speechModels.isReady()) {
            scope.launch(Dispatchers.Default) { sherpa.ensureEngine() }
        }
    }

    /** Asks permission if needed, then records. Safe to call repeatedly. */
    fun begin() {
        if (recording || transcribing) return
        if (permission != true) {
            environment.mic.ensure { granted ->
                permission = granted
                if (granted) start()
            }
            return
        }
        start()
    }

    private fun start() {
        if (recording || transcribing) return
        hint = null
        heard = ""
        val chunks = Channel<ByteArray>(Channel.UNLIMITED)
        if (!recorder.start(onChunk = { pcm -> chunks.trySend(pcm) })) {
            hint = "无法开始录音，请重试。"
            return
        }
        // 模型未就绪时端侧退化为在线：本次录音按 online 处理。
        val wantDevice = asrMode == VoiceAsrMode.DEVICE && environment.speechModels.isReady()
        if (wantDevice && sherpa.begin(onPartial = { text -> heard = text })) {
            pcmChunks.set(chunks)
            pcmJob.set(
                scope.launch(Dispatchers.Default) {
                    for (chunk in chunks) sherpa.accept(chunk)
                },
            )
        } else {
            chunks.close()
        }
        recording = true
        cancelling = false
        elapsed = 0L
        levels = List(VOICE_METER_BARS) { 0f }
        haptics.play(HapticCue.SELECT)
        meterJob?.cancel()
        meterJob = scope.launch {
            while (recording) {
                delay(80)
                elapsed = recorder.elapsedMs()
                levels = (levels.drop(1) + recorder.level()).takeLast(VOICE_METER_BARS)
                if (elapsed >= VOICE_MAX_MS) {
                    finish(cancel = false)
                    break
                }
            }
        }
    }

    private fun stopPcm() {
        pcmChunks.getAndSet(null)?.close()
        pcmJob.getAndSet(null)?.cancel()
        sherpa.cancel()
    }

    /** Stops and delivers the clip, or abandons it on cancel / too short. */
    fun finish(cancel: Boolean) {
        if (!recording) return
        recording = false
        cancelling = false
        meterJob?.cancel()
        val duration = recorder.elapsedMs()
        if (cancel || duration < VOICE_MIN_MS) {
            recorder.cancel()
            stopPcm()
            hint = if (cancel) "已取消" else "说话时间太短"
            return
        }
        scope.launch {
            val clip = recorder.stop()
            if (clip == null) {
                stopPcm()
                hint = "没有录到声音，请重试。"
                return@launch
            }
            pcmChunks.getAndSet(null)?.close()
            pcmJob.getAndSet(null)?.join()
            var transcript = withContext(Dispatchers.Default) { sherpa.finish() }.trim()
            // One fallback covers every path that produced no words: online
            // mode, a device model that was not downloaded in time, or sherpa
            // hearing nothing. Off stays audio-only by definition.
            if (transcript.isEmpty() && asrMode != VoiceAsrMode.OFF) {
                transcribing = true
                transcript = environment.session.transcribeVoice(clip.data).orEmpty()
                transcribing = false
            }
            onResult(clip, transcript)
        }
    }

    /** Abandons whatever is in flight; the card calls this on its way out. */
    fun cancel() {
        if (recording) {
            recording = false
            cancelling = false
            meterJob?.cancel()
            recorder.cancel()
        }
        stopPcm()
    }

    fun release() {
        cancel()
        recorder.release()
        sherpa.release()
    }
}

/**
 * The floating voice card: a compact recorder that hovers over the transcript
 * instead of taking the screen. [hold] is true while the finger that opened it
 * is still down — the card then just narrates ("release to send, slide up to
 * cancel"); once released into tap mode it carries the send and cancel buttons
 * itself.
 */
@Composable
internal fun VoiceCard(
    capture: VoiceCapture,
    hold: Boolean,
    onClose: () -> Unit,
) {
    val timer = String.format(Locale.ROOT, "%02d:%02d", capture.elapsed / 1000 / 60, capture.elapsed / 1000 % 60)
    Box(modifier = Modifier.fillMaxSize()) {
        if (!hold) {
            // In tap mode the card is the only recorder control on screen, so
            // tapping the dimmed space around it cancels like a sheet would.
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.24f))
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        role = Role.Button,
                        onClickLabel = "取消",
                        onClick = onClose,
                    )
                    .semantics { contentDescription = "取消" },
            )
        }
        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .padding(start = 16.dp, end = 16.dp, bottom = 96.dp)
                .chromeSheet(cornerRadius = 24.dp, elevation = 14.dp)
                .padding(start = 20.dp, end = 20.dp, top = 16.dp, bottom = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "语音消息",
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = minisInk,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    text = timer,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.Medium,
                    fontFamily = FontFamily.Monospace,
                    color = if (capture.recording) MinisTokens.Danger else minisInk,
                )
            }

            VoiceLevels(
                levels = capture.levels,
                color = if (capture.cancelling) MinisTokens.Danger else minisAccent,
            )

            if (capture.recording && capture.heard.isNotEmpty()) {
                Text(
                    text = capture.heard,
                    fontSize = 14.sp,
                    color = minisInk,
                    maxLines = 2,
                )
            }

            Text(
                text = when {
                    capture.permission == false -> "需要麦克风权限才能发送语音消息"
                    capture.permission == null -> "正在请求麦克风权限…"
                    capture.transcribing -> "正在转写…"
                    capture.recording && capture.cancelling -> "松开取消"
                    hold -> "上滑取消 · 松开发送"
                    capture.recording -> "说完点发送"
                    capture.hint != null -> capture.hint!!
                    else -> "正在准备录音…"
                },
                fontSize = 13.sp,
                color = if (capture.cancelling) MinisTokens.Danger else minisSecondary,
                maxLines = 1,
            )

            when {
                capture.permission == false -> {
                    TextButton(onClick = {
                        capture.permission = null
                        capture.begin()
                    }) {
                        Text("重新授权")
                    }
                }
                !hold -> {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        TouchTarget(
                            onClick = onClose,
                            size = 48.dp,
                            contentDescription = "取消语音消息",
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(48.dp)
                                    .background(minisGrouped, CircleShape),
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(
                                    imageVector = Icons.Filled.Close,
                                    contentDescription = null,
                                    tint = minisInk,
                                    modifier = Modifier.size(22.dp),
                                )
                            }
                        }
                        TouchTarget(
                            onClick = { capture.finish(cancel = false) },
                            enabled = capture.recording,
                            size = 48.dp,
                            contentDescription = "发送语音消息",
                            modifier = Modifier.semantics(mergeDescendants = true) {},
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(48.dp)
                                    .background(
                                        if (capture.recording) minisInk else minisGrouped,
                                        CircleShape,
                                    ),
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(
                                    imageVector = Icons.AutoMirrored.Filled.Send,
                                    contentDescription = null,
                                    tint = if (capture.recording) minisPage else minisTertiary,
                                    modifier = Modifier.size(20.dp),
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/** The rolling level history: one bar per 80 ms of capture. */
@Composable
private fun VoiceLevels(levels: List<Float>, color: Color) {
    Canvas(
        modifier = Modifier
            .fillMaxWidth()
            .height(40.dp),
    ) {
        if (levels.isEmpty()) return@Canvas
        val barWidth = 3.dp.toPx()
        val gap = 4.dp.toPx()
        val total = levels.size * barWidth + (levels.size - 1) * gap
        var x = (size.width - total) / 2f
        val centerY = size.height / 2f
        for (level in levels) {
            val barHeight = (4.dp.toPx() + level * (size.height - 8.dp.toPx()))
            drawRoundRect(
                color = color,
                topLeft = Offset(x, centerY - barHeight / 2f),
                size = Size(barWidth, barHeight),
                cornerRadius = CornerRadius(barWidth / 2f),
            )
            x += barWidth + gap
        }
    }
}
