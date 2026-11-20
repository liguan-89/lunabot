package com.lunabot.companion.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * When a folded block of card text offers its toggle.
 *
 * Kept separate from the composable so the fold is checked rather than eyeballed
 * on one phone.
 */
object ExpandableTextRules {
    /** Enough to tell what is being asked, small enough not to own the screen. */
    const val COLLAPSED_LINES = 4

    /**
     * The fold is decided by *measured* overflow, not by counting characters.
     *
     * The desktop folds past 280 characters or six source lines
     * (`src/components/ExpandableText.tsx`), and those numbers are right for a
     * desktop: a 200-character paragraph there is three lines. On a 411dp phone
     * the same paragraph is seven, and the card filled the screen while passing
     * both tests. So the phone asks the layout engine how many lines the text
     * actually took, which is the only number that predicts height.
     */
    fun toggleVisible(expanded: Boolean, overflowed: Boolean): Boolean = expanded || overflowed

    /** The line cap to hand `Text`: folded, or none once opened. */
    fun maxLines(expanded: Boolean): Int =
        if (expanded) Int.MAX_VALUE else COLLAPSED_LINES
}

/**
 * Card text that folds when it does not fit, and is shown whole when it does.
 *
 * Everything in a card is bot-authored and has no client-side length limit: a
 * question can be 8 000 characters (`MAX_QUESTION_TEXT`) and a subtitle is
 * whatever a tool chose to explain. Rendered whole, one such body filled the
 * screen, and a question card with its answer under it filled two.
 *
 * The text always renders clamped first; if it fit, the clamp changes nothing
 * and no control appears. If it did not, the toggle opens it. Short text
 * therefore renders exactly as it did before this existed.
 */
@Composable
fun ExpandableText(
    text: String,
    style: TextStyle,
    modifier: Modifier = Modifier,
    showMore: String = "显示完整问题",
    showLess: String = "收起",
) {
    var expanded by remember(text) { mutableStateOf(false) }
    // Reset with the text: a row reused for another message must not inherit
    // the previous body's overflow.
    var overflowed by remember(text) { mutableStateOf(false) }
    val toggle = ExpandableTextRules.toggleVisible(expanded, overflowed)
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        // The text is the thing worth copying — a question, a command, a diff.
        SelectionContainer {
            Text(
                text = text,
                style = style,
                maxLines = ExpandableTextRules.maxLines(expanded),
                overflow = TextOverflow.Ellipsis,
                onTextLayout = { result: TextLayoutResult ->
                    // While folded the cap is what makes the measurement
                    // meaningful; once open, the whole text is on screen.
                    if (!expanded && result.hasVisualOverflow && !overflowed) {
                        overflowed = true
                    }
                },
            )
        }
        if (!toggle) return@Column
        // A 32dp target with the label centred in it: the text is 18dp tall, and
        // letting it sit at the top of the box left the space below it reading as
        // a gap between the question and its answer.
        Box(
            modifier = Modifier
                .heightIn(min = 32.dp)
                .clickable(role = Role.Button) { expanded = !expanded }
                .semantics { stateDescription = if (expanded) "已展开" else "已收起" },
            contentAlignment = Alignment.CenterStart,
        ) {
            Text(
                text = if (expanded) showLess else showMore,
                fontSize = 13.sp,
                color = minisAccent,
            )
        }
    }
}
