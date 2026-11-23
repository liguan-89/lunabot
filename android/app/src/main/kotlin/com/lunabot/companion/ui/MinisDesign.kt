package com.lunabot.companion.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.Alignment
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Design tokens for the Minis-style phone surface.
 *
 * Values re-derived from the OpenMinis look: monochrome ink on white or black,
 * iOS-style grouped cards, one desaturated blue accent for links and live
 * states, and a warm beige floating action button. No OpenMinis source is
 * copied; this is an independent implementation of the same visual language.
 *
 * Everything reads the theme's current surface, so a forced light subtree (the
 * transcript share export) still gets the palette that belongs to it.
 */
object MinisTokens {
    val AccentLight = Color(0xFF528AD2)
    val AccentDark = Color(0xFF6A94CE)
    val PageLight = Color(0xFFFFFFFF)
    val PageDark = Color(0xFF000000)
    // Pure Muse editorial white canvas so oatmeal user bubbles, soft-grey bot
    // bubbles, and hairline dividers breathe with zero visual weight.
    val CanvasLight = Color(0xFFFFFFFF)
    val CanvasDark = Color(0xFF0B0B0C)
    val CardLight = Color(0xFFFFFFFF)
    val CardDark = Color(0xFF1C1C1E)
    val SoftCardLight = Color(0xFFF5F5F3)
    val GroupedLight = Color(0xFFF3F3F1)
    val GroupedDark = Color(0xFF1C1C1E)
    val RaisedDark = Color(0xFF2C2C2E)
    val InkLight = Color(0xFF111111)
    val InkDark = Color(0xFFFFFFFF)
    val SecondaryLight = Color(0x993C3C43)
    val SecondaryDark = Color(0x99EBEBF5)
    val TertiaryLight = Color(0x4D3C3C43)
    val TertiaryDark = Color(0x4DEBEBF5)
    val SeparatorLight = Color(0x14000000)
    val SeparatorDark = Color(0xFF38383A)
    // Muse-inspired warm oatmeal-taupe user bubble paired with a quiet soft-grey
    // bot bubble — warm, calm, and legible without borders or harsh shadows.
    val UserBubbleLight = Color(0xFFD2C4B6)
    val UserBubbleDark = Color(0xFF453E36)
    val BubbleRimLight = Color(0x00000000)
    val BubbleRimDark = Color(0x14FFFFFF)
    val BotBubbleLight = Color(0xFFE6E6E3)
    val BotBubbleDark = Color(0xFF26262A)
    val FabLight = Color(0xFFB7AF96)
    val FabDark = Color(0xFF504C42)
    val Danger = Color(0xFFFF3B30)
    val Success = Color(0xFF34C759)
    val Warning = Color(0xFFFF9500)

    // The warning's own wash, for a banner or inline error that needs a body.
    // Two alphas rather than one because a 12% orange over white is a tint and
    // the same alpha over black is mud.
    val WarningWashLight = Color(0x1FFF9500)
    val WarningWashDark = Color(0x26FF9500)

    // Liquid Gloss: a translucent fill, a rim that catches the light and a
    // short sheen. Alphas are the look — there is no backdrop blur here, so
    // the glass reads through what sits behind it. In light mode the fill is
    // near-opaque white and the rim a dark hairline: the previous translucent
    // grey (0xCCF4F5F9) sat within 3/255 of the F4F4F5 canvas, and on it the
    // search field, menus and chips all but vanished.
    val GlassLight = Color(0xEBFFFFFF)
    val GlassDark = Color(0xCC1E1E22)
    val GlassBlurTintLight = Color(0xADFFFFFF)
    val GlassBlurTintDark = Color(0x9E1C1C22)
    val ControlLight = Color(0xFFFFFFFF)
    val ControlDark = Color(0xE62C2C2E)
    // The floating chat header sits on scrolling text, so it is a step more
    // opaque than the rest of the chrome.
    val GlassHeaderLight = Color(0xF2FBFBFD)
    val GlassHeaderDark = Color(0xF51C1C1E)
    val SheenLight = Color(0x66FFFFFF)
    val SheenDark = Color(0x24FFFFFF)
    val RimLight = Color(0x0E000000)
    val RimHighlightLight = Color(0xCCFFFFFF)
    val RimDark = Color(0x38FFFFFF)
}

