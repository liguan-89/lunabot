package com.lunabot.companion.ui

import com.lunabot.companion.core.AskQuestion
import com.lunabot.companion.core.AskQuestionOption
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The line a settled question card keeps, and what it refuses to say.
 *
 * The bug this guards is one card filling two screens: the card drew the whole
 * question, then echoed `answeredText` — which is `Q: <the same question>\nA:
 * <pick>`. A settled card now says what was chosen, once, and never repeats the
 * question back at the person who just read it.
 */
class SettledQuestionLineTest {
    private val model = AskQuestion(
        question = "Which model?",
        header = "Model",
        options = listOf(AskQuestionOption("Opus"), AskQuestionOption("Gemini")),
    )
    private val stores = AskQuestion(
        question = "Which stores?",
        header = "Stores",
        multiSelect = true,
        options = listOf(AskQuestionOption("Instamart"), AskQuestionOption("Blinkit")),
    )

    private fun answer(vararg pairs: Pair<AskQuestion, String>) =
        "The user answered your questions.\n\n" +
            pairs.joinToString("\n\n") { (question, picked) -> "Q: ${question.question}\nA: $picked" }

    @Test
    fun `a picked option reads as a choice`() {
        val answers = SettledQuestionLine.answers(listOf(model), answer(model to "Opus"))
        assertEquals("你选择了：Opus", SettledQuestionLine.line(model, answers[model.question]))
    }

    @Test
    fun `words that were not an option read as an answer, not a choice`() {
        // The card's free-text row: nothing offered matches, so calling it a
        // choice would be a lie about what the person did.
        val answers = SettledQuestionLine.answers(listOf(model), answer(model to "用 Gemini 吧，便宜"))
        assertEquals("你回答了：用 Gemini 吧，便宜", SettledQuestionLine.line(model, answers[model.question]))
    }

    @Test
    fun `each question keeps its own answer`() {
        val answers = SettledQuestionLine.answers(
            listOf(model, stores),
            answer(model to "Opus", stores to "Instamart, Blinkit"),
        )
        assertEquals("你选择了：Opus", SettledQuestionLine.line(model, answers[model.question]))
        // A multi-select answer is the labels joined, which is not equal to any
        // one label — the same reading `settledAnswer` in AskCard.tsx makes, so
        // the two platforms word it the same way.
        assertEquals("你回答了：Instamart, Blinkit", SettledQuestionLine.line(stores, answers[stores.question]))
    }

    @Test
    fun `a multi-line answer is flattened into the one line`() {
        // The line is the whole point of the change: a pasted answer would
        // otherwise push the card back to a block of text.
        val answers = SettledQuestionLine.answers(listOf(model), answer(model to "先跑 Rust\n再跑 Node"))
        assertEquals("你回答了：先跑 Rust 再跑 Node", SettledQuestionLine.line(model, answers[model.question]))
    }

    @Test
    fun `an unanswered question has no line`() {
        assertNull(SettledQuestionLine.line(model, null))
        assertNull(SettledQuestionLine.line(model, "   "))
        assertEquals(emptyMap(), SettledQuestionLine.answers(listOf(model), null))
    }

    @Test
    fun `the question body never leaks back into the line`() {
        // The whole bug: if the line contained the question, the card would be
        // printing it twice again.
        val answers = SettledQuestionLine.answers(listOf(model), answer(model to "Opus"))
        val line = SettledQuestionLine.line(model, answers[model.question])!!
        assertFalse(line.contains("Which model?"))
        assertFalse(line.contains("Q:"))
        assertTrue(line.startsWith("你选择了："))
    }
}
