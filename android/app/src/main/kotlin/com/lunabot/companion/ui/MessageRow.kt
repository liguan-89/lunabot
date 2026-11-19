package com.lunabot.companion.ui

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.util.Base64
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import com.lunabot.companion.R
import com.lunabot.companion.core.Chat
import com.lunabot.companion.core.ConnectorCardAction
import com.lunabot.companion.core.ConnectorCardData
import com.lunabot.companion.core.GroupGoalRunCardData
import com.lunabot.companion.core.LiveCallRecord
import com.lunabot.companion.core.RoutineRunCardData
import com.lunabot.companion.core.SignInCardAction
import com.lunabot.companion.core.SecretCardAction
import com.lunabot.companion.core.SecretRequestCardData
import com.lunabot.companion.core.AttachedMessageContent
import com.lunabot.companion.core.fileAttachments
import com.lunabot.companion.core.generatedImages
import com.lunabot.companion.core.voiceNotes
import com.lunabot.companion.core.DisplayedMessageAttachment
import com.lunabot.companion.core.DownloadedFile
import com.lunabot.companion.core.Message
import com.lunabot.companion.core.OptionCard
import com.lunabot.companion.core.ThreadRef
import com.lunabot.companion.core.ToolActivity
import com.lunabot.companion.core.forTask
import com.lunabot.companion.core.TranscriptCard
import com.lunabot.companion.core.TranscriptCards
import com.lunabot.companion.core.webhookContent
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.min

/** What the clipboard shows this came from. */
private const val MESSAGE_CLIP_LABEL = "Luna Bot message"

/**
 * One row of the transcript — the port of `MessageRow` in `ios/App/ChatView.swift`.
 *
 * [startsRun] and [endsRun] are the two ends of a run of bubbles from the same
 * side. [TranscriptLayout] decides both, over the whole transcript, so a row
 * never has to look at its neighbours; the pair is what lets a bubble round only
 * the corners that face the page, with the ones touching a neighbour tucked in.
 */
@Composable
fun MessageRow(
    chat: Chat,
    message: Message,
    startsRun: Boolean = true,
    endsRun: Boolean = true,
    /** Where a tapped link in a bot reply goes; null leaves it to the system. */
    openLink: ((String, Message) -> Unit)? = null,
    /** Open one exact user attachment through the authenticated computer route. */
    openAttachment: ((DisplayedMessageAttachment, Message, DownloadedFile?) -> Unit)? = null,
    /** Where an "Opened thread" chip goes; null leaves the chip a receipt. */
    openThread: ((ThreadRef) -> Unit)? = null,
    /**
     * Where a tapped screenshot goes: the bot's live computer. Null leaves the
     * still inert, which is what rooms and non-bot transcripts get — a screen
     * belongs to one bot, and there is no second bot to open.
     */
    openComputer: (() -> Unit)? = null,
    /** Quote this message into the composer; null hides the action. */
    onQuote: ((Message) -> Unit)? = null,
) {
    val session = LocalCompanion.current.session
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    val state by session.state.collectAsState()
    val clipboard = LocalClipboard.current
    var menuOpen by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf(false) }
    var editText by remember { mutableStateOf("") }
    var selectingText by remember { mutableStateOf<String?>(null) }

    val bot = (chat as? Chat.BotChat)?.bot
    val versions = remember(state, message.id) { state.versions(message, chat.threadId) }
    val versionIndex = versions.indexOfFirst { it.id == message.id }
    // The stand-in for an edit the computer has not answered yet. It has no
    // server identity, so nothing may react to it or edit it again.
    val editPending = state.pendingEdits[chat.threadId]
    val isPendingEdit = editPending?.placeholderId == message.id
    val mine = message.role == Message.Role.USER

    Box(
        modifier = Modifier
            .fillMaxWidth()
            // Long-press is the context menu; a plain tap must stay inert, so no
            // ripple is drawn for it.
            .combinedClickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                // TalkBack has to be told what the hold does; "double-tap and
                // hold" with no label is an unnamed action.
                onLongClickLabel = "消息操作",
                onLongClick = { menuOpen = true },
                onClick = {},
            )
            // The row is a long-press target, not a button with a name of its
            // own. Merging keeps its message text as the announcement while the
            // hold action stays available; nested links and reactions remain
            // separate targets.
            .semantics(mergeDescendants = true) {},
    ) {
        Column(
            modifier = Modifier.fillMaxWidth(),
            horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            MessageContent(
                chat = chat,
                message = message,
                startsRun = startsRun,
                endsRun = endsRun,
                haptics = haptics,
                openLink = openLink,
                openAttachment = openAttachment,
                openThread = openThread,
                openComputer = openComputer,
            )

            message.comm?.let {
                Text(
                    text = "已向 ${it.withName} 发送消息",
                    fontSize = 12.sp,
                    color = secondaryTint,
                )
            }

            message.reactions?.takeIf { it.isNotEmpty() }?.let { reactions ->
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Reactions.group(reactions).forEach { group ->
                        val tint = if (group.mine) {
                            MaterialTheme.colorScheme.primary
                        } else {
                            secondaryTint
                        }
                        // The capsule is 28 dp tall; the target is 48 dp. The
                        // outer box owns the tap and the semantics, the inner
                        // Text keeps the pill exactly where the design put it.
                        Box(
                            modifier = Modifier
                                .heightIn(min = 48.dp)
                                .clickable(
                                    role = Role.Button,
                                    onClickLabel = if (group.mine) "移除回应" else "回应",
                                ) {
                                    haptics.play(TactileAction.TOGGLE_REACTION)
                                    scope.launch {
                                        session.react(message, chat.threadId, group.emoji)
                                    }
                                }
                                .semantics {
                                    stateDescription = if (group.mine) "已回应" else "未回应"
                                },
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                text = "${group.emoji} ${group.count}",
                                fontSize = 13.sp,
                                color = tint,
                                modifier = Modifier
                                    .border(1.dp, tint.copy(alpha = 0.5f), CircleShape)
                                    .padding(horizontal = 10.dp, vertical = 3.dp),
                            )
                        }
                    }
                }
            }

            // Versions are a bot idea: a room has no branch to switch (§12).
            if (versions.size > 1 && versionIndex >= 0 && bot != null) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    val busy = bot.busy == true
                    TouchTarget(
                        onClick = {
                            scope.launch {
                                session.switchVersion(versions[versionIndex - 1], bot)
                            }
                        },
                        size = 20.dp,
                        enabled = versionIndex > 0 && !busy,
                        contentDescription = "上一版本",
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.KeyboardArrowLeft,
                            contentDescription = null,
                            tint = if (versionIndex == 0 || busy) {
                                secondaryTint.copy(alpha = 0.4f)
                            } else {
                                secondaryTint
                            },
                            modifier = Modifier.size(20.dp),
                        )
                    }
                    Text(
                        text = "${versionIndex + 1} / ${versions.size}",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                        color = secondaryTint,
                    )
                    TouchTarget(
                        onClick = {
                            scope.launch {
                                session.switchVersion(versions[versionIndex + 1], bot)
                            }
                        },
                        size = 20.dp,
                        enabled = versionIndex + 1 < versions.size && !busy,
                        contentDescription = "下一版本",
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                            contentDescription = null,
                            tint = if (versionIndex + 1 >= versions.size || busy) {
                                secondaryTint.copy(alpha = 0.4f)
                            } else {
                                secondaryTint
                            },
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
            }
        }

        if (menuOpen) {
            // The long-press menu is chrome, not a list: the same frosted glass
            // card the composer's `+` sheet draws, anchored over the message.
            Popup(
                alignment = Alignment.Center,
                onDismissRequest = { menuOpen = false },
                properties = PopupProperties(focusable = true),
            ) {
                Column(
                    modifier = Modifier
                        .widthIn(min = 190.dp, max = 250.dp)
                        .chromeSheet(cornerRadius = 18.dp, elevation = 14.dp)
                        .padding(vertical = 6.dp),
                ) {
                    if (!isPendingEdit) {
                        Row(modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp)) {
                            Reactions.CHOICES.forEach { emoji ->
                                TouchTarget(
                                    onClick = {
                                        menuOpen = false
                                        haptics.play(TactileAction.TOGGLE_REACTION)
                                        scope.launch { session.react(message, chat.threadId, emoji) }
                                    },
                                    size = 40.dp,
                                    contentDescription = "用 $emoji 回应",
                                ) {
                                    Text(text = emoji, fontSize = 22.sp)
                                }
                            }
                        }
                    }
                    MessageActions.copyableText(message)?.let { text ->
                        MessageMenuDivider()
                        MessageMenuRow(
                            title = "复制",
                            onClick = {
                                menuOpen = false
                                scope.launch {
                                    clipboard.setClipEntry(
                                        ClipEntry(ClipData.newPlainText(MESSAGE_CLIP_LABEL, text)),
                                    )
                                }
                            },
                        )
                        MessageMenuRow(
                            title = "选择文本",
                            onClick = {
                                menuOpen = false
                                selectingText = text
                            },
                        )
                        if (onQuote != null) {
                            MessageMenuRow(
                                title = "引用回复",
                                onClick = {
                                    menuOpen = false
                                    haptics.play(HapticCue.SELECT)
                                    onQuote(message)
                                },
                            )
                        }
                    }
                    // Attachment messages cannot be reconstructed by a text-only edit.
                    // The policy also keeps their private transport paths out of the UI.
                    val editableText = MessageActions.editableText(message)
                    if (editableText != null && bot != null && !isPendingEdit) {
                        MessageMenuDivider()
                        MessageMenuRow(
                            title = "编辑并重试",
                            enabled = bot.busy != true && editPending == null,
                            onClick = {
                                menuOpen = false
                                editText = editableText
                                editing = true
                            },
                        )
                    }
                }
            }
        }
    }

    if (editing && bot != null) {
        AlertDialog(
            onDismissRequest = { editing = false },
            containerColor = minisCanvas,
            title = { Text("编辑并重试") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("这将创建一个新版本并从此处继续对话。", fontSize = 14.sp)
                    MinisSheetField(
                        value = editText,
                        onValueChange = { editText = it },
                        placeholder = "消息",
                        singleLine = false,
                        minLines = 2,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            },
            confirmButton = {
                TextButton(
                    // `bot` is re-read from the collected state on every frame,
                    // so a bot that starts running while this dialog is open
                    // disables Send rather than sending an edit the harness will
                    // refuse with 409.
                    enabled = bot.busy != true && editText.isNotBlank(),
                    onClick = {
                        val text = editText.trim()
                        editing = false
                        if (text.isEmpty()) return@TextButton
                        scope.launch { session.edit(message, bot, text) }
                    },
                ) { Text("发送") }
            },
            dismissButton = {
                TextButton(onClick = { editing = false }) { Text("取消") }
            },
        )
    }

    selectingText?.let { text ->
        SelectableTextDialog(text = text, onDismiss = { selectingText = null })
    }
}

