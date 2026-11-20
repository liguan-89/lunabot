package com.lunabot.companion.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive

/**
 * Structured questions raised by a provider's own "ask the human" tool —
 * Claude's built-in `AskUserQuestion`.
 *
 * A port of `shared/ask-question.ts`, kept in step with
 * `ios/Sources/CompanionCore/AskQuestion.swift`. The desktop re-reads that
 * tool's input into these questions and puts them on the card; the phone
 * renders them and sends back the same answer text the desktop would, so a
 * question answered here is indistinguishable from one answered on the Mac.
 *
 * Every field but the question itself is optional. These payloads are
 * bot-authored and arrive inside a transcript: a question whose shape
 * surprises us must cost one card, never the whole conversation.
 */
@Serializable
data class AskQuestionOption(
    val label: String,
    /**
     * The model's one-line gloss under the label. Named `detail` because
     * `description` collides with nothing here but reads as a Kotlin
     * `toString` hook to anyone arriving from the Swift twin.
     */
    @SerialName("description") val detail: String? = null,
)

@Serializable
data class AskQuestion(
    val question: String,
    /** The short tab label the model gave this question ("Schedule", "Model"). */
    val header: String? = null,
    val multiSelect: Boolean? = null,
    /**
     * A question with no options is still answerable — the card always offers
     * free text — so a missing list is empty, not a failure.
     */
    val options: List<AskQuestionOption> = emptyList(),
) {
    val allowsMultiple: Boolean get() = multiSelect == true

    /**
     * What the tab shows. The model names most questions; a numbered fallback
     * keeps the tabs distinguishable when it does not.
     */
    fun tabLabel(position: Int): String = header?.takeIf { it.isNotEmpty() } ?: "问题 $position"
}

@Serializable
data class QuestionRequestCardData(
    val version: Int = 1,
    val questions: List<AskQuestion> = emptyList(),
    /**
     * Where the ask came from: a tool call (null) or a block the harness parsed
     * out of model-authored output ("output"). Badge data only — it never
     * changes how a card is answered.
     */
    val origin: String? = null,
)

/**
 * The answer text, byte-for-byte what `shared/ask-question.ts` produces.
 *
 * It reaches the model as the tool's own result, so it has to stand on its
 * own: name each question, then what was picked for it.
 */
object AskQuestionAnswer {
    /**
     * The lead-in exists for the model — the answer is delivered on the
     * permission contract's deny channel, so it has to say what it is. The
     * card strips it back off when it shows a person what they sent.
     */
    const val PREAMBLE = "The user answered your questions."

    /**
     * What a card shows once it has landed: the same answer, but named so a
     * person reading the transcript knows whose words these are.
     */
    const val CHOSE = "你选择了："
    const val ANSWERED = "你回答了："

    private const val JSON_PREFIX = "$PREAMBLE\n\nAnswers (JSON):\n"

    /**
     * A block runs from one `Q:` header to the next; blank lines inside an
     * answer are the answer's. Same shape as `shared/ask-question.ts`.
     */
    private val BLOCK = Regex("""(?:^|\n\n)Q: ([\s\S]+?)\nA: ([\s\S]*?)(?=\n\nQ: |$)""")

    fun format(questions: List<AskQuestion>, answers: List<List<String>>): String {
        val blocks = questions.mapIndexedNotNull { index, question ->
            val picked = answers.getOrElse(index) { emptyList() }
                .map { it.trim() }
                .filter { it.isNotEmpty() }
            if (picked.isEmpty()) null else "Q: ${question.question}\nA: ${picked.joinToString(", ")}"
        }
        if (blocks.isEmpty()) return ""
        return "$PREAMBLE\n\n${blocks.joinToString("\n\n")}"
    }

    /** The same answer without the model-facing lead-in, for a settled card. */
    fun withoutPreamble(answer: String): String {
        val lead = "$PREAMBLE\n\n"
        return if (answer.startsWith(lead)) answer.removePrefix(lead) else answer
    }

    /**
     * One answer per question, read back out of the single reply the card sent.
     *
     * The reply is written for the model — `Q: <question>\nA: <picks>` per
     * answered question — so a card that wants to say "you chose Cancel" has to
     * take it apart again. This is `questionAnswersByQuestion` from
     * `shared/ask-question.ts`, and it accepts both encodings that function
     * accepts: the block form, and the `Answers (JSON):` form used when an
     * answer itself contains newlines. Without the second, a question answered
     * on the desktop would show up here as raw JSON.
     *
     * Only questions this ask actually posed are answered; a forged or repeated
     * question text is not something a block can tell apart, so it is left
     * unanswered rather than guessed at.
     */
    fun answersByQuestion(questions: List<AskQuestion>, answer: String): Map<String, String> {
        if (answer.isBlank() || questions.isEmpty()) return emptyMap()
        val known = HashSet<String>()
        val ambiguous = HashSet<String>()
        for (question in questions) {
            if (!known.add(question.question)) ambiguous.add(question.question)
        }
        fun take(asked: String): Boolean =
            asked in known && asked !in ambiguous

        val answers = LinkedHashMap<String, String>()
        if (answer.startsWith(JSON_PREFIX)) {
            for ((asked, value) in jsonPairs(answer.removePrefix(JSON_PREFIX))) {
                if (!take(asked)) continue
                val trimmed = value.trim()
                if (trimmed.isNotEmpty()) answers[asked] = trimmed
            }
            return answers
        }

        var sawBlock = false
        for (match in BLOCK.findAll(answer)) {
            sawBlock = true
            val asked = match.groupValues[1].trim()
            val value = match.groupValues[2].trim()
            // A blank `A:` is no answer.
            if (value.isNotEmpty() && take(asked)) answers[asked] = value
        }
        // A reply that matched a block is authoritative even when it answered
        // nothing, or the literal Q:/A: text would be filed as the answer.
        if (sawBlock) return answers

        // A bare reply answers a lone question: the harness sends the option
        // label on its own when there was only one thing to answer.
        if (questions.size != 1) return emptyMap()
        val flat = answer.trim()
        return if (flat.isEmpty()) emptyMap() else mapOf(questions[0].question to flat)
    }

    /** `[["question", "answer"], …]`, or nothing when the body is not that. */
    private fun jsonPairs(body: String): List<Pair<String, String>> {
        val root = runCatching { CompanionJson.parseToJsonElement(body) }.getOrNull()
            as? JsonArray ?: return emptyList()
        return root.mapNotNull { pair ->
            val entry = pair as? JsonArray ?: return@mapNotNull null
            if (entry.size != 2) return@mapNotNull null
            val asked = (entry[0] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return@mapNotNull null
            val value = (entry[1] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return@mapNotNull null
            asked to value
        }
    }
}