@Composable
fun minisIsDark(): Boolean = MaterialTheme.colorScheme.surface.luminance() < 0.5f

/**
 * The colour the root paints behind the system bars, outside its safe-drawing
 * inset. Null means the theme's page colour.
 *
 * A screen that is deliberately full-bleed (the computer viewer, which is a
 * screenshot on black) sets this while it is on screen. It is a single-window
 * app, so one value is the whole model — a CompositionLocal would have to be
 * threaded through the navigator for exactly one screen.
 */
object SystemBarBackdrop {
    var color by mutableStateOf<Color?>(null)
}

/** Primary text. Black on the light page, white on the dark page. */
val minisInk: Color
    @Composable get() = if (minisIsDark()) MinisTokens.InkDark else MinisTokens.InkLight

/** The page itself: white or black. */
val minisPage: Color
    @Composable get() = if (minisIsDark()) MinisTokens.PageDark else MinisTokens.PageLight

/** The Grok Bot canvas: a light grey page that white cards sit on. */
val minisCanvas: Color
    @Composable get() = if (minisIsDark()) MinisTokens.CanvasDark else MinisTokens.CanvasLight

/** A card or control on [minisCanvas]. */
val minisCard: Color
    @Composable get() = if (minisIsDark()) MinisTokens.CardDark else MinisTokens.CardLight

/** The hairline that makes a bubble a shape on the canvas. */
val minisBubbleRim: Color
    @Composable get() = if (minisIsDark()) MinisTokens.BubbleRimDark else MinisTokens.BubbleRimLight

/** Muted foreground, like iOS `secondaryLabel`. */
val minisSecondary: Color
    @Composable get() = if (minisIsDark()) MinisTokens.SecondaryDark else MinisTokens.SecondaryLight

/** Faint foreground, like iOS `tertiaryLabel`. */
val minisTertiary: Color
    @Composable get() = if (minisIsDark()) MinisTokens.TertiaryDark else MinisTokens.TertiaryLight

/** The one accent: link blue, live indicators, selection. */
val minisAccent: Color
    @Composable get() = if (minisIsDark()) MinisTokens.AccentDark else MinisTokens.AccentLight

/** A grouped card surface, like iOS `secondarySystemGroupedBackground`. */
val minisGrouped: Color
    @Composable get() = if (minisIsDark()) MinisTokens.GroupedDark else MinisTokens.GroupedLight

/** Soft warm-neutral rounded card surface on the pure-white Muse canvas. */
val minisSoftCard: Color
    @Composable get() = if (minisIsDark()) MinisTokens.GroupedDark else MinisTokens.SoftCardLight

/** A raised grouped card, one step above [minisGrouped] in dark mode. */
val minisRaised: Color
    @Composable get() = if (minisIsDark()) MinisTokens.RaisedDark else MinisTokens.GroupedLight

/** The warm beige of the new-chat action. */
val minisFab: Color
    @Composable get() = if (minisIsDark()) MinisTokens.FabDark else MinisTokens.FabLight

val minisSeparator: Color
    @Composable get() = if (minisIsDark()) MinisTokens.SeparatorDark else MinisTokens.SeparatorLight

/**
 * The three status colours the interface is allowed to speak with. Everything
 * else is ink, grey or the one accent; a fourth hue at a call site is how the
 * palette drifted into three oranges and two greens.
 */
val minisWarning: Color
    @Composable get() = MinisTokens.Warning

val minisWarningWash: Color
    @Composable get() = if (minisIsDark()) MinisTokens.WarningWashDark else MinisTokens.WarningWashLight

