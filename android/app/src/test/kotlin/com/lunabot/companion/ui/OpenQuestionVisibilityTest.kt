package com.lunabot.companion.ui

import com.lunabot.companion.core.Message
import com.lunabot.companion.core.OptionCard
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class OpenQuestionVisibilityTest {

    private fun openCard(requestId: String? = null, answered: String? = null, dismissed: Boolean? = null) = OptionCard(
        title = "t", subtitle = "s", options = listOf("a", "b"),
        answered = answered, dismissed = dismissed, requestId = requestId,
    )

    private fun row(id: String, kind: Message.Kind, role: Message.Role = Message.Role.BOT, card: OptionCard? = null) = Message(
        id = id, role = role, kind = kind, at = 1.0, text = "x", card = card,
    )

    @Test
    fun openCardStaysVisible() {
        val messages = listOf(row("c1", Message.Kind.OPTIONS, card = openCard()))
        assertTrue(OpenQuestionVisibility.hiddenIds(messages).isEmpty())
    }

    @Test
    fun answeredOrDismissedCardHides() {
        val messages = listOf(
            row("c1", Message.Kind.OPTIONS, card = openCard(answered = "好")),
            row("c2", Message.Kind.OPTIONS, card = openCard(dismissed = true)),
        )
        assertEquals(setOf("c1", "c2"), OpenQuestionVisibility.hiddenIds(messages))
    }

    @Test
    fun laterUserTextHidesTheCard() {
        val messages = listOf(
            row("c1", Message.Kind.OPTIONS, card = openCard()),
            row("u1", Message.Kind.TEXT, role = Message.Role.USER),
        )
        assertEquals(setOf("c1"), OpenQuestionVisibility.hiddenIds(messages))
    }

    @Test
    fun earlierUserTextDoesNotHide() {
        val messages = listOf(
            row("u1", Message.Kind.TEXT, role = Message.Role.USER),
            row("c1", Message.Kind.OPTIONS, card = openCard()),
        )
        assertTrue(OpenQuestionVisibility.hiddenIds(messages).isEmpty())
    }

    @Test
    fun liveRequestCardsNeverHideThisWay() {
        val messages = listOf(
            row("c1", Message.Kind.OPTIONS, card = openCard(requestId = "r1", answered = "allow")),
            row("u1", Message.Kind.TEXT, role = Message.Role.USER),
        )
        assertTrue(OpenQuestionVisibility.hiddenIds(messages).isEmpty())
    }
}
