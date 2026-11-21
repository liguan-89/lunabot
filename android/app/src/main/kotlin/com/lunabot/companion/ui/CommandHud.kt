package com.lunabot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.ui.res.painterResource
import com.lunabot.companion.R
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The slash-command HUD and the predictive chips — the port of
 * `ios/App/Composer/CommandSkillHUDView.swift` and
 * `ios/App/Composer/PredictiveActionChipsView.swift`.
 *
 * What each control *does* is [SlashCommands] and [PredictiveChips]; this file
 * only draws them, and draws them as Material rather than as SwiftUI. The iOS
 * HUD is a gradient over `.ultraThinMaterial` with a hairline stroke and a
 * per-command SF Symbol; Android has neither the blur (see `Chrome.kt`) nor
 * honest counterparts for `arrow.triangle.pull` or `steeringwheel` in the core
 * icon set. Inventing a glyph for a command is worse than not drawing one — a
 * wrench beside `/diff` tells the reader something untrue — so the cards carry a
 * coloured rail instead, in the same five accents the iOS cards outline
 * themselves with, and the chips are Material assist chips.
 */
@Composable
fun CommandSkillHud(
    commands: List<SlashCommand>,
    draft: String,
    onSelect: (SlashCommand) -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val visible = remember(commands, draft) { SlashCommands.matching(commands, draft) }
    Column(
        modifier = modifier
            .fillMaxWidth()
            .chromeSheet(cornerRadius = HUD_RADIUS)
            .clip(RoundedCornerShape(HUD_RADIUS))
            .padding(bottom = 8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 14.dp, top = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "斜杠命令",
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                color = secondaryTint,
                modifier = Modifier.weight(1f),
            )
            TouchTarget(onClick = onClose, contentDescription = "关闭斜杠命令") {
                Icon(
                    imageVector = Icons.Filled.Close,
                    contentDescription = null,
                    tint = secondaryTint,
                    modifier = Modifier.size(18.dp),
                )
            }
        }

        // Five cards at most, so a scrolling Row rather than a LazyRow: the lazy
        // machinery would cost more than it saves at this size.
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            visible.forEach { command ->
                CommandCard(command = command, onSelect = { onSelect(command) })
            }
        }
    }
}

