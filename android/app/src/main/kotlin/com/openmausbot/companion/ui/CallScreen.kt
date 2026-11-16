package com.openmausbot.companion.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.Popup
import com.openmausbot.companion.R
import com.openmausbot.companion.audio.CallSpeaker
import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.Message
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import androidx.compose.runtime.mutableIntStateOf

/**
 * Call mode — the bot on the line, on the phone. The port of
 * `ios/App/CallView.swift`, and deliberately HALF-DUPLEX for the same reason:
 * the microphone is live only while the bot is not speaking. Interrupting is
 * a tap instead.
 *
 * Turn-taking is the silence endpointer in [com.openmausbot.companion.dictation.SpeechDictation.listenForTurn]:
 * the turn ends [CallRules.ENDPOINT_GAP_MILLIS] after the transcript last
 * changed. Waiting is narrated — every activity chip the harness phrases for
 * a voice is read as it lands — so an agent turn of tool calls sounds like
 * someone working rather than a dropped call. Approvals and questions are
 * announced, not answered by voice; answering them happens in the chat.
 */
@Composable
internal fun CallScreen(bot: Bot, onDismiss: () -> Unit) {
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
        phase = CallPhase.LISTENING
        note = null
        if (muted) return
        microphone.listenForTurn(CallRules.ENDPOINT_GAP_MILLIS) { heard ->
            val said = heard.trim()
            if (said.isEmpty()) {
                listen()
            } else {
                phase = CallPhase.SENDING
                scope.launch { session.send(said, Chat.BotChat(current)) }
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

    // The call opens as a floating card over the chat; the handle at its foot
    // (or a pull) grows it into the full screen, and collapsing keeps the call.
    var expanded by remember { mutableStateOf(false) }

    fun toggleMute() {
        muted = !muted
        if (muted) {
            microphone.stop()
        } else if (phase == CallPhase.LISTENING) {
            listen()
        }
    }

    Dialog(
        onDismissRequest = { if (expanded) expanded = false },
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        BackHandler { if (expanded) expanded = false else hangUp() }
        val tint = Color(MausPalette.argb(current.color))
        val pulse = rememberInfiniteTransition(label = "speaking")
        val breathe by pulse.animateFloat(
            initialValue = 1f,
            targetValue = 1.06f,
            animationSpec = infiniteRepeatable(tween(600), RepeatMode.Reverse),
            label = "breathe",
        )
        val (leftIcon, leftLabel, leftEnabled) = Triple(R.drawable.ic_pan_tool, "打断并说话", phase == CallPhase.SPEAKING)
        if (!expanded) {
            CallCard(
                tint = tint,
                bot = current,
                phase = CallRules.phaseText(phase, current.name),
                heard = if (phase == CallPhase.LISTENING) transcript else "",
                spoken = if (phase == CallPhase.SPEAKING) "正在说话…" else "",
                note = note,
                muted = muted,
                onMute = ::toggleMute,
                onClose = ::hangUp,
                onExpand = { expanded = true },
                options = listOf("打断并说话" to ::interrupt),
            )
            return@Dialog
        }
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
                    state = if (phase == CallPhase.SPEAKING) MausState.HAPPY else MausState.forChat(Chat.BotChat(current), messages.lastOrNull()),
                    contentDescription = "${current.name} 头像",
                    modifier = Modifier.graphicsLayer {
                        val scale = if (phase == CallPhase.SPEAKING) breathe else 1f
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
                Text(text = CallRules.phaseText(phase, current.name), fontSize = 17.sp, color = secondaryTint)
                if (transcript.isNotEmpty() && phase == CallPhase.LISTENING) {
                    Text(
                        text = transcript,
                        fontSize = 17.sp,
                        textAlign = TextAlign.Center,
                        maxLines = 4,
                        modifier = Modifier.padding(horizontal = 28.dp),
                    )
                }
                note?.let {
                    Text(
                        text = it,
                        fontSize = 14.sp,
                        color = minisWarning,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(horizontal = 28.dp),
                    )
                }
                Spacer(Modifier.weight(1f))
                Row(
                    horizontalArrangement = Arrangement.spacedBy(40.dp),
                    modifier = Modifier.padding(bottom = 36.dp),
                ) {
                    TouchTarget(
                        onClick = ::interrupt,
                        enabled = leftEnabled,
                        size = 68.dp,
                        contentDescription = leftLabel,
                        modifier = Modifier.graphicsLayer { alpha = if (leftEnabled) 1f else 0.35f },
                    ) {
                        Box(
                            modifier = Modifier
                                .size(68.dp)
                                .background(secondaryTint.copy(alpha = 0.18f), CircleShape),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                painter = painterResource(leftIcon),
                                contentDescription = null,
                                modifier = Modifier.size(30.dp),
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

/**
 * The floating call card, docked at the top of the chat it was opened from.
 * The call keeps running behind it while the transcript reads both ways;
 * the crowned face is the same Luna the home hero wears. The strip at the
 * card's foot is a handle, not a button: pull it down and the card follows
 * the finger — far enough and it grows into the full call screen.
 */
@Composable
internal fun CallCard(
    tint: Color,
    bot: Bot,
    phase: String,
    heard: String,
    spoken: String,
    note: String?,
    muted: Boolean,
    onMute: () -> Unit,
    onClose: () -> Unit,
    onExpand: () -> Unit,
    options: List<Pair<String, () -> Unit>>,
    controlsEnabled: Boolean = true,
) {
    var optionsOpen by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val dragOffset = remember { Animatable(0f) }
    val expandPx = with(density) { 56.dp.toPx() }
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.30f)),
        contentAlignment = Alignment.TopCenter,
    ) {
        Column(
            modifier = Modifier
                .padding(top = 72.dp)
                .graphicsLayer { translationY = dragOffset.value }
                .widthIn(max = 320.dp)
                .fillMaxWidth()
                .padding(horizontal = 28.dp)
                .chromeSheet(cornerRadius = 22.dp, elevation = 14.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 14.dp, end = 14.dp, top = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                PresetBotAvatar(
                    color = "white",
                    size = 40.dp,
                    crown = true,
                    motion = AvatarMotion.BREATH,
                    mood = if (spoken.isNotEmpty()) FaceMood.SPEAKING else FaceMood.IDLE,
                )
                Column(modifier = Modifier.padding(start = 10.dp).weight(1f)) {
                    Text(
                        text = bot.name,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = minisInk,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(text = phase, fontSize = 12.sp, color = minisTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (spoken.isNotEmpty() || heard.isNotEmpty()) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 18.dp)
                        .padding(top = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    if (spoken.isNotEmpty()) {
                        Text(text = spoken, fontSize = 13.sp, color = minisInk, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    if (heard.isNotEmpty()) {
                        Text(text = heard, fontSize = 13.sp, color = minisSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            note?.let {
                Text(
                    text = it,
                    fontSize = 12.sp,
                    color = minisWarning,
                    modifier = Modifier.padding(horizontal = 18.dp).padding(top = 4.dp),
                )
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 6.dp, bottom = 2.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box {
                    TouchTarget(
                        onClick = { optionsOpen = !optionsOpen },
                        size = 44.dp,
                        contentDescription = "语音通话选项",
                    ) {
                        Icon(
                            imageVector = Icons.Filled.Settings,
                            contentDescription = null,
                            modifier = Modifier.size(20.dp),
                            tint = minisSecondary,
                        )
                    }
                    if (optionsOpen) {
                        Popup(
                            alignment = Alignment.TopCenter,
                            offset = IntOffset(0, -140),
                            onDismissRequest = { optionsOpen = false },
                        ) {
                            Column(
                                modifier = Modifier
                                    .widthIn(min = 180.dp)
                                    .chromeSheet(cornerRadius = 16.dp, elevation = 12.dp)
                                    .padding(vertical = 4.dp),
                            ) {
                                (options + ("展开全屏" to onExpand)).forEach { (label, action) ->
                                    Text(
                                        text = label,
                                        fontSize = 15.sp,
                                        color = minisInk,
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .clickable(role = Role.Button) {
                                                optionsOpen = false
                                                action()
                                            }
                                            .padding(horizontal = 16.dp, vertical = 12.dp),
                                    )
                                }
                            }
                        }
                    }
                }
                TouchTarget(
                    onClick = onMute,
                    enabled = controlsEnabled,
                    size = 44.dp,
                    contentDescription = if (muted) "取消静音" else "静音",
                    modifier = Modifier.graphicsLayer { alpha = if (controlsEnabled) 1f else 0.35f },
                ) {
                    Icon(
                        painter = painterResource(R.drawable.ic_mic),
                        contentDescription = null,
                        modifier = Modifier.size(20.dp),
                        tint = if (muted) minisDanger else minisSecondary,
                    )
                }
                TouchTarget(onClick = onClose, size = 44.dp, contentDescription = "结束通话") {
                    Box(
                        modifier = Modifier
                            .size(44.dp)
                            .background(minisDanger, CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            painter = painterResource(R.drawable.ic_call_end),
                            contentDescription = null,
                            tint = Color.White,
                            modifier = Modifier.size(22.dp),
                        )
                    }
                }
            }
            // A pull, not a button: the card tracks the finger down; past the
            // threshold the release grows it into the full call screen.
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 30.dp)
                    .pointerInput(onExpand) {
                        detectVerticalDragGestures(
                            onDragStart = { scope.launch { dragOffset.stop() } },
                            onVerticalDrag = { change, amount ->
                                change.consume()
                                scope.launch {
                                    dragOffset.snapTo((dragOffset.value + amount).coerceAtLeast(0f))
                                }
                            },
                            onDragEnd = {
                                scope.launch {
                                    if (dragOffset.value > expandPx) {
                                        onExpand()
                                        dragOffset.snapTo(0f)
                                    } else {
                                        dragOffset.animateTo(0f, spring(stiffness = Spring.StiffnessMediumLow))
                                    }
                                }
                            },
                            onDragCancel = {
                                scope.launch { dragOffset.animateTo(0f, spring(stiffness = Spring.StiffnessMediumLow)) }
                            },
                        )
                    }
                    .semantics { contentDescription = "下拉展开全屏" },
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    modifier = Modifier
                        .width(28.dp)
                        .height(3.5.dp)
                        .background(minisTertiary.copy(alpha = 0.45f), RoundedCornerShape(2.dp)),
                )
            }
        }
    }
}

@Composable
internal fun CallCollapseButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    TouchTarget(onClick = onClick, size = 40.dp, contentDescription = "收起", modifier = modifier) {
        Box(
            modifier = Modifier
                .size(40.dp)
                .background(minisGrouped, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Icons.Filled.KeyboardArrowDown,
                contentDescription = null,
                tint = secondaryTint,
            )
        }
    }
}
