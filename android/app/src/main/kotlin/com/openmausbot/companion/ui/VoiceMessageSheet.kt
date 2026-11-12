package com.openmausbot.companion.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
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
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.openmausbot.companion.R
import java.util.Locale
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import androidx.compose.runtime.mutableLongStateOf

/** One minute is the ceiling; the server's own file limit is far above this. */
private const val VOICE_MAX_MS = 60_000L

/** Shorter than this is a mis-tap, not a message — the same rule chat apps use. */
private const val VOICE_MIN_MS = 600L

private const val VOICE_METER_BARS = 28

/**
 * The hold-to-talk surface: press the big button, speak, release to send, slide
 * up to cancel.
 *
 * A dialog rather than a bottom sheet on purpose: a sheet owns its vertical drag
 * for dismissing, and the same drag is this gesture's cancel. Keeping the sheet
 * out of the pointer path is what makes "slide up to cancel" reliable.
 *
 * The recording stops when the screen backgrounds, when the dialog is dismissed,
 * and at one minute. Nothing is left on disk either way.
 */
@Composable
fun VoiceMessageSheet(
    onDismiss: () -> Unit,
    onSend: (VoiceClip) -> Unit,
) {
    val environment = LocalCompanion.current
    val context = LocalContext.current
    val recorder = remember { VoiceRecorder(context) }
    val haptics = rememberHaptics()
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val cancelThreshold = with(density) { 72.dp.toPx() }

    // null while the system permission sheet is up, so the button explains
    // itself instead of silently doing nothing.
    var permission by remember { mutableStateOf<Boolean?>(null) }
    var recording by remember { mutableStateOf(false) }
    var cancelling by remember { mutableStateOf(false) }
    var elapsed by remember { mutableLongStateOf(0L) }
    var levels by remember { mutableStateOf(List(VOICE_METER_BARS) { 0f }) }
    var hint by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        environment.mic.ensure { granted -> permission = granted }
    }

    fun startRecording() {
        if (recording || permission != true) return
        hint = null
        if (!recorder.start()) {
            hint = "无法开始录音，请重试。"
            return
        }
        recording = true
        cancelling = false
        elapsed = 0L
        levels = List(VOICE_METER_BARS) { 0f }
        haptics.play(HapticCue.SELECT)
    }

    fun stopAndSend(cancel: Boolean) {
        if (!recording) return
        recording = false
        cancelling = false
        val duration = recorder.elapsedMs()
        if (cancel || duration < VOICE_MIN_MS) {
            recorder.cancel()
            hint = if (cancel) "已取消" else "说话时间太短"
            return
        }
        scope.launch {
            val clip = recorder.stop()
            if (clip == null) {
                hint = "没有录到声音，请重试。"
            } else {
                onSend(clip)
            }
        }
    }

    // Leaving the screen (or the app) never keeps the microphone open.
    DisposableEffect(Unit) {
        onDispose { recorder.release() }
    }
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) {
                recorder.cancel()
                recording = false
                cancelling = false
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    LaunchedEffect(recording) {
        if (!recording) return@LaunchedEffect
        while (true) {
            delay(80)
            elapsed = recorder.elapsedMs()
            levels = (levels.drop(1) + recorder.level()).takeLast(VOICE_METER_BARS)
            if (elapsed >= VOICE_MAX_MS) {
                stopAndSend(cancel = false)
                break
            }
        }
    }

    fun dismiss() {
        if (recording) {
            recorder.cancel()
            recording = false
        }
        onDismiss()
    }

    val primary = if (cancelling) MinisTokens.Danger else minisInk
    val timer = String.format(Locale.ROOT, "%02d:%02d", elapsed / 1000 / 60, elapsed / 1000 % 60)

    Dialog(
        onDismissRequest = ::dismiss,
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            decorFitsSystemWindows = false,
        ),
    ) {
        Box(modifier = Modifier.fillMaxSize().safeDrawingPadding()) {
            // Scrim. A separate sibling behind the sheet, so a press on the
            // hold button never also means "dismiss".
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.38f))
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        role = Role.Button,
                        onClickLabel = "关闭",
                        onClick = ::dismiss,
                    )
                    // The scrim is a control, not a blank surface: give the
                    // full-screen clickable the name the chat's scrim has.
                    .semantics { contentDescription = "关闭" },
            )

            Column(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .pointerInput(Unit) { detectTapGestures { } }
                    .background(minisPage, RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp))
                    .padding(start = 24.dp, end = 24.dp, top = 16.dp, bottom = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = "语音消息",
                        fontSize = 17.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = minisInk,
                    )
                    Spacer(Modifier.weight(1f))
                    ChromeButton(
                        icon = Icons.Filled.Close,
                        contentDescription = "关闭语音消息",
                        onClick = ::dismiss,
                        size = 40.dp,
                        glyph = 18.dp,
                    )
                }

                Text(
                    text = timer,
                    fontSize = 40.sp,
                    fontWeight = FontWeight.Medium,
                    fontFamily = FontFamily.Monospace,
                    color = if (recording) MinisTokens.Danger else minisInk,
                )

                VoiceLevels(
                    levels = levels,
                    color = if (cancelling) MinisTokens.Danger else minisAccent,
                )

                Text(
                    text = when {
                        permission == false -> "需要麦克风权限才能发送语音消息"
                        permission == null -> "正在请求麦克风权限…"
                        recording && cancelling -> "松开取消"
                        recording -> "上滑取消 · 松开发送"
                        hint != null -> hint!!
                        else -> "按住下方按钮说话，松开发送"
                    },
                    fontSize = 14.sp,
                    color = if (cancelling) MinisTokens.Danger else minisSecondary,
                    maxLines = 1,
                )

                if (permission == false) {
                    TextButton(onClick = {
                        permission = null
                        environment.mic.ensure { granted -> permission = granted }
                    }) {
                        Text("重新授权")
                    }
                } else {
                    // The ring answers the microphone; the inner disc is the
                    // control. Scaling the outer ring is a real level meter,
                    // not a decorative loop.
                    val pulse = if (recording) 1f + levels.last() * 0.08f else 1f
                    Box(
                        modifier = Modifier
                            .size(112.dp)
                            .graphicsLayer {
                                scaleX = pulse
                                scaleY = pulse
                            }
                            .background(
                                if (recording) MinisTokens.Danger.copy(alpha = 0.12f) else minisGrouped,
                                CircleShape,
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        Box(
                            modifier = Modifier
                                .size(88.dp)
                                .background(primary, CircleShape)
                                .pointerInput(permission) {
                                    if (permission != true) return@pointerInput
                                    awaitEachGesture {
                                        val down = awaitFirstDown(requireUnconsumed = false)
                                        down.consume()
                                        startRecording()
                                        var cancel = false
                                        // A pointer that lifts normally sends; one
                                        // that is taken away (system back gesture,
                                        // a call arriving, the window going away)
                                        // must not leave the microphone recording
                                        // forever behind a button nobody is holding.
                                        var released = false
                                        while (true) {
                                            val event = awaitPointerEvent()
                                            val change = event.changes.firstOrNull { it.id == down.id }
                                                ?: break
                                            if (!change.pressed) {
                                                released = true
                                                break
                                            }
                                            change.consume()
                                            val next = down.position.y - change.position.y > cancelThreshold
                                            if (next != cancel) {
                                                cancel = next
                                                cancelling = next
                                                haptics.play(HapticCue.SELECT)
                                            }
                                        }
                                        stopAndSend(cancel = cancel || !released)
                                    }
                                }
                                .semantics {
                                    contentDescription = "按住说话"
                                    // TalkBack cannot hold-and-drag; a double
                                    // tap starts, a second double tap sends.
                                    onClick(label = if (recording) "停止并发送" else "开始录音") {
                                        if (recording) stopAndSend(cancel = false) else startRecording()
                                        true
                                    }
                                },
                            contentAlignment = Alignment.Center,
                        ) {
                            when {
                                permission == null -> CircularProgressIndicator(
                                    modifier = Modifier.size(22.dp),
                                    color = minisPage,
                                    strokeWidth = 2.dp,
                                )
                                cancelling -> Icon(
                                    imageVector = Icons.Filled.Close,
                                    contentDescription = null,
                                    tint = Color.White,
                                    modifier = Modifier.size(30.dp),
                                )
                                else -> Icon(
                                    painter = painterResource(R.drawable.ic_mic),
                                    contentDescription = null,
                                    // The disc is ink: black on the light page,
                                    // white on the dark page. The glyph has to
                                    // be the page colour, not always white.
                                    tint = minisPage,
                                    modifier = Modifier.size(30.dp),
                                )
                            }
                        }
                    }
                }

                Text(
                    text = "最长 60 秒 · 语音会作为音频文件发送给机器人",
                    fontSize = 12.sp,
                    color = minisTertiary,
                )
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
            .height(54.dp)
            .padding(horizontal = 8.dp),
    ) {
        val gap = 3.dp.toPx()
        val barWidth = (size.width - gap * (levels.size - 1)) / levels.size
        val minBar = 3.dp.toPx()
        levels.forEachIndexed { index, level ->
            val height = minBar + (size.height - minBar) * level
            drawRoundRect(
                color = color,
                topLeft = Offset(index * (barWidth + gap), (size.height - height) / 2f),
                size = Size(barWidth, height),
                cornerRadius = CornerRadius(barWidth / 2f, barWidth / 2f),
            )
        }
    }
}