val minisSuccess: Color
    @Composable get() = MinisTokens.Success

val minisDanger: Color
    @Composable get() = MinisTokens.Danger

/** The translucent fill the floating chrome is made of. */
val minisGlass: Color
    @Composable get() = if (minisIsDark()) MinisTokens.GlassDark else MinisTokens.GlassLight

/** The filled glass of an input control: tinted, so it is a surface rather
 *  than a window onto a page that is already the same colour. */
val minisControl: Color
    @Composable get() = if (minisIsDark()) MinisTokens.ControlDark else MinisTokens.ControlLight

/** One step more opaque, for the header that sits on scrolling text. */
val minisGlassHeader: Color
    @Composable get() = if (minisIsDark()) MinisTokens.GlassHeaderDark else MinisTokens.GlassHeaderLight

/** The specular highlight along the top edge. */
val minisGlassSheen: Color
    @Composable get() = if (minisIsDark()) MinisTokens.SheenDark else MinisTokens.SheenLight

/** The 0.5 dp rim that catches the light. */
val minisGlassRim: Color
    @Composable get() = if (minisIsDark()) MinisTokens.RimDark else MinisTokens.RimLight

val minisGlassBlurTint: Color
    @Composable get() = if (minisIsDark()) MinisTokens.GlassBlurTintDark else MinisTokens.GlassBlurTintLight

/** Page and row rhythm: one horizontal inset for full-width content, one for
 *  group headers that sit a step further in. */
val MinisPagePadding = 16.dp
val MinisRowIndent = 20.dp

val MinisCardShape = RoundedCornerShape(16.dp)

/**
 * A bubble's standing corner. The shape a bubble actually draws comes from
 * [joinedBubbleShape], which tucks the corners that touch a neighbour in the
 * same run; this is the round one it falls back to.
 *
 * 21dp rather than 18: at a 45dp bubble the smaller radius read as a rounded
 * rectangle, and the reference this transcript is measured against uses 21.
 */
val MinisBubbleCorner = 22.dp
val MinisComposerShape = RoundedCornerShape(26.dp)

/** Muse-style crisp floating white control surface: whisper-soft pillow shadow + 0.75dp hairline. */
@Composable
fun Modifier.museFloatingPill(
    shape: Shape = androidx.compose.foundation.shape.CircleShape,
    elevation: Dp = 4.dp,
): Modifier {
    val dark = minisIsDark()
    return if (dark) {
        this.clip(shape).background(minisCard).border(0.6.dp, Color(0x20FFFFFF), shape)
    } else {
        this
            .shadow(
                elevation = elevation,
                shape = shape,
                ambientColor = Color(0x0D000000),
                spotColor = Color(0x14000000),
            )
            .clip(shape)
            .background(Color.White)
            .border(0.75.dp, Color(0xFFE9E9E7), shape)
    }
}

/** The corner a bubble tucks in where it touches the next line of its run. */
val MinisBubbleJoinedCorner = 6.dp

/** Small chips and code blocks. */
val MinisChipShape = RoundedCornerShape(10.dp)

/** Buttons and input controls. */
val MinisControlShape = RoundedCornerShape(12.dp)

/** Bottom sheets: top-only 28dp corners so the bottom edge sits flush. */
val MinisSheetShape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)

/** Centered dialogs and floating cards with all four corners rounded. */
val MinisDialogShape = RoundedCornerShape(28.dp)

/** Standard scrim behind ModalBottomSheet surfaces. */
val MinisSheetScrim = Color.Black.copy(alpha = 0.20f)

/** Consistent Muse drag handle for every ModalBottomSheet. */
@Composable
internal fun MuseSheetDragHandle() {
    Box(
        modifier = Modifier
            .padding(top = 8.dp, bottom = 4.dp)
            .size(width = 36.dp, height = 4.dp)
            .clip(CircleShape)
            .background(minisTertiary),
    )
}