@Composable
private fun MessageMenuDivider() {
    HorizontalDivider(
        modifier = Modifier.padding(horizontal = 16.dp),
        thickness = 0.5.dp,
        color = minisSeparator,
    )
}

@Composable
private fun MessageMenuRow(title: String, onClick: () -> Unit, enabled: Boolean = true) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 46.dp)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = title,
            fontSize = 15.sp,
            color = minisInk.copy(alpha = if (enabled) 1f else 0.45f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * Raw message text in a separate surface where Android can own the long-press
 * selection gesture. The bubble's long press is intentionally reserved for
 * reactions and message actions.
 */
@Composable
private fun SelectableTextDialog(text: String, onDismiss: () -> Unit) {
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var copied by remember(text) { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = minisCanvas,
        title = { Text("选择文本") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                SelectionContainer {
                    Text(
                        text = text,
                        fontSize = 16.sp,
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(max = 360.dp)
                            .verticalScroll(rememberScrollState()),
                    )
                }
                Text(
                    "长按文本以选择部分内容。",
                    fontSize = 12.sp,
                    color = secondaryTint,
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    scope.launch {
                        // "Copied" after the clipboard has it, not before: the
                        // label is a report, and `setClipEntry` suspends.
                        clipboard.setClipEntry(
                            ClipEntry(ClipData.newPlainText(MESSAGE_CLIP_LABEL, text)),
                        )
                        copied = true
                    }
                },
            ) { Text(if (copied) "已复制" else "全部复制") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("完成") } },
    )
}

@Composable
private fun MessageContent(
    chat: Chat,
    message: Message,
    startsRun: Boolean,
    endsRun: Boolean,
    haptics: Haptics,
    openLink: ((String, Message) -> Unit)?,
    openAttachment: ((DisplayedMessageAttachment, Message, DownloadedFile?) -> Unit)?,
    openThread: ((ThreadRef) -> Unit)?,
    openComputer: (() -> Unit)?,
) {
    when (message.kind) {
        Message.Kind.TEXT -> TextBubble(chat, message, startsRun, endsRun, openLink, openAttachment)
        // A structured ask draws its own card: its answers are the model's
        // questions, not an allow/deny a tap could stand for.
        Message.Kind.OPTIONS -> if (QuestionCardRules.drawsQuestionCard(message)) {
            QuestionCardView(chat, message, haptics)
        } else {
            CardView(chat, message, haptics)
        }
        Message.Kind.ACTIVITY -> {
            ActivityChip(message.tool, message.threadRef, openThread)
            // Claude Code too old for the model: offer the update on the
            // engine this bot's thread runs on. Rooms have no single engine.
            val claudeInstance = (chat as? Chat.BotChat)?.bot
                ?.let { it.forTask(chat.threadId) ?: it }
                ?.modelSelection?.instanceId
            if (message.tool?.claudeUpdate == true && claudeInstance != null) {
                ClaudeUpdateCard(messageId = message.id, instanceId = claudeInstance)
            }
        }
        Message.Kind.COMPACTION -> ReceiptChip(
            label = message.compaction?.chipText ?: message.text.orEmpty(),
            detail = message.compaction?.summary ?: message.text.orEmpty(),
        )
        Message.Kind.SCREEN -> ScreenShot(chat.threadId, message, openComputer)
        // Four card kinds the transcript used to drop on the floor. Each one
        // carries its payload instead of `text`, so an unknown-kind fallback
        // rendered an invisible row; these draw the card the desktop draws.
        Message.Kind.CONNECTOR -> if (message.connector != null) {
            ConnectorRequestCard(message, (chat as? Chat.BotChat)?.bot?.id, chat.threadId)
        } else if (!message.text.isNullOrEmpty()) {
            TextBubble(chat, message, startsRun, endsRun, openLink, openAttachment)
        }
        Message.Kind.SECRET -> if (message.secret != null) {
            SecretRequestCard(message, (chat as? Chat.BotChat)?.bot?.id, chat.threadId)
        } else if (!message.text.isNullOrEmpty()) {
            TextBubble(chat, message, startsRun, endsRun, openLink, openAttachment)
        }
        // The person does the signing in; the phone only carries the request
        // and the two answers, so a card waiting on the computer is visible
        // here instead of being a gap in the transcript.
        Message.Kind.SIGNIN -> if (message.signIn != null) {
            SignInRequestCard(
                message = message,
                botId = (chat as? Chat.BotChat)?.bot?.id,
                botName = chat.name,
                threadId = chat.threadId,
            )
        } else if (!message.text.isNullOrEmpty()) {
            TextBubble(chat, message, startsRun, endsRun, openLink, openAttachment)
        }
        Message.Kind.ROUTINE_RUN -> if (message.routineRun != null) {
            RoutineRunCard(message)
        } else if (!message.text.isNullOrEmpty()) {
            TextBubble(chat, message, startsRun, endsRun, openLink, openAttachment)
        }
        Message.Kind.GOAL_RUN -> if (message.goalRun != null) {
            GoalRunCard(message)
        } else if (!message.text.isNullOrEmpty()) {
            TextBubble(chat, message, startsRun, endsRun, openLink, openAttachment)
        }
        // A finished Live call leaves a receipt; without it the call simply
        // vanishes from the conversation. The phone cannot join a call the
        // desktop is running, so it shows what happened and when.
        Message.Kind.CALL -> {
            val call = message.call
            if (call != null) {
                CallRecordCard(call)
            } else if (!message.text.isNullOrEmpty()) {
                TextBubble(chat, message, startsRun, endsRun, openLink, openAttachment)
            }
        }
        // A bot-authored widget or app page is a full document on the desktop.
        // The phone shows its readable fallback and the settled answer, so the
        // row is a receipt rather than a gap.
        Message.Kind.WIDGET -> if (message.widget != null || !message.text.isNullOrEmpty()) {
            WidgetSummaryCard(message)
        }
        Message.Kind.APP -> if (message.app != null || !message.text.isNullOrEmpty()) {
            AppSummaryCard(message)
        }
        // Turn-audit chip (tool list + reply preview). Desktop shows it only
        // behind a "show tool calls" setting Android doesn't have; hide it.
        Message.Kind.DIGEST -> {}
        // A message kind from a newer computer. Almost everything the harness
        // sends carries `text`, so showing it is usually the whole message and
        // always better than a gap in the transcript. When there is nothing to
        // show, show nothing — a placeholder saying "unsupported" is a worse gap
        // than the gap.
        Message.Kind.UNKNOWN -> if (!message.text.isNullOrEmpty()) {
            TextBubble(chat, message, startsRun, endsRun, openLink, openAttachment)
        }
    }
}

