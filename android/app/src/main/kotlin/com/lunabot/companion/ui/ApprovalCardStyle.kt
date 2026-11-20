package com.lunabot.companion.ui

import com.lunabot.companion.core.Chat
import com.lunabot.companion.core.OptionCard

/**
 * What an approval card is, as opposed to what it says.
 *
 * The card already carried every fact the screen needs — pending, expired,
 * answered, danger — but the phone drew all four outcomes the same way: a
 * 1.5dp accent ring while pending, and one line of grey text after. A person
 * scanning a transcript could not tell "waiting on you" from "already allowed"
 * without reading the small print.
 *
 * This is deliberately a pure function over the card and the chat, so the four
 * outcomes and the strings that name them are unit-tested rather than inferred
 * from a screenshot. It invents nothing: every field below is one the harness
 * sent, and anything it did not send (an expiry countdown, a decision time, a
 * read-only scope) stays absent instead of being guessed.
 */
enum class ApprovalState {
    /** Waiting on a person: the only state that offers actions. */
    PENDING,

    /** Answered, and the answer meant go ahead. */
    ALLOWED,

    /** Answered, and the answer was the refusal. */
    DENIED,

    /** The server withdrew the options; nothing can answer it. */
    EXPIRED,

    /** Settled some other way (dismissed, or a card that was never a request). */
    SETTLED,
}

/**
 * @param label the state's own words, shown above the title.
 * @param stamp the one line left after the card lands, or null when the harness
 *   recorded no words. It is `answeredText` and nothing else: `answered` holds a
 *   behavior ("allow", "deny", "answer"), which is the wire's vocabulary and not
 *   something to show a person. The state line already names the outcome, so a
 *   card without words keeps no stamp rather than repeating itself in English.
 * @param showsActions only a pending card offers its options.
 * @param showsAlwaysAllow the standing grant, which needs both a grant key and
 *   a bot to hang it on ([ApprovalChoices.showsAlwaysAllow]).
 */
data class ApprovalCardStyle(
    val state: ApprovalState,
    val label: String,
    val danger: Boolean,
    val stamp: String?,
    val showsActions: Boolean,
    val showsAlwaysAllow: Boolean,
) {
    val isPending: Boolean get() = state == ApprovalState.PENDING

    /** Only a settled card has anything to stamp, and only when it says something. */
    val showsStamp: Boolean get() = stamp != null

    companion object {
        const val PENDING_LABEL = "需要你确认"
        const val ALLOWED_LABEL = "已允许"
        const val DENIED_LABEL = "已拒绝"
        const val EXPIRED_LABEL = "已过期"
        const val SETTLED_LABEL = "已处理"

        fun of(card: OptionCard, chat: Chat): ApprovalCardStyle {
            val danger = card.danger == true
            val alwaysAllow = ApprovalChoices.showsAlwaysAllow(card, chat)

            if (card.isPending) {
                return ApprovalCardStyle(
                    state = ApprovalState.PENDING,
                    label = PENDING_LABEL,
                    danger = danger,
                    stamp = null,
                    showsActions = true,
                    showsAlwaysAllow = alwaysAllow,
                )
            }

            if (card.expired == true && card.answered == null) {
                return ApprovalCardStyle(
                    state = ApprovalState.EXPIRED,
                    label = EXPIRED_LABEL,
                    danger = danger,
                    // The server withdrew it; nothing was decided, so there is
                    // no decision to record. The state line already says so.
                    stamp = null,
                    showsActions = false,
                    showsAlwaysAllow = false,
                )
            }

            val answered = card.answered
            if (answered != null) {
                // The same classification that decides allow versus deny on the
                // wire, so a card cannot be drawn as allowed and recorded as
                // denied. A card that answered with words rather than a verdict
                // ("answer") is neither: it is settled, and its words are the
                // record.
                val stamp = card.answeredText?.takeIf { it.isNotBlank() }
                val state = when (card.responseBehavior(answered)) {
                    "allow" -> ApprovalState.ALLOWED
                    "deny" -> ApprovalState.DENIED
                    else -> ApprovalState.SETTLED
                }
                return ApprovalCardStyle(
                    state = state,
                    label = when (state) {
                        ApprovalState.ALLOWED -> ALLOWED_LABEL
                        ApprovalState.DENIED -> DENIED_LABEL
                        else -> SETTLED_LABEL
                    },
                    danger = danger,
                    stamp = stamp,
                    showsActions = false,
                    showsAlwaysAllow = false,
                )
            }

            return ApprovalCardStyle(
                state = ApprovalState.SETTLED,
                label = SETTLED_LABEL,
                danger = danger,
                stamp = null,
                showsActions = false,
                showsAlwaysAllow = false,
            )
        }
    }
}
