package com.lunabot.companion.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.os.Build
import android.view.View
import android.view.Window
import android.view.WindowManager
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick as semanticsOnClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogWindowProvider
import dev.chrisbanes.haze.HazeProgressive
import dev.chrisbanes.haze.HazeState
import dev.chrisbanes.haze.HazeStyle
import dev.chrisbanes.haze.HazeTint
import dev.chrisbanes.haze.hazeEffect

/**
 * The one material the floating chrome is made of — where `ios/App/Glass.swift`
 * sits in the port, done the way Android does it.
 *
 * iOS floats its bars on real glass and refracts whatever scrolls beneath.
 * Android cannot do that for a list this app can afford: the platform's only
 * backdrop blur is per-layer, so reproducing the refraction means re-recording
 * the list every frame — the look at the price of the scroll. So the chrome is
 * translucent without being a blur: [minisGloss] lets the page show through and
 * gives the edge a rim and a sheen, while staying a plain fill underneath. That
 * costs nothing in the draw phase and looks the same on API 26 and on 37.
 *
 * The one backdrop the system will blur for free is a dialog window, where it
 * owns both layers — see [GlassBackdrop].
 */

/** Below this, a control is hard to hit; Android asks for 48 dp either way. */
internal val MIN_TOUCH_TARGET: Dp = 48.dp

/** The Activity behind a Compose view, through any ContextWrapper chain. */
internal tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

internal val LocalHazeState = compositionLocalOf<HazeState?> { null }

private val CHROME_ELEVATION: Dp = 0.dp

private val hardwareBlurAvailable: Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
        !Build.FINGERPRINT.equals("robolectric", ignoreCase = true)

@Composable
internal fun rememberGlassHazeStyle(blurRadius: Dp = 24.dp): HazeStyle {
    val canvas = minisCanvas
    val tint = minisGlassBlurTint
    val fallback = minisGlass
    return remember(canvas, tint, fallback, blurRadius) {
        HazeStyle(
            backgroundColor = canvas,
            tints = listOf(HazeTint(tint)),
            blurRadius = blurRadius,
            noiseFactor = 0.025f,
            fallbackTint = HazeTint(fallback),
        )
    }
}

@Composable
internal fun Modifier.progressiveHazeBand(
    hazeState: HazeState,
    fromTop: Boolean,
    alpha: Float = 1f,
): Modifier {
    if (alpha <= 0.001f) return this
    val dark = minisIsDark()
    val canvas = minisCanvas
    val style = remember(canvas, dark) {
        HazeStyle(
            backgroundColor = canvas,
            tints = listOf(HazeTint(canvas.copy(alpha = if (dark) 0.68f else 0.74f))),
            blurRadius = 28.dp,
            noiseFactor = 0.025f,
            fallbackTint = HazeTint(canvas.copy(alpha = 0.88f)),
        )
    }
    val maskStops = if (fromTop) {
        arrayOf(
            0f to Color.Black,
            0.55f to Color.Black.copy(alpha = 0.92f),
            0.82f to Color.Black.copy(alpha = 0.42f),
            1f to Color.Transparent,
        )
    } else {
        arrayOf(
            0f to Color.Transparent,
            0.18f to Color.Black.copy(alpha = 0.42f),
            0.45f to Color.Black.copy(alpha = 0.92f),
            1f to Color.Black,
        )
    }
    val edgeScrim = if (fromTop) {
        Brush.verticalGradient(
            0f to canvas.copy(alpha = (if (dark) 0.76f else 0.80f) * alpha),
            0.50f to canvas.copy(alpha = (if (dark) 0.34f else 0.38f) * alpha),
            1f to Color.Transparent,
        )
    } else {
        Brush.verticalGradient(
            0f to Color.Transparent,
            0.50f to canvas.copy(alpha = (if (dark) 0.34f else 0.38f) * alpha),
            1f to canvas.copy(alpha = (if (dark) 0.78f else 0.82f) * alpha),
        )
    }
    return this
        .hazeEffect(hazeState, style) {
            blurEnabled = hardwareBlurAvailable
            this.alpha = alpha
            mask = Brush.verticalGradient(colorStops = maskStops)
            progressive = HazeProgressive.LinearGradient(
                startIntensity = if (fromTop) 1f else 0f,
                endIntensity = if (fromTop) 0f else 1f,
                easing = CubicBezierEasing(0.33f, 0f, 0.67f, 1f),
                preferPerformance = true,
            )
        }
        .background(edgeScrim)
}

