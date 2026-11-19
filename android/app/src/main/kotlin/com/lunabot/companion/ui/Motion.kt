package com.openmausbot.companion.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The app's one-shot motion vocabulary.
 *
 * Everything here is a *reaction*: it answers something the person just did, or a
 * state that just changed, and then stops. Nothing loops on its own — the bot's
 * face switching expression is the product's animation, and a mascot that keeps
 * breathing in an idle chat is noise, not life. The single exception is
 * [ListeningBars], which loops exactly as long as the microphone is open, because
 * there it is not decoration: it is the only sign that capture is still running.
 */

/**
 * Squash the control under the finger, spring it back on release.
 *
 * Applied to every [TouchTarget] so the whole app answers to a press the same
 * way. The layer is draw-only, so the hit target never moves; a press that
 * shrinks the target is a press that can miss.
 */
@Composable
internal fun Modifier.pressScale(
    source: InteractionSource,
    pressed: Float = 0.88f,
): Modifier {
    val isPressed by source.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (isPressed) pressed else 1f,
        animationSpec = spring(
            dampingRatio = 0.55f,
            stiffness = 900f,
        ),
        label = "pressScale",
    )
    return graphicsLayer {
        scaleX = scale
        scaleY = scale
    }
}

/**
 * A short pop whenever [key] changes — used where a state the person did not
 * touch becomes visible (the bot's expression changing under its name).
 *
 * The first composition is deliberately silent: arriving on a screen is not an
 * event the mascot is reacting to. A key that changes several times in a row
 * restarts from the same small scale rather than stacking, so the beat stays one
 * gesture long.
 */
@Composable
internal fun rememberReactionScale(
    key: Any?,
    from: Float = 0.82f,
): Float {
    val scale = remember { Animatable(1f) }
    var settled by remember { mutableStateOf(false) }
    LaunchedEffect(key) {
        if (!settled) {
            settled = true
            return@LaunchedEffect
        }
        scale.snapTo(from)
        scale.animateTo(
            targetValue = 1f,
            animationSpec = spring(
                dampingRatio = Spring.DampingRatioMediumBouncy,
                stiffness = Spring.StiffnessMediumLow,
            ),
        )
    }
    return scale.value
}

/**
 * The microphone's level, drawn as bars.
 *
 * There is no real amplitude behind this — the platform's speech recogniser does
 * not publish one through the API this app uses — so an "honest" meter would be
 * a worse lie than a clearly decorative one. What it does communicate is the one
 * thing that matters: capture is live and will keep running until the button is
 * pressed again.
 */
@Composable
internal fun ListeningBars(
    color: Color,
    modifier: Modifier = Modifier,
    bars: Int = 4,
    barWidth: Dp = 2.dp,
) {
    val transition = rememberInfiniteTransition(label = "listening")
    val levels = List(bars) { index ->
        transition.animateFloat(
            initialValue = 0.3f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(
                animation = tween(
                    durationMillis = 380 + index * 90,
                    easing = FastOutSlowInEasing,
                ),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "bar$index",
        )
    }
    Canvas(modifier) {
        val width = barWidth.toPx()
        val gap = if (bars > 1) {
            ((size.width - width * bars) / (bars - 1)).coerceAtLeast(0f)
        } else {
            0f
        }
        val minHeight = 2.dp.toPx()
        levels.forEachIndexed { index, level ->
            val height = (size.height * level.value).coerceAtLeast(minHeight)
            val x = index * (width + gap) + width / 2f
            drawLine(
                color = color,
                start = androidx.compose.ui.geometry.Offset(x, (size.height - height) / 2f),
                end = androidx.compose.ui.geometry.Offset(x, (size.height + height) / 2f),
                strokeWidth = width,
                cap = StrokeCap.Round,
            )
        }
    }
}
