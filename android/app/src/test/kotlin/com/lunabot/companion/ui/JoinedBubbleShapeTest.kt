package com.lunabot.companion.ui

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Where a bubble's corners tuck in.
 *
 * The rule is geometric, not per-role: the corners that face the page stay round
 * and the ones that touch a neighbour in the same run tuck to 6dp. A bubble alone
 * in its run is exactly the plain 18dp shape it was before, so nothing that used
 * to look right changed.
 *
 * `RoundedCornerShape` compares by its four corner values, so equality against a
 * hand-built shape is the assertion: it fails on the one corner that is wrong.
 */
class JoinedBubbleShapeTest {
    private fun shape(
        topStart: Int,
        topEnd: Int,
        bottomEnd: Int,
        bottomStart: Int,
    ) = RoundedCornerShape(
        topStart = topStart.dp,
        topEnd = topEnd.dp,
        bottomEnd = bottomEnd.dp,
        bottomStart = bottomStart.dp,
    )

    // The standing corner and the tucked one, from the design tokens.
    private val round = MinisBubbleCorner.value.toInt()
    private val tuck = MinisBubbleJoinedCorner.value.toInt()

    @Test
    fun `a bubble alone in its run keeps all four corners`() {
        assertEquals(
            shape(round, round, round, round),
            joinedBubbleShape(mine = true, startsRun = true, endsRun = true),
        )
        assertEquals(
            shape(round, round, round, round),
            joinedBubbleShape(mine = false, startsRun = true, endsRun = true),
        )
    }

    @Test
    fun `the first bubble of a run tucks only its bottom corner`() {
        // It is followed by another line, so only the bottom touches one.
        assertEquals(
            shape(round, round, tuck, round),
            joinedBubbleShape(mine = true, startsRun = true, endsRun = false),
        )
        assertEquals(
            shape(round, round, round, tuck),
            joinedBubbleShape(mine = false, startsRun = true, endsRun = false),
        )
    }

    @Test
    fun `a middle bubble tucks both of its inner corners`() {
        assertEquals(
            shape(round, tuck, tuck, round),
            joinedBubbleShape(mine = true, startsRun = false, endsRun = false),
        )
        assertEquals(
            shape(tuck, round, round, tuck),
            joinedBubbleShape(mine = false, startsRun = false, endsRun = false),
        )
    }

    @Test
    fun `the last bubble of a run tucks only its top corner`() {
        assertEquals(
            shape(round, tuck, round, round),
            joinedBubbleShape(mine = true, startsRun = false, endsRun = true),
        )
        assertEquals(
            shape(tuck, round, round, round),
            joinedBubbleShape(mine = false, startsRun = false, endsRun = true),
        )
    }

    @Test
    fun `the side the bubble sits on decides which corners are inner`() {
        // A user bubble is on the right, so its inner corners are the end ones;
        // the bot's are the mirror image. Both are computed, so no caller branches.
        val mine = joinedBubbleShape(mine = true, startsRun = false, endsRun = false)
        val theirs = joinedBubbleShape(mine = false, startsRun = false, endsRun = false)
        assertEquals(shape(round, tuck, tuck, round), mine)
        assertEquals(shape(tuck, round, round, tuck), theirs)
    }
}