/** A capsule of chrome — pills and round buttons. */
@Composable
internal fun Modifier.chromeCapsule(
    elevation: Dp = CHROME_ELEVATION,
    surface: Boolean = false,
): Modifier {
    val hazeState = LocalHazeState.current
    val dark = minisIsDark()
    val effectiveElevation = if (elevation > 0.dp) elevation else if (!dark && surface) 3.dp else 0.dp
    return if (hazeState != null) {
        val style = rememberGlassHazeStyle()
        this
            .then(
                if (effectiveElevation > 0.dp) {
                    Modifier.shadow(
                        elevation = effectiveElevation,
                        shape = CircleShape,
                        clip = false,
                        ambientColor = Color(0x14000000),
                        spotColor = Color(0x1E000000),
                    )
                } else {
                    Modifier
                },
            )
            .clip(CircleShape)
            .hazeEffect(hazeState, style) {
                blurEnabled = hardwareBlurAvailable
            }
            .minisGloss(
                shape = CircleShape,
                fill = Color.Transparent,
                sheen = minisGlassSheen,
                rim = minisGlassRim,
                fillBrush = false,
            )
    } else if (surface) {
        this.minisGloss(
            shape = CircleShape,
            fill = minisGlass,
            sheen = minisGlassSheen,
            rim = minisGlassRim,
            elevation = effectiveElevation,
        )
    } else {
        chrome(CircleShape, effectiveElevation)
    }
}

/** A rounded sheet of chrome. */
@Composable
internal fun Modifier.chromeSheet(cornerRadius: Dp = 24.dp, elevation: Dp = 0.dp): Modifier {
    val shape = RoundedCornerShape(cornerRadius)
    val hazeState = LocalHazeState.current
    return if (hazeState != null) {
        val style = rememberGlassHazeStyle(blurRadius = 28.dp)
        this
            .then(
                if (elevation > 0.dp) {
                    Modifier.shadow(
                        elevation = elevation,
                        shape = shape,
                        clip = false,
                        ambientColor = Color(0x18000000),
                        spotColor = Color(0x26000000),
                    )
                } else {
                    Modifier
                },
            )
            .clip(shape)
            .hazeEffect(hazeState, style) {
                blurEnabled = hardwareBlurAvailable
            }
            .minisGloss(
                shape = shape,
                fill = Color.Transparent,
                sheen = minisGlassSheen,
                rim = minisGlassRim,
                fillBrush = false,
            )
    } else {
        chrome(shape, elevation)
    }
}

@Composable
internal fun Modifier.chrome(shape: Shape, elevation: Dp = CHROME_ELEVATION): Modifier = this
    .minisGloss(
        shape = shape,
        fill = minisGlass,
        sheen = minisGlassSheen,
        rim = minisGlassRim,
        elevation = elevation,
    )

/**
 * Real backdrop blur behind a dialog window — the one glass trick Android does
 * for free, because here the system owns both layers.
 *
 * Sheets and dialogs render in their own window, so `blurBehindRadius` has the
 * system blur the activity behind them; nothing is re-recorded and a scroll
 * never pays for it. Below API 31, or when the system has cross-window blur
 * switched off, this is a no-op and the ordinary dim scrim stands alone.
 *
 * Place it anywhere inside the dialog's content: it draws nothing, it only asks
 * the window it finds up the view tree to blur what is behind that window.
 */
@Composable
internal fun GlassBackdrop(radius: Int = 40) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
    val view = LocalView.current
    DisposableEffect(view) {
        val window = view.findDialogWindow() ?: return@DisposableEffect onDispose { }
        val previous = window.attributes
        val attributes = WindowManager.LayoutParams().apply { copyFrom(previous) }
        attributes.flags = attributes.flags or WindowManager.LayoutParams.FLAG_BLUR_BEHIND
        attributes.blurBehindRadius = radius
        window.attributes = attributes
        onDispose { window.attributes = previous }
    }
}

/** The dialog window a Compose view was mounted into, if there is one. */
private fun View.findDialogWindow(): Window? {
    var current: Any? = this
    while (current is View) {
        if (current is DialogWindowProvider) return current.window
        current = current.parent
    }
    return null
}

/**
 * A round chrome button with one glyph — the shape of every action in the chrome
 * that is not a pill.
 *
 * The tile keeps the size the design draws it at; the clickable area around it is
 * always at least [MIN_TOUCH_TARGET], so a 44 dp tile does not hand back a target
 * Android considers too small.
 */