@Composable
private fun TextBubble(
    chat: Chat,
    message: Message,
    startsRun: Boolean,
    endsRun: Boolean,
    openLink: ((String, Message) -> Unit)?,
    openAttachment: ((DisplayedMessageAttachment, Message, DownloadedFile?) -> Unit)?,
) {
    val threadId = chat.threadId
    val mine = message.role == Message.Role.USER
    // A reply that is *entirely* a patch or a table is drawn as one. The gate is
    // in `:core` and it is strict: anything with a sentence in it stays a
    // paragraph, because a card around a paragraph hides the paragraph.
    val card = remember(message.id, message.role, message.text) { TranscriptCards.of(message) }
    // Shared attachments are protocol tags in stored user text. They are not
    // prose, and a server-controlled path must never be presented as a link.
    val attached = remember(message.id, message.text) { AttachedMessageContent.parse(message.text.orEmpty()) }
    val webhook = remember(message) { message.webhookContent }
    // Both sides are bubbles. Your words take the brighter fill, the bot's the
    // quieter one, so the transcript reads as a conversation rather than as
    // notes written on a page. A patch or a table still brings its own surface
    // and gets no bubble of its own: a card around a card hides the card.
    val bubble = card == null
    // A run of one side's bubbles: the corners that touch a neighbour tuck in,
    // the ones that face the page stay round. One per run, not one per bubble,
    // so three lines in a row read as one block rather than three cards.
    val bubbleShape = joinedBubbleShape(
        mine = mine,
        startsRun = startsRun,
        endsRun = endsRun,
    )
    // The rim is what makes a bubble a shape. No drop shadow: a run sits 4dp
    // apart, and a 3dp shadow spreads wider than that gap, so the bubbles'
    // shadows landed on each other and the run read as one smudged block.
    val bubbleRim = minisBubbleRim
    val bubbleFill = if (mine) BubbleColor.userBubble else BubbleColor.botBubble
    // What the bubble will actually lay out, which is what the gutter is
    // measured against: a diff or a table draws its own card and never reaches
    // here.
    val bubbleText = attached.text.takeIf { it.isNotEmpty() } ?: message.text
    // The bot's gutter depends on how many lines the answer takes at the narrow
    // width, so the column's own width has to be known before the Row is built.
    BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
        val columnWidth = maxWidth
        val botGutter = if (mine) 0.dp else botBubbleGutter(
            text = bubbleText,
            columnWidth = columnWidth,
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
            verticalAlignment = Alignment.Bottom,
        ) {
            // iOS spaces the far side with `Spacer(minLength:)`; a non-filling
            // weight lets the bubble shrink to its text while never crossing that
            // gutter. Both sides keep one: yours on the left, the bot's right.
            if (mine) Spacer(Modifier.width(USER_BUBBLE_GUTTER))
            Column(
                modifier = Modifier
                    .weight(1f, fill = false)
                    // The bot uses the width it needs (up to the reading measure);
                    // your card stays a card rather than becoming a page.
                    .widthIn(max = if (mine) 360.dp else 640.dp)
                    .then(
                        if (bubble) {
                            Modifier
                                .background(
                                    bubbleFill,
                                    bubbleShape,
                                )
                                .border(0.5.dp, bubbleRim, bubbleShape)
                                .padding(horizontal = 13.dp, vertical = 10.dp)
                        } else {
                            Modifier
                        },
                    ),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
            // Rooms attribute each line to the member who said it. Only theirs:
            // your own bubble is already on your side.
            if (!mine) {
                message.from?.let {
                    Text(
                        text = it.name,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = Color(MausPalette.argb(it.color)),
                    )
                }
            }
            // Voice notes sit above the attachment gallery, as they do on the
            // desktop transcript: the note is the message, not an appendix to it.
            message.voiceNotes.forEach { note ->
                VoiceNoteAttachmentView(threadId, message, note)
            }
            message.generatedImages.forEach { attachment ->
                SharedAttachmentView(threadId, message, attachment, openAttachment)
            }
            // Documents a bot handed over through `attach_file`. These used to
            // render as an empty row — an audio handover was invisible, which is
            // the half of "接收不到语音消息" that no amount of TTS could fix.
            // Audio paths have already been claimed by [Message.voiceNotes], so
            // what is left is the file card.
            message.fileAttachments.forEach { attachment ->
                SharedAttachmentView(
                    threadId = threadId,
                    message = message,
                    attachment = attachment,
                    onOpen = openAttachment,
                    foreground = if (mine) BubbleColor.userBubbleText else minisInk,
                )
            }
            // Bots get markdown, you do not — the same split the desktop makes.
            // Markdown you did not intend is worse than markdown you did: a
            // message about `**` should show the asterisks.
            //
            // The text is deliberately NOT in a SelectionContainer. On Android
            // that container owns the long press, so it fired the system
            // selection toolbar *and* this row's action menu at once — two
            // overlays for one gesture. Selection lives in the menu's "选择文本"
            // dialog instead, which gives the same clipboard and leaves the
            // long press meaning one thing.
            when (card) {
                is TranscriptCard.Diff -> DiffCard(card)
                is TranscriptCard.Table -> DataTableCard(card)
                null -> if (webhook != null) {
                    WebhookMessageBody(webhook)
                } else if (mine) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        attached.attachments.forEach { attachment ->
                            // A recorded voice note is a file on the wire and a
                            // player in the transcript, exactly like the notes
                            // the computer sends back.
                            if (attachment.kind == DisplayedMessageAttachment.Kind.AUDIO) {
                                VoiceNoteAttachmentView(threadId, message, attachment)
                            } else {
                                SharedAttachmentView(
                                    threadId = threadId,
                                    message = message,
                                    attachment = attachment,
                                    onOpen = openAttachment,
                                )
                            }
                        }
                        if (attached.text.isNotEmpty()) {
                            UserMessageText(attached.text)
                        }
                    }
                } else {
                    // A bot can attach documents too (attach_file). The tags are
                    // transport, not prose, so render the attachments and the
                    // text that remains — the old path painted the raw tag.
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        attached.attachments.forEach { attachment ->
                            SharedAttachmentView(
                                threadId = threadId,
                                message = message,
                                attachment = attachment,
                                onOpen = openAttachment,
                                foreground = minisInk,
                            )
                        }
                        if (attached.text.isNotEmpty()) {
                            MarkdownText(
                                source = attached.text,
                                openLink = openLink?.let { open -> { url -> open(url, message) } },
                            )
                        }
                    }
                }
            }
            }
            // The bot's bubble stops short of the far edge. Without this it grows
            // to the column and a long answer reads as a page of text rather
            // than as something that arrived in the conversation.
            if (!mine) Spacer(Modifier.width(botGutter))
        }
    }
}

/**
 * Your bubble stays plain text — except the blockquote "引用回复" puts at the
 * head of a draft, which reads as one clipped reference, not as literal
 * ">" runes in front of your words.
 */
@Composable
private fun UserMessageText(text: String) {
    val color = BubbleColor.userBubbleText
    if (!text.startsWith(">")) {
        Text(text = text, fontSize = 17.sp, lineHeight = 24.sp, color = color)
        return
    }
    val lines = text.lines()
    val quote = lines.takeWhile { it.startsWith(">") }
        .joinToString("\n") { it.removePrefix(">").trimStart() }
        .trim()
    val body = lines.dropWhile { it.startsWith(">") }
        .dropWhile { it.isBlank() }
        .joinToString("\n")
    if (quote.isEmpty()) {
        Text(text = text, fontSize = 17.sp, lineHeight = 24.sp, color = color)
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(
            modifier = Modifier.height(IntrinsicSize.Min),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(
                Modifier
                    .width(3.dp)
                    .fillMaxHeight()
                    .background(color.copy(alpha = 0.35f), RoundedCornerShape(1.5.dp)),
            )
            Text(
                text = quote,
                fontSize = 14.sp,
                color = color.copy(alpha = 0.72f),
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (body.isNotEmpty()) {
            Text(text = body, fontSize = 17.sp, lineHeight = 24.sp, color = color)
        }
    }
}

@Composable
private fun SharedAttachmentView(
    threadId: String,
    message: Message,
    attachment: DisplayedMessageAttachment,
    onOpen: ((DisplayedMessageAttachment, Message, DownloadedFile?) -> Unit)?,
    foreground: Color = BubbleColor.userBubbleText,
) {
    if (attachment.kind == DisplayedMessageAttachment.Kind.IMAGE) {
        SharedImageAttachment(threadId, message, attachment, onOpen)
        return
    }
    Row(
        modifier = Modifier
            .widthIn(max = 360.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(foreground.copy(alpha = 0.10f))
            .clickable(enabled = onOpen != null, role = Role.Button) {
                onOpen?.invoke(attachment, message, null)
            }
            .padding(horizontal = 12.dp, vertical = 10.dp)
            .semantics { contentDescription = "文件附件：${attachment.name}。点击预览。" },
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("文件", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = foreground.copy(alpha = 0.68f))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                attachment.name,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                color = foreground,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text("点击预览", fontSize = 12.sp, color = foreground.copy(alpha = 0.68f))
        }
    }
}

private sealed interface AttachmentThumbnailState {
    data object Loading : AttachmentThumbnailState
    data class Ready(val file: DownloadedFile, val image: ImageBitmap) : AttachmentThumbnailState
    data object Failed : AttachmentThumbnailState
}

@Composable
private fun SharedImageAttachment(
    threadId: String,
    message: Message,
    attachment: DisplayedMessageAttachment,
    onOpen: ((DisplayedMessageAttachment, Message, DownloadedFile?) -> Unit)?,
) {
    val foreground = if (message.role == Message.Role.USER) BubbleColor.userBubbleText else MaterialTheme.colorScheme.onSurface
    val session = LocalCompanion.current.session
    var attempt by remember(message.id, attachment.path) { mutableIntStateOf(0) }
    var state by remember(message.id, attachment.path) {
        mutableStateOf<AttachmentThumbnailState>(AttachmentThumbnailState.Loading)
    }
    LaunchedEffect(threadId, message.id, attachment.path, attempt) {
        state = AttachmentThumbnailState.Loading
        // A failed inline preview owns its own retry UI; it must not replace an
        // unrelated composer or account alert while this row scrolls on screen.
        val downloaded = session.downloadFile(
            threadId,
            message.id,
            attachment.path,
            reportError = false,
            cacheResult = true,
        )
        if (downloaded == null) {
            state = AttachmentThumbnailState.Failed
            return@LaunchedEffect
        }
        val bitmap = withContext(Dispatchers.Default) {
            decodeAttachmentImage(downloaded.data, AttachmentImageRules.THUMBNAIL_EDGE)
        }
        state = bitmap?.let { AttachmentThumbnailState.Ready(downloaded, it) }
            ?: AttachmentThumbnailState.Failed
    }

    val ready = state as? AttachmentThumbnailState.Ready
    Column(
        modifier = Modifier
            .widthIn(max = 360.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(foreground.copy(alpha = 0.10f))
            .clickable(enabled = ready != null && onOpen != null, role = Role.Button) {
                ready?.let { onOpen?.invoke(attachment, message, it.file) }
            }
            .semantics { contentDescription = "图片附件：${attachment.name}。点击预览。" },
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(4f / 3f),
            contentAlignment = Alignment.Center,
        ) {
            when (val current = state) {
                AttachmentThumbnailState.Loading ->
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                AttachmentThumbnailState.Failed -> AttachmentLoadFailure(
                    label = "图片不可用",
                    foreground = foreground,
                    onRetry = { attempt += 1 },
                )
                is AttachmentThumbnailState.Ready -> Image(
                    bitmap = current.image,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxWidth().aspectRatio(4f / 3f),
                )
            }
        }
        Text(
            attachment.name,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            color = foreground,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp),
        )
    }
}

@Composable
private fun AttachmentLoadFailure(label: String, foreground: Color = BubbleColor.userBubbleText, onRetry: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Icon(
            imageVector = Icons.Filled.Warning,
            contentDescription = null,
            tint = foreground.copy(alpha = 0.70f),
            modifier = Modifier.size(20.dp),
        )
        Text(label, fontSize = 13.sp, color = foreground.copy(alpha = 0.80f))
        TextButton(onClick = onRetry) { Text("重试") }
    }
}

/** Where the bubble's clip bytes are: fetched on first play, then kept for replay. */
private sealed interface VoiceNoteClipState {
    data object NotLoaded : VoiceNoteClipState
    data object Loading : VoiceNoteClipState
    data class Ready(val data: ByteArray) : VoiceNoteClipState
    data object Failed : VoiceNoteClipState
}

/** The desktop bubble's clock: m:ss, and 0:00 for anything not yet audible. */
private fun voiceNoteClock(ms: Long): String {
    if (ms <= 0) return "0:00"
    val wholeSeconds = ms / 1000
    return (wholeSeconds / 60).toString() + ":" + (wholeSeconds % 60).toString().padStart(2, '0')
}

