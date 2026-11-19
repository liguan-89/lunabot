package com.lunabot.companion.ui

import androidx.compose.ui.unit.dp
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The bot's bubble leaves a wide gutter on a short answer and a narrow one once
 * the answer runs past five lines.
 *
 * The threshold is on lines rather than characters because the same sentence is
 * three lines on a small phone and two on a large one: a character count would
 * call it long on one device and short on the other, so the same message would
 * change shape when the phone rotated.
 */
class BotBubbleGutterTest {
    @Test
    fun `a short answer keeps the wide gutter`() {
        assertEquals(BotBubbleGutter.SHORT, BotBubbleGutter.of(lineCount = 1))
        assertEquals(BotBubbleGutter.SHORT, BotBubbleGutter.of(lineCount = 3))
        assertEquals(BotBubbleGutter.SHORT, BotBubbleGutter.of(lineCount = 5))
    }

    @Test
    fun `past five lines the bubble uses the room`() {
        assertEquals(BotBubbleGutter.LONG, BotBubbleGutter.of(lineCount = 6))
        assertEquals(BotBubbleGutter.LONG, BotBubbleGutter.of(lineCount = 40))
    }

    @Test
    fun `the two gutters differ, and the long one is the narrower`() {
        // The whole point: a long answer gets more room, not less.
        assertEquals(true, BotBubbleGutter.LONG < BotBubbleGutter.SHORT)
        assertEquals(44.dp, BotBubbleGutter.SHORT)
        assertEquals(24.dp, BotBubbleGutter.LONG)
        assertEquals(5, BotBubbleGutter.LONG_ANSWER_LINES)
    }
}
