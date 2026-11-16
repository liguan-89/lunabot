package com.openmausbot.companion.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.openmausbot.companion.R
import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.live.LiveCallController
import kotlinx.coroutines.delay

/**
 * The real-time call: full-duplex audio over `/api/live/relay` while the
 * computer's Live provider speaks the socket transport. Same shell as the
 * half-duplex [CallScreen]; instead of an interrupt button there is a mute
 * one, because the person can simply talk over the bot.
 */
@Composable
internal fun LiveCallScreen(bot: Bot, onDismiss: () -> Unit) {
    val environment = LocalCompanion.current
    val session = environment.session
    val context = LocalContext.current
    val state by session.state.collectAsState()
    val current = state.bot(bot.id) ?: bot
    // The call stays on the thread it was opened from, even if the bot's
    // selected task moves while the screen is up.
    val call = remember(bot.id) {
        LiveCallController(
            context = context,
            session = session,
            botId = bot.id,
            threadId = current.threadId,
            hasRecordAudio = { environment.permissions.recordAudioGranted() },
            requestRecordAudio = { onResult -> environment.mic.ensure(onResult) },
        )
    }

    LaunchedEffect(call) { call.start() }

    // Backgrounding cuts the mic off anyway; ending the call there keeps the
    // record honest instead of leaving a dead line open.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, call) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) call.hangUp()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            call.stop()
        }
    }

    fun hangUp() {
        call.hangUp()
        onDismiss()
    }

    // A finished call lets the record row speak: close the sheet on its own.
    LaunchedEffect(call.state) {
        if (call.state is LiveCallController.State.Ended) {
            delay(1_200)
            onDismiss()
        }
    }

    // Opens as a floating card over the chat; the handle grows it into the
    // full screen. Collapsing keeps the call alive either way.
    var expanded by remember { mutableStateOf(false) }

    Dialog(
        onDismissRequest = { if (expanded) expanded = false },
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        BackHandler { if (expanded) expanded = false else hangUp() }
        val tint = Color(MausPalette.argb(current.color))
        val live = call.state is LiveCallController.State.Live
        if (!expanded) {
            CallCard(
                tint = tint,
                bot = current,
                phase = phaseText(call.state, current.name),
                heard = call.heard,
                spoken = if (live) call.caption else "",
                note = null,
                muted = call.muted,
                onMute = { call.mute(!call.muted) },
                onClose = ::hangUp,
                onExpand = { expanded = true },
                options = listOf(
                    (if (call.speakerOn) "切到听筒" else "切到扬声器") to { call.setSpeaker(!call.speakerOn) },
                ),
                controlsEnabled = live,
            )
            return@Dialog
        }
        val pulse = rememberInfiniteTransition(label = "speaking")
        val breathe by pulse.animateFloat(
            initialValue = 1f,
            targetValue = 1.06f,
            animationSpec = infiniteRepeatable(tween(600), RepeatMode.Reverse),
            label = "breathe",
        )
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.surface)
                .background(tint.copy(alpha = 0.18f))
                .systemBarsPadding(),
        ) {
            // Collapsing back to the card keeps the call; hanging up is the
            // button that says so.
            CallCollapseButton(
                onClick = { expanded = false },
                modifier = Modifier.align(Alignment.TopStart).padding(8.dp),
            )
            Column(
                modifier = Modifier.fillMaxSize(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                Spacer(Modifier.weight(1f))
                BotAvatar(
                    bot = current,
                    size = 160.dp,
                    state = if (live) MausState.HAPPY else MausState.IDLE,
                    contentDescription = "${current.name} 头像",
                    modifier = Modifier.graphicsLayer {
                        val scale = if (live) breathe else 1f
                        scaleX = scale
                        scaleY = scale
                    },
                )
                Text(
                    text = current.name,
                    fontSize = 28.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(text = phaseText(call.state, current.name), fontSize = 17.sp, color = secondaryTint)
                val line = when {
                    call.heard.isNotEmpty() -> call.heard
                    call.caption.isNotEmpty() && live -> call.caption
                    else -> ""
                }
                if (line.isNotEmpty()) {
                    Text(
                        text = line,
                        fontSize = 17.sp,
                        textAlign = TextAlign.Center,
                        maxLines = 4,
                        modifier = Modifier.padding(horizontal = 28.dp),
                    )
                }
                Spacer(Modifier.weight(1f))
                Row(
                    horizontalArrangement = Arrangement.spacedBy(40.dp),
                    modifier = Modifier.padding(bottom = 36.dp),
                ) {
                    TouchTarget(
                        onClick = { call.setSpeaker(!call.speakerOn) },
                        enabled = live,
                        size = 68.dp,
                        contentDescription = if (call.speakerOn) "切到听筒" else "切到扬声器",
                        modifier = Modifier.graphicsLayer { alpha = if (live) 1f else 0.35f },
                    ) {
                        Box(
                            modifier = Modifier
                                .size(68.dp)
                                .background(secondaryTint.copy(alpha = 0.18f), CircleShape),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                painter = painterResource(if (call.speakerOn) R.drawable.ic_volume_up else R.drawable.ic_volume_off),
                                contentDescription = null,
                                modifier = Modifier.size(30.dp),
                            )
                        }
                    }
                    TouchTarget(
                        onClick = { call.mute(!call.muted) },
                        enabled = live,
                        size = 68.dp,
                        contentDescription = if (call.muted) "取消静音" else "静音",
                        modifier = Modifier.graphicsLayer { alpha = if (live) 1f else 0.35f },
                    ) {
                        Box(
                            modifier = Modifier
                                .size(68.dp)
                                .background(secondaryTint.copy(alpha = 0.18f), CircleShape),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                painter = painterResource(R.drawable.ic_mic),
                                contentDescription = null,
                                modifier = Modifier.size(30.dp),
                                tint = if (call.muted) minisDanger else Color.Unspecified,
                            )
                        }
                    }
                    TouchTarget(onClick = ::hangUp, size = 68.dp, contentDescription = "挂断通话") {
                        Box(
                            modifier = Modifier
                                .size(68.dp)
                                .background(minisDanger, CircleShape),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                painter = painterResource(R.drawable.ic_call_end),
                                contentDescription = null,
                                tint = Color.White,
                                modifier = Modifier.size(32.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

private fun phaseText(state: LiveCallController.State, name: String): String = when (state) {
    LiveCallController.State.Connecting -> "正在接通…"
    LiveCallController.State.Live -> "通话中"
    LiveCallController.State.Ending -> "正在挂断…"
    LiveCallController.State.Ended -> "通话已结束"
    is LiveCallController.State.Failed -> state.message
}