/**
 * Shared monochrome Muse toggle switch (display-only; parent row owns toggleable
 * semantics so TalkBack announces one control).
 */
@Composable
internal fun MuseSwitch(
    checked: Boolean,
    enabled: Boolean = true,
    modifier: Modifier = Modifier,
) {
    val dark = minisIsDark()
    val trackColor by animateColorAsState(
        targetValue = when {
            !enabled -> if (dark) Color(0xFF2C2C2E) else Color(0xFFE5E5E3)
            checked -> minisInk
            else -> if (dark) Color(0xFF3A3A3D) else Color(0xFFDDDCD9)
        },
        animationSpec = tween(160),
        label = "muse-switch-track",
    )
    val thumbOffset by animateDpAsState(
        targetValue = if (checked) 18.dp else 0.dp,
        animationSpec = tween(160),
        label = "muse-switch-thumb",
    )
    Box(
        modifier = modifier
            .size(width = 46.dp, height = 28.dp)
            .clip(CircleShape)
            .background(trackColor)
            .padding(3.dp)
            .clearAndSetSemantics {},
        contentAlignment = Alignment.CenterStart,
    ) {
        Box(
            modifier = Modifier
                .offset(x = thumbOffset)
                .size(22.dp)
                .shadow(2.dp, CircleShape, ambientColor = Color(0x18000000), spotColor = Color(0x22000000))
                .clip(CircleShape)
                .background(if (checked && dark) Color(0xFF111111) else Color.White),
        )
    }
}

/** A hairline separator, inset from the leading edge by default. */
@Composable
fun MinisDivider(
    modifier: Modifier = Modifier,
    insetStart: Dp = 0.dp,
) {
    androidx.compose.material3.HorizontalDivider(
        modifier = modifier.padding(start = insetStart),
        thickness = 0.5.dp,
        color = minisSeparator,
    )
}

/** A grouped settings card: rounded, filled, and gapped from its neighbours. */
@Composable
fun MinisCard(
    modifier: Modifier = Modifier,
    padding: PaddingValues = PaddingValues(16.dp),
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(minisGrouped, MinisCardShape)
            .padding(padding),
        content = content,
    )
}

/** The small uppercase caption above a group of rows. */
@Composable
fun MinisSectionHeader(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        // A caption that names a group is a heading to a screen reader: it is
        // how TalkBack's by-heading navigation moves between groups.
        modifier = modifier
            .padding(horizontal = 20.dp, vertical = 6.dp)
            .semantics { heading() },
        fontSize = 13.sp,
        fontWeight = FontWeight.Medium,
        letterSpacing = 0.2.sp,
        color = minisSecondary,
    )
}

/**
 * The Liquid Gloss surface: a translucent fill, a rim that catches the light,
 * and a specular sheen fading down from it.
 *
 * There is no backdrop blur here on purpose. Compose can only blur a layer it
 * owns, and recording the backdrop every frame over a scrolling list buys the
 * look at the price of the scroll (see `Chrome.kt`). What this does is cheaper
 * and, on a page that already has something behind the chrome, reads the same:
 * the fill lets the content through, and the rim and sheen give the surface an
 * edge that a flat alpha rectangle does not have.
 *
 * The sheen is drawn *under* the content, so a title or glyph stays at full
 * contrast; only the fill behind it lightens.
 */
