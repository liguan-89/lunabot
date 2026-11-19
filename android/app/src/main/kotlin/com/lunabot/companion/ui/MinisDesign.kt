package com.openmausbot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
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
    // The Grok Bot canvas: the page is a light grey, and every card, bubble and
    // control on it is white. Keeping it separate from [PageLight] means the
    // screens that still want a white sheet (settings, sheets) do not have to
    // move in the same change.
    val CanvasLight = Color(0xFFF4F4F5)
    val CanvasDark = Color(0xFF0B0B0C)
    val CardLight = Color(0xFFFFFFFF)
    val CardDark = Color(0xFF1C1C1E)
    val GroupedLight = Color(0xFFF2F2F7)
    val GroupedDark = Color(0xFF1C1C1E)
    val RaisedDark = Color(0xFF2C2C2E)
    val InkLight = Color(0xFF000000)
    val InkDark = Color(0xFFFFFFFF)
    val SecondaryLight = Color(0x993C3C43)
    val SecondaryDark = Color(0x99EBEBF5)
    val TertiaryLight = Color(0x4D3C3C43)
    val TertiaryDark = Color(0x4DEBEBF5)
    val SeparatorLight = Color(0x1F000000)
    val SeparatorDark = Color(0xFF38383A)
    // Your own words are the raised surface on a grey page, not a dark block.
    // The Grok Bot transcript keeps the bot on the page and gives only the
    // person a card.
    val UserBubbleLight = Color(0xFFFFFFFF)
    val UserBubbleDark = Color(0xFF2C2C2E)
    val BotBubbleLight = Color(0xFFF2F2F2)
    val BotBubbleDark = Color(0xFF2C2C2E)
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
    val RimLight = Color(0x22000000)
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
val MinisBubbleShape = RoundedCornerShape(18.dp)
val MinisComposerShape = RoundedCornerShape(24.dp)

/** Small chips and code blocks. */
val MinisChipShape = RoundedCornerShape(10.dp)

/** Buttons and input controls. */
val MinisControlShape = RoundedCornerShape(12.dp)

/** Sheets and large floating layers. */
val MinisSheetShape = RoundedCornerShape(28.dp)

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
    val color = tint ?: minisAccent
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
    singleLine: Boolean = true,
    minLines: Int = 1,
    maxLines: Int = if (singleLine) 1 else 6,
    isError: Boolean = false,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
) {
    val borderColor = if (isError) MinisTokens.Danger else minisSeparator
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = singleLine,
        minLines = minLines,
        maxLines = maxLines,
        visualTransformation = visualTransformation,
        keyboardOptions = keyboardOptions,
        keyboardActions = keyboardActions,
        textStyle = TextStyle(fontSize = 16.sp, color = minisInk),
        cursorBrush = SolidColor(minisAccent),
        modifier = modifier
            .fillMaxWidth()
            .clip(MinisCardShape)
            .background(minisCard, MinisCardShape)
            .border(if (isError) 1.dp else 0.5.dp, borderColor, MinisCardShape)
            .padding(horizontal = 16.dp, vertical = 14.dp)
            .semantics { contentDescription = label },
        decorationBox = { inner ->
            Box {
                if (value.isEmpty()) {
                    Text(placeholder, fontSize = 16.sp, color = minisTertiary)
                }
                inner()
            }
        },
    )
}
