package com.lunabot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.core.Chat
import com.lunabot.companion.core.DisplayedMessageAttachment
import com.lunabot.companion.core.DownloadedFile
import com.lunabot.companion.core.Message
import com.lunabot.companion.core.ThreadRef
import com.lunabot.companion.core.TranscriptRow
import com.lunabot.companion.core.WebhookMessageContent

/**
 * The single unified pill worn by every quiet event/receipt row in the
 * transcript — folded work turns, tool steps, bot handoffs, and context
 * compaction — so they share identical height, hairline border, padding, and
 * vertical rhythm.
 */
@Composable
internal fun TranscriptEventPill(
    text: String,
    modifier: Modifier = Modifier,
    leading: @Composable () -> Unit,
    trailing: (@Composable () -> Unit)? = null,
    error: Boolean = false,
    onClick: (() -> Unit)? = null,
    contentDescriptionText: String = text,
) {
    val dark = minisIsDark()
    val errorInk = if (dark) Color(0xFFE59688) else Color(0xFF9E4B3B)
    val fill = if (error) {
        if (dark) Color(0xFF2B211F) else Color(0xFFF8F1EE)
    } else {
        minisInk.copy(alpha = 0.03f)
    }
    val borderColor = if (error) {
        errorInk.copy(alpha = 0.30f)
    } else {
        minisSeparator.copy(alpha = 0.55f)
    }
    // 16dp radius renders as a full pill on a single line and stays a clean,
    // compact rounded tag when expanded to multiple lines (never a bloated oval).
    val shape = RoundedCornerShape(16.dp)
    var expanded by remember(text) { mutableStateOf(false) }
    var overflows by remember(text) { mutableStateOf(false) }
    val canSelfExpand = onClick == null && (overflows || expanded)
    val effectiveOnClick: (() -> Unit)? = onClick ?: if (canSelfExpand) {
        { expanded = !expanded }
    } else {
        null
    }
    Row(
        modifier = modifier
            .clip(shape)
            .background(fill, shape)
            .border(0.5.dp, borderColor, shape)
            .then(
                if (effectiveOnClick != null) {
                    Modifier.clickable(role = Role.Button, onClick = effectiveOnClick)
                } else {
                    Modifier
                },
            )
            .padding(horizontal = 10.dp, vertical = 5.dp)
            .semantics(mergeDescendants = true) {
                contentDescription = contentDescriptionText
            },
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading()
        Text(
            text = text,
            fontSize = 12.5.sp,
            lineHeight = 17.sp,
            fontWeight = FontWeight.Medium,
            color = if (error) errorInk else minisInk,
            maxLines = if (expanded) Int.MAX_VALUE else 1,
            overflow = TextOverflow.Ellipsis,
            onTextLayout = { result ->
                if (!expanded) overflows = result.hasVisualOverflow
            },
            modifier = Modifier.weight(1f, fill = false),
        )
        if (trailing != null) {
            trailing()
        } else if (canSelfExpand) {
            Text(
                text = if (expanded) "收起" else "展开",
                fontSize = 11.5.sp,
                color = minisSecondary,
            )
        }
    }
}

/**
 * The one pill a folded run of work wears, finished or still going.
 */
@Composable
internal fun RunReceiptPill(
    summary: String,
    expanded: Boolean,
    running: Boolean,
    onToggle: () -> Unit,
) {
    val haptics = rememberHaptics()
    TranscriptEventPill(
        text = summary,
        leading = {
            if (running) {
                CircularProgressIndicator(modifier = Modifier.size(12.dp), strokeWidth = 1.5.dp)
            } else {
                Icon(
                    imageVector = Icons.Filled.Check,
                    contentDescription = null,
                    tint = minisSecondary.copy(alpha = 0.78f),
                    modifier = Modifier.size(13.dp),
                )
            }
        },
        trailing = {
            Text(
                text = if (expanded) "收起" else "展开",
                fontSize = 11.5.sp,
                color = minisSecondary,
            )
        },
        onClick = {
            onToggle()
            haptics.play(TactileAction.TOGGLE_ACTIVITY_RUN)
        },
        contentDescriptionText = "$summary，${if (expanded) "已展开" else "已收起"}",
    )
}

/** Reversible completed narration; tools still follow the activity preference. */
@Composable
fun AssistantTurnChip(
    turn: TranscriptRow.AssistantTurn,
    chat: Chat,
    expanded: Boolean,
    revealMessageId: String?,
    onRevealed: (String) -> Unit,
    onToggle: () -> Unit,
    openLink: (String, Message) -> Unit,
    openAttachment: (DisplayedMessageAttachment, Message, DownloadedFile?) -> Unit,
    openThread: (ThreadRef) -> Unit,
    /** A tapped screenshot opens the bot's live computer; null leaves it inert. */
    openComputer: (() -> Unit)? = null,
    onQuote: ((Message) -> Unit)? = null,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        RunReceiptPill(
            summary = turn.label,
            expanded = expanded,
            running = false,
            onToggle = onToggle,
        )
        if (expanded) turn.items.forEach { message ->
            key(message.id) {
                val requester = remember { BringIntoViewRequester() }
                LaunchedEffect(revealMessageId) {
                    if (revealMessageId == message.id) {
                        // Let the expanded child receive layout coordinates.
                        withFrameNanos { }
                        requester.bringIntoView()
                        onRevealed(message.id)
                    }
                }
                Box(Modifier.bringIntoViewRequester(requester)) {
                    MessageRow(
                        chat,
                        message,
                        // The steps sit inside the fold, not in the transcript's
                        // own run: each is its own receipt, so none of them tucks
                        // a corner into its neighbour's.
                        startsRun = true,
                        endsRun = true,
                        openLink = openLink,
                        openAttachment = openAttachment,
                        openThread = openThread,
                        openComputer = openComputer,
                        onQuote = onQuote,
                    )
                }
            }
        }
    }
}

@Composable
fun WebhookMessageBody(content: WebhookMessageContent) {
    var expanded by remember(content) { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Webhook 任务", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = minisInk)
        SelectionContainer {
            Text(content.task, fontSize = 17.sp, color = minisInk)
        }
        content.payload?.let { payload ->
            Row(
                modifier = Modifier.fillMaxWidth().heightIn(min = MIN_TOUCH_TARGET)
                    .clickable(role = Role.Button) { expanded = !expanded }
                    .semantics { stateDescription = if (expanded) "已展开" else "已收起" },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("事件负载", fontSize = 13.sp, color = minisInk, modifier = Modifier.weight(1f))
                Icon(
                    if (expanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                    contentDescription = null, tint = minisInk,
                )
            }
            if (expanded) {
                SelectionContainer {
                    Text(
                        payload, fontSize = 12.sp, fontFamily = FontFamily.Monospace, color = minisInk,
                        modifier = Modifier.heightIn(max = 180.dp).verticalScroll(rememberScrollState()),
                    )
                }
            }
        }
    }
}