/**
 * One voice note in the transcript, matching the desktop VoiceNoteBubble:
 * a play button, a scrub bar, and the clip's length. Playback is app-scoped
 * (CompanionEnvironment.voiceNotes), so a note keeps playing while its row
 * scrolls away, and the one-voice rule rides the same audio-focus gate the
 * TTS preview uses: starting a note (or a preview) pauses any other voice
 * rather than talking over it. The clip's bytes are fetched through the same
 * authenticated file route as image thumbnails, but only on first play — a
 * note nobody opens costs no request, and a replay never refetches.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun VoiceNoteAttachmentView(
    threadId: String,
    message: Message,
    note: DisplayedMessageAttachment,
) {
    val foreground = if (message.role == Message.Role.USER) BubbleColor.userBubbleText else MaterialTheme.colorScheme.onSurface
    val session = LocalCompanion.current.session
    val player = LocalCompanion.current.voiceNotes
    val scope = rememberCoroutineScope()
    val key = remember(message.id, note.path) { message.id + ":" + note.path }
    var clip by remember(message.id, note.path) { mutableStateOf<VoiceNoteClipState>(VoiceNoteClipState.NotLoaded) }
    // The scrub position while the slider is held; null when it tracks playback.
    var scrub by remember(key) { mutableStateOf<Float?>(null) }

    fun startPlayback(data: ByteArray) {
        if (player.play(key, data) != null) clip = VoiceNoteClipState.Failed
    }

    fun loadAndPlay() {
        clip = VoiceNoteClipState.Loading
        scope.launch {
            val downloaded = session.downloadFile(
                threadId,
                message.id,
                note.path,
                reportError = false,
                cacheResult = true,
            )
            if (downloaded == null) {
                clip = VoiceNoteClipState.Failed
            } else {
                clip = VoiceNoteClipState.Ready(downloaded.data)
                startPlayback(downloaded.data)
            }
        }
    }

    val active = player.playback.collectAsState().value?.takeIf { it.key == key }
    val playing = active?.playing == true

    // Late engine failures park the clip; the bubble's retry row is its UI.
    LaunchedEffect(key) {
        player.playbackErrors.collectLatest {
            if (it.key == key) clip = VoiceNoteClipState.Failed
        }
    }
    // Pull the engine's position while it plays; the clock reads it back.
    LaunchedEffect(key, playing) {
        while (playing) {
            player.refresh()
            delay(200)
        }
    }

    if (clip is VoiceNoteClipState.Failed) {
        AttachmentLoadFailure(
            label = "语音留言不可用",
            foreground = foreground,
            onRetry = { clip = VoiceNoteClipState.NotLoaded },
        )
        return
    }

    // The wire's estimate until the engine loads metadata, then the real length.
    val durationMs = active?.durationMs ?: note.durationMs?.toLong()?.takeIf { it > 0 }
    val durationSeconds = durationMs?.let { it / 1000f } ?: 0f
    val positionMs = scrub?.toLong() ?: (active?.positionMs ?: 0L)

    val mine = message.role == Message.Role.USER
    Row(
        // A voice note is a message, not a media widget: it stays compact
        // enough to read at a glance, and the progress bar is a hairline
        // rather than the platform's default slider.
        modifier = Modifier
            .widthIn(min = 180.dp, max = 260.dp)
            .then(
                if (mine) {
                    Modifier
                } else {
                    Modifier
                        .clip(RoundedCornerShape(16.dp))
                        .background(foreground.copy(alpha = 0.08f))
                        .padding(horizontal = 10.dp, vertical = 6.dp)
                },
            ),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(32.dp)
                .clip(CircleShape)
                // Ink on the page in both themes; the glyph is the page
                // colour, so a dark-mode user bubble gets a black play mark
                // on white instead of the old white-on-white blank disc.
                .background(foreground)
                .clickable(role = Role.Button) {
                    when {
                        playing -> player.pause()
                        clip is VoiceNoteClipState.Loading -> Unit
                        active != null && player.resumable(key) ->
                            if (player.resume() != null) clip = VoiceNoteClipState.Failed
                        clip is VoiceNoteClipState.Ready ->
                            startPlayback((clip as VoiceNoteClipState.Ready).data)
                        else -> loadAndPlay()
                    }
                }
                .semantics {
                    contentDescription = if (playing) "暂停语音留言" else "播放语音留言"
                },
            contentAlignment = Alignment.Center,
        ) {
            when {
                clip is VoiceNoteClipState.Loading && active == null ->
                    CircularProgressIndicator(
                        modifier = Modifier.size(14.dp),
                        strokeWidth = 2.dp,
                        // The button is the bubble's text colour (white on a
                        // user note); the glyph is the bubble behind it.
                        color = if (mine) BubbleColor.userBubble else minisPage,
                    )
                playing -> VoiceNotePauseGlyph(if (mine) BubbleColor.userBubble else minisPage)
                else -> Icon(
                    imageVector = Icons.Filled.PlayArrow,
                    contentDescription = null,
                    tint = if (mine) BubbleColor.userBubble else minisPage,
                    modifier = Modifier.size(20.dp),
                )
            }
        }
        Slider(
            // The slider works in seconds; without an explicit range Compose clamps
            // it to 0f..1f and scrubs can only land inside the first second.
            value = if (durationSeconds > 0f) (positionMs / 1000f).coerceIn(0f, durationSeconds) else 0f,
            valueRange = if (durationSeconds > 0f) 0f..durationSeconds else 0f..1f,
            onValueChange = { scrub = it * 1000f },
            onValueChangeFinished = {
                val target = scrub
                scrub = null
                if (target != null && active != null) player.seek(key, target.toLong())
            },
            // Like the desktop range input: no scrubbing until the length is known.
            enabled = active != null && durationMs != null,
            modifier = Modifier
                .weight(1f)
                .height(32.dp)
                .semantics { contentDescription = "拖动调节语音留言进度" },
            thumb = {
                // The slot is as tall as the control and the dot is centred in
                // it. A bare 10 dp box is placed at the slot's top, which put
                // the dot visibly above the 3 dp track.
                Box(
                    modifier = Modifier
                        .width(10.dp)
                        .fillMaxHeight(),
                    contentAlignment = Alignment.Center,
                ) {
                    Box(
                        modifier = Modifier
                            .size(10.dp)
                            .background(foreground, CircleShape),
                    )
                }
            },
            track = { state ->
                val span = state.valueRange.endInclusive - state.valueRange.start
                val fraction = if (span > 0f) {
                    ((state.value - state.valueRange.start) / span).coerceIn(0f, 1f)
                } else {
                    0f
                }
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(3.dp)
                        .clip(CircleShape)
                        .background(foreground.copy(alpha = 0.22f)),
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth(fraction)
                            .height(3.dp)
                            .background(foreground),
                    )
                }
            },
        )
        // The length, not a clock pair: while a note plays the bar already
        // says where it is, and "0:00 / 0:01" was the widest thing here. A note
        // the wire never timed keeps its bar and drops the dead "--:--".
        durationMs?.let {
            Text(
                text = voiceNoteClock(it),
                fontSize = 12.sp,
                color = foreground.copy(alpha = 0.75f),
            )
        }
    }
}

/** The pause glyph the core icon set does not carry, drawn at the button's scale. */
@Composable
private fun VoiceNotePauseGlyph(color: Color) {
    Canvas(modifier = Modifier.size(14.dp)) {
        val bar = size.width * 0.22f
        val gap = size.width * 0.20f
        val left = (size.width - (bar * 2 + gap)) / 2f
        val top = size.height * 0.12f
        val height = size.height - top * 2f
        drawRoundRect(
            color = color,
            topLeft = Offset(left, top),
            size = Size(bar, height),
            cornerRadius = CornerRadius(bar / 2f),
        )
        drawRoundRect(
            color = color,
            topLeft = Offset(left + bar + gap, top),
            size = Size(bar, height),
            cornerRadius = CornerRadius(bar / 2f),
        )
    }
}

/**
 * A tool the bot ran, and what became of it — the status half of
 * `ios/App/Cards/SkillExecutionReceiptView.swift`.
 *
 * Deliberately quiet: these are the bulk of a busy transcript and they are
 * context, not content. So the receipt is a dot and a name, and the badge word
 * appears only for the two states worth a glance ([ActivityReceipt.showsLabel]).
 * A row that failed keeps the warning glyph it already had, so failure is a
 * shape and not only a colour — and the whole row reads as one sentence to a
 * screen reader whichever state it is in.
 *
 * None of iOS's detail is here, because none of it has data: `durationMs`,
 * `parameters` and `output` are dormant on that view and absent from
 * [ToolActivity]. Nothing to expand means nothing to tap, which is why this is
 * not a button — except a chip that names a thread it opened, which is the
 * link to that thread.
 */
@Composable
private fun ActivityChip(
    tool: ToolActivity?,
    threadRef: ThreadRef? = null,
    openThread: ((ThreadRef) -> Unit)? = null,
) {
    if (tool == null) return
    val status = ActivityReceipt.status(tool.ok)
    val tint = when (status) {
        ActivityStatus.RUNNING -> minisAccent
        ActivityStatus.SUCCESS -> secondaryTint
        ActivityStatus.ERROR -> MaterialTheme.colorScheme.error
    }
    // A receipt is a pill that wraps its sentence, not a full-width row. Stretched
    // edge to edge it read as a log line, and the state word sat marooned at the
    // screen edge; a capsule keeps the mark, the sentence and the state together.
    val shape = RoundedCornerShape(12.dp)
    // A wash of ink, not a white card: a white pill beside a white message bubble
    // reads as another reply, and these are the transcript's smallest print.
    val wash = when (status) {
        ActivityStatus.ERROR -> tint.copy(alpha = 0.08f)
        ActivityStatus.RUNNING, ActivityStatus.SUCCESS -> minisInk.copy(alpha = 0.05f)
    }
    val haptics = rememberHaptics()
    val label = readableActivityName(tool.name)
    val linked = if (threadRef != null && openThread != null) {
        Modifier
            .heightIn(min = MIN_TOUCH_TARGET)
            .clickable(role = Role.Button) {
                haptics.play(TactileAction.OPEN_THREAD_CHIP)
                openThread(threadRef)
            }
    } else {
        Modifier
    }
    Row(
        modifier = Modifier
            .padding(start = 4.dp)
            .widthIn(max = 280.dp)
            .clip(shape)
            .background(wash)
            .then(linked)
            .padding(horizontal = 11.dp, vertical = 7.dp)
            .semantics(mergeDescendants = true) {
                contentDescription = ActivityReceipt.announcement(label, status)
            },
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        // The marker belongs to the first line, not to the middle of a wrapped
        // sentence.
        verticalAlignment = Alignment.Top,
    ) {
        if (status == ActivityStatus.ERROR) {
            Icon(
                imageVector = Icons.Filled.Warning,
                contentDescription = null,
                tint = tint,
                modifier = Modifier
                    .padding(top = 2.dp)
                    .size(13.dp),
            )
        } else {
            Box(
                modifier = Modifier
                    .padding(top = 6.dp)
                    .size(ACTIVITY_DOT)
                    .background(tint, CircleShape),
            )
        }
        Text(
            text = label,
            fontSize = 13.sp,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            color = if (status == ActivityStatus.ERROR) tint else secondaryTint,
        )
        if (ActivityReceipt.showsLabel(status)) {
            Text(
                text = ActivityReceipt.label(status),
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                color = tint,
                modifier = Modifier.padding(top = 1.dp),
            )
        }
    }
}

