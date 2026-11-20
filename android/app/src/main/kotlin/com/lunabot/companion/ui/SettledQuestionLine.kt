package com.lunabot.companion.ui

import com.lunabot.companion.core.AskQuestion
import com.lunabot.companion.core.AskQuestionAnswer

/**
 * What a settled question card says back, in the person's own terms.
 *
 * A settled card used to draw the question body and then echo the raw answer
 * text — which is `Q: <the same question>\nA: <pick>`, a format written for the
 * model. The question therefore appeared twice, and a long one filled the
 * screen twice over.
 *
 * The replacement is `settledAnswer` from `src/components/QuestionCard.tsx`:
 * one line per question, naming what was chosen when the pick was one of the
 * offered labels and saying they answered in their own words when it was not.
 * Those are different acts and the card should not call both "chose".
 */
object SettledQuestionLine {
    /** What a card with no recorded answer says. */
    const val ANSWERED = "已回答"

    /** The answer to each question this ask posed, keyed by the question text. */
    fun answers(questions: List<AskQuestion>, answer: String?): Map<String, String> =
        if (answer.isNullOrBlank()) emptyMap()
        else AskQuestionAnswer.answersByQuestion(questions, answer)

    /**
     * The line for one answered question, or null when nothing was recorded.
     *
     * The value is flattened first: an answer with newlines in it would
     * otherwise push the single line the card keeps into a block.
     */
    fun line(question: AskQuestion, value: String?): String? {
        val text = value?.replace(Regex("\\s+"), " ")?.trim().orEmpty()
        if (text.isEmpty()) return null
        // The same reading `settledAnswer` uses: a value that is one of the
        // offered labels was chosen, anything else was typed.
        val offered = question.options.any { it.label == text }
        return (if (offered) AskQuestionAnswer.CHOSE else AskQuestionAnswer.ANSWERED) + text
    }
}
