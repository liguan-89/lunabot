package com.lunabot.companion.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.onClick as semanticsOnClick
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.R
import com.lunabot.companion.core.Bot
import kotlinx.coroutines.launch

@Composable
internal fun CallSurface(
    bot: Bot,
    expanded: Boolean,
    onExpandedChange: (Boolean) -> Unit,
    phase: String,
    heard: String,
    spoken: String,
    note: String?,
    muted: Boolean,
    primaryIcon: Int?,
    primaryLabel: String?,
    primaryEnabled: Boolean,
    secondaryIcon: Int? = null,
    secondaryLabel: String? = null,
    controlsEnabled: Boolean,
    bottomClearance: Dp,
    avatarState: MausState,
    onPrimary: () -> Unit,
    onSecondary: () -> Unit = {},
    onMute: () -> Unit,
    onHangUp: () -> Unit,
) {
    val statusText = if (muted) "$phase · 已静音" else phase
    BackHandler {
        if (expanded) onExpandedChange(false) else onHangUp()
    }
    if (!expanded) {
        Box(modifier = Modifier.fillMaxSize()) {
            FloatingCallCard(
                bot = bot,
                phase = phase,
                heard = heard,
                spoken = spoken,
                note = note,
                muted = muted,
                primaryIcon = primaryIcon,
                primaryLabel = primaryLabel,
                primaryEnabled = primaryEnabled,
                secondaryIcon = secondaryIcon,
                secondaryLabel = secondaryLabel,
                controlsEnabled = controlsEnabled,
                bottomClearance = bottomClearance,
                avatarState = avatarState,
                onPrimary = onPrimary,
                onSecondary = onSecondary,
                onMute = onMute,
                onHangUp = onHangUp,
                onExpand = { onExpandedChange(true) },
            )
        }
        return
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(minisCanvas)
            .systemBarsPadding(),
    ) {
        CallActionButton(
            icon = null,
            label = "收起通话",
            enabled = true,
            size = 44.dp,
            onClick = { onExpandedChange(false) },
            modifier = Modifier.align(Alignment.TopStart).padding(8.dp),
        ) {
            Icon(
                imageVector = Icons.Filled.KeyboardArrowDown,
                contentDescription = null,
                tint = minisInk,
                modifier = Modifier.size(24.dp),
            )
        }
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.weight(1f))
            BotAvatar(
                bot = bot,
                size = 136.dp,
                state = avatarState,
                animated = true,
                contentDescription = "${bot.name} 头像",
                fallback = AvatarFallback.PRESET,
            )
            Spacer(Modifier.height(22.dp))
            Text(
                text = bot.name,
                fontSize = 25.sp,
                fontWeight = FontWeight.SemiBold,
                color = minisInk,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = statusText,
                modifier = Modifier.padding(top = 6.dp),
                fontSize = 15.sp,
                color = minisSecondary,
                textAlign = TextAlign.Center,
            )
            if (spoken.isNotBlank() || heard.isNotBlank()) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 28.dp)
                        .clip(RoundedCornerShape(16.dp))
                        .background(minisGrouped)
                        .padding(horizontal = 16.dp, vertical = 14.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    if (heard.isNotBlank()) CallTranscriptLine(label = "你", text = heard)
                    if (spoken.isNotBlank()) CallTranscriptLine(label = bot.name, text = spoken)
                }
            }
            note?.takeIf(String::isNotBlank)?.let {
                Text(
                    text = it,
                    modifier = Modifier.padding(top = 16.dp),
                    fontSize = 14.sp,
                    color = minisWarning,
                    textAlign = TextAlign.Center,
                )
            }
            Spacer(Modifier.weight(1f))
            Row(
                modifier = Modifier.padding(bottom = 28.dp),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (primaryIcon != null && primaryLabel != null) {
                    CallActionButton(
                        icon = primaryIcon,
                        label = primaryLabel,
                        enabled = primaryEnabled && controlsEnabled,
                        size = 60.dp,
                        onClick = onPrimary,
                    )
                }
                if (secondaryIcon != null && secondaryLabel != null) {
                    CallActionButton(
                        icon = secondaryIcon,
                        label = secondaryLabel,
                        enabled = controlsEnabled,
                        size = 60.dp,
                        onClick = onSecondary,
                    )
                }
                CallActionButton(
                    icon = R.drawable.ic_mic,
                    label = if (muted) "取消静音" else "静音",
                    enabled = controlsEnabled || !muted,
                    size = 60.dp,
                    active = muted,
                    onClick = onMute,
                )
                CallActionButton(
                    icon = R.drawable.ic_call_end,
                    label = "挂断通话",
                    enabled = true,
                    size = 60.dp,
                    destructive = true,
                    onClick = onHangUp,
                )
            }
        }
    }
}

