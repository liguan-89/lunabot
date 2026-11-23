package com.lunabot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.core.AskQuestion
import com.lunabot.companion.core.AskQuestionAnswer
import com.lunabot.companion.core.Chat
import com.lunabot.companion.core.Message
import kotlinx.coroutines.launch
import androidx.compose.runtime.mutableIntStateOf

/**
 * The question card: what the bot actually asked, and its own answers.
 *
 * A structured ask (Claude's `AskUserQuestion`) reaches the harness through
 * the permission channel, so before this it drew the ordinary card — a flat
 * row of buttons over "which model should this bot run on?". One tap could not
 * say WHICH question it answered, so a multi-question ask had nothing tappable
 * at all and the phone could only watch it time out.
 *
 * The desktop's `src/components/QuestionCard.tsx` and its Swift twin
 * `ios/App/Cards/QuestionCardView.swift`, in Compose: a tab per question, the
 * model's options with their glosses, an "Other" row for a reply it did not
 * think of, and one submit that sends every answer at once. The answer text is
 * built by [AskQuestionAnswer.format], so an answer given here is
 * byte-for-byte the one the Mac would have sent.
 */
@Composable
internal fun QuestionCardView(chat: Chat, message: Message, haptics: Haptics) {
    val card = message.card ?: return
    val questions = card.questions
    if (questions.isEmpty()) return

    val session = LocalCompanion.current.session
    val scope = rememberCoroutineScope()
    // Per question: the option labels ticked, the free-text reply, and whether
    // "Other" is open. An open field with nothing in it is not an answer.
    val picked = remember(message.id) { mutableStateMapOf<Int, Set<String>>() }
    val custom = remember(message.id) { mutableStateMapOf<Int, String>() }
    val other = remember(message.id) { mutableStateMapOf<Int, Boolean>() }
    var active by remember(message.id) { mutableIntStateOf(0) }
    var answering by remember(message.id) { mutableStateOf(false) }
    // The harness settles the card, but only after a round trip. Holding the
    // sent answer closes the window where the buttons are still live.
    var sent by remember(message.id) { mutableStateOf<String?>(null) }

    fun answersFor(position: Int): List<String> {
        val chosen = picked[position].orEmpty().sorted().toMutableList()
        if (other[position] == true) {
            custom[position]?.trim()?.takeIf { it.isNotEmpty() }?.let(chosen::add)
        }
        return chosen
    }

    val index = active.coerceIn(0, questions.lastIndex)
    val current = questions[index]
    val answeredCount = questions.indices.count { answersFor(it).isNotEmpty() }
    val complete = answeredCount == questions.size
    val settled = card.answered != null || sent != null

    fun choose(label: String) {
        if (settled) return
        if (current.allowsMultiple) {
            val chosen = picked[index].orEmpty()
            picked[index] = if (label in chosen) chosen - label else chosen + label
            return
        }
        // Single-select is a radio group: picking replaces, and picking an
        // option means the free-text answer was not the one they wanted.
        picked[index] = setOf(label)
        other[index] = false
        // Move to the next question they still owe an answer to. The last one
        // stays put so the submit button is under the thumb that just chose.
        questions.indices
            .firstOrNull { it != index && answersFor(it).isEmpty() }
            ?.let { active = it }
    }

    fun toggleOther() {
        if (settled) return
        if (other[index] == true) {
            other[index] = false
            return
        }
        other[index] = true
        if (!current.allowsMultiple) picked[index] = emptySet()
    }

    fun send() {
        val requestId = card.requestId
        if (settled || !complete || requestId == null) return
        val answer = AskQuestionAnswer.format(questions, questions.indices.map(::answersFor))
        if (answer.isEmpty()) return
        sent = answer
        answering = true
        scope.launch {
            // A question only ever answers with text; the harness rejects an
            // allow/deny on one, so this never takes the permission path.
            session.answer(
                threadId = chat.threadId,
                requestId = requestId,
                choice = answer,
                isPermission = false,
            )
            answering = false
        }
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .musePaperCard()
            .padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            MuseCardBadge(size = 22.dp) {
                Box(
                    modifier = Modifier
                        .size(7.dp)
                        .background(if (settled) minisSuccess else Color(0xFFC4B094), CircleShape),
                )
            }
            Text(
                text = if (questions.size > 1 && !settled) {
                    "${chat.name} 提问 · ${index + 1}/${questions.size}"
                } else {
                    "${chat.name} 提问"
                },
                fontSize = 12.5.sp,
                fontWeight = FontWeight.Medium,
                color = minisSecondary,
                modifier = Modifier.weight(1f),
            )
            if (questions.size > 1 && !settled) {
                Text(
                    text = "已答 $answeredCount/${questions.size}",
                    fontSize = 12.sp,
                    color = minisTertiary,
                )
            }
        }

        if (QuestionCardRules.agentComposed(message)) {
            Text("智能体生成的问题", fontSize = 12.sp, color = minisTertiary)
        }

        if (settled) {
            val answer = card.answeredText ?: sent
            val byQuestion = SettledQuestionLine.answers(questions, answer)
            questions.forEachIndexed { pos, question ->
                if (pos > 0) MuseCardDivider()
                ExpandableText(
                    text = question.question,
                    style = TextStyle(fontSize = 15.5.sp, fontWeight = FontWeight.Medium, color = minisInk),
                )
                SettledQuestionLine.line(question, byQuestion[question.question])
                    ?.let { AnswerLine(it) }
            }
            if (byQuestion.isEmpty()) AnswerLine(SettledQuestionLine.ANSWERED)
            return@Column
        }

        if (questions.size > 1) {
            Row(
                modifier = Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                questions.forEachIndexed { position, question ->
                    val chosen = position == index
                    Row(
                        modifier = Modifier
                            .heightIn(min = 34.dp)
                            .background(
                                if (chosen) minisInk else minisSoftCard,
                                CircleShape,
                            )
                            .clickable(enabled = !settled, role = Role.Tab) {
                                haptics.play(TactileAction.CHOOSE_APPROVAL)
                                active = position
                            }
                            .semantics { selected = chosen }
                            .padding(horizontal = 12.dp, vertical = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (answersFor(position).isNotEmpty()) {
                            Icon(
                                imageVector = Icons.Filled.Check,
                                contentDescription = null,
                                tint = if (chosen) minisPage else minisSuccess,
                                modifier = Modifier.size(12.dp),
                            )
                        }
                        Text(
                            question.tabLabel(position + 1),
                            fontSize = 12.5.sp,
                            fontWeight = if (chosen) FontWeight.SemiBold else FontWeight.Normal,
                            color = if (chosen) minisPage else minisSecondary,
                        )
                    }
                }
            }
        }

        ExpandableText(
            text = current.question,
            style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold, lineHeight = 22.sp, color = minisInk),
        )

        if (current.allowsMultiple) {
            Text("可多选", fontSize = 12.sp, color = minisSecondary)
        }

        Column(modifier = Modifier.fillMaxWidth()) {
            current.options.forEachIndexed { position, option ->
                if (position > 0) MuseCardDivider()
                ChoiceRow(
                    label = option.label,
                    detail = option.detail,
                    checked = option.label in picked[index].orEmpty(),
                    multi = current.allowsMultiple,
                    enabled = !answering,
                ) {
                    haptics.play(TactileAction.CHOOSE_APPROVAL)
                    choose(option.label)
                }
            }
            if (current.options.isNotEmpty()) MuseCardDivider()
            ChoiceRow(
                label = "其他",
                detail = null,
                checked = other[index] == true,
                multi = current.allowsMultiple,
                enabled = !answering,
            ) {
                haptics.play(TactileAction.CHOOSE_APPROVAL)
                toggleOther()
            }
            if (other[index] == true) {
                MinisSheetField(
                    value = custom[index].orEmpty(),
                    onValueChange = { custom[index] = it },
                    placeholder = "输入您的回答",
                    enabled = !answering,
                    singleLine = false,
                    maxLines = 4,
                    containerColor = minisSoftCard,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
        }

        MusePrimaryPillButton(
            text = if (questions.size > 1) "提交全部回答" else "提交回答",
            onClick = ::send,
            enabled = complete && !answering,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/** One option row: clean Muse editorial line with right-aligned monochrome indicator. */
@Composable
private fun ChoiceRow(
    label: String,
    detail: String?,
    checked: Boolean,
    multi: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(
                enabled = enabled,
                role = if (multi) Role.Checkbox else Role.RadioButton,
                onClick = onClick,
            )
            .semantics {
                selected = checked
                stateDescription = if (checked) "已选择" else "未选择"
            }
            .padding(vertical = 11.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text = label,
                fontSize = 15.sp,
                fontWeight = if (checked) FontWeight.SemiBold else FontWeight.Normal,
                color = minisInk,
            )
            if (!detail.isNullOrEmpty()) {
                Text(detail, fontSize = 12.5.sp, color = minisSecondary)
            }
        }
        Marker(checked = checked, multi = multi)
    }
}

/** What the tabs and the answer share, kept here so a test can reach it. */
internal object QuestionCardRules {
    /** A structured ask draws the question card; everything else the ordinary one. */
    fun drawsQuestionCard(message: Message): Boolean =
        message.kind == Message.Kind.OPTIONS && message.card?.questions?.isNotEmpty() == true

    /** The tab labels, in order, exactly as the card shows them. */
    fun tabLabels(questions: List<AskQuestion>): List<String> =
        questions.mapIndexed { index, question -> question.tabLabel(index + 1) }

    /** An ask the harness parsed out of model output rather than a tool call. */
    fun agentComposed(message: Message): Boolean =
        message.card?.questionRequest?.origin == "output"
}

/** Crisp monochrome circular/rounded-square selection indicator matching Muse Plan-H. */
@Composable
private fun Marker(checked: Boolean, multi: Boolean) {
    val shape = if (multi) RoundedCornerShape(6.dp) else CircleShape
    Box(
        modifier = Modifier
            .size(20.dp)
            .then(
                if (checked) {
                    Modifier.background(minisInk, shape)
                } else {
                    Modifier.border(1.25.dp, minisTertiary, shape)
                },
            ),
        contentAlignment = Alignment.Center,
    ) {
        if (!checked) return@Box
        Icon(
            imageVector = Icons.Filled.Check,
            contentDescription = null,
            tint = minisPage,
            modifier = Modifier.size(13.dp),
        )
    }
}

/** The one line a settled question keeps: a tick and what came back. */
@Composable
private fun AnswerLine(text: String) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.Filled.Check,
            contentDescription = null,
            tint = minisSuccess,
            modifier = Modifier.size(15.dp),
        )
        SelectionContainer {
            Text(text = text, fontSize = 13.5.sp, color = minisSecondary)
        }
    }
}