fun Modifier.minisGloss(
    shape: Shape,
    fill: Color,
    sheen: Color,
    rim: Color = Color.Transparent,
    elevation: Dp = 0.dp,
    fillBrush: Boolean = true,
): Modifier = this
    .then(
        if (elevation > 0.dp) {
            Modifier.shadow(
                elevation = elevation,
                shape = shape,
                clip = false,
                ambientColor = Color(0x14000000),
                spotColor = Color(0x1E000000),
            )
        } else {
            Modifier
        },
    )
    .clip(shape)
    .then(
        if (fillBrush) {
            Modifier.background(
                Brush.verticalGradient(
                    listOf(
                        fill,
                        fill.copy(alpha = (fill.alpha * 0.92f).coerceIn(0f, 1f)),
                    ),
                ),
                shape,
            )
        } else {
            Modifier
        },
    )
    .border(
        0.6.dp,
        Brush.verticalGradient(
            0f to rim,
            0.48f to rim.copy(alpha = rim.alpha * 0.28f),
            1f to rim.copy(alpha = rim.alpha * 0.62f),
        ),
        shape,
    )
    .drawWithContent {
        drawRect(
            Brush.verticalGradient(
                0f to sheen,
                0.42f to Color.Transparent,
                startY = 0f,
                endY = size.height,
            ),
        )
        drawContent()
    }

/**
 * The chief-of-staff crown the desktop puts after the main bot's name. Drawn as
 * a path rather than an icon font so it stays crisp at 12–14 dp and inherits the
 * accent colour.
 */
@Composable
fun CrownBadge(
    modifier: Modifier = Modifier,
    size: Dp = 14.dp,
    tint: Color? = null,
) {
    val color = tint ?: if (minisIsDark()) Color(0xFFF0B92E) else Color(0xFFD49B1A)
    androidx.compose.foundation.Canvas(modifier.size(size)) {
        val w = this.size.width
        val h = this.size.height
        val crown = androidx.compose.ui.graphics.Path().apply {
            moveTo(w * 0.08f, h * 0.80f)
            lineTo(w * 0.08f, h * 0.30f)
            lineTo(w * 0.30f, h * 0.54f)
            lineTo(w * 0.50f, h * 0.18f)
            lineTo(w * 0.70f, h * 0.54f)
            lineTo(w * 0.92f, h * 0.30f)
            lineTo(w * 0.92f, h * 0.80f)
            close()
        }
        drawPath(crown, color)
    }
}

@Composable
internal fun MinisSheetField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    label: String = placeholder,
    enabled: Boolean = true,
    singleLine: Boolean = true,
    minLines: Int = 1,
    maxLines: Int = if (singleLine) 1 else 6,
    isError: Boolean = false,
    containerColor: Color = Color.Unspecified,
    textStyle: TextStyle? = null,
    suffix: String? = null,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
) {
    val fill = if (containerColor == Color.Unspecified) minisSoftCard else containerColor
    val resolvedStyle = (textStyle ?: TextStyle(fontSize = 15.5.sp)).copy(color = minisInk)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        enabled = enabled,
        singleLine = singleLine,
        minLines = minLines,
        maxLines = maxLines,
        visualTransformation = visualTransformation,
        keyboardOptions = keyboardOptions,
        keyboardActions = keyboardActions,
        textStyle = resolvedStyle,
        cursorBrush = SolidColor(minisInk),
        modifier = modifier
            .fillMaxWidth()
            .clip(MinisCardShape)
            .background(fill, MinisCardShape)
            .then(
                if (isError) Modifier.border(1.dp, MinisTokens.Danger, MinisCardShape) else Modifier,
            )
            .padding(horizontal = 16.dp, vertical = 14.dp)
            .semantics { contentDescription = label },
        decorationBox = { inner ->
            androidx.compose.foundation.layout.Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(8.dp),
            ) {
                Box(modifier = Modifier.weight(1f)) {
                    if (value.isEmpty()) {
                        Text(
                            text = placeholder,
                            fontSize = resolvedStyle.fontSize,
                            color = minisTertiary,
                            textAlign = resolvedStyle.textAlign,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    inner()
                }
                if (suffix != null) {
                    Text(text = suffix, fontSize = 14.sp, color = minisSecondary)
                }
            }
        },
    )
}

/** Muse Plan-H porcelain paper card shape: airy 24dp corners. */
val MusePaperCardShape = RoundedCornerShape(24.dp)