/**
 * A tool receipt's name is wire text: `notice: …` for a fallback, and often a
 * provider's JSON error. Strip the prefix and keep the one sentence a person
 * can read; the icon and the status label already say "error".
 */
internal fun readableActivityName(name: String): String {
    val body = name.removePrefix("notice: ").removePrefix("error: ")
    if (body.isBlank()) return name
    val detail = Regex("\"message\"\\s*:\\s*\"([^\"]+)").find(body)
        ?.groupValues?.getOrNull(1)
    if (detail != null) {
        val prefix = body.substringBefore("{").trim().trimEnd(':', '：').trim()
        val clean = RosterPreviewFormat.humanizeErrorMessage(cleanActivityText(detail))
        return when {
            prefix.isEmpty() -> clean
            prefix.matches(Regex("\\d{3}")) -> "错误 $prefix：$clean"
            else -> "$prefix: $clean"
        }
    }
    val coded = Regex("^(\\d{3})\\s*[:：]\\s*([\\s\\S]+)$").matchEntire(body)
    if (coded != null) {
        return "错误 ${coded.groupValues[1]}：${
            RosterPreviewFormat.humanizeErrorMessage(cleanActivityText(coded.groupValues[2]))
        }"
    }
    return cleanActivityText(body)
}

private fun cleanActivityText(text: String): String = text
    .replace(Regex("\\(?\\s*request_id\\s*[:=]\\s*[^)\\s,]*\\)?", RegexOption.IGNORE_CASE), "")
    // The provider's own quoted reason is a diagnostic, not a sentence; the
    // state above it already says the request failed.
    .replace(Regex("\\s*\\([A-Za-z][\\w .-]* says:.*$", RegexOption.IGNORE_CASE), "")
    .trim()
    .trimEnd('(', '（', ',', '，')
    .trim()

/**
 * A quiet chip under a reply for the harness's receipts (the work digest, a
 * compaction record): one line, and the full text on tap. Port of
 * `ReceiptChip` in `ios/App/ChatView.swift`.
 */
@Composable
private fun ReceiptChip(label: String, detail: String) {
    if (label.isEmpty()) return
    var expanded by remember(label) { mutableStateOf(false) }
    val haptics = rememberHaptics()
    Column(
        modifier = Modifier
            .padding(start = 4.dp)
            .heightIn(min = MIN_TOUCH_TARGET)
            .clickable(role = Role.Button) {
                haptics.play(TactileAction.TOGGLE_ACTIVITY_RUN)
                expanded = !expanded
            }
            .semantics(mergeDescendants = true) { contentDescription = label },
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(ACTIVITY_DOT)
                    .background(secondaryTint, CircleShape),
            )
            Text(text = label, fontSize = 13.sp, maxLines = 1, color = secondaryTint)
        }
        if (expanded && detail.isNotEmpty() && detail != label) {
            Text(text = detail, fontSize = 12.sp, color = secondaryTint)
        }
    }
}

/** Several consecutive successful/running activity receipts, folded on demand. */
@Composable
fun ActivityRunChip(items: List<Message>, openThread: ((ThreadRef) -> Unit)? = null) {
    if (items.isEmpty()) return
    // Keyed on the run's identity — the same one the LazyColumn keys the row by
    // (`TranscriptRow.ActivityRun.id = "run.${head.id}"`). Keying on the last id
    // too would throw the reader's disclosure away on every receipt that lands
    // while the run is still going. iOS holds a `@State` with no key at all.
    var expanded by remember(items.first().id) { mutableStateOf(false) }
    val running = items.any { it.tool?.ok == null }
    val summary = if (running) "正在运行 ${items.size} 个步骤" else "已运行 ${items.size} 个步骤"
    Column(
        modifier = Modifier.padding(start = 4.dp),
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        RunReceiptPill(
            summary = summary,
            expanded = expanded,
            running = running,
            onToggle = { expanded = !expanded },
        )
        if (expanded) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                items.forEach { item -> ActivityChip(item.tool, item.threadRef, openThread) }
            }
        }
    }
}

/** The receipt's status dot, sized to sit level with the 13 sp name beside it. */
private val ACTIVITY_DOT = 7.dp

/**
 * An option card. When it still has a request behind it, this is the screen the
 * companion exists for — a bot stopped, and only a person can let it continue.
 */