@Composable
private fun BoxScope.FloatingCallCard(
    bot: Bot,
    phase: String,
    heard: String,
    spoken: String,
    note: String?,
    muted: Boolean,
    primaryIcon: Int?,
    primaryLabel: String?,
    primaryEnabled: Boolean,
    secondaryIcon: Int?,
    secondaryLabel: String?,
    controlsEnabled: Boolean,
    bottomClearance: Dp,
    avatarState: MausState,
    onPrimary: () -> Unit,
    onSecondary: () -> Unit,
    onMute: () -> Unit,
    onHangUp: () -> Unit,
    onExpand: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val statusText = if (muted) "$phase · 已静音" else phase
    val dragOffset = androidx.compose.runtime.remember { Animatable(0f) }
    val expandPx = with(density) { 56.dp.toPx() }

    Column(
        modifier = Modifier
            .align(Alignment.BottomCenter)
            .padding(start = 16.dp, end = 16.dp, bottom = bottomClearance)
            .widthIn(max = 460.dp)
            .fillMaxWidth()
            .graphicsLayer { translationY = dragOffset.value }
            .chromeSheet(cornerRadius = 18.dp, elevation = 12.dp)
            .padding(horizontal = 14.dp, vertical = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(32.dp)
                .pointerInput(onExpand) {
                    detectVerticalDragGestures(
                        onVerticalDrag = { change, amount ->
                            change.consume()
                            scope.launch {
                                dragOffset.snapTo((dragOffset.value + amount).coerceAtMost(0f))
                            }
                        },
                        onDragEnd = {
                            scope.launch {
                                if (dragOffset.value < -expandPx) onExpand()
                                dragOffset.animateTo(0f, spring(stiffness = Spring.StiffnessMediumLow))
                            }
                        },
                        onDragCancel = {
                            scope.launch { dragOffset.animateTo(0f, spring(stiffness = Spring.StiffnessMediumLow)) }
                        },
                    )
                }
                .clickable(role = Role.Button, onClick = onExpand)
                .semantics {
                    contentDescription = "上滑或点按展开全屏通话"
                    role = Role.Button
                    semanticsOnClick(label = "展开全屏通话") {
                        onExpand()
                        true
                    }
                },
            contentAlignment = Alignment.Center,
        ) {
            Box(
                modifier = Modifier
                    .size(width = 32.dp, height = 4.dp)
                    .background(minisTertiary.copy(alpha = 0.55f), RoundedCornerShape(2.dp)),
            )
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BotAvatar(
                bot = bot,
                size = 40.dp,
                state = avatarState,
                animated = true,
                contentDescription = null,
                fallback = AvatarFallback.PRESET,
            )
            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(start = 10.dp)
                    .clickable(role = Role.Button, onClick = onExpand),
            ) {
                Text(
                    text = bot.name,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = minisInk,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = statusText,
                    fontSize = 12.sp,
                    color = minisSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            CallActionButton(
                icon = R.drawable.ic_call_end,
                label = "挂断通话",
                enabled = true,
                size = 44.dp,
                destructive = true,
                onClick = onHangUp,
            )
        }
        if (heard.isNotBlank() || spoken.isNotBlank() || !note.isNullOrBlank()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 50.dp, end = 4.dp, bottom = 8.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                if (heard.isNotBlank()) CallCompactTranscript(label = "你", text = heard)
                if (spoken.isNotBlank()) CallCompactTranscript(label = bot.name, text = spoken)
                note?.takeIf(String::isNotBlank)?.let {
                    Text(it, fontSize = 12.sp, color = minisWarning, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 42.dp, end = 20.dp, bottom = 4.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (primaryIcon != null && primaryLabel != null) {
                CallActionButton(
                    icon = primaryIcon,
                    label = primaryLabel,
                    enabled = primaryEnabled && controlsEnabled,
                    size = 44.dp,
                    onClick = onPrimary,
                )
            }
            if (secondaryIcon != null && secondaryLabel != null) {
                CallActionButton(
                    icon = secondaryIcon,
                    label = secondaryLabel,
                    enabled = controlsEnabled,
                    size = 44.dp,
                    onClick = onSecondary,
                )
            }
            CallActionButton(
                icon = R.drawable.ic_mic,
                label = if (muted) "取消静音" else "静音",
                enabled = controlsEnabled || !muted,
                size = 44.dp,
                active = muted,
                onClick = onMute,
            )
            CallActionButton(
                icon = null,
                label = "展开全屏通话",
                enabled = true,
                size = 44.dp,
                onClick = onExpand,
            ) {
                Icon(
                    imageVector = Icons.Filled.KeyboardArrowUp,
                    contentDescription = null,
                    tint = minisSecondary,
                    modifier = Modifier.size(24.dp),
                )
            }
        }
    }
}

@Composable
private fun CallTranscriptLine(label: String, text: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(label, fontSize = 12.sp, fontWeight = FontWeight.Medium, color = minisSecondary)
        Text(
            text = text,
            fontSize = 16.sp,
            color = minisInk,
            textAlign = TextAlign.Center,
            maxLines = 4,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun CallCompactTranscript(label: String, text: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, fontSize = 12.sp, fontWeight = FontWeight.Medium, color = minisSecondary, maxLines = 1)
        Text(
            text = text,
            fontSize = 12.sp,
            color = minisInk,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun CallActionButton(
    icon: Int?,
    label: String,
    enabled: Boolean,
    size: Dp,
    modifier: Modifier = Modifier,
    active: Boolean = false,
    destructive: Boolean = false,
    onClick: () -> Unit,
    content: (@Composable () -> Unit)? = null,
) {
    TouchTarget(
        onClick = onClick,
        modifier = modifier,
        size = size,
        enabled = enabled,
        contentDescription = label,
    ) {
        Box(
            modifier = Modifier
                .size(size)
                .background(
                    when {
                        destructive -> minisDanger
                        active -> minisDanger.copy(alpha = 0.12f)
                        else -> minisGrouped
                    },
                    CircleShape,
                ),
            contentAlignment = Alignment.Center,
        ) {
            if (content != null) content()
            else if (icon != null) {
                Icon(
                    painter = painterResource(icon),
                    contentDescription = null,
                    tint = when {
                        destructive -> Color.White
                        active -> minisDanger
                        else -> minisInk
                    },
                    modifier = Modifier.size(if (size >= 60.dp) 28.dp else 21.dp),
                )
            }
        }
    }
}
