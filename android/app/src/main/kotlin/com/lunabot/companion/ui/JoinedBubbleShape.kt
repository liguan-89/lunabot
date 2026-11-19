package com.lunabot.companion.ui

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The shape of one bubble inside a run of the same person's lines.
 *
 * Two adjacent bubbles that both kept all four corners round read as two cards;
 * tucking the corners that touch turns a run into one block, which is what every
 * messaging app the transcript is imitating does. The tucked corner is
 * [MinisBubbleJoinedCorner] (6dp) against the standing 18dp.
 *
 * The rule is about geometry, not sides: the corners that face the page stay
 * round and the ones that face a neighbour tuck in. A bubble alone in its run
 * keeps all four, so a single line looks exactly as it did before.
 *
 * The bot's answers draw no fill (the transcript is text-first), so this only
 * changes what your own words look like; the shape is still computed for both
 * so a caller never has to branch on the role.
 */
fun joinedBubbleShape(
    mine: Boolean,
    startsRun: Boolean,
    endsRun: Boolean,
    corner: Dp = 18.dp,
    joined: Dp = MinisBubbleJoinedCorner,
): RoundedCornerShape {
    if (startsRun && endsRun) return RoundedCornerShape(corner)
    // Your bubble sits on the right, so its top-right and bottom-right are the
    // corners a neighbour touches; on the left the mirror image.
    val topJoin = !startsRun
    val bottomJoin = !endsRun
    return if (mine) {
        RoundedCornerShape(
            topStart = corner,
            topEnd = if (topJoin) joined else corner,
            bottomEnd = if (bottomJoin) joined else corner,
            bottomStart = corner,
        )
    } else {
        RoundedCornerShape(
            topStart = if (topJoin) joined else corner,
            topEnd = corner,
            bottomEnd = corner,
            bottomStart = if (bottomJoin) joined else corner,
        )
    }
}
