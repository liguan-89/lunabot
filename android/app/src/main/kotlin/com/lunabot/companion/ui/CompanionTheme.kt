package com.lunabot.companion.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat

/**
 * The app's colours: the Minis phone palette.
 *
 * Monochrome by design — ink on the page, one blue accent for links and live
 * states, and grouped grey cards for anything that groups. The mascot colours
 * still come from [MausPalette] wherever a bot's own identity is drawn; they
 * are no longer the app's primary.
 */
private val LightColors = lightColorScheme(
    primary = MinisTokens.InkLight,
    onPrimary = MinisTokens.PageLight,
    primaryContainer = MinisTokens.GroupedLight,
    onPrimaryContainer = MinisTokens.InkLight,
    secondary = MinisTokens.AccentLight,
    onSecondary = Color.White,
    // Material's default secondary container is a lavender that shows up in
    // SegmentedButton selections; the palette has no lavender.
    secondaryContainer = MinisTokens.GroupedLight,
    onSecondaryContainer = MinisTokens.InkLight,
    // The window behind the safe insets is the Grok Bot canvas; screens that
    // want a white sheet paint one themselves.
    background = MinisTokens.CanvasLight,
    onBackground = MinisTokens.InkLight,
    surface = MinisTokens.PageLight,
    onSurface = MinisTokens.InkLight,
    surfaceVariant = MinisTokens.GroupedLight,
    onSurfaceVariant = MinisTokens.SecondaryLight,
    surfaceContainerLowest = MinisTokens.PageLight,
    surfaceContainerLow = MinisTokens.GroupedLight,
    surfaceContainer = MinisTokens.GroupedLight,
    surfaceContainerHigh = MinisTokens.GroupedLight,
    surfaceContainerHighest = MinisTokens.GroupedLight,
    outline = MinisTokens.TertiaryLight,
    outlineVariant = MinisTokens.SeparatorLight,
    // Material's default tertiary is a plum that belongs to no palette here.
    // Mapping it to the warning keeps a forgotten call site inside the design
    // instead of leaking a fourth hue into a monochrome page.
    tertiary = MinisTokens.Warning,
    onTertiary = MinisTokens.PageLight,
    tertiaryContainer = MinisTokens.WarningWashLight,
    onTertiaryContainer = MinisTokens.InkLight,
    error = MinisTokens.Danger,
)

private val DarkColors = darkColorScheme(
    primary = MinisTokens.InkDark,
    onPrimary = MinisTokens.PageDark,
    primaryContainer = MinisTokens.GroupedDark,
    onPrimaryContainer = MinisTokens.InkDark,
    secondary = MinisTokens.AccentDark,
    onSecondary = Color.Black,
    secondaryContainer = MinisTokens.RaisedDark,
    onSecondaryContainer = MinisTokens.InkDark,
    background = MinisTokens.CanvasDark,
    onBackground = MinisTokens.InkDark,
    surface = MinisTokens.PageDark,
    onSurface = MinisTokens.InkDark,
    surfaceVariant = MinisTokens.GroupedDark,
    onSurfaceVariant = MinisTokens.SecondaryDark,
    surfaceContainerLowest = MinisTokens.PageDark,
    surfaceContainerLow = MinisTokens.GroupedDark,
    surfaceContainer = MinisTokens.GroupedDark,
    surfaceContainerHigh = MinisTokens.RaisedDark,
    surfaceContainerHighest = MinisTokens.RaisedDark,
    outline = MinisTokens.SeparatorDark,
    outlineVariant = MinisTokens.SeparatorDark,
    tertiary = MinisTokens.Warning,
    onTertiary = MinisTokens.PageDark,
    tertiaryContainer = MinisTokens.WarningWashDark,
    onTertiaryContainer = MinisTokens.InkDark,
    error = MinisTokens.Danger,
)

