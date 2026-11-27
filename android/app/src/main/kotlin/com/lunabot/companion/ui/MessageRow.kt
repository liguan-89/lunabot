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
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
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
import com.lunabot.companion.core.PhoneSecretCrypto
import com.lunabot.companion.core.PhoneSecretEntryBlocker
import com.lunabot.companion.core.SecretCardAction
import com.lunabot.companion.core.SecretCardProvideResult
import com.lunabot.companion.core.SecretRequestCardData
import com.lunabot.companion.core.phoneSecretEntryBlocker
import com.lunabot.companion.core.sealPhoneSecret
import com.lunabot.companion.core.AttachedMessageContent
import com.lunabot.companion.core.fileAttachments
import com.lunabot.companion.core.generatedImages
import com.lunabot.companion.core.voiceNotes
import com.lunabot.companion.core.DisplayedMessageAttachment
import com.lunabot.companion.core.DownloadedFile
import com.lunabot.companion.core.DataResultData
import com.lunabot.companion.core.Message
import com.lunabot.companion.core.OptionCard
import com.lunabot.companion.core.ThreadRef
import com.lunabot.companion.core.ToolActivity
import com.lunabot.companion.core.forTask
import com.lunabot.companion.core.TranscriptCard
import com.lunabot.companion.core.TranscriptCards
import com.lunabot.companion.core.webhookContent
import com.lunabot.companion.ui.widget.WidgetCardMessage
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
    /** Widget `open_thread` 到群线程时的导航出口；null 时该 action 不响应。 */
    openChat: ((Chat) -> Unit)? = null,
    /**
     * Where a tapped screenshot goes: the bot's live computer. Null leaves the
     * still inert, which is what rooms and non-bot transcripts get — a screen
     * belongs to one bot, and there is no second bot to open.
     */
    openComputer: (() -> Unit)? = null,
    /** A data_show receipt's chip opens the bot's Data viewer at that card. */
    onOpenData: ((botId: String, cardId: String) -> Unit)? = null,
    /** Resolves a quote's message id in this transcript; absent quotes nothing. */
    quoteOf: (String) -> Message? = { null },
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
                openChat = openChat,
                openComputer = openComputer,
                onOpenData = onOpenData,
                quoteOf = quoteOf,
            )

            message.comm?.let { comm ->
                val targetBot = state.bot(comm.withBotId)
                TranscriptEventPill(
                    text = "已向 ${comm.withName} 发送消息",
                    leading = {
                        if (targetBot != null) {
                            BotAvatar(
                                bot = targetBot,
                                size = 18.dp,
                                animated = false,
                                fallback = AvatarFallback.PRESET,
                            )
                        } else {
                            PresetBotAvatar(
                                color = comm.withColor,
                                size = 18.dp,
                                contentDescription = null,
                            )
                        }
                    },
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
    openChat: ((Chat) -> Unit)? = null,
    openComputer: (() -> Unit)?,
    onOpenData: ((botId: String, cardId: String) -> Unit)? = null,
    quoteOf: (String) -> Message? = { null },
) {
    when (message.kind) {
        Message.Kind.TEXT -> when {
            message.grantProposal != null -> GrantProposalCard(chat.threadId, message)
            message.setupSuggestion != null -> HelperSuggestionCard(chat.threadId, message)
            else -> TextBubble(chat, message, startsRun, endsRun, openLink, openAttachment,
                quoted = message.replyToId?.let(quoteOf))
        }
        // A structured ask draws its own card: its answers are the model's
        // questions, not an allow/deny a tap could stand for.
        Message.Kind.OPTIONS -> if (QuestionCardRules.drawsQuestionCard(message)) {
            QuestionCardView(chat, message, haptics)
        } else if (message.card?.requestId == null) {
            OpenQuestionCard(chat, message, haptics)
        } else {
            CardView(chat, message, haptics)
        }
        Message.Kind.ACTIVITY -> {
            val dataResult = message.dataResult
            if (message.tool?.name == "data_show" && dataResult != null && onOpenData != null) {
                DataResultChip(dataResult, onOpenData)
            } else {
                ActivityChip(message.tool, message.threadRef, openThread, threadId = chat.threadId, messageId = message.id)
            }
            // Claude Code too old for the model: offer the update on the
            // engine this bot's thread runs on. Rooms have no single engine.
            val claudeInstance = (chat as? Chat.BotChat)?.bot
                ?.let { it.forTask(chat.threadId) ?: it }
                ?.modelSelection?.instanceId
            if (message.tool?.claudeUpdate == true && claudeInstance != null) {
                ClaudeUpdateCard(messageId = message.id, instanceId = claudeInstance)
            }
            // 额度限制停住的回合：提供「到点继续」。与桌面端同一条边界——房间
            // 没有单一 botId，continue 路由又按 botId+threadId 点名会话，所以
            // 只有一对一会话提供。
            val limitBotId = (chat as? Chat.BotChat)?.bot?.id
            val limitResetsAt = message.tool?.limitResetsAt
            if (limitResetsAt != null && limitBotId != null) {
                LimitResetContinueRow(
                    messageId = message.id,
                    botId = limitBotId,
                    threadId = chat.threadId,
                    resetsAt = limitResetsAt,
                )
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
        // A bot-authored widget renders the same tree the desktop mounts; a
        // press rides the shared widgetAction message route. Only when the row
        // carries no tree does it stay the readable receipt.
        Message.Kind.WIDGET -> if (message.widget != null || !message.text.isNullOrEmpty()) {
            WidgetCardMessage(
                chat = chat,
                message = message,
                openLink = openLink,
                openThread = openThread,
                openChat = openChat,
                fallback = { WidgetSummaryCard(message) },
            )
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
    /** The message this one quotes, already resolved; null quotes nothing. */
    quoted: Message? = null,
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
    val bubbleText = attached.text.takeIf { it.isNotEmpty() } ?: message.text
    val isStandalone = startsRun && endsRun
    BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
        val columnWidth = maxWidth
        val botGutter = when {
            mine -> 0.dp
            !isStandalone -> BotBubbleGutter.LONG
            else -> botBubbleGutter(
                text = bubbleText,
                columnWidth = columnWidth,
            )
        }
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
                                .then(if (mine) Modifier.border(0.5.dp, bubbleRim, bubbleShape) else Modifier)
                                .padding(horizontal = 15.dp, vertical = 10.dp)
                        } else {
                            Modifier
                        },
                    ),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
            // A flat reply quotes the line it answers, one line of it, the way
            // the desktop's inline quote does; an unresolved id quotes nothing.
            quoted?.let { anchor ->
                Row(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Box(
                        modifier = Modifier
                            .width(2.5.dp)
                            .height(16.dp)
                            .background(minisSecondary.copy(alpha = 0.5f), RoundedCornerShape(2.dp)),
                    )
                    Text(
                        text = anchor.text.orEmpty().replace('\n', ' ').take(80),
                        fontSize = 12.sp,
                        color = minisSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
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
            // A workspace with several people attributes your side too, and an
            // outside line says how it got in: the API, a Live call, or a relay
            // nobody typed here.
            if (mine) {
                val senderName = message.sender?.name
                val attribution = when {
                    senderName != null -> senderName
                    message.relayed == true -> "经外部接口转发"
                    message.via == "call" -> "语音来电"
                    message.via == "api" -> "经 API 发送"
                    else -> null
                }
                if (attribution != null) {
                    Text(
                        text = attribution,
                        fontSize = 11.5.sp,
                        color = minisSecondary,
                        fontWeight = FontWeight.Medium,
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
private data class SystemPromptBubble(
    val badge: String,
    val preview: String,
    val fullText: String,
)

private fun parseSystemPromptBubble(text: String): SystemPromptBubble? {
    val trimmed = text.trimStart()
    val badge = when {
        trimmed.startsWith("[From Luna Bot") -> "系统事件报告"
        trimmed.startsWith("[Scheduled routine") -> "定时巡检触发"
        else -> return null
    }
    val closing = trimmed.indexOf(']')
    val body = if (closing in 1 until trimmed.lastIndex) {
        trimmed.substring(closing + 1).trim()
    } else {
        trimmed
    }
    val preview = body.lineSequence()
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .joinToString(" ")
        .ifEmpty { trimmed }
    return SystemPromptBubble(badge = badge, preview = preview, fullText = trimmed)
}

@Composable
private fun SystemPromptCollapse(prompt: SystemPromptBubble, color: Color) {
    var expanded by remember(prompt.fullText) { mutableStateOf(false) }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button) { expanded = !expanded },
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = prompt.badge,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                color = color.copy(alpha = 0.72f),
            )
            Text(
                text = if (expanded) "收起" else "展开详情",
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                color = minisAccent,
            )
        }
        Text(
            text = if (expanded) prompt.fullText else prompt.preview,
            fontSize = 13.5.sp,
            lineHeight = 20.sp,
            color = color.copy(alpha = if (expanded) 0.86f else 0.74f),
            maxLines = if (expanded) Int.MAX_VALUE else 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun UserMessageText(text: String) {
    val color = BubbleColor.userBubbleText
    parseSystemPromptBubble(text)?.let { prompt ->
        SystemPromptCollapse(prompt = prompt, color = color)
        return
    }
    if (!text.startsWith(">")) {
        Text(
            text = text,
            fontSize = 15.5.sp,
            lineHeight = 22.sp,
            fontWeight = FontWeight.Medium,
            letterSpacing = 0.08.sp,
            color = color,
        )
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
        Text(
            text = text,
            fontSize = 15.5.sp,
            lineHeight = 22.sp,
            fontWeight = FontWeight.Medium,
            letterSpacing = 0.08.sp,
            color = color,
        )
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
                fontSize = 13.5.sp,
                color = color.copy(alpha = 0.72f),
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (body.isNotEmpty()) {
            Text(
                text = body,
                fontSize = 15.5.sp,
                lineHeight = 22.sp,
                fontWeight = FontWeight.Medium,
                letterSpacing = 0.08.sp,
                color = color,
            )
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
    threadId: String? = null,
    messageId: String? = null,
) {
    if (tool == null) return
    // The AI has answered since: the notice said "no answer yet" about a turn
    // that has one, and the desktop drops the same row. [transcriptRows] hides
    // it too; this is the second door, for a caller that draws a row directly.
    if (tool.rescue?.answered == true) return
    val status = ActivityReceipt.status(tool.ok)
    val dark = minisIsDark()
    val errorInk = if (dark) Color(0xFFE59688) else Color(0xFF9E4B3B)
    val haptics = rememberHaptics()
    val state by LocalCompanion.current.session.state.collectAsState()
    val label = readableActivityName(
        ActivityNaming.toolLabel(ActivityNaming.rescueEngine(tool.name, tool.rescue)),
    )
    val handoffBot = remember(state.bots, threadRef, label) {
        threadRef?.botId?.let(state::bot)
            ?: state.bots.firstOrNull { bot ->
                bot.name.isNotBlank() && (
                    label.startsWith("${bot.name} ") ||
                        label.endsWith(" ${bot.name}") ||
                        label.contains("「${bot.name}」")
                    )
            }
    }
    // A chip with more to say than one line — what the call did, read or
    // wrote back — opens it in a sheet; a thread chip keeps its jump instead.
    val detail = remember(tool) {
        listOfNotNull(tool.summary, tool.input, tool.output, tool.problem)
            .any { it.isNotBlank() } || tool.fullResult == true
    }
    var showDetail by remember(tool, messageId) { mutableStateOf(false) }
    val onOpen = if (threadRef != null && openThread != null) {
        {
            haptics.play(TactileAction.OPEN_THREAD_CHIP)
            openThread(threadRef)
        }
    } else if (detail) {
        { showDetail = true }
    } else {
        null
    }
    TranscriptEventPill(
        text = label,
        error = status == ActivityStatus.ERROR,
        onClick = onOpen,
        contentDescriptionText = ActivityReceipt.announcement(label, status),
        leading = {
            when {
                handoffBot != null -> BotAvatar(
                    bot = handoffBot,
                    size = 18.dp,
                    animated = false,
                    fallback = AvatarFallback.PRESET,
                )
                status == ActivityStatus.ERROR -> Icon(
                    imageVector = Icons.Filled.Warning,
                    contentDescription = null,
                    tint = errorInk,
                    modifier = Modifier.size(13.dp),
                )
                status == ActivityStatus.RUNNING -> CircularProgressIndicator(
                    modifier = Modifier.size(12.dp),
                    strokeWidth = 1.5.dp,
                )
                else -> Icon(
                    imageVector = Icons.Filled.Check,
                    contentDescription = null,
                    tint = minisSecondary.copy(alpha = 0.78f),
                    modifier = Modifier.size(13.dp),
                )
            }
        },
        trailing = when {
            ActivityReceipt.showsLabel(status) -> {
                {
                    Text(
                        text = ActivityReceipt.label(status),
                        fontSize = 11.5.sp,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        color = if (status == ActivityStatus.ERROR) errorInk else minisSecondary,
                    )
                }
            }
            onOpen != null -> {
                {
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                        contentDescription = null,
                        tint = minisSecondary,
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
            else -> null
        },
    )

    if (showDetail) {
        ActivityDetailDialog(
            tool = tool,
            threadId = threadId,
            messageId = messageId,
            onDismiss = { showDetail = false },
        )
    }
}

/** The activity chip's sheet: what the call did, read and wrote back, in the
 * chip's own words. A truncated output the harness spilled whole server-side
 * is fetched on demand — never eagerly, one tap only. */
@Composable
private fun ActivityDetailDialog(
    tool: ToolActivity,
    threadId: String?,
    messageId: String?,
    onDismiss: () -> Unit,
) {
    val session = LocalCompanion.current.session
    val scope = rememberCoroutineScope()
    var fullOutput by remember(messageId) { mutableStateOf<String?>(null) }
    var loadingFull by remember(messageId) { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            Text(
                text = "关闭",
                fontSize = 14.5.sp,
                fontWeight = FontWeight.Medium,
                color = minisInk,
                modifier = Modifier
                    .clickable(role = Role.Button, onClick = onDismiss)
                    .padding(horizontal = 16.dp, vertical = 10.dp),
            )
        },
        title = {
            Text(
                text = readableActivityName(ActivityNaming.toolLabel(ActivityNaming.rescueEngine(tool.name, tool.rescue))),
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                color = minisInk,
            )
        },
        text = {
            Column(
                verticalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.verticalScroll(rememberScrollState()),
            ) {
                listOf(
                    "摘要" to tool.summary,
                    "输入" to tool.input,
                    "输出" to (fullOutput ?: tool.output),
                    "问题" to tool.problem,
                ).forEach { (label, value) ->
                    if (!value.isNullOrBlank()) {
                        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text(text = label, fontSize = 12.sp, fontWeight = FontWeight.Medium, color = minisSecondary)
                            Text(
                                text = value,
                                fontSize = 13.sp,
                                color = minisInk,
                                fontFamily = if (label == "输入" || label == "输出") FontFamily.Monospace else null,
                            )
                        }
                    }
                }
                if (fullOutput == null && tool.fullResult == true && threadId != null && messageId != null) {
                    MuseSecondaryPillButton(
                        text = if (loadingFull) "加载中…" else "加载完整输出",
                        onClick = {
                            if (loadingFull) return@MuseSecondaryPillButton
                            loadingFull = true
                            scope.launch {
                                fullOutput = session.toolOutput(threadId, messageId)
                                loadingFull = false
                            }
                        },
                        enabled = !loadingFull,
                    )
                }
            }
        },
    )
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
    val cleaned = cleanActivityText(body)
    return friendlyToolLabel(cleaned)
}

private fun friendlyToolLabel(raw: String): String {
    val repeatMatch = Regex("^(.*?)(\\s*×\\d+)$").matchEntire(raw)
    val core = repeatMatch?.groupValues?.get(1)?.trim() ?: raw
    val suffix = repeatMatch?.groupValues?.get(2).orEmpty()
    val normalized = core.lowercase()
    val phoneUiAction = when {
        normalized.startsWith("mcp__device__phone_ui_") -> normalized.removePrefix("mcp__device__phone_ui_")
        normalized.startsWith("device_phone_ui_") -> normalized.removePrefix("device_phone_ui_")
        normalized.startsWith("phone_ui_") -> normalized.removePrefix("phone_ui_")
        else -> null
    }
    val mapped = when {
        phoneUiAction != null -> when {
            "observe" in phoneUiAction || "screenshot" in phoneUiAction ||
                "snapshot" in phoneUiAction || "read" in phoneUiAction -> "读取手机屏幕"
            "tap" in phoneUiAction || "click" in phoneUiAction -> "点击手机屏幕"
            "type" in phoneUiAction || "input" in phoneUiAction -> "输入手机文字"
            "swipe" in phoneUiAction || "scroll" in phoneUiAction -> "滑动手机屏幕"
            "back" in phoneUiAction || "home" in phoneUiAction -> "导航手机界面"
            else -> "操作手机界面"
        }
        normalized == "agents_trigger" -> "触发协作助手"
        normalized == "agents_retry_thread" -> "重试助手话题"
        normalized == "agents_session_search" -> "检索历史会话"
        normalized == "agents_send" || normalized == "agents_message" -> "向助手发消息"
        normalized == "agents_list" || normalized == "agents_status" -> "查看助手状态"
        normalized.startsWith("agents_") -> "协作助手操作"
        normalized == "manage_routine" -> "管理定时巡检"
        normalized == "create_routine" -> "创建定时巡检"
        normalized == "delete_routine" -> "删除定时巡检"
        normalized.startsWith("mcp__") -> {
            val segments = core.removePrefix("mcp__").split("__").filter { it.isNotBlank() }
            val tool = segments.lastOrNull().orEmpty()
                .replace('_', ' ')
                .trim()
            if (tool.isEmpty()) core else tool.lowercase().replaceFirstChar { it.uppercase() }
        }
        normalized.startsWith("device_") -> {
            val tool = core.removePrefix("device_").replace('_', ' ').trim()
            if (tool.isEmpty()) core else tool.lowercase().replaceFirstChar { it.uppercase() }
        }
        else -> core
    }
    return mapped + suffix
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
    val hasDetail = detail.isNotEmpty() && detail != label
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        TranscriptEventPill(
            text = label,
            leading = {
                Box(
                    modifier = Modifier
                        .size(ACTIVITY_DOT)
                        .background(minisSecondary.copy(alpha = 0.72f), CircleShape),
                )
            },
            trailing = if (hasDetail) {
                {
                    Text(
                        text = if (expanded) "收起" else "展开",
                        fontSize = 11.5.sp,
                        color = minisSecondary,
                    )
                }
            } else {
                null
            },
            onClick = if (hasDetail) {
                {
                    haptics.play(TactileAction.TOGGLE_ACTIVITY_RUN)
                    expanded = !expanded
                }
            } else {
                null
            },
        )
        if (expanded && hasDetail) {
            Text(
                text = detail,
                fontSize = 12.sp,
                lineHeight = 18.sp,
                color = minisSecondary,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .background(minisSoftCard)
                    .padding(horizontal = 12.dp, vertical = 10.dp),
            )
        }
    }
}

/** Several consecutive successful/running activity receipts, folded on demand. */
@Composable
fun ActivityRunChip(items: List<Message>, openThread: ((ThreadRef) -> Unit)? = null, threadId: String? = null) {
    if (items.isEmpty()) return
    var expanded by remember(items.first().id) { mutableStateOf(false) }
    val running = items.any { it.tool?.ok == null }
    val summary = if (running) "正在运行 ${items.size} 个步骤" else "已运行 ${items.size} 个步骤"
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        RunReceiptPill(
            summary = summary,
            expanded = expanded,
            running = running,
            onToggle = { expanded = !expanded },
        )
        if (expanded) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                items.forEach { item -> ActivityChip(item.tool, item.threadRef, openThread, threadId = threadId, messageId = item.id) }
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
    val style = ApprovalCardStyle.of(card, chat)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .musePaperCard(danger = style.isPending && style.danger)
            .padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ApprovalStateLine(style)

        Text(card.title, fontSize = 16.5.sp, fontWeight = FontWeight.SemiBold, color = minisInk)
        ExpandableText(
            text = card.subtitle,
            style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, color = minisSecondary),
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
                            color = minisInk,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            "sha256 ${reviewed.take(8)}",
                            fontSize = 12.sp,
                            fontFamily = FontFamily.Monospace,
                            color = minisSecondary,
                        )
                    }
                    SelectionContainer {
                        Text(
                            "来源：${skill.source ?: "未知"}",
                            fontSize = 12.sp,
                            color = minisSecondary,
                        )
                    }
                    SelectionContainer {
                        Text(
                            skill.preview.orEmpty(),
                            fontSize = 12.sp,
                            fontFamily = FontFamily.Monospace,
                            color = minisInk,
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(max = 220.dp)
                                .verticalScroll(rememberScrollState())
                                .background(minisSoftCard, RoundedCornerShape(12.dp))
                                .padding(12.dp),
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

        card.tool?.takeIf { it.isNotBlank() }?.let { tool ->
            val label = friendlyToolLabel(tool)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(minisSoftCard, RoundedCornerShape(12.dp))
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = label,
                    fontSize = 13.sp,
                    fontFamily = if (label == tool) FontFamily.Monospace else FontFamily.Default,
                    color = minisInk.copy(alpha = 0.84f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        if (style.showsActions) {
            MuseCardDivider()
            val chooseOption: (String) -> Unit = { option ->
                haptics.play(TactileAction.CHOOSE_APPROVAL)
                answering = true
                scope.launch {
                    ApprovalAnswers.choose(session, chat, card, option)
                    answering = false
                }
            }
            val isEnabled: (Boolean) -> Boolean = { refusal ->
                !answering && (skillRequest == null || refusal || skillRequest.reviewedSha256 != null)
            }
            val twoChoicePair = card.options.size == 2 &&
                card.options.count { ApprovalChoices.emphasis(it) == OptionEmphasis.SECONDARY } == 1
            if (twoChoicePair) {
                val refusalOption = card.options.first { ApprovalChoices.emphasis(it) == OptionEmphasis.SECONDARY }
                val primaryOption = card.options.first { ApprovalChoices.emphasis(it) != OptionEmphasis.SECONDARY }
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    MuseSecondaryPillButton(
                        text = refusalOption,
                        onClick = { chooseOption(refusalOption) },
                        enabled = isEnabled(true),
                        modifier = Modifier.weight(1f),
                    )
                    MusePrimaryPillButton(
                        text = primaryOption,
                        onClick = { chooseOption(primaryOption) },
                        enabled = isEnabled(false),
                        danger = style.danger,
                        modifier = Modifier.weight(1f),
                    )
                }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    card.options.forEach { option ->
                        val refusal = ApprovalChoices.emphasis(option) == OptionEmphasis.SECONDARY
                        if (refusal) {
                            MuseSecondaryPillButton(
                                text = option,
                                onClick = { chooseOption(option) },
                                enabled = isEnabled(true),
                                modifier = Modifier.fillMaxWidth(),
                            )
                        } else {
                            MusePrimaryPillButton(
                                text = option,
                                onClick = { chooseOption(option) },
                                enabled = isEnabled(false),
                                danger = style.danger,
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                }
            }

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
                        Text("始终允许此工具", fontSize = 13.sp, color = minisSecondary)
                    }
                }
            }
        }

        if (style.showsStamp) {
            ApprovalStamp(style)
        }
    }
}

/** The state line above a card's title: Muse Plan-H warm-sand disc + calm label. */
@Composable
private fun ApprovalStateLine(style: ApprovalCardStyle) {
    val dotTint = when (style.state) {
        ApprovalState.PENDING -> if (style.danger) minisDanger else Color(0xFFC4B094)
        ApprovalState.ALLOWED -> minisSuccess
        ApprovalState.DENIED, ApprovalState.EXPIRED, ApprovalState.SETTLED -> minisSecondary
    }
    val badgeFill = if (style.state == ApprovalState.PENDING && style.danger) {
        minisDanger.copy(alpha = 0.12f)
    } else {
        minisWarmSand
    }
    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        MuseCardBadge(size = 22.dp, tint = badgeFill) {
            when (style.state) {
                ApprovalState.PENDING -> if (style.danger) {
                    Icon(
                        imageVector = Icons.Filled.Warning,
                        contentDescription = null,
                        tint = minisDanger,
                        modifier = Modifier.size(12.dp),
                    )
                } else {
                    Box(Modifier.size(7.dp).background(dotTint, CircleShape))
                }
                ApprovalState.ALLOWED -> Icon(
                    imageVector = Icons.Filled.Check,
                    contentDescription = null,
                    tint = minisSuccess,
                    modifier = Modifier.size(12.dp),
                )
                ApprovalState.EXPIRED -> Icon(
                    painter = painterResource(R.drawable.ic_schedule),
                    contentDescription = null,
                    tint = minisSecondary,
                    modifier = Modifier.size(12.dp),
                )
                ApprovalState.DENIED, ApprovalState.SETTLED -> Box(
                    Modifier.size(6.dp).background(minisTertiary, CircleShape),
                )
            }
        }
        Text(
            text = style.label,
            fontSize = 12.5.sp,
            fontWeight = FontWeight.Medium,
            color = if (style.state == ApprovalState.PENDING && style.danger) minisDanger else minisSecondary,
        )
    }
}

/** What a settled card leaves behind: one line, behind a hairline. */
@Composable
private fun ApprovalStamp(style: ApprovalCardStyle) {
    val tint = if (style.state == ApprovalState.ALLOWED) minisSuccess else minisSecondary
    MuseCardDivider()
    Row(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (style.state == ApprovalState.ALLOWED) {
            Icon(
                imageVector = Icons.Filled.Check,
                contentDescription = null,
                tint = tint,
                modifier = Modifier.size(13.dp),
            )
        }
        Text(
            text = style.stamp.orEmpty(),
            fontSize = 12.5.sp,
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
    iconRes: Int? = null,
    statusPill: String? = null,
    statusDanger: Boolean = false,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .musePaperCard(danger = statusDanger)
            .padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            iconRes?.let { res ->
                MuseCardBadge(
                    size = 38.dp,
                    tint = if (statusDanger) minisDanger.copy(alpha = 0.12f) else minisWarmSand,
                ) {
                    Icon(
                        painter = painterResource(res),
                        contentDescription = null,
                        tint = if (statusDanger) minisDanger else minisInk,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = title,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = minisInk,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    statusPill?.takeIf { it.isNotBlank() }?.let {
                        Box(
                            modifier = Modifier
                                .clip(CircleShape)
                                .background(if (statusDanger) minisDanger.copy(alpha = 0.12f) else minisSoftCard)
                                .padding(horizontal = 9.dp, vertical = 3.dp),
                        ) {
                            Text(
                                text = it,
                                fontSize = 11.5.sp,
                                fontWeight = FontWeight.Medium,
                                color = if (statusDanger) minisDanger else minisSecondary,
                                maxLines = 1,
                            )
                        }
                    }
                }
                body?.takeIf { it.isNotBlank() }?.let {
                    SelectionContainer {
                        Text(it, fontSize = 13.5.sp, lineHeight = 19.sp, color = minisSecondary)
                    }
                }
            }
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

    val openAuthorize: () -> Unit = {
        scope.launch {
            working = true
            try {
                val url = session.authorizeConnector(data.slug, data.alias) ?: return@launch
                try {
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
    }

    val badgeText = when {
        data.dismissed == true -> "已跳过"
        data.status == "connected" -> "已连接"
        data.status == "authorizing" -> "授权中"
        data.status == "failed" -> "失败"
        else -> "待授权"
    }
    RemoteCard(
        title = "连接 ${data.label}",
        body = data.description.ifBlank { connectorStatusLabel(data) },
        iconRes = R.drawable.ic_hub,
        statusPill = badgeText,
        statusDanger = data.status == "failed",
    ) {
        data.error?.takeIf { it.isNotBlank() }?.let {
            Text(it, fontSize = 13.sp, color = minisWarning)
        }
        Text(
            "授权在浏览器中完成，令牌仅保存在电脑端。",
            fontSize = 12.sp,
            color = minisTertiary,
        )
        val needsConnect = data.status == "required" || data.status == "failed"
        val canClose = data.isPending && botId != null
        if (needsConnect || canClose) {
            MuseCardDivider()
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (canClose) {
                    MuseSecondaryPillButton(
                        text = "跳过",
                        onClick = { close(ConnectorCardAction.DISMISS) },
                        enabled = !working,
                        modifier = Modifier.weight(1f),
                    )
                }
                if (needsConnect) {
                    MusePrimaryPillButton(
                        text = if (working) "正在打开…" else "前往授权",
                        onClick = openAuthorize,
                        enabled = !working,
                        modifier = Modifier.weight(1f),
                    )
                } else if (canClose && data.status == "authorizing") {
                    MusePrimaryPillButton(
                        text = "已完成，继续",
                        onClick = { close(ConnectorCardAction.RESUME) },
                        enabled = !working,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
    }
}

@Composable
private fun SecretRequestCard(message: Message, botId: String?, threadId: String) {
    val data = message.secret ?: return
    val uriHandler = LocalUriHandler.current
    val session = LocalCompanion.current.session
    val connection by session.transportConnection.collectAsState()
    val scope = rememberCoroutineScope()
    var working by remember(message.id, data.requestKey) { mutableStateOf(false) }
    var secretValue by remember(message.id, data.requestKey) { mutableStateOf("") }
    var sealedEnvelope by remember(message.id, data.requestKey) {
        mutableStateOf<PhoneSecretCrypto.Envelope?>(null)
    }
    var submitError by remember(message.id, data.requestKey) { mutableStateOf<String?>(null) }

    fun act(action: SecretCardAction) {
        val bot = botId ?: return
        scope.launch {
            working = true
            session.secretCardAction(bot, message.id, threadId, action)
            working = false
        }
    }

    fun submit() {
        val bot = botId ?: return
        val target = data.target ?: return
        val requestKey = data.requestKey ?: return
        val activeConnection = connection ?: return
        scope.launch {
            working = true
            submitError = null
            val envelope = sealedEnvelope ?: run {
                if (secretValue.isBlank()) {
                    submitError = "请输入凭据。"
                    working = false
                    return@launch
                }
                if (secretValue.toByteArray(Charsets.UTF_8).size > PhoneSecretCrypto.MAX_VALUE_BYTES) {
                    submitError = "凭据太长，最多 4096 字节。"
                    working = false
                    return@launch
                }
                val sealed = runCatching {
                    activeConnection.sealPhoneSecret(
                        botId = bot,
                        threadId = threadId,
                        messageId = message.id,
                        target = target,
                        requestKey = requestKey,
                        plaintext = secretValue,
                    )
                }.getOrElse {
                    submitError = "此连接不能安全提交凭据。请在电脑上填写。"
                    working = false
                    return@launch
                }
                sealedEnvelope = sealed
                // The only plaintext copy this composable controls leaves the
                // field before the network request starts.
                secretValue = ""
                sealed
            }
            when (val result = session.provideSecretCard(bot, message.id, envelope)) {
                SecretCardProvideResult.Submitted -> {
                    sealedEnvelope = null
                    submitError = null
                }
                is SecretCardProvideResult.Rejected -> {
                    sealedEnvelope = null
                    submitError = result.message
                }
                is SecretCardProvideResult.Uncertain -> {
                    submitError = result.message
                }
                is SecretCardProvideResult.Blocked -> {
                    submitError = result.message
                }
                SecretCardProvideResult.Unavailable -> {
                    sealedEnvelope = null
                    submitError = "此电脑当前离线。请稍后重试。"
                }
            }
            working = false
        }
    }

    val badgeText = when {
        data.superseded == true -> "已取代"
        data.provided == true -> "已保存"
        data.dismissed == true -> "已跳过"
        else -> "待填写"
    }
    val blocker = connection?.phoneSecretEntryBlocker()
    val missingSubmissionMetadata = data.target.isNullOrBlank() || data.requestKey.isNullOrBlank()
    RemoteCard(
        title = data.label?.takeIf { it.isNotBlank() } ?: "需要一个凭据",
        body = data.description ?: secretStatusLabel(data),
        iconRes = R.drawable.ic_shield_line,
        statusPill = badgeText,
        statusDanger = data.error != null,
    ) {
        data.error?.takeIf { it.isNotBlank() }?.let {
            Text(it, fontSize = 13.sp, color = minisWarning)
        }
        if (data.isPending) {
            val explanation = when {
                missingSubmissionMetadata -> "这张凭据卡缺少安全提交信息，请在电脑上填写。"
                blocker == PhoneSecretEntryBlocker.NEEDS_RESCAN ->
                    "此配对还没有绑定桌面安全密钥。请重新扫码配对后，才能在手机上填写。"
                blocker == PhoneSecretEntryBlocker.NEEDS_PROTECTED_ROUTE ->
                    "当前是本地明文路由。请改用 HTTPS 或 Tailscale 连接，或在电脑上填写。"
                sealedEnvelope != null ->
                    "凭据已在此手机本地加密。若网络结果不确定，重试会复用同一份加密信封。"
                else ->
                    "凭据只在此手机本地加密后提交；不会进入聊天，也不会保存在手机上。"
            }
            Text(explanation, fontSize = 12.sp, color = minisTertiary)
        }
        data.helpUrl?.takeIf { it.startsWith("https://") }?.let { url ->
            TextButton(onClick = { runCatching { uriHandler.openUri(url) } }) {
                Text("查看填写说明", fontSize = 13.sp, color = minisSecondary)
            }
        }
        submitError?.takeIf { it.isNotBlank() }?.let {
            Text(it, fontSize = 13.sp, color = minisWarning)
        }
        if (botId != null && data.isPending) {
            val canSubmit = connection != null && !missingSubmissionMetadata && blocker == null
            if (canSubmit && sealedEnvelope == null) {
                MinisSheetField(
                    value = secretValue,
                    onValueChange = {
                        secretValue = it
                        submitError = null
                    },
                    placeholder = data.placeholder?.takeIf { it.isNotBlank() } ?: "输入凭据",
                    label = data.label ?: "凭据",
                    enabled = !working,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                )
            }
            MuseCardDivider()
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (sealedEnvelope == null || !canSubmit) {
                    MuseSecondaryPillButton(
                        text = "跳过",
                        onClick = { act(SecretCardAction.DISMISS) },
                        enabled = !working,
                        modifier = Modifier.weight(1f),
                    )
                }
                if (canSubmit) {
                    MusePrimaryPillButton(
                        text = when {
                            working && sealedEnvelope != null -> "正在提交…"
                            sealedEnvelope != null -> "重试提交"
                            else -> "加密并提交"
                        },
                        onClick = { submit() },
                        enabled = !working && (sealedEnvelope != null || secretValue.isNotBlank()),
                        modifier = Modifier.weight(1f),
                    )
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

    val badgeText = when {
        data.done == true || data.savedLogin != null -> "已登录"
        data.cancelled == true -> "已取消"
        data.superseded == true -> "已取代"
        data.stopped == true -> "已停止"
        else -> "待登录"
    }
    RemoteCard(
        title = if (data.site.isBlank()) "在电脑端登录" else "在电脑端登录 ${data.site}",
        body = data.reason ?: if (data.isPending) SignInCardRules.whereText(data.place, botName) else SignInCardRules.statusLabel(data, data.site),
        iconRes = R.drawable.ic_display_line,
        statusPill = badgeText,
        statusDanger = data.error != null,
    ) {
        if (data.isPending) {
            Text(
                "密码仅在电脑浏览器中输入，Luna Bot 始终看不到。",
                fontSize = 12.sp,
                color = minisTertiary,
            )
        }
        data.error?.takeIf { it.isNotBlank() }?.let {
            Text(it, fontSize = 13.sp, color = minisWarning)
        }
        if (botId != null && data.isPending) {
            MuseCardDivider()
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                MuseSecondaryPillButton(
                    text = "取消",
                    onClick = { act(SignInCardAction.CANCEL) },
                    enabled = !working,
                    modifier = Modifier.weight(1f),
                )
                MusePrimaryPillButton(
                    text = "我已完成",
                    onClick = { act(SignInCardAction.DONE) },
                    enabled = !working,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

@Composable
private fun RoutineRunCard(message: Message) {
    val data = message.routineRun ?: return
    val isFailed = data.status == "failed"
    val badgeBg = if (isFailed) MinisTokens.Danger.copy(alpha = 0.12f) else minisWarmSand
    val badgeTint = if (isFailed) MinisTokens.Danger else minisInk

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .musePaperCard(danger = isFailed)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        MuseCardBadge(size = 40.dp, tint = badgeBg) {
            Icon(
                painter = painterResource(R.drawable.ic_schedule),
                contentDescription = null,
                tint = badgeTint,
                modifier = Modifier.size(19.dp),
            )
        }
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = data.routineName.ifBlank { "定时巡检" },
                    fontSize = 15.5.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = minisInk,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Box(
                    modifier = Modifier
                        .clip(CircleShape)
                        .background(if (isFailed) MinisTokens.Danger.copy(alpha = 0.12f) else minisSoftCard)
                        .padding(horizontal = 9.dp, vertical = 3.dp),
                ) {
                    Text(
                        text = routineStatusLabel(data),
                        fontSize = 11.5.sp,
                        fontWeight = FontWeight.Medium,
                        color = if (isFailed) MinisTokens.Danger else minisSecondary,
                        maxLines = 1,
                    )
                }
            }
            if (data.deferredAt != null && data.status == "queued") {
                Text("目标正忙，这次运行已延后。", fontSize = 12.sp, color = minisSecondary)
            }
            data.summary?.takeIf { it.isNotBlank() }?.let {
                Text(it, fontSize = 13.5.sp, lineHeight = 19.sp, color = minisSecondary, maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
            data.error?.takeIf { it.isNotBlank() }?.let {
                Text(it, fontSize = 12.5.sp, color = minisWarning, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        Icon(
            imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = minisTertiary,
            modifier = Modifier.size(18.dp),
        )
    }
}

@Composable
private fun GoalRunCard(message: Message) {
    val data = message.goalRun ?: return
    val coordinator = data.coordinatorName?.takeIf { it.isNotBlank() }
    val turns = if (data.maxTurns > 0) "${data.turnCount}/${data.maxTurns} 轮" else "${data.turnCount} 轮"
    RemoteCard(
        title = "团队目标",
        body = data.goal,
        iconRes = R.drawable.ic_sparkles,
        statusPill = goalStatusLabel(data.status),
        statusDanger = data.status == "failed",
    ) {
        Text(
            listOfNotNull(coordinator?.let { "协调者：$it" }, turns).joinToString(" · "),
            fontSize = 12.sp,
            color = minisTertiary,
        )
        data.detail?.takeIf { it.isNotBlank() }?.let {
            Text(it, fontSize = 13.5.sp, lineHeight = 19.sp, color = minisInk)
        }
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
    val reason = callEndLabel(record.endReason)
    RemoteCard(
        title = record.title?.takeIf { it.isNotBlank() } ?: "通话记录",
        body = "${callDurationLabel(record.seconds)} · $client",
        iconRes = R.drawable.ic_call_line,
        statusPill = reason.ifBlank { null },
    ) {}
}

@Composable
private fun WidgetSummaryCard(message: Message) {
    val settled = message.widget?.settled
    RemoteCard(
        title = "小组件",
        body = message.text,
        iconRes = R.drawable.ic_sparkles,
        statusPill = if (settled != null && settled.label.isNotBlank()) "已选择" else "电脑端操作",
    ) {
        if (settled != null && settled.label.isNotBlank()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(minisSoftCard, RoundedCornerShape(12.dp))
                    .padding(horizontal = 12.dp, vertical = 9.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = Icons.Filled.Check,
                    contentDescription = null,
                    tint = minisSuccess,
                    modifier = Modifier.size(14.dp),
                )
                Text(
                    text = settled.label,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    color = minisInk,
                )
            }
        } else {
            Text("此小组件的交互按钮请在电脑端操作。", fontSize = 12.sp, color = minisTertiary)
        }
    }
}

@Composable
private fun AppSummaryCard(message: Message) {
    val data = message.app
    RemoteCard(
        title = data?.title?.takeIf { it.isNotBlank() } ?: "应用卡片",
        body = message.text,
        iconRes = R.drawable.ic_hub,
        statusPill = if (data?.source == "mcp") "MCP 应用" else "智能体页面",
    ) {
        Text("完整页面请在电脑端打开。", fontSize = 12.sp, color = minisTertiary)
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
                val live = revealed(text)
                BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
                    val gutter = botBubbleGutter(text = live, columnWidth = maxWidth)
                    Box(
                        modifier = Modifier
                            .padding(end = gutter)
                            .widthIn(max = 640.dp)
                            .background(BubbleColor.botBubble, bubbleShape)
                            .padding(horizontal = 15.dp, vertical = 10.dp),
                    ) {
                        MarkdownText(source = live, caret = true)
                    }
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
            style = TextStyle(fontSize = 15.5.sp, lineHeight = 22.5.sp),
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
private val THINKING_PHRASES = listOf("正在仔细思考", "正在整理思路", "正在处理中")

@Composable
fun WorkingBubble(chat: Chat, whisper: String? = null) {
    val label = LiveTail.workingLabel(chat.name)
    val generic = remember { setOf("working", "busy", "running", "thinking") }
    val liveDetail = chat.activity
        ?.trim()
        ?.takeIf { it.isNotBlank() && it.lowercase() !in generic }
        ?: whisper?.takeIf { it.isNotBlank() }
    var phraseIndex by remember(chat.threadId) { mutableIntStateOf(0) }
    LaunchedEffect(chat.threadId, liveDetail == null) {
        if (liveDetail != null) return@LaunchedEffect
        while (true) {
            delay(3_600)
            phraseIndex = (phraseIndex + 1) % THINKING_PHRASES.size
        }
    }
    val statusText = liveDetail ?: THINKING_PHRASES[phraseIndex]
    val botBodyId = (chat as? Chat.BotChat)?.bot?.mascotBody

    Entrance {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 4.dp, top = 2.dp, bottom = 2.dp)
                .semantics {
                    contentDescription = label
                    liveRegion = LiveRegionMode.Polite
                },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            PresetBotAvatar(
                color = chat.color,
                size = 28.dp,
                bodyId = botBodyId,
                contentDescription = null,
                motion = AvatarMotion.SHEEN,
                mood = FaceMood.WORKING,
            )
            Spacer(Modifier.width(9.dp))
            AnimatedContent(
                targetState = statusText,
                transitionSpec = {
                    (fadeIn(tween(260)) + slideInVertically(tween(260)) { it / 4 }) togetherWith
                        (fadeOut(tween(160)) + slideOutVertically(tween(160)) { -it / 4 })
                },
                label = "working-phrase",
            ) { current ->
                ShimmerStatusText(
                    text = current,
                    baseColor = minisSecondary,
                    highlightColor = minisInk,
                )
            }
        }
    }
}

/** Desktop-aligned gentle horizontal shimmer sweep across the live status phrase. */
@Composable
private fun ShimmerStatusText(
    text: String,
    baseColor: Color,
    highlightColor: Color,
) {
    val transition = rememberInfiniteTransition(label = "working-shimmer")
    val shift by transition.animateFloat(
        initialValue = -0.35f,
        targetValue = 1.35f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 2_000, easing = LinearEasing),
        ),
        label = "shimmer-shift",
    )
    val span = 320f
    val center = shift * span
    val brush = Brush.linearGradient(
        colors = listOf(baseColor, highlightColor, baseColor),
        start = Offset(center - span * 0.35f, 0f),
        end = Offset(center + span * 0.35f, 0f),
    )
    Text(
        text = text,
        style = TextStyle(
            brush = brush,
            fontSize = 14.sp,
            lineHeight = 20.sp,
        ),
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
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

/** The data_show receipt's chip: what the desktop's DataResultChip says, one
 * tap into the bot's read-only Data viewer at exactly that card. */
@Composable
private fun DataResultChip(result: DataResultData, onOpenData: (botId: String, cardId: String) -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier
            .fillMaxWidth()
            .musePaperCard()
            .clickable(role = Role.Button) { onOpenData(result.botId, result.cardId) }
            .padding(horizontal = 14.dp, vertical = 12.dp),
    ) {
        Text(
            text = if (result.kind == "chart") "📊" else "🗂️",
            fontSize = 16.sp,
        )
        Text(
            text = result.title,
            fontSize = 14.5.sp,
            fontWeight = FontWeight.Medium,
            color = minisInk,
            maxLines = 1,
            modifier = Modifier.weight(1f),
        )
        Text(text = "在数据中打开", fontSize = 12.5.sp, color = minisSecondary)
    }
}