/** Warm sand disc fill for Muse Plan-H status dots and icon medallions. */
val minisWarmSand: Color
    @Composable get() = if (minisIsDark()) Color(0xFF2B2925) else Color(0xFFEFECE6)

/** Warm linen hairline border for Muse Plan-H porcelain cards. */
val minisPaperBorder: Color
    @Composable get() = if (minisIsDark()) Color(0x20FFFFFF) else Color(0xFFE6E5E0)

/**
 * Muse Plan-H porcelain paper card surface: pure white with a razor-thin warm
 * linen hairline and whisper-soft studio shadow (elevated dark surface in dark mode).
 */
@Composable
fun Modifier.musePaperCard(
    danger: Boolean = false,
    shape: Shape = MusePaperCardShape,
): Modifier {
    val dark = minisIsDark()
    val borderColor = if (danger) {
        MinisTokens.Danger.copy(alpha = if (dark) 0.45f else 0.35f)
    } else {
        minisPaperBorder
    }
    return if (dark) {
        this.clip(shape).background(minisCard, shape).border(0.6.dp, borderColor, shape)
    } else {
        this
            .shadow(
                elevation = 3.dp,
                shape = shape,
                ambientColor = Color(0x0A000000),
                spotColor = Color(0x12000000),
            )
            .clip(shape)
            .background(Color.White, shape)
            .border(0.75.dp, borderColor, shape)
    }
}

/** Circular warm-sand medallion holding a status dot or thin line icon. */
@Composable
internal fun MuseCardBadge(
    size: Dp = 24.dp,
    tint: Color = Color.Unspecified,
    content: @Composable BoxScope.() -> Unit,
) {
    val fill = if (tint == Color.Unspecified) minisWarmSand else tint
    Box(
        modifier = Modifier
            .size(size)
            .clip(CircleShape)
            .background(fill, CircleShape),
        contentAlignment = Alignment.Center,
        content = content,
    )
}

/** Whisper-thin horizontal hairline separating card body from bottom actions. */
@Composable
internal fun MuseCardDivider(modifier: Modifier = Modifier) {
    androidx.compose.material3.HorizontalDivider(
        modifier = modifier,
        thickness = 0.5.dp,
        color = minisSeparator.copy(alpha = 0.65f),
    )
}

/** Matte charcoal-black (or terracotta danger) capsule button for Muse Plan-H cards. */
@Composable
internal fun MusePrimaryPillButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    danger: Boolean = false,
) {
    androidx.compose.material3.Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.heightIn(min = 42.dp),
        shape = CircleShape,
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
        colors = if (danger) {
            androidx.compose.material3.ButtonDefaults.buttonColors(
                containerColor = MinisTokens.Danger,
                contentColor = Color.White,
                disabledContainerColor = MinisTokens.Danger.copy(alpha = 0.35f),
                disabledContentColor = Color.White.copy(alpha = 0.7f),
            )
        } else {
            androidx.compose.material3.ButtonDefaults.buttonColors(
                containerColor = minisInk,
                contentColor = minisPage,
                disabledContainerColor = minisInk.copy(alpha = 0.25f),
                disabledContentColor = minisPage.copy(alpha = 0.7f),
            )
        },
    ) {
        Text(
            text = text,
            fontSize = 14.5.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
        )
    }
}

/** Soft warm-gray capsule button for secondary/dismiss actions in Muse Plan-H cards. */
@Composable
internal fun MuseSecondaryPillButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val dark = minisIsDark()
    val container = if (dark) MinisTokens.RaisedDark else Color(0xFFF0F0EE)
    androidx.compose.material3.Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.heightIn(min = 42.dp),
        shape = CircleShape,
        elevation = null,
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
        colors = androidx.compose.material3.ButtonDefaults.buttonColors(
            containerColor = container,
            contentColor = minisInk,
            disabledContainerColor = container.copy(alpha = 0.5f),
            disabledContentColor = minisTertiary,
        ),
    ) {
        Text(
            text = text,
            fontSize = 14.5.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
        )
    }
}
