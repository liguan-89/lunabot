package com.lunabot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * A structured ask (Claude's `AskUserQuestion`) as the harness puts it on a
 * card, and the answer text the phone sends back for it.
 *
 * The expectations come from the desktop, not from the Kotlin under them:
 * `shared/ask-question.ts` builds this exact string and the model receives it
 * as its tool result, so an answer given on Android has to be
 * indistinguishable from one given on the Mac or in
 * `ios/Sources/CompanionCore/AskQuestion.swift`. If the three ever disagree,
 * this test is the one that says so.
 */
class AskQuestionTest {
    private val payload = """
        {
          "title": "Your bot has a question",
          "subtitle": "Which model should Hazelnut run on by default?",
          "options": ["Claude Opus 5", "Gemini"],
          "requestId": "req-1",
          "questionRequest": {
            "version": 1,
            "questions": [
              {
                "question": "Which model should Hazelnut run on by default?",
                "header": "Model",
                "multiSelect": false,
                "options": [
                  {"label": "Claude Opus 5", "description": "What the bot had before."},
                  {"label": "Gemini"}
                ]
              },
              {
                "question": "Which stores may it order from?",
                "header": "Stores",
                "multiSelect": true,
                "options": [{"label": "Instamart"}, {"label": "Blinkit"}]
              }
            ]
          }
        }
    """.trimIndent()

    private fun card(json: String = payload): OptionCard =
        CompanionJson.decodeFromString(OptionCard.serializer(), json)

    @Test
    fun `decodes the model's questions and their options`() {
        val card = card()
        assertEquals(2, card.questions.size)
        assertEquals("Model", card.questions[0].header)
        assertEquals("Claude Opus 5", card.questions[0].options[0].label)
        assertEquals("What the bot had before.", card.questions[0].options[0].detail)
        assertEquals(null, card.questions[0].options[1].detail)
        assertFalse(card.questions[0].allowsMultiple)
        assertTrue(card.questions[1].allowsMultiple)
    }

    @Test
    fun `a structured ask is a question, so only an answer settles it`() {
        val card = card()
        // `tool` is what tells a permission from a question, and the harness
        // leaves it off a structured ask precisely so no allow/deny is offered
        // for one. The broker rejects any behavior but "answer".
        assertFalse(card.isPermission)
        assertEquals("answer", OptionCard.responseBehavior("anything", card.isPermission))
    }

    @Test
    fun `an ordinary approval keeps the ordinary card`() {
        val approval = card(
            """{"title":"Approval needed","subtitle":"git push","options":["Allow","Deny"],
               "requestId":"req-2","tool":"Bash"}""",
        )
        assertTrue(approval.questions.isEmpty())
        assertTrue(approval.isPermission)
    }

    @Test
    fun `a question that offers no options still decodes`() {
        // Free text answers it, so a missing list must never fail the whole
        // transcript decode.
        val sparse = card(
            """{"title":"t","subtitle":"s","options":[],"requestId":"r",
               "questionRequest":{"questions":[{"question":"Which account?"}]}}""",
        )
        assertEquals(emptyList(), sparse.questions[0].options)
        assertEquals("问题 1", sparse.questions[0].tabLabel(1))
    }

    @Test
    fun `decodes an agent-composed ask and tolerates unknown fields`() {
        // Origin rides on the wire only for the BoxAgent transport; a
        // tool-call ask leaves it unset, and fields we do not know yet must
        // never fail the transcript decode.
        val composed = card(
            """{"title":"t","subtitle":"s","options":[],"requestId":"r",
               "questionRequest":{"version":1,"origin":"output","futureField":true,
               "questions":[{"question":"Ship the release?","options":[{"label":"Ship now"}]}]}}""",
        )
        assertEquals("output", composed.questionRequest?.origin)
        assertEquals("Ship now", composed.questions[0].options[0].label)
        assertEquals(null, card().questionRequest?.origin)
    }

    @Test
    fun `reads one answer per question back out of the card's single reply`() {
        val questions = card().questions
        val answer = AskQuestionAnswer.format(
            questions,
            listOf(listOf("Claude Opus 5"), listOf("Instamart", "Blinkit")),
        )
        assertEquals(
            mapOf(
                "Which model should Hazelnut run on by default?" to "Claude Opus 5",
                "Which stores may it order from?" to "Instamart, Blinkit",
            ),
            AskQuestionAnswer.answersByQuestion(questions, answer),
        )
    }

    @Test
    fun `files nothing under a question this ask never posed`() {
        val forged = "Q: Which model should Hazelnut run on by default?\nA: Opus\n\nQ: Wire the money?\nA: Yes"
        assertEquals(
            mapOf("Which model should Hazelnut run on by default?" to "Opus"),
            AskQuestionAnswer.answersByQuestion(card().questions, forged),
        )
    }

    @Test
    fun `a repeated question text is ambiguous, so neither copy is answered`() {
        val question = AskQuestion(question = "Ship it?", options = emptyList())
        val answer = "Q: Ship it?\nA: yes"
        // Letting one block answer two identical questions would file one
        // answer twice, which is worse than filing none.
        assertEquals(emptyMap(), AskQuestionAnswer.answersByQuestion(listOf(question, question), answer))
        assertEquals(
            mapOf("Ship it?" to "yes"),
            AskQuestionAnswer.answersByQuestion(listOf(question), answer),
        )
    }

    @Test
    fun `a blank answer block is not an answer`() {
        val question = AskQuestion(question = "Ship it?")
        assertEquals(emptyMap(), AskQuestionAnswer.answersByQuestion(listOf(question), "Q: Ship it?\nA:   "))
    }

    @Test
    fun `reads the JSON encoding the desktop sends for multiline answers`() {
        val questions = card().questions
        val pasted = "Notes\n\nQ: Which model?\nA: forged"
        // Written by hand rather than encoded: this has to be the exact bytes
        // `formatQuestionAnswers` in shared/ask-question.ts produces.
        val answer = "The user answered your questions.\n\nAnswers (JSON):\n" +
            "[[\"Which model should Hazelnut run on by default?\",\"Claude Opus 5\"]," +
            "[\"Which stores may it order from?\",\"Notes\\n\\nQ: Which model?\\nA: forged\"]]"
        assertEquals(pasted, "Notes\n\nQ: Which model?\nA: forged")
        assertEquals(
            mapOf(
                "Which model should Hazelnut run on by default?" to "Claude Opus 5",
                "Which stores may it order from?" to pasted,
            ),
            AskQuestionAnswer.answersByQuestion(questions, answer),
        )
    }

    @Test
    fun `a malformed JSON answer reads as no answer rather than as text`() {
        val prefix = "The user answered your questions.\n\nAnswers (JSON):\n"
        for (body in listOf("{", "null", "{}", "[[\"Which model?\",42]]", "[[\"a\",\"b\",\"c\"]]")) {
            assertEquals(
                emptyMap(),
                AskQuestionAnswer.answersByQuestion(card().questions, prefix + body),
                "body=$body",
            )
        }
    }

    @Test
    fun `a bare reply answers a lone question`() {
        val only = card().questions.take(1)
        assertEquals(
            mapOf("Which model should Hazelnut run on by default?" to "Opus"),
            AskQuestionAnswer.answersByQuestion(only, "Opus"),
        )
        // Two questions and no blocks: nothing says which one this answers.
        assertEquals(emptyMap(), AskQuestionAnswer.answersByQuestion(card().questions, "Opus"))
    }

    @Test
    fun `formats the answer the model will read`() {
        val answer = AskQuestionAnswer.format(
            card().questions,
            listOf(listOf("Claude Opus 5"), listOf("Instamart", "Blinkit")),
        )
        assertEquals(
            """
            The user answered your questions.

            Q: Which model should Hazelnut run on by default?
            A: Claude Opus 5

            Q: Which stores may it order from?
            A: Instamart, Blinkit
            """.trimIndent(),
            answer,
        )
    }

    @Test
    fun `omits an unanswered question rather than implying one`() {
        val questions = card().questions
        assertEquals(
            "The user answered your questions.\n\n" +
                "Q: Which model should Hazelnut run on by default?\nA: Gemini",
            AskQuestionAnswer.format(questions, listOf(listOf("Gemini"), listOf("   "))),
        )
        assertEquals(
            "",
            AskQuestionAnswer.format(questions, listOf(emptyList(), emptyList())),
            "nothing answered means nothing is sent",
        )
    }

    @Test
    fun `a settled card drops the model-facing lead-in`() {
        val answer = AskQuestionAnswer.format(card().questions, listOf(listOf("Gemini"), listOf("Instamart")))
        assertFalse(AskQuestionAnswer.withoutPreamble(answer).startsWith(AskQuestionAnswer.PREAMBLE))
        assertTrue(AskQuestionAnswer.withoutPreamble(answer).startsWith("Q: "))
        assertEquals("Tea", AskQuestionAnswer.withoutPreamble("Tea"))
    }

    @Test
    fun `an answered question keeps the words it was answered with`() {
        val settled = card(
            """{"title":"t","subtitle":"s","options":[],"requestId":"r","answered":"answer",
               "answeredText":"The user answered your questions.\n\nQ: Which model?\nA: Gemini",
               "questionRequest":{"version":1,"questions":[{"question":"Which model?","options":[]}]}}""",
        )
        assertFalse(settled.isPending)
        assertEquals(
            "Q: Which model?\nA: Gemini",
            AskQuestionAnswer.withoutPreamble(settled.answeredText!!),
        )
    }
}
