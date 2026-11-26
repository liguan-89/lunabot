package com.lunabot.companion.ui.widget

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertTrue

class ShrinkRowWidthsTest {
    @Test
    fun `flex children share the room fixed children leave`() {
        assertContentEquals(
            intArrayOf(100, 66, 33),
            shrinkRowWidths(intArrayOf(100, 999, 999), listOf(0f, 2f, 1f), avail = 200),
        )
    }

    @Test
    fun `fixed children shrink proportionally when they already exceed the row`() {
        val widths = shrinkRowWidths(intArrayOf(150, 50, 999), listOf(0f, 0f, 1f), avail = 100)

        assertContentEquals(intArrayOf(75, 25, 0), widths)
        assertTrue(widths.sum() <= 100)
    }

    @Test
    fun `a row without flex keeps the old proportional shrink`() {
        assertContentEquals(
            intArrayOf(60, 40),
            shrinkRowWidths(intArrayOf(120, 80), listOf(0f, 0f), avail = 100),
        )
    }
}