@Composable
private fun CardView(chat: Chat, message: Message, haptics: Haptics) {
    val card = message.card ?: return
    val session = LocalCompanion.current.session
    val scope = rememberCoroutineScope()
    var answering by remember(message.id) { mutableStateOf(false) }
    val skillRequest = card.skillRequest
    // What this card is, as opposed to what it says: the four outcomes already
    // existed on the wire, and the phone drew all of them the same way.
    val style = ApprovalCardStyle.of(card, chat)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(minisGrouped, MinisCardShape)
            .then(
                if (style.isPending) {
                    Modifier.border(
                        1.5.dp,
                        if (style.danger) minisDanger else minisAccent,
                        MinisCardShape,
                    )
                } else {
                    Modifier.border(0.5.dp, minisSeparator, MinisCardShape)
                },
            )
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // The state line: the one thing a person scanning the transcript needs
        // before the title. It carries a glyph rather than a colour alone, so it
        // reads in a screenshot and to a colour-blind eye.
        ApprovalStateLine(style)

        // Explicit ink: the row's inherited content colour is not the card's,
        // and without it the title drew near-black on the dark card.
        Text(card.title, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = minisInk)
        // The detail of what is being approved is the thing worth copying, and
        // it is also the thing with no length limit: a command, a diff, a tool's
        // own explanation. Folding it keeps one such card from filling the
        // screen; the whole text stays one tap away.
        ExpandableText(
            text = card.subtitle,
            style = TextStyle(fontSize = 14.sp, color = minisSecondary),
            showMore = "显示完整内容",
        )

        card.held?.let {
            Text(it, fontSize = 13.sp, color = minisWarning)
        }

        skillRequest?.let { skill ->
            val reviewed = skill.reviewedSha256
            if (reviewed != null) {
                Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            "审阅完整的 SKILL.md",
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            "sha256 ${reviewed.take(8)}",
                            fontSize = 12.sp,
                            fontFamily = FontFamily.Monospace,
                            color = secondaryTint,
                        )
                    }
                    SelectionContainer {
                        Text(
                            "来源：${skill.source ?: "未知"}",
                            fontSize = 12.sp,
                            color = secondaryTint,
                        )
                    }
                    SelectionContainer {
                        Text(
                            skill.preview.orEmpty(),
                            fontSize = 12.sp,
                            fontFamily = FontFamily.Monospace,
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(max = 220.dp)
                                .verticalScroll(rememberScrollState())
                                .background(
                                    secondaryTint.copy(alpha = 0.08f),
                                    RoundedCornerShape(10.dp),
                                )
                                .padding(10.dp),
                        )
                    }
                }
            } else {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = Icons.Filled.Warning,
                        contentDescription = null,
                        tint = minisWarning,
                    )
                    Text(
                        "此提案由旧版本创建，无法安全启用。请拒绝该提案并让智能体重新创建。",
                        fontSize = 12.sp,
                        color = minisWarning,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }

        // The slip: the one fact a person checks before tapping, in the face
        // that says "this is a machine's name, not prose". Only cards that name
        // a tool have one; a question card has nothing to put here.
        card.tool?.takeIf { it.isNotBlank() }?.let { tool ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(secondaryTint.copy(alpha = 0.08f), RoundedCornerShape(10.dp))
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = tool,
                    fontSize = 11.5.sp,
                    fontFamily = FontFamily.Monospace,
                    color = minisInk.copy(alpha = 0.78f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        if (style.showsActions) {
            // Minis stacks the decisions: one full-width primary action, the
            // refusal quieter underneath. Nothing sits side by side where a
            // thumb has to choose between "allow" and "deny" at speed.
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                // The buttons are the card's own options, never a string
                // invented here. Session maps the choice to allow/deny/answer.
                card.options.forEach { option ->
                    val refusal = ApprovalChoices.emphasis(option) == OptionEmphasis.SECONDARY
                    Button(
                        onClick = {
                            haptics.play(TactileAction.CHOOSE_APPROVAL)
                            answering = true
                            scope.launch {
                                ApprovalAnswers.choose(session, chat, card, option)
                                answering = false
                            }
                        },
                        enabled = !answering && (
                            skillRequest == null ||
                                refusal ||
                                skillRequest.reviewedSha256 != null
                            ),
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 44.dp),
                        shape = RoundedCornerShape(12.dp),
                        // Same `isRefusal` that picks the allow choice picks the
                        // weight, so the most sensible action on the most
                        // sensitive screen is not the same shape as the refusal.
                        //
                        // The refusal is a tint of the text colour rather than
                        // the page colour: the card already sits on `grouped`,
                        // and in dark mode the page colour is near-black, which
                        // made the button's shape vanish into its own card.
                        colors = if (refusal) {
                            ButtonDefaults.filledTonalButtonColors(
                                containerColor = secondaryTint.copy(alpha = 0.12f),
                                contentColor = minisInk,
                            )
                        } else if (style.danger) {
                            // The allow action deletes something. The desktop
                            // has drawn it red since `card.danger` existed; the
                            // phone drew it ink like any other.
                            ButtonDefaults.buttonColors(
                                containerColor = minisDanger,
                                contentColor = Color.White,
                            )
                        } else {
                            ButtonDefaults.buttonColors(
                                containerColor = minisInk,
                                contentColor = minisPage,
                            )
                        },
                    ) {
                        Text(option, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }

            // The grant key comes from the card. The phone never derives its
            // own, so it cannot permit something subtly wider than the computer
            // would have. The same goes for the answer: it is one of the options
            // the card offered, never a string invented here.
            //
            // `showsAlwaysAllow` already requires a bot chat, but the compiler
            // cannot see through that predicate, so the cast is re-stated here.
            val botChat = chat as? Chat.BotChat
            if (style.showsAlwaysAllow && botChat != null) {
                val alwaysAllow = ApprovalChoices.alwaysAllowChoice(card)
                if (alwaysAllow != null) {
                    TextButton(
                        onClick = {
                            haptics.play(TactileAction.GRANT_APPROVAL)
                            answering = true
                            scope.launch {
                                ApprovalAnswers.grant(session, botChat, card, alwaysAllow)
                                answering = false
                            }
                        },
                        enabled = !answering,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("始终允许此工具", fontSize = 14.sp, color = minisAccent)
                    }
                }
            }
        }

        // The stamp: one line, after the actions are gone, saying what was
        // decided. A settled card that said nothing read as still pending.
        if (style.showsStamp) {
            ApprovalStamp(style)
        }
    }
}

/** The state line above a card's title: glyph, words, and nothing else. */
@Composable
private fun ApprovalStateLine(style: ApprovalCardStyle) {
    val tint = when (style.state) {
        ApprovalState.PENDING -> if (style.danger) minisDanger else minisAccent
        ApprovalState.ALLOWED -> minisSuccess
        // A refusal is not an error; it is the card doing its job.
        ApprovalState.DENIED -> secondaryTint
        ApprovalState.EXPIRED -> secondaryTint
        ApprovalState.SETTLED -> secondaryTint
    }
    Row(
        horizontalArrangement = Arrangement.spacedBy(7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        when (style.state) {
            ApprovalState.PENDING -> if (style.danger) {
                Icon(
                    imageVector = Icons.Filled.Warning,
                    contentDescription = null,
                    tint = tint,
                    modifier = Modifier.size(14.dp),
                )
            } else {
                Icon(
                    painter = painterResource(R.drawable.ic_shield_line),
                    contentDescription = null,
                    tint = tint,
                    modifier = Modifier.size(14.dp),
                )
            }
            ApprovalState.ALLOWED -> Icon(
                imageVector = Icons.Filled.Check,
                contentDescription = null,
                tint = tint,
                modifier = Modifier.size(14.dp),
            )
            ApprovalState.EXPIRED -> Icon(
                painter = painterResource(R.drawable.ic_schedule),
                contentDescription = null,
                tint = tint,
                modifier = Modifier.size(14.dp),
            )
            ApprovalState.DENIED, ApprovalState.SETTLED -> Unit
        }
        Text(
            text = style.label,
            fontSize = 11.5.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.2.sp,
            color = tint,
        )
    }
}

/** What a settled card leaves behind: one line, behind a hairline. */
@Composable
private fun ApprovalStamp(style: ApprovalCardStyle) {
    val tint = if (style.state == ApprovalState.ALLOWED) minisSuccess else secondaryTint
    HorizontalDivider(thickness = 0.5.dp, color = minisSeparator)
    Row(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (style.state == ApprovalState.ALLOWED) {
            Icon(
                imageVector = Icons.Filled.Check,
                contentDescription = null,
                tint = tint,
                modifier = Modifier.size(12.dp),
            )
        }
        Text(
            text = style.stamp.orEmpty(),
            fontSize = 12.sp,
            color = tint,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * A frame of the bot's computer. In the paged shape the pixels are not in the
 * transcript — they are fetched here, once, when the row appears.
 *
 * When [openComputer] is present the frame is also the door to the live view:
 * the still is what the reader recognises, so tapping it should show the same
 * computer moving rather than sending them to a header icon they never noticed.
 */
@Composable
private fun ScreenShot(threadId: String, message: Message, openComputer: (() -> Unit)?) {
    val session = LocalCompanion.current.session
    var attempt by remember(message.id) { mutableIntStateOf(0) }
    var state by remember(message.id) { mutableStateOf<ScreenShotState>(ScreenShotState.Loading) }

    BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
        val renderedWidthPixels = with(LocalDensity.current) { maxWidth.toPx().toInt().coerceAtLeast(1) }
        LaunchedEffect(threadId, message.id, attempt, renderedWidthPixels) {
            state = ScreenShotState.Loading
            val bytes = try {
                message.png?.let { encoded ->
                    withContext(Dispatchers.Default) {
                        runCatching { Base64.decode(encoded, Base64.DEFAULT) }.getOrNull()
                    }
                } ?: if (message.hasImage == true) session.image(threadId, message.id) else null
            } catch (error: CancellationException) {
                throw error
            } catch (_: Throwable) {
                null
            }
            val bitmap = bytes?.let {
                withContext(Dispatchers.Default) {
                    decodeScreenShotImage(it, renderedWidthPixels)
                }
            }
            state = bitmap?.let(ScreenShotState::Ready) ?: ScreenShotState.Failed
        }

        val aspectRatio = (state as? ScreenShotState.Ready)?.image?.let { image ->
            image.width.toFloat() / image.height.coerceAtLeast(1).toFloat()
        } ?: (16f / 10f)
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(aspectRatio)
                .clip(RoundedCornerShape(16.dp))
                .background(secondaryTint.copy(alpha = 0.13f))
                .then(
                    if (openComputer != null) {
                        Modifier.clickable(
                            role = Role.Button,
                            onClickLabel = "打开实时电脑画面",
                            onClick = openComputer,
                        )
                    } else {
                        Modifier
                    },
                ),
            contentAlignment = Alignment.Center,
        ) {
            when (val current = state) {
                ScreenShotState.Loading ->
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                ScreenShotState.Failed -> Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Icon(
                        imageVector = Icons.Filled.Warning,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.error,
                        modifier = Modifier.size(20.dp),
                    )
                    Text("截图不可用", fontSize = 13.sp, color = secondaryTint)
                    TextButton(onClick = { attempt += 1 }) { Text("重试") }
                }
                is ScreenShotState.Ready -> Image(
                    bitmap = current.image,
                    contentDescription = "此智能体电脑的一帧画面",
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize(),
                )
            }
            // The still is indistinguishable from a screenshot you cannot tap.
            // One quiet word in the corner is the whole affordance.
            if (state is ScreenShotState.Ready && openComputer != null) {
                Text(
                    text = "实时画面",
                    color = Color.White,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(10.dp)
                        .clip(RoundedCornerShape(50))
                        .background(Color.Black.copy(alpha = 0.55f))
                        .padding(horizontal = 8.dp, vertical = 4.dp),
                )
            }
        }
    }
}

private sealed interface ScreenShotState {
    data object Loading : ScreenShotState
    data class Ready(val image: ImageBitmap) : ScreenShotState
    data object Failed : ScreenShotState
}

/**
 * The shared shell for the cards whose content lives on the computer: the
 * desktop's grouped-card fill, a title, an optional body, and whatever status
 * or action the kind adds. The person's own transcript keeps the card even
 * when the phone cannot finish the action — an invisible message is worse.
 */
@Composable
private fun RemoteCard(
    title: String,
    body: String?,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(minisGrouped, MinisCardShape)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(title, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        body?.takeIf { it.isNotBlank() }?.let {
            SelectionContainer { Text(it, fontSize = 14.sp, color = minisSecondary) }
        }
        content()
    }
}

@Composable
private fun ConnectorRequestCard(message: Message, botId: String?, threadId: String) {
    val data = message.connector ?: return
    val session = LocalCompanion.current.session
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var working by remember(message.id) { mutableStateOf(false) }

    fun close(action: ConnectorCardAction) {
        val bot = botId ?: return
        scope.launch {
            working = true
            session.connectorCardAction(bot, message.id, threadId, action)
            working = false
        }
    }

    RemoteCard(title = data.label, body = data.description) {
        Text(
            text = connectorStatusLabel(data),
            fontSize = 13.sp,
            color = if (data.status == "failed") minisWarning else secondaryTint,
        )
        data.error?.takeIf { it.isNotBlank() }?.let {
            Text(it, fontSize = 13.sp, color = minisWarning)
        }
        if (data.status == "required" || data.status == "failed") {
            TextButton(
                enabled = !working,
                onClick = {
                    scope.launch {
                        working = true
                        try {
                            val url = session.authorizeConnector(data.slug, data.alias) ?: return@launch
                            try {
                                // The browser owns the provider cookies and the
                                // account choice, exactly as on the app's own
                                // Connected Apps screen.
                                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url.toASCIIString())))
                            } catch (_: ActivityNotFoundException) {
                                session.actionError = "此手机没有可用的浏览器来打开授权页面。"
                            } catch (_: SecurityException) {
                                session.actionError = "无法打开授权页面，请检查浏览器限制后重试。"
                            }
                        } finally {
                            working = false
                        }
                    }
                },
            ) { Text(if (working) "正在打开…" else "连接 ${data.label}") }
        }
        // Once the browser has finished, the card is the only place that can
        // tell the computer to carry on — and the only place to stop asking.
        if (data.isPending && botId != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (data.status == "authorizing") {
                    TextButton(enabled = !working, onClick = { close(ConnectorCardAction.RESUME) }) {
                        Text("已完成授权，继续")
                    }
                }
                TextButton(enabled = !working, onClick = { close(ConnectorCardAction.DISMISS) }) {
                    Text("跳过")
                }
            }
        }
        Text(
            "授权在浏览器中完成；令牌保存在电脑上，不会发送到此手机。",
            fontSize = 12.sp,
            color = secondaryTint,
        )
    }
}

