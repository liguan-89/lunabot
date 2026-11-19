package com.openmausbot.companion.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.unit.Dp

/**
 * The bot's face as the app's mark: the disc is the whole circle, the eyes are
 * the page showing through.
 *
 * One drawing for every surface that carries the brand — the launch screen, the
 * first-run screens, the identity row and the sign-off in Settings — so the
 * app opens and closes on the same face. The roster's living portrait is the
 * other half of the same identity; this is the still one, for places a face
 * cannot blink (a list row, a header, a screen that is about to be replaced).
 */
@Composable
internal fun DexBotMark(diameter: Dp, modifier: Modifier = Modifier) {
    val disc = minisInk
    val eye = minisPage
    Canvas(modifier = modifier.size(diameter)) {
        drawCircle(disc)
        val eyeWidth = size.width * 0.13f
        val eyeHeight = size.height * 0.30f
        val radius = CornerRadius(eyeWidth / 2f, eyeWidth / 2f)
        drawRoundRect(
            color = eye,
            topLeft = Offset(size.width * 0.27f, size.height * 0.33f),
            size = Size(eyeWidth, eyeHeight),
            cornerRadius = radius,
        )
        drawRoundRect(
            color = eye,
            topLeft = Offset(size.width * 0.60f, size.height * 0.33f),
            size = Size(eyeWidth, eyeHeight),
            cornerRadius = radius,
        )
    }
}
