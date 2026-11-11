package com.openmausbot.companion.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.Dp
import kotlin.coroutines.coroutineContext

/**
 * How much life a *photograph* is given.
 *
 * A face from the preset library is drawn, so it can blink and look around —
 * see [BotFace]. A picture somebody uploaded cannot: its eyes are pixels. What
 * it can do is sit in a breathing frame with a highlight travelling across it,
 * which is the most a still image can honestly offer.
 *
 * The three levels are still the roster's own vocabulary — still, glancing,
 * alive — so a screen lines one up against the other without a second scale.
 */
internal enum class AvatarMotion {
    /** Held entirely still. */
    NONE,

    /** Only the highlight sweeps; the image does not move. */
    SHEEN,

    /** A slow breath plus the highlight: the one large portrait on a screen. */
    BREATH,
}

/**
 * The breath and the highlight, as a modifier so that any image — a library
 * circle or a custom image the person uploaded — moves the same way.
 *
 * Apply it *after* the clip: the sweep is a rectangle drawn inside the already
 * clipped layer, which is what keeps it off the corners of a rounded crop.
 * The sweep is drawn, not composed: no layout pass, no text remeasure, and
 * `MotionDurationScale` at zero (Android's "remove animations") leaves a still
 * image instead of a crawling one.
 */
@Composable
internal fun Modifier.portraitMotion(motion: AvatarMotion): Modifier {
    if (motion == AvatarMotion.NONE) return this
    // The animator duration scale is only readable from a suspend context, and
    // a composable is not one. The effect reads it once; at zero (Android's
    // "remove animations") the portrait stays still for its whole lifetime.
    var enabled by remember(motion) { mutableStateOf(true) }
    LaunchedEffect(motion) {
        enabled = (coroutineContext[MotionDurationScale]?.scaleFactor ?: 1f) > 0f
    }
    if (!enabled) return this

    // Two phases from one transition: the breath is 0..1..0, the sweep runs
    // 0..1 and restarts. A linear sweep and a smooth breath need different
    // specs, but they share a clock, so there is still one animation driver.
    val transition = rememberInfiniteTransition(label = "bot-portrait")
    val breathing by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 2_600, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "breath",
    )
    val sweeping by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            // A highlight that crosses in about six seconds and then waits
            // off-frame: the pause is what makes it read as a sheen rather than
            // a radar.
            animation = tween(durationMillis = 7_200, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "sweep",
    )
    val scale = if (motion == AvatarMotion.BREATH) 1f + 0.018f * breathing else 1f
    return this
        .graphicsLayer {
            scaleX = scale
            scaleY = scale
        }
        .drawWithContent {
            drawContent()
            // Only the middle of the cycle carries the band; the start and end
            // are the pause, when nothing is drawn at all.
            if (sweeping <= 0.04f || sweeping >= 0.86f) return@drawWithContent
            val x = size.width * (sweeping * 1.4f - 0.2f)
            val band = size.width * 0.34f
            drawRect(
                brush = Brush.linearGradient(
                    colors = listOf(
                        Color.Transparent,
                        Color.White.copy(alpha = SHEEN_ALPHA),
                        Color.Transparent,
                    ),
                    start = Offset(x - band, 0f),
                    end = Offset(x + band, size.height),
                ),
            )
        }
}

/** How much of a life each level asks of a drawn face. */
internal val AvatarMotion.life: FaceLife
    get() = when (this) {
        AvatarMotion.NONE -> FaceLife.STILL
        AvatarMotion.SHEEN -> FaceLife.GLANCE
        AvatarMotion.BREATH -> FaceLife.ALIVE
    }

/**
 * The Grok-style portrait, from the avatar library, optionally alive.
 *
 * Both the hero and the roster rows draw through here, so the border, the
 * circle crop and the face itself are one implementation rather than three
 * that can drift apart.
 */
@Composable
internal fun PresetBotAvatar(
    color: String?,
    size: Dp,
    modifier: Modifier = Modifier,
    contentDescription: String? = null,
    motion: AvatarMotion = AvatarMotion.NONE,
    mood: FaceMood = FaceMood.IDLE,
    drowsy: Boolean = false,
    seed: Int = 0,
    crown: Boolean = false,
) {
    BotFace(
        color = color,
        size = size,
        life = motion.life,
        mood = mood,
        modifier = modifier,
        contentDescription = contentDescription,
        drowsy = drowsy,
        seed = seed,
        crown = crown,
    )
}

/** The highlight is a suggestion, not a glare: a third of white would be a lamp. */
private const val SHEEN_ALPHA = 0.26f