@Composable
private fun SecretRequestCard(message: Message, botId: String?, threadId: String) {
    val data = message.secret ?: return
    val uriHandler = LocalUriHandler.current
    val session = LocalCompanion.current.session
    val scope = rememberCoroutineScope()
    var working by remember(message.id) { mutableStateOf(false) }

    fun act(action: SecretCardAction) {
        val bot = botId ?: return
        scope.launch {
            working = true
            session.secretCardAction(bot, message.id, threadId, action)
            working = false
        }
    }

    RemoteCard(
        title = data.label?.takeIf { it.isNotBlank() } ?: "需要一个凭据",
        body = data.description,
    ) {
        Text(
            text = secretStatusLabel(data),
            fontSize = 13.sp,
            color = if (data.error != null) minisWarning else secondaryTint,
        )
        data.error?.takeIf { it.isNotBlank() }?.let {
            Text(it, fontSize = 13.sp, color = minisWarning)
        }
        if (data.isPending) {
            Text(
                "手机端暂不支持直接提交凭据，请在电脑上填写后保存。",
                fontSize = 12.sp,
                color = secondaryTint,
            )
        }
        data.helpUrl?.takeIf { it.startsWith("https://") }?.let { url ->
            TextButton(onClick = { runCatching { uriHandler.openUri(url) } }) {
                Text("查看填写说明")
            }
        }
        // The host stores the value; the phone can still say "saved, carry on"
        // or "stop asking", which is what these two verbs are.
        if (botId != null && data.isPending) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (data.provided == true) {
                    TextButton(enabled = !working, onClick = { act(SecretCardAction.RESUME) }) {
                        Text("已在电脑上保存，继续")
                    }
                }
                TextButton(enabled = !working, onClick = { act(SecretCardAction.DISMISS) }) {
                    Text("跳过")
                }
            }
        }
    }
}

@Composable
private fun SignInRequestCard(
    message: Message,
    botId: String?,
    botName: String,
    threadId: String,
) {
    val data = message.signIn ?: return
    val session = LocalCompanion.current.session
    val scope = rememberCoroutineScope()
    var working by remember(message.id) { mutableStateOf(false) }

    fun act(action: SignInCardAction) {
        val bot = botId ?: return
        scope.launch {
            working = true
            session.signInCardAction(bot, message.id, threadId, action)
            working = false
        }
    }

    RemoteCard(
        title = if (data.site.isBlank()) "需要登录" else "需要登录 ${data.site}",
        body = data.reason,
    ) {
        Text(
            text = SignInCardRules.statusLabel(data, data.site),
            fontSize = 13.sp,
            color = if (data.error != null) minisWarning else secondaryTint,
        )
        if (data.isPending) {
            Text(
                SignInCardRules.whereText(data.place, botName),
                fontSize = 13.sp,
                color = minisSecondary,
            )
            Text(
                "密码由你亲自输入到页面中，Luna Bot 始终看不到。",
                fontSize = 12.sp,
                color = secondaryTint,
            )
        }
        data.error?.takeIf { it.isNotBlank() }?.let {
            Text(it, fontSize = 13.sp, color = minisWarning)
        }
        if (botId != null && data.isPending) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(enabled = !working, onClick = { act(SignInCardAction.DONE) }) {
                    Text("完成")
                }
                TextButton(enabled = !working, onClick = { act(SignInCardAction.CANCEL) }) {
                    Text("取消")
                }
            }
        }
    }
}

@Composable
private fun RoutineRunCard(message: Message) {
    val data = message.routineRun ?: return

    RemoteCard(title = data.routineName.ifBlank { "例行任务" }, body = null) {
        Text(
            text = routineStatusLabel(data),
            fontSize = 13.sp,
            color = if (data.status == "failed") minisWarning else secondaryTint,
        )
        if (data.deferredAt != null && data.status == "queued") {
            Text("目标正忙，这次运行已延后。", fontSize = 12.sp, color = secondaryTint)
        }
        data.goalStatus?.let {
            Text("团队目标：${goalStatusLabel(it)}", fontSize = 12.sp, color = secondaryTint)
        }
        data.summary?.takeIf { it.isNotBlank() }?.let { Text(it, fontSize = 14.sp) }
        data.error?.takeIf { it.isNotBlank() }?.let {
            Text(it, fontSize = 13.sp, color = minisWarning)
        }
    }
}

@Composable
private fun GoalRunCard(message: Message) {
    val data = message.goalRun ?: return

    RemoteCard(title = "团队目标", body = data.goal) {
        Text(
            text = goalStatusLabel(data.status),
            fontSize = 13.sp,
            color = if (data.status == "failed") minisWarning else secondaryTint,
        )
        val coordinator = data.coordinatorName?.takeIf { it.isNotBlank() }
        val turns = if (data.maxTurns > 0) "${data.turnCount}/${data.maxTurns} 轮" else "${data.turnCount} 轮"
        Text(
            listOfNotNull(coordinator?.let { "协调者：$it" }, turns).joinToString(" · "),
            fontSize = 12.sp,
            color = secondaryTint,
        )
        data.detail?.takeIf { it.isNotBlank() }?.let { Text(it, fontSize = 14.sp) }
    }
}

@Composable
private fun CallRecordCard(record: LiveCallRecord) {
    val client = when (record.client) {
        "android", "ios" -> "手机"
        "web" -> "浏览器"
        "desktop" -> "电脑"
        else -> "其他设备"
    }
    RemoteCard(
        title = record.title?.takeIf { it.isNotBlank() } ?: "通话记录",
        body = null,
    ) {
        Text(
            "${callDurationLabel(record.seconds)} · $client",
            fontSize = 13.sp,
            color = secondaryTint,
        )
        val reason = callEndLabel(record.endReason)
        if (reason.isNotBlank()) Text(reason, fontSize = 12.sp, color = secondaryTint)
    }
}

@Composable
private fun WidgetSummaryCard(message: Message) {
    RemoteCard(title = "小组件", body = message.text) {
        val settled = message.widget?.settled
        if (settled != null && settled.label.isNotBlank()) {
            Text("已选择：${settled.label}", fontSize = 13.sp, color = secondaryTint)
        } else {
            Text("这个小组件的按钮需要在电脑上操作。", fontSize = 12.sp, color = secondaryTint)
        }
    }
}

@Composable
private fun AppSummaryCard(message: Message) {
    val data = message.app
    RemoteCard(
        title = data?.title?.takeIf { it.isNotBlank() } ?: "应用卡片",
        body = message.text,
    ) {
        Text(
            if (data?.source == "mcp") "MCP 应用" else "智能体页面",
            fontSize = 12.sp,
            color = secondaryTint,
        )
        Text("完整页面请在电脑上打开。", fontSize = 12.sp, color = secondaryTint)
    }
}

private fun callDurationLabel(seconds: Double): String {
    val total = seconds.coerceAtLeast(0.0).toInt()
    val minutes = total / 60
    val rest = total % 60
    return if (minutes > 0) "$minutes 分 $rest 秒" else "$rest 秒"
}

private fun callEndLabel(reason: String): String = when (reason) {
    "hung-up" -> "已挂断"
    "idle" -> "因长时间无对话结束"
    "expired" -> "已过期"
    "content" -> "因内容原因结束"
    "remote-hangup" -> "对方已挂断"
    "connection-lost" -> "连接中断"
    "sideband-lost" -> "连接中断"
    "deleted" -> "通话已删除"
    "shutdown" -> "服务已关闭"
    "signed-out" -> "登录已失效"
    "error" -> "通话出错"
    else -> ""
}

private fun connectorStatusLabel(card: ConnectorCardData): String = when {
    card.dismissed == true -> "已跳过。"
    card.status == "required" -> "智能体需要你连接这个应用。"
    card.status == "authorizing" -> "正在浏览器中等待授权完成…"
    card.status == "connected" -> if (card.resumed == true) "已连接，任务已继续。" else "已连接。"
    card.status == "failed" -> "上次连接没有完成。"
    else -> card.status
}

private fun secretStatusLabel(card: SecretRequestCardData): String = when {
    card.superseded == true -> "此请求已被更新的一次取代。"
    card.provided == true && card.resumed == true -> "已安全保存，任务已继续。"
    card.provided == true -> "已安全保存到电脑。"
    card.dismissed == true -> "已跳过。"
    else -> "电脑正在等待这个凭据。"
}

private fun routineStatusLabel(card: RoutineRunCardData): String = when (card.status) {
    "queued" -> "排队中"
    "running" -> "运行中"
    "waiting" -> "等待你处理"
    "completed" -> "已完成"
    "failed" -> "失败"
    "cancelled" -> "已取消"
    "missed" -> "已错过"
    else -> card.status
}

private fun goalStatusLabel(status: String): String = when (status) {
    "completed" -> "已完成"
    "needs-input" -> "需要你补充"
    "blocked" -> "被阻塞"
    "limit-reached" -> "达到轮次上限"
    "paused" -> "已暂停"
    "stopped" -> "已停止"
    "failed" -> "失败"
    else -> status
}

/**
 * The reply as it is being typed, styled to match the settled bubble it is about
 * to become — the handover should be invisible, and any difference in padding or
 * corner radius reads as the message jumping on arrival.
 *
 * A caret rather than a spinner: a spinner says "something is happening
 * somewhere", which the reader already knows. A caret at the end of real text
 * says how far along it is.
 */
@Composable
fun StreamingBubble(text: String?, reasoning: String?) {
    // The live reply wears the same bubble its settled version will, so the
    // handover is invisible. Only the answer gets the fill: a thought chamber
    // with nothing but reasoning has no text yet, and a bubble around the
    // chamber would be a bubble around a loading state.
    val bubbleShape = joinedBubbleShape(mine = false, startsRun = true, endsRun = true)
    val bubbleRim = minisBubbleRim
    Entrance {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .widthIn(max = 640.dp)
                .padding(vertical = 2.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            if (!reasoning.isNullOrEmpty() && text.isNullOrEmpty()) {
                // Folded away by default, because reasoning is not the answer.
                // Tail-limited: it runs to thousands of words and the part worth
                // reading is always the end. Plain lines, unlike the answer: the
                // tail cut lands wherever it lands, and rendering markdown that
                // starts mid-syntax invents structure the model did not write.
                ThoughtChamber(reasoning = reasoning)
            }
            if (!text.isNullOrEmpty()) {
                // Same renderer as the settled text: a live reply showing
                // `**bold**` that snaps to bold on arrival is the message
                // jumping, just in a different dimension.
                Box(
                    modifier = Modifier
                        .widthIn(max = 640.dp)
                        .background(BubbleColor.botBubble, bubbleShape)
                        .border(0.5.dp, bubbleRim, bubbleShape)
                        .padding(horizontal = 13.dp, vertical = 10.dp),
                ) {
                    MarkdownText(source = revealed(text), caret = true)
                }
            }
        }
    }
}

