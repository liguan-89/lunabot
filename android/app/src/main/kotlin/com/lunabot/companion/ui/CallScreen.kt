package com.lunabot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Settings
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import com.lunabot.companion.R
import com.lunabot.companion.audio.CallSpeaker
import com.lunabot.companion.core.Bot
import com.lunabot.companion.core.Chat
import com.lunabot.companion.core.Message
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import androidx.compose.runtime.mutableIntStateOf

/**
 * Call mode — the bot on the line, on the phone. The port of
 * `ios/App/CallView.swift`, and deliberately HALF-DUPLEX for the same reason:
 * the microphone is live only while the bot is not speaking. Interrupting is
 * a tap instead.
 *
 * Turn-taking is the silence endpointer in [com.lunabot.companion.dictation.SpeechDictation.listenForTurn]:
 * the turn ends [CallRules.ENDPOINT_GAP_MILLIS] after the transcript last
 * changed. Waiting is narrated — every activity chip the harness phrases for
 * a voice is read as it lands — so an agent turn of tool calls sounds like
 * someone working rather than a dropped call. Approvals and questions are
 * announced, not answered by voice; answering them happens in the chat.
 */
@Composable
internal fun CallScreen(
    bot: Bot,
    bottomClearance: Dp,
    onDismiss: () -> Unit,
) {
    val environment = LocalCompanion.current
    val session = environment.session
    val microphone = environment.dictation
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val speaker = remember { CallSpeaker(context) }
    val state by session.state.collectAsState()
    val current = state.bot(bot.id) ?: bot
    val messages = remember(state, current.threadId) { state.visibleTranscript(current.threadId) }
    val transcript by microphone.transcript.collectAsState()
    val microphoneError by microphone.error.collectAsState()
    val speaking by speaker.isSpeaking.collectAsState()

    var phase by remember { mutableStateOf(CallPhase.LISTENING) }
    var note by remember { mutableStateOf<String?>(null) }
    // Half-duplex has no open mic to stream over, so "mute" means the
    // listening turn is parked until unmuted.
    var muted by remember { mutableStateOf(false) }
    // Everything already on screen when the call starts has been read or
    // ignored — a call must not open by reciting the backlog.
    val spokenIds = remember { mutableSetOf<String>() }
    val announcedRequests = remember { mutableSetOf<String>() }
    var started by remember { mutableStateOf(false) }
    var sayGeneration by remember { mutableIntStateOf(0) }

    fun listen() {
        phase = if (muted) CallPhase.WORKING else CallPhase.LISTENING
        note = null
        if (muted) return
        microphone.listenForTurn(CallRules.ENDPOINT_GAP_MILLIS) { heard ->
            val said = heard.trim()
            if (said.isEmpty()) {
                listen()
            } else {
                phase = CallPhase.SENDING
                scope.launch {
                    val sent = session.send(said, Chat.BotChat(current))
                    if (!sent) {
                        note = session.actionError ?: "发送失败，请稍后重试。"
                        session.actionError = null
                    }
                }
            }
        }
    }

    /**
     * Speak with the microphone closed, then return whether this call is
     * still the one that asked (an interrupt or hang-up bumps the generation).
     */
    suspend fun say(text: String): Boolean {
        sayGeneration += 1
        val mine = sayGeneration
        phase = CallPhase.SPEAKING
        microphone.stop()
        return try {
            val prepared = session.prepareSpeech(text, current.voice)
            if (!prepared.ready) {
                note = CallRules.noVoiceNote(current.name)
                return sayGeneration == mine
            }
            val clips = ArrayList<ByteArray>(prepared.utterances.size)
            for (utterance in prepared.utterances) {
                if (sayGeneration != mine) return false
                clips += session.speak(utterance, current.voice)
            }
            if (sayGeneration != mine) return false
            speaker.speak(clips) && sayGeneration == mine
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            note = error.message ?: "无法朗读该内容。"
            sayGeneration == mine
        }
    }

    fun sayThenListen(text: String) {
        scope.launch {
            val stillMine = say(text)
            if (stillMine && phase == CallPhase.SPEAKING) listen()
        }
    }

    LaunchedEffect(Unit) {
        if (started) return@LaunchedEffect
        started = true
        spokenIds += messages.map { it.id }
        if (current.busy == true) phase = CallPhase.WORKING else listen()
    }

    LaunchedEffect(messages, current.busy) {
        if (!started) return@LaunchedEffect
        val fresh = messages.filter { it.id !in spokenIds }
        spokenIds += fresh.map { it.id }
        val pendingCard = messages.lastOrNull { it.card?.isPending == true }
        when (val action = CallRules.react(
            name = current.name,
            fresh = fresh,
            pendingCard = pendingCard,
            announced = announcedRequests,
            phase = phase,
            busy = current.busy == true,
            speakerSpeaking = speaking,
        )) {
            is CallAction.Announce -> {
                pendingCard?.card?.requestId?.let { announcedRequests += it }
                sayThenListen(action.text)
            }
            is CallAction.SayReply -> sayThenListen(action.text)
            is CallAction.SayChip -> scope.launch {
                val stillMine = say(action.text)
                if (stillMine && phase == CallPhase.SPEAKING) phase = CallPhase.WORKING
            }
            CallAction.StopListeningAndWork -> {
                microphone.stop()
                phase = CallPhase.WORKING
            }
            CallAction.Listen -> listen()
            CallAction.None -> Unit
        }
    }

    LaunchedEffect(microphoneError) { microphoneError?.let { note = it } }

    fun hangUp() {
        sayGeneration += 1
        microphone.stop()
        speaker.stop()
        onDismiss()
    }

    fun interrupt() {
        if (phase != CallPhase.SPEAKING) return
        sayGeneration += 1
        speaker.stop()
        listen()
    }

    DisposableEffect(Unit) {
        onDispose {
            microphone.stop()
            speaker.stop()
        }
    }

    var expanded by remember { mutableStateOf(false) }
    val lastBotReply = messages.lastOrNull {
        it.role == Message.Role.BOT && it.kind == Message.Kind.TEXT && !it.text.isNullOrBlank()
    }?.text.orEmpty()

    fun toggleMute() {
        muted = !muted
        if (muted) {
            microphone.stop()
        } else if (phase == CallPhase.WORKING || phase == CallPhase.LISTENING) {
            listen()
        }
    }

    CallSurface(
        bot = current,
        expanded = expanded,
        onExpandedChange = { expanded = it },
        phase = if (muted && phase == CallPhase.LISTENING) "已静音" else CallRules.phaseText(phase, current.name),
        heard = if (muted) "" else transcript,
        spoken = when {
            phase == CallPhase.SPEAKING -> lastBotReply
            phase == CallPhase.WORKING -> lastBotReply
            else -> ""
        },
        note = note,
        muted = muted,
        primaryIcon = if (phase == CallPhase.SPEAKING) R.drawable.ic_pan_tool else null,
        primaryLabel = if (phase == CallPhase.SPEAKING) "打断并说话" else null,
        primaryEnabled = phase == CallPhase.SPEAKING,
        controlsEnabled = true,
        bottomClearance = bottomClearance,
        avatarState = when (phase) {
            CallPhase.LISTENING -> MausState.LISTENING
            CallPhase.SENDING, CallPhase.WORKING -> MausState.THINKING
            CallPhase.SPEAKING -> MausState.HAPPY
        },
        onPrimary = ::interrupt,
        onMute = ::toggleMute,
        onHangUp = ::hangUp,
    )
}