@Composable
internal fun ChromeButton(
    icon: ImageVector,
    contentDescription: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = 44.dp,
    glyph: Dp = 20.dp,
    enabled: Boolean = true,
    tint: Color = Color.Unspecified,
    glass: Boolean = false,
    surface: Boolean = false,
) {
    ChromeButton(modifier, size, enabled, onClick, glass, surface, contentDescription) {
        // The target carries the name; the glyph is decorative, otherwise the
        // control exposes a silent parent and a description child.
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = if (tint == Color.Unspecified) MaterialTheme.colorScheme.onSurface else tint,
            modifier = Modifier.size(glyph),
        )
    }
}

/** The same button for a glyph the core icon set does not carry. */
@Composable
internal fun ChromeButton(
    painter: Painter,
    contentDescription: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = 44.dp,
    glyph: Dp = 20.dp,
    enabled: Boolean = true,
    tint: Color = Color.Unspecified,
    glass: Boolean = false,
    surface: Boolean = false,
) {
    ChromeButton(modifier, size, enabled, onClick, glass, surface, contentDescription) {
        Icon(
            painter = painter,
            contentDescription = null,
            tint = if (tint == Color.Unspecified) MaterialTheme.colorScheme.onSurface else tint,
            modifier = Modifier.size(glyph),
        )
    }
}

@Composable
private fun ChromeButton(
    modifier: Modifier,
    size: Dp,
    enabled: Boolean,
    onClick: () -> Unit,
    glass: Boolean,
    surface: Boolean,
    contentDescription: String?,
    glyph: @Composable () -> Unit,
) {
    // The name lives on the target. Leaving it to the glyph produced a
    // clickable parent with no label and a separate description child.
    TouchTarget(
        modifier = modifier,
        size = size,
        enabled = enabled,
        onClick = onClick,
        contentDescription = contentDescription,
    ) {
        Box(
            // Minis draws header actions as bare glyphs on the page. A glass
            // circle is the floating-chrome variant: the target stays 48 dp,
            // the visible tile is the size the design asks for.
            modifier = Modifier
                .size(size)
                .then(
                    when {
                        surface -> Modifier.chromeCapsule(surface = true)
                        glass -> Modifier.chromeCapsule()
                        else -> Modifier
                    },
                ),
            contentAlignment = Alignment.Center,
            content = { glyph() },
        )
    }
}

/**
 * Leaving a flat header — Settings and the screens it opens.
 *
 * The glyph keeps the 32 dp tile the header is drawn with; the target around it
 * is [MIN_TOUCH_TARGET], because a 32 dp target is one Android considers too
 * small to hit.
 */
@Composable
internal fun HeaderBackButton(onBack: () -> Unit, modifier: Modifier = Modifier) {
    TouchTarget(onClick = onBack, modifier = modifier, contentDescription = "返回") {
        Icon(
            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
            contentDescription = null,
            tint = minisInk,
            modifier = Modifier.size(22.dp),
        )
    }
}

/**
 * A control drawn at [size] but hit at [MIN_TOUCH_TARGET]: the visual stays where
 * the design puts it while the target stays where Android's guidance puts it.
 *
 * [contentDescription] is for a target whose content says nothing on its own — a
 * bare glyph, a face. Where the content is already a labelled icon or a line of
 * text, leave it null and let that name the button.
 */
@Composable
internal fun TouchTarget(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = MIN_TOUCH_TARGET,
    enabled: Boolean = true,
    contentDescription: String? = null,
    content: @Composable BoxScope.() -> Unit,
) {
    // One interaction source for both the ripple and the press spring, so the
    // animation and the ripple can never disagree about whether a finger is down.
    val interaction = remember { MutableInteractionSource() }
    Box(
        modifier = modifier
            .size(if (size > MIN_TOUCH_TARGET) size else MIN_TOUCH_TARGET)
            .pressScale(interaction)
            .clip(CircleShape)
            .clickable(
                interactionSource = interaction,
                indication = LocalIndication.current,
                enabled = enabled,
                role = Role.Button,
                onClick = onClick,
            )
            .then(
                if (contentDescription == null) {
                    Modifier
                } else {
                    // One named node, not a silent clickable parent plus a
                    // description child. `clickable` still handles the touch;
                    // this block replaces its semantics and re-adds the same
                    // action so TalkBack announces and activates one button.
                    Modifier.clearAndSetSemantics {
                        this.contentDescription = contentDescription
                        this.role = Role.Button
                        // A disabled control must not keep an action TalkBack
                        // can invoke: re-add it only when the touch target is
                        // also enabled.
                        if (enabled) {
                            semanticsOnClick(label = contentDescription) {
                                onClick()
                                true
                            }
                        }
                    }
                },
            ),
        contentAlignment = Alignment.Center,
        content = content,
    )
}