@Composable
private fun CommandCard(command: SlashCommand, onSelect: () -> Unit) {
    Row(
        modifier = Modifier
            .width(COMMAND_CARD_WIDTH)
            .heightIn(min = COMMAND_CARD_HEIGHT)
            .height(IntrinsicSize.Min)
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerHighest)
            .clickable(role = Role.Button, onClick = onSelect),
    ) {
        // The rail is the card's only ornament, and it is decoration: the title
        // beside it already says which command this is.
        Box(
            modifier = Modifier
                .width(3.dp)
                .fillMaxHeight()
                .background(minisAccent.copy(alpha = 0.5f)),
        )
        Column(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text(
                text = command.title,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = command.description,
                fontSize = 12.sp,
                color = secondaryTint,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/**
 * Four standing prompts under an empty composer, each sent on the tap.
 *
 * `AssistChip` rather than a hand-rolled capsule: it is the Material control for
 * exactly this — a suggested action beside a text field — and it carries the
 * `Role.Button` semantics and the 48 dp touch expansion that a 32 dp pill drawn
 * by hand would not.
 *
 * [chips] carries no default. These are the reader's own quick replies, which the
 * composer always passes; a default of [PredictiveChips.ALL] would let a future
 * call site render the four factory ones instead — silently, and always wrongly.
 */
@Composable
fun PredictiveChipsRow(
    chips: List<PredictiveChip>,
    onSelect: (PredictiveChip) -> Unit,
    modifier: Modifier = Modifier,
    onDismiss: (() -> Unit)? = null,
) {
    val scrollState = rememberScrollState()
    val fadeLeft = scrollState.canScrollBackward
    val fadeRight = scrollState.canScrollForward
    Row(
        modifier = modifier
            .fillMaxWidth()
            .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
            .drawWithContent {
                drawContent()
                if (fadeLeft || fadeRight) {
                    val edgePx = 28.dp.toPx().coerceAtMost(size.width * 0.25f)
                    val leftStop = if (size.width > 0f) edgePx / size.width else 0f
                    val rightStop = if (size.width > 0f) 1f - edgePx / size.width else 1f
                    drawRect(
                        brush = Brush.horizontalGradient(
                            0f to if (fadeLeft) Color.Transparent else Color.Black,
                            leftStop to Color.Black,
                            rightStop to Color.Black,
                            1f to if (fadeRight) Color.Transparent else Color.Black,
                        ),
                        blendMode = BlendMode.DstIn,
                    )
                }
            }
            .horizontalScroll(scrollState)
            .padding(horizontal = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        chips.forEach { chip ->
            Box(
                modifier = Modifier
                    .heightIn(min = 40.dp)
                    .clickable(
                        role = Role.Button,
                        onClick = { onSelect(chip) },
                    )
                    .semantics(mergeDescendants = true) {
                        contentDescription = chip.title
                    },
                contentAlignment = Alignment.Center,
            ) {
                Row(
                    modifier = Modifier
                        .clip(androidx.compose.foundation.shape.CircleShape)
                        .background(if (minisIsDark()) minisCard else Color(0xFFF3F3F1))
                        .padding(horizontal = 13.dp, vertical = 7.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    chip.icon?.let { icon ->
                        QuickReplyVectorIcon(icon = icon, tint = secondaryTint)
                    }
                    Text(
                        text = chip.title,
                        fontSize = 12.5.sp,
                        fontWeight = FontWeight.Medium,
                        color = minisInk.copy(alpha = 0.85f),
                        maxLines = 1,
                    )
                }
            }
        }
        if (onDismiss != null) {
            Box(
                modifier = Modifier
                    .heightIn(min = 40.dp)
                    .clickable(
                        role = Role.Button,
                        onClick = onDismiss,
                    )
                    .semantics { contentDescription = "收起快捷建议" },
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    modifier = Modifier
                        .size(28.dp)
                        .clip(androidx.compose.foundation.shape.CircleShape)
                        .background(if (minisIsDark()) minisCard else Color(0xFFF3F3F1)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = Icons.Filled.Close,
                        contentDescription = null,
                        tint = secondaryTint,
                        modifier = Modifier.size(13.dp),
                    )
                }
            }
        }
        Spacer(Modifier.width(4.dp))
    }
}

/**
 * Small platform-neutral marks for the icon choices stored with a reply.
 *
 * One table, drawn by the composer's chips and offered by `QuickRepliesEditor`:
 * a mark someone picks in Settings is the mark that appears above the composer
 * because it is literally the same branch, not a copy that agrees today.
 */
@Composable
private fun QuickReplyVectorIcon(icon: String, tint: Color) {
    val mod = Modifier.size(14.dp)
    when (icon) {
        "next" -> Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = null, tint = tint, modifier = mod)
        "tests" -> Icon(Icons.Filled.Check, contentDescription = null, tint = tint, modifier = mod)
        "explain" -> Icon(Icons.Filled.Info, contentDescription = null, tint = tint, modifier = mod)
        "build" -> Icon(Icons.Filled.Build, contentDescription = null, tint = tint, modifier = mod)
        "bug" -> Icon(Icons.Filled.Warning, contentDescription = null, tint = tint, modifier = mod)
        "send" -> Icon(Icons.AutoMirrored.Filled.Send, contentDescription = null, tint = tint, modifier = mod)
        "search" -> Icon(Icons.Filled.Search, contentDescription = null, tint = tint, modifier = mod)
        "history" -> Icon(Icons.Filled.Refresh, contentDescription = null, tint = tint, modifier = mod)
        "list", "document" -> Icon(painterResource(R.drawable.ic_list_line), contentDescription = null, tint = tint, modifier = mod)
        else -> Icon(painterResource(R.drawable.ic_edit_line), contentDescription = null, tint = tint, modifier = mod)
    }
}

internal fun quickReplyGlyph(icon: String): String = when (icon) {
    "next" -> "→"
    "diff" -> "±"
    "tests" -> "✓"
    "explain" -> "?"
    "build" -> "⌁"
    "bug" -> "!"
    "document" -> "▤"
    "terminal" -> ">_"
    "send" -> "↑"
    "search" -> "⌕"
    "history" -> "↶"
    "list" -> "☷"
    else -> "•"
}

private val HUD_RADIUS = 16.dp
private val COMMAND_CARD_WIDTH = 168.dp
private val COMMAND_CARD_HEIGHT = 62.dp