/**
 * The reply, revealed at reading speed instead of at network speed.
 *
 * The server sends a reply in chunks that have nothing to do with how fast a
 * person reads: three tokens, then a paragraph. Painting each chunk the moment
 * it lands is why a long answer arrives as a series of jumps. This draws the
 * same text at a steady rate and lets the stream catch up when it falls far
 * behind, so the eye sees writing rather than teleporting.
 *
 * A reply that is already long is not re-typed: past [TYPEWRITER_LIMIT]
 * characters the animation would be longer than the wait for the rest of it,
 * and re-parsing a large markdown document thirty times a second is real work
 * for a flourish. And with no clock — a test, a preview, animations turned off —
 * the text is simply the text.
 */
@Composable
private fun revealed(text: String): String {
    val time = rememberFaceTime()
    val shown = remember { mutableIntStateOf(0) }
    LaunchedEffect(text, time == null) {
        if (time == null || text.length > TYPEWRITER_LIMIT) {
            shown.intValue = text.length
            return@LaunchedEffect
        }
        // A new reply (the text got shorter) starts again from the first
        // character rather than inheriting the last one's position.
        if (shown.intValue > text.length) shown.intValue = 0
        while (shown.intValue < text.length) {
            val gap = text.length - shown.intValue
            // Catch up in bigger steps when the stream is ahead of the reveal,
            // so the animation never becomes a lag behind the model.
            val step = when {
                gap > 400 -> gap / 6
                gap > 120 -> 4
                gap > 40 -> 2
                else -> 1
            }
            shown.intValue = min(text.length, shown.intValue + step)
            delay(if (gap > 120) 16 else 30)
        }
    }
    return text.take(shown.intValue.coerceIn(0, text.length))
}

/** Past this many characters the reply is shown at once; see [revealed]. */
private const val TYPEWRITER_LIMIT = 2_000

/** The gutter your own bubble keeps from the left edge. */
private val USER_BUBBLE_GUTTER = 56.dp

/** A bubble's own horizontal padding, needed to know how wide its text may be. */
private val BUBBLE_HORIZONTAL_PADDING = 13.dp

/**
 * How much room the bot's bubble leaves on its far side, measured rather than
 * guessed.
 *
 * The answer is laid out at the widest width the bubble may take, and the lines
 * that produces decide the gutter: a short answer keeps [BotBubbleGutter.SHORT]
 * so the two sides read as two speakers, a long one gets [BotBubbleGutter.LONG]
 * because every dp taken from the right is a word pushed to the next line.
 *
 * Measured here rather than inside the bubble because the gutter is a `Spacer`
 * beside the bubble: by the time the text knows how tall it is, the space next to
 * it has already been handed out.
 */
@Composable
private fun botBubbleGutter(text: String?, columnWidth: Dp): Dp {
    if (text.isNullOrBlank()) return BotBubbleGutter.SHORT
    val measurer = rememberTextMeasurer()
    val widest = (columnWidth - BotBubbleGutter.SHORT - BUBBLE_HORIZONTAL_PADDING * 2)
        .coerceAtLeast(1.dp)
    val widestPx = with(LocalDensity.current) { widest.roundToPx() }
    val lines = remember(text, widestPx, measurer) {
        // The raw markdown source is what gets measured, so a table or a heavy
        // list counts a little long: its syntax characters never reach the
        // screen. That errs toward the wide bubble, which is the harmless
        // direction — the cost is a few dp of margin, not a clipped line.
        measurer.measure(
            text = AnnotatedString(text),
            style = TextStyle(fontSize = 17.sp, lineHeight = 24.sp),
            maxLines = BotBubbleGutter.LONG_ANSWER_LINES + 1,
            constraints = Constraints(maxWidth = widestPx),
        ).lineCount
    }
    return BotBubbleGutter.of(lines)
}

/**
 * A gentle arrival: the reply rises the last few dp and fades in, so the
 * transcript gains a line instead of being redrawn with one more.
 *
 * Forced through a transition state rather than a plain `AnimatedVisibility`,
 * because those start settled and would show nothing on the one composition
 * that matters.
 */
@Composable
private fun Entrance(content: @Composable () -> Unit) {
    val state = remember { MutableTransitionState(false).apply { targetState = true } }
    AnimatedVisibility(
        visibleState = state,
        enter = fadeIn(tween(180)) + slideInVertically(tween(240)) { it / 3 },
    ) {
        content()
    }
}

/**
 * The beat between "go" and the first token — the port of the `else if
 * current.busy` branch of `ChatView.swift` and of `TypingIndicatorView`.
 *
 * The reason this exists is the sentence in the semantics block, not the dots.
 * Busy already reaches a sighted reader twice over — the mascot wears a working
 * face and the composer offers an interrupt — and reached a TalkBack reader
 * through neither. The row is a polite live region, so it is spoken when it
 * appears, and it carries a name of its own, so it can also be found by swiping
 * to the end of the transcript.
 *
 * Drawn in the same bubble as the reply that will replace it, and in the bot's
 * own colour, so the handover is the text arriving rather than the shape
 * changing. Everything Apple about the original — the capsule, the secondary
 * fill, the `TimelineView`, the scale wave — is left where it was; see
 * [WorkingDots].
 */
@Composable
fun WorkingBubble(chat: Chat, whisper: String? = null) {
    val label = LiveTail.workingLabel(chat.name)
    Entrance {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .semantics {
                contentDescription = label
                liveRegion = LiveRegionMode.Polite
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // The running face: the bot's own portrait inside a slow arc, so the
        // row is visibly alive without pretending to know a percentage.
        Box(modifier = Modifier.size(34.dp), contentAlignment = Alignment.Center) {
            PresetBotAvatar(
                color = chat.color,
                size = 24.dp,
                contentDescription = null,
                motion = AvatarMotion.SHEEN,
                // Eyes up: the row's face is doing the same thing the header's
                // is, which is what makes the two read as one bot.
                mood = FaceMood.WORKING,
            )
            WorkingRing(minisAccent)
        }
        Spacer(Modifier.width(10.dp))
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "正在工作",
                    fontSize = 15.sp,
                    color = minisSecondary,
                )
                Spacer(Modifier.width(6.dp))
                WorkingDotsView(minisTertiary)
            }
            // The computer's own status line, or the reasoning tail it is
            // currently producing. This is the "碎碎念": real work, never a
            // carousel of invented reassurances. The reasoning is one line
            // here even in 精简 mode — the full chamber is the verbose view.
            // "working" is the harness's generic flag, not a sentence: under a
            // line that already says 正在工作 it would be the same word twice,
            // in another language. Only a specific activity earns this line;
            // otherwise the reasoning tail speaks.
            val generic = setOf("working", "busy", "running", "thinking")
            val mutter = chat.activity
                ?.trim()
                ?.takeIf { it.isNotBlank() && it.lowercase() !in generic }
                ?: whisper?.takeIf { it.isNotBlank() }
            mutter?.let { line ->
                // The line changes whenever the computer has something new to
                // say, and a hard cut between two sentences reads as a glitch.
                // One line out, the next in, in two hundred milliseconds.
                AnimatedContent(
                    targetState = line,
                    transitionSpec = {
                        (fadeIn(tween(200)) + slideInVertically(tween(200)) { it / 3 }) togetherWith
                            (fadeOut(tween(120)) + slideOutVertically(tween(120)) { -it / 3 })
                    },
                    label = "mutter",
                ) { current ->
                    Text(
                        text = current,
                        fontSize = 12.sp,
                        color = minisTertiary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
    }
}

/** A 110° arc going round the working portrait once every 1.4 s. */
@Composable
private fun WorkingRing(color: Color) {
    val transition = rememberInfiniteTransition(label = "working-ring")
    val angle by transition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1_400, easing = LinearEasing),
        ),
        label = "angle",
    )
    Canvas(modifier = Modifier.size(34.dp)) {
        val stroke = 2.dp.toPx()
        // A sweep gradient rather than one flat colour: a solid arc is a dial,
        // an arc that fades along its length is something loading. The gradient
        // is rotated with the arc so its bright head stays at the front.
        val brush = Brush.sweepGradient(
            0f to color,
            0.02f to color,
            0.30f to Color.Transparent,
            1f to Color.Transparent,
            center = center,
        )
        rotate(angle) {
            drawArc(
                brush = brush,
                startAngle = 0f,
                sweepAngle = 110f,
                useCenter = false,
                topLeft = Offset(stroke / 2f, stroke / 2f),
                size = Size(size.width - stroke, size.height - stroke),
                style = Stroke(width = stroke, cap = StrokeCap.Round),
            )
        }
    }
}

/** `WorkingDots`' alpha curve, drawn — three dots breathing out of phase. */
@Composable
internal fun WorkingDotsView(color: Color) {
    val transition = rememberInfiniteTransition(label = "working-dots")
    val phase by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1_100, easing = LinearEasing),
        ),
        label = "phase",
    )
    Canvas(modifier = Modifier.size(width = 24.dp, height = 8.dp)) {
        val radius = 2.2.dp.toPx()
        val step = 7.dp.toPx()
        repeat(WorkingDots.COUNT) { index ->
            val alpha = WorkingDots.alpha(
                index = index,
                elapsedNanos = (phase * WorkingDots.PERIOD_NANOS).toLong(),
                moving = true,
            )
            drawCircle(
                color = color.copy(alpha = alpha),
                radius = radius,
                center = Offset(radius + index * step, size.height / 2f),
            )
        }
    }
}
