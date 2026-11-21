package com.lunabot.companion.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
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

private val CallHangUpRed = Color(0xFFD94A3D)

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
    speaking: Boolean = false,
    audioLevel: Float = 0f,
    onPrimary: () -> Unit,
    onSecondary: () -> Unit = {},
    onMute: () -> Unit,
    onHangUp: () -> Unit,
) {
    val dynamicState = when {
        speaking -> DynamicAvatarStates.TALKING
        avatarState == MausState.THINKING -> DynamicAvatarStates.THINKING
        avatarState == MausState.WORKING -> DynamicAvatarStates.WORKING
        avatarState == MausState.LISTENING -> DynamicAvatarStates.LISTENING
        else -> DynamicAvatarStates.IDLE
    }
    val avatarMood = when {
        speaking -> FaceMood.SPEAKING
        avatarState == MausState.THINKING -> FaceMood.THINKING
        avatarState == MausState.WORKING -> FaceMood.WORKING
        avatarState == MausState.LISTENING -> FaceMood.LISTENING
        else -> FaceMood.IDLE
    }
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
                avatarMood = avatarMood,
                dynamicState = dynamicState,
                audioLevel = audioLevel,
                onPrimary = onPrimary,
                onSecondary = onSecondary,
                onMute = onMute,
                onHangUp = onHangUp,
                onExpand = { onExpandedChange(true) },
            )
        }
        return
    }

    val dark = minisIsDark()
    val pulse = rememberInfiniteTransition(label = "call-aura")
    val haloScale by pulse.animateFloat(
        initialValue = 0.94f,
        targetValue = 1.08f,
        animationSpec = infiniteRepeatable(tween(2200), RepeatMode.Reverse),
        label = "call-aura-scale",
    )
    val softCardFill = if (dark) minisGrouped else Color(0xFFF5F5F3)
    val auraColor = if (dark) Color(0x28DDD2C7) else Color(0x66DDD2C7)

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(minisCanvas)
            .systemBarsPadding(),
    ) {
        Box(
            modifier = Modifier
                .align(Alignment.TopStart)
                .padding(14.dp)
                .size(44.dp)
                .museFloatingPill(CircleShape, elevation = 4.dp)
                .clickable(role = Role.Button) { onExpandedChange(false) }
                .semantics { contentDescription = "收起通话" },
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Icons.Filled.KeyboardArrowDown,
                contentDescription = null,
                tint = minisInk,
                modifier = Modifier.size(22.dp),
            )
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.weight(1f))

            // Muse serene centerpiece: large rounded portrait card when dynamic avatar is configured,
            // otherwise breathing warm-linen ambient aura + floating avatar.
            val hasDynamicAvatar = !bot.avatarStates.isNullOrEmpty()
            Box(
                modifier = Modifier.size(if (hasDynamicAvatar) 248.dp else 228.dp),
                contentAlignment = Alignment.Center,
            ) {
                Canvas(
                    modifier = Modifier
                        .fillMaxSize()
                        .graphicsLayer {
                            val speakingBoost = if (speaking) 1.04f + audioLevel * 0.06f else 1f
                            scaleX = haloScale * speakingBoost
                            scaleY = haloScale * speakingBoost
                        },
                ) {
                    drawCircle(
                        brush = Brush.radialGradient(
                            0.0f to auraColor,
                            0.56f to auraColor.copy(alpha = auraColor.alpha * 0.45f),
                            1.0f to Color.Transparent,
                        ),
                    )
                }
                BotAvatar(
                    bot = bot,
                    size = if (hasDynamicAvatar) 216.dp else 140.dp,
                    state = avatarState,
                    animated = true,
                    contentDescription = "${bot.name} 头像",
                    fallback = AvatarFallback.PRESET,
                    mood = avatarMood,
                    breakout = hasDynamicAvatar,
                    audioLevel = audioLevel,
                    avatarStateOverride = dynamicState,
                )
            }

            Spacer(Modifier.height(10.dp))
            Text(
                text = bot.name,
                fontSize = 24.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = (-0.4).sp,
                color = minisInk,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(10.dp))
            Row(
                modifier = Modifier
                    .clip(CircleShape)
                    .background(softCardFill)
                    .padding(horizontal = 14.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(7.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .size(7.dp)
                        .clip(CircleShape)
                        .background(if (muted) minisTertiary else MinisTokens.Success),
                )
                Text(
                    text = statusText,
                    fontSize = 13.5.sp,
                    fontWeight = FontWeight.Medium,
                    color = minisSecondary,
                    textAlign = TextAlign.Center,
                )
            }

            if (spoken.isNotBlank() || heard.isNotBlank()) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 24.dp)
                        .clip(RoundedCornerShape(22.dp))
                        .background(softCardFill)
                        .padding(horizontal = 18.dp, vertical = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    if (heard.isNotBlank()) CallTranscriptLine(label = "你", text = heard)
                    if (spoken.isNotBlank()) CallTranscriptLine(label = bot.name, text = spoken)
                }
            }
            note?.takeIf(String::isNotBlank)?.let {
                Text(
                    text = it,
                    modifier = Modifier.padding(top = 14.dp),
                    fontSize = 13.5.sp,
                    color = Color(0xFF9E4B3B),
                    textAlign = TextAlign.Center,
                )
            }
            Spacer(Modifier.weight(1f))

            // Muse floating bottom control dock.
            Row(
                modifier = Modifier
                    .padding(bottom = 26.dp)
                    .museFloatingPill(CircleShape, elevation = 8.dp)
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (primaryIcon != null && primaryLabel != null) {
                    CallActionButton(
                        icon = primaryIcon,
                        label = primaryLabel,
                        enabled = primaryEnabled && controlsEnabled,
                        size = 54.dp,
                        onClick = onPrimary,
                    )
                }
                if (secondaryIcon != null && secondaryLabel != null) {
                    CallActionButton(
                        icon = secondaryIcon,
                        label = secondaryLabel,
                        enabled = controlsEnabled,
                        size = 54.dp,
                        onClick = onSecondary,
                    )
                }
                CallActionButton(
                    icon = R.drawable.ic_mic,
                    label = if (muted) "取消静音" else "静音",
                    enabled = controlsEnabled || !muted,
                    size = 54.dp,
                    active = muted,
                    onClick = onMute,
                )
                CallActionButton(
                    icon = R.drawable.ic_call_end,
                    label = "挂断通话",
                    enabled = true,
                    size = 54.dp,
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
    avatarMood: FaceMood,
    dynamicState: String,
    audioLevel: Float,
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
            .museFloatingPill(RoundedCornerShape(28.dp), elevation = 10.dp)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(24.dp)
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
                    .size(width = 34.dp, height = 4.dp)
                    .background(minisTertiary.copy(alpha = 0.45f), CircleShape),
            )
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BotAvatar(
                bot = bot,
                size = 42.dp,
                state = avatarState,
                animated = true,
                contentDescription = null,
                fallback = AvatarFallback.PRESET,
                mood = avatarMood,
                audioLevel = audioLevel,
                avatarStateOverride = dynamicState,
            )
            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(start = 11.dp)
                    .clickable(role = Role.Button, onClick = onExpand),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(
                    text = bot.name,
                    fontSize = 15.5.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = minisInk,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        modifier = Modifier
                            .size(6.dp)
                            .clip(CircleShape)
                            .background(if (muted) minisTertiary else MinisTokens.Success),
                    )
                    Text(
                        text = statusText,
                        fontSize = 12.5.sp,
                        color = minisSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            CallActionButton(
                icon = R.drawable.ic_call_end,
                label = "挂断通话",
                enabled = true,
                size = 42.dp,
                destructive = true,
                onClick = onHangUp,
            )
        }
        if (heard.isNotBlank() || spoken.isNotBlank() || !note.isNullOrBlank()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 10.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(if (minisIsDark()) minisGrouped else Color(0xFFF5F5F3))
                    .padding(horizontal = 12.dp, vertical = 9.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                if (heard.isNotBlank()) CallCompactTranscript(label = "你", text = heard)
                if (spoken.isNotBlank()) CallCompactTranscript(label = bot.name, text = spoken)
                note?.takeIf(String::isNotBlank)?.let {
                    Text(it, fontSize = 12.sp, color = Color(0xFF9E4B3B), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 4.dp),
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
                    tint = minisInk,
                    modifier = Modifier.size(22.dp),
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
            fontSize = 15.5.sp,
            fontWeight = FontWeight.Medium,
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
            fontSize = 12.5.sp,
            fontWeight = FontWeight.Medium,
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
    val neutralFill = if (minisIsDark()) minisGrouped else Color(0xFFF2F2F0)
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
                        destructive -> CallHangUpRed
                        active -> minisInk
                        else -> neutralFill
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
                        active -> minisCanvas
                        !enabled -> minisTertiary
                        else -> minisInk
                    },
                    modifier = Modifier.size(if (size >= 52.dp) 24.dp else 20.dp),
                )
            }
        }
    }
}
