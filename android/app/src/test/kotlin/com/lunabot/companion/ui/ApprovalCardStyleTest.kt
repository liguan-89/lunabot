package com.lunabot.companion.ui

import com.lunabot.companion.core.Chat
import com.lunabot.companion.core.OptionCard
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The four outcomes an approval card can land in, and the words each one gets.
 *
 * These are the phone's own strings, so what is worth pinning is the mapping
 * from the card's fields to the state, and that nothing is invented: a card the
 * harness never settled shows no stamp, an expiry shows no decision, and the
 * standing grant is offered only where [ApprovalChoices] says it may be.
 */
class ApprovalCardStyleTest {
    private val chat = Chat.BotChat(bot())

    private fun card(
        options: List<String> = listOf("Allow", "Deny"),
        requestId: String? = "req-1",
        answered: String? = null,
        answeredText: String? = null,
        expired: Boolean? = null,
        dismissed: Boolean? = null,
        tool: String? = "calendar.events.list",
        allowKey: String? = null,
        danger: Boolean? = null,
    ) = OptionCard(
        title = "读取日历事件",
        subtitle = "允许 Moss 查看 11 月 20 日至 21 日的日程",
        options = options,
        answered = answered,
        answeredText = answeredText,
        expired = expired,
        dismissed = dismissed,
        requestId = requestId,
        tool = tool,
        allowKey = allowKey,
        danger = danger,
    )

    @Test
    fun pendingOffersItsActionsAndNoStamp() {
        val style = ApprovalCardStyle.of(card(), chat)

        assertEquals(ApprovalState.PENDING, style.state)
        assertEquals(ApprovalCardStyle.PENDING_LABEL, style.label)
        assertTrue(style.showsActions)
        assertTrue(style.isPending)
        assertNull(style.stamp)
        assertFalse(style.showsStamp)
    }

    @Test
    fun allowedSettlesOnTheAllowBehavior() {
        val style = ApprovalCardStyle.of(card(answered = "allow"), chat)

        assertEquals(ApprovalState.ALLOWED, style.state)
        assertEquals(ApprovalCardStyle.ALLOWED_LABEL, style.label)
        assertFalse(style.showsActions)
        assertFalse(style.isPending)
        // `allow` is the wire's word, not a person's; the state line already
        // says the outcome, so there is no stamp to repeat it in English.
        assertNull(style.stamp)
        assertFalse(style.showsStamp)
    }

    @Test
    fun deniedSettlesOnTheRefusalBehavior() {
        // "Deny" is the card's own word, and `responseBehavior` is what the
        // wire records; both have to agree or the card is drawn as the opposite
        // of what it answered.
        val style = ApprovalCardStyle.of(card(answered = "Deny"), chat)

        assertEquals(ApprovalState.DENIED, style.state)
        assertEquals(ApprovalCardStyle.DENIED_LABEL, style.label)
        assertFalse(style.showsActions)
        assertNull(style.stamp)
    }

    @Test
    fun answeredTextWinsOverTheBehaviorWord() {
        // A question card answers with words rather than a verdict: no tool, so
        // `responseBehavior` is "answer" and the card is settled with what the
        // person actually picked.
        val style = ApprovalCardStyle.of(
            card(tool = null, answered = "answer", answeredText = "下午三点"),
            chat,
        )

        assertEquals(ApprovalState.SETTLED, style.state)
        assertEquals("下午三点", style.stamp)
    }

    @Test
    fun expiredWithNoAnswerRecordsNoDecision() {
        val style = ApprovalCardStyle.of(card(expired = true), chat)

        assertEquals(ApprovalState.EXPIRED, style.state)
        assertEquals(ApprovalCardStyle.EXPIRED_LABEL, style.label)
        assertFalse(style.showsActions)
        assertNull(style.stamp)
    }

    @Test
    fun anAnswerOutranksAWithdrawnRequest() {
        // The server can expire a card a person already answered; the answer is
        // the fact worth keeping.
        val style = ApprovalCardStyle.of(card(answered = "allow", expired = true), chat)

        assertEquals(ApprovalState.ALLOWED, style.state)
    }

    @Test
    fun aDismissedCardIsSettledWithoutActions() {
        val style = ApprovalCardStyle.of(card(requestId = null, dismissed = true), chat)

        assertEquals(ApprovalState.SETTLED, style.state)
        assertFalse(style.showsActions)
        assertNull(style.stamp)
    }

    @Test
    fun dangerIsCarriedThroughWithoutChangingTheState() {
        val style = ApprovalCardStyle.of(card(danger = true), chat)

        assertEquals(ApprovalState.PENDING, style.state)
        assertTrue(style.danger)
        assertFalse(ApprovalCardStyle.of(card(), chat).danger)
    }

    @Test
    fun theStandingGrantNeedsAKeyAndABot() {
        assertFalse(ApprovalCardStyle.of(card(), chat).showsAlwaysAllow)
        assertTrue(ApprovalCardStyle.of(card(allowKey = "Bash:git"), chat).showsAlwaysAllow)
        // Rooms never show one: there is no single bot to hang the grant on.
        assertFalse(
            ApprovalCardStyle.of(card(allowKey = "Bash:git"), Chat.RoomChat(room())).showsAlwaysAllow,
        )
        // And a settled card offers no actions at all.
        assertFalse(
            ApprovalCardStyle.of(card(allowKey = "Bash:git", answered = "allow"), chat)
                .showsAlwaysAllow,
        )
    }
}
