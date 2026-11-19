package com.lunabot.companion.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.lunabot.companion.R
import com.lunabot.companion.core.Bot
import com.lunabot.companion.live.LiveCallController
import kotlinx.coroutines.delay

/**
 * The real-time call: full-duplex audio over `/api/live/relay` while the
 * computer's Live provider speaks the socket transport. Same shell as the
 * half-duplex [CallScreen]; instead of an interrupt button there is a mute
 * one, because the person can simply talk over the bot.
 */
@Composable
internal fun LiveCallScreen(
    bot: Bot,
    bottomClearance: Dp,
    onDismiss: () -> Unit,
) {
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

    // A finished call lets the record row speak: close the card on its own.
    LaunchedEffect(call.state) {
        if (call.state is LiveCallController.State.Ended) {
            delay(1_200)
            onDismiss()
        }
    }

    var expanded by remember { mutableStateOf(false) }
    val live = call.state is LiveCallController.State.Live

    CallSurface(
        bot = current,
        expanded = expanded,
        onExpandedChange = { expanded = it },
        phase = phaseText(call.state, current.name),
        heard = call.heard,
        spoken = if (live) call.caption else "",
        note = (call.state as? LiveCallController.State.Failed)?.message,
        muted = call.muted,
        primaryIcon = if (call.speakerOn) R.drawable.ic_volume_up else R.drawable.ic_volume_off,
        primaryLabel = if (call.speakerOn) "切到听筒" else "切到扬声器",
        primaryEnabled = live,
        controlsEnabled = live,
        bottomClearance = bottomClearance,
        avatarState = if (live) MausState.LISTENING else MausState.IDLE,
        onPrimary = { call.setSpeaker(!call.speakerOn) },
        onMute = { call.mute(!call.muted) },
        onHangUp = ::hangUp,
    )
}

private fun phaseText(state: LiveCallController.State, name: String): String = when (state) {
    LiveCallController.State.Connecting -> "正在接通…"
    LiveCallController.State.Live -> "通话中"
    LiveCallController.State.Ending -> "正在挂断…"
    LiveCallController.State.Ended -> "通话已结束"
    is LiveCallController.State.Failed -> state.message
}
