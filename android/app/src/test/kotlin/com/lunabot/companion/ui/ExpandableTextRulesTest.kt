package com.lunabot.companion.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * When a card body folds, and how much it keeps.
 *
 * The decision is made from what the layout engine measured, not from the
 * character count: the screenshot that started this had a 150-character
 * question — under every limit the desktop uses — which took seven lines on a
 * phone and filled the screen.
 */
class ExpandableTextRulesTest {
    @Test
    fun `text that fitted gets no toggle`() {
        assertFalse(ExpandableTextRules.toggleVisible(expanded = false, overflowed = false))
    }

    @Test
    fun `text that overflowed gets a toggle`() {
        assertTrue(ExpandableTextRules.toggleVisible(expanded = false, overflowed = true))
    }

    @Test
    fun `an open block keeps its toggle so it can be closed again`() {
        // Opening the text removes the overflow it was measured from; without
        // this the only way back would be leaving the thread.
        assertTrue(ExpandableTextRules.toggleVisible(expanded = true, overflowed = false))
        assertTrue(ExpandableTextRules.toggleVisible(expanded = true, overflowed = true))
    }

    @Test
    fun `folded text is capped and open text is not`() {
        assertEquals(4, ExpandableTextRules.maxLines(expanded = false))
        assertEquals(Int.MAX_VALUE, ExpandableTextRules.maxLines(expanded = true))
    }

    @Test
    fun `the folded view is four lines`() {
        // The number every folded card shows at once; pinned so changing it is
        // a decision rather than a side effect.
        assertEquals(4, ExpandableTextRules.COLLAPSED_LINES)
    }
}