/**
 * Reading direction comes from the words, not from the locale's layout.
 *
 * Compose's default is [TextDirection.Unspecified], and — unlike the platform's
 * own `TextView`, whose default is `TEXT_DIRECTION_FIRST_STRONG` — it resolves
 * straight off `LocalLayoutDirection`: an RTL locale gives *every* paragraph an
 * RTL base level, English or not. On an `ar-EG` device that produced three
 * measured defects, all of them the same bidi reordering:
 *
 *  - trailing punctuation jumped to the front — *"What do you mostly want help
 *    with?"* drew as *"?What do you mostly want help with"*, because a neutral
 *    `?` at the end of an LTR run inside an RTL paragraph resolves to the
 *    paragraph level and is reordered to the paragraph's leading edge;
 *  - a counted list came out backwards — the bot's *"1 2 3 … 20"* drew as
 *    *"16 15 … 1"*, because digits are weak, the spaces between them resolve to
 *    R, and the whole sequence lays out right to left;
 *  - one-line roster previews lost their opening characters — *"error: CUA
 *    Driver is not ready…"* drew as *"ror: CUA Driver…"*, the line being aligned
 *    to the right and ellipsised at what the paragraph thought was its start.
 *
 * [TextDirection.ContentOrLtr] resolves the base level from the first strong
 * character instead: English stays LTR with its punctuation in place, Arabic a
 * user types stays RTL, and text with no strong character at all — a bare
 * number, a timestamp, a path — falls back to LTR rather than to the locale.
 * That last fallback is the one place this goes past `TextView`'s
 * `FIRST_STRONG` (which falls back to the layout direction), and it is what
 * fixes the counted list.
 *
 * It is a choice about this product, not a fact about text, and it has a price:
 * a paragraph with no strong character is anchored LTR even when an Arabic user
 * typed it — Arabic-Indic digits, an emoji-only line, bare punctuation from the
 * composer. The choice is made for what this app actually carries: counts,
 * clock times, file paths, code and command output, read left to right whoever
 * is holding the phone. If the app ever ships an RTL translation, or grows text
 * where a neutral line should follow the reader rather than the content, this
 * is the line to come back to.
 *
 * This is only about the direction glyphs are *ordered* in. Where the box sits
 * is untouched: `Row`/`Column`, `padding(start=)`, `placeRelative` and the
 * auto-mirrored icons all keep reading `LocalLayoutDirection`, so the chrome,
 * the bubble sides and the table's mirrored columns still follow the locale.
 *
 * It is set on the theme's [Typography] rather than at every call site, so it
 * reaches whatever Compose draws under this theme — the message bubbles, the
 * roster previews, the labels — by way of `LocalTextStyle` and the
 * `MaterialTheme.typography` slots, with nothing new to remember at the next
 * call site.
 *
 * Its reach ends where the theme does. Notifications are drawn by SystemUI in
 * its own window, from strings that never pass through a Compose typography, so
 * the same policy has to be carried there inside the string itself — see
 * `notifications.NotificationText`, which anchors each notification paragraph
 * that would otherwise take the shade's base direction.
 */
private fun TextStyle.readingFromContent(): TextStyle =
    copy(textDirection = TextDirection.ContentOrLtr)

private val ContentDirectedTypography: Typography = Typography().run {
    copy(
        displayLarge = displayLarge.readingFromContent(),
        displayMedium = displayMedium.readingFromContent(),
        displaySmall = displaySmall.readingFromContent(),
        headlineLarge = headlineLarge.readingFromContent(),
        headlineMedium = headlineMedium.readingFromContent(),
        headlineSmall = headlineSmall.readingFromContent(),
        titleLarge = titleLarge.readingFromContent(),
        titleMedium = titleMedium.readingFromContent(),
        titleSmall = titleSmall.readingFromContent(),
        bodyLarge = bodyLarge.readingFromContent(),
        bodyMedium = bodyMedium.readingFromContent(),
        bodySmall = bodySmall.readingFromContent(),
        labelLarge = labelLarge.readingFromContent(),
        labelMedium = labelMedium.readingFromContent(),
        labelSmall = labelSmall.readingFromContent(),
    )
}

@Composable
fun CompanionTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    // The status and gesture bars follow the app's theme, not only the phone's.
    // MainActivity applies the launch-time answer; this is what changes it when
    // someone overrides the theme in Settings. ComputerScreen overrides the
    // icons for its black viewer and restores this same answer on dispose.
    val view = LocalView.current
    LaunchedEffect(darkTheme) {
        val window = view.context.findActivity()?.window ?: return@LaunchedEffect
        WindowCompat.getInsetsController(window, view).apply {
            isAppearanceLightStatusBars = !darkTheme
            isAppearanceLightNavigationBars = !darkTheme
        }
    }
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = ContentDirectedTypography,
        shapes = MinisShapes,
        content = content,
    )
}

/** Material's slots, derived from the same corners [MinisDesign] draws by hand. */
private val MinisShapes = androidx.compose.material3.Shapes(
    extraSmall = MinisChipShape,
    small = MinisControlShape,
    medium = MinisCardShape,
    large = MinisComposerShape,
    extraLarge = MinisSheetShape,
)

/** SwiftUI's `Color.secondary` — the muted foreground everything quiet uses. */
val secondaryTint: Color
    @Composable get() = MaterialTheme.colorScheme.onSurfaceVariant
