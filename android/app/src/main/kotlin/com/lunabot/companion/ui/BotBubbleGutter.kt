package com.lunabot.companion.ui

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * How much room the bot's bubble leaves on its far side.
 *
 * A short answer keeps a wide gutter, so the two sides read as two speakers: the
 * bot's bubble stops well short of the right edge, mirroring the space your own
 * bubble keeps on the left. A long answer is the case that gutter hurts — every
 * dp taken from the right is a word that moves to the next line — so past
 * [LONG_ANSWER_LINES] lines the bubble is allowed to use the room, and only a
 * narrow gutter is kept so it still does not touch the edge.
 *
 * The threshold is on *measured* lines rather than characters: the same sentence
 * is three lines on a small phone and two on a large one, and a character count
 * would call it long on one and short on the other.
 */
object BotBubbleGutter {
    /** Short answers: the bubble stops well short of the edge. */
    val SHORT = 32.dp

    /** Long answers: the bubble uses the room, keeping only a hair of margin. */
    val LONG = 16.dp

    /** Past this many lines the answer is long enough that the room matters more. */
    const val LONG_ANSWER_LINES = 5

    fun of(lineCount: Int): Dp = if (lineCount > LONG_ANSWER_LINES) LONG else SHORT
}
