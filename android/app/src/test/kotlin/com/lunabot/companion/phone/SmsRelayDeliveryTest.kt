package com.lunabot.companion.phone

import com.lunabot.companion.RECEIVER_CONNECT_BUDGET_MS
import com.lunabot.companion.core.PhoneSmsEvent
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

/** An inbound text against the clock a receiver is held to. */
@OptIn(ExperimentalCoroutinesApi::class)
class SmsRelayDeliveryTest {
    private val text = PhoneSmsEvent(sendId = "13800000000:1", from = "13800000000", text = "hi")

    @Test
    fun `a text reaches the computer once the session is live`() = runTest {
        var connects = 0
        val posted = mutableListOf<PhoneSmsEvent>()

        val delivered = deliverInboundSms(
            events = listOf(text),
            deliverWithinMs = SMS_DELIVER_WITHIN_MS,
            connect = { connects += 1 },
            live = {},
            post = { posted += it; true },
            note = { _, _ -> true },
        )

        assertEquals(1, delivered)
        assertEquals(1, connects)
        assertEquals(listOf(text), posted)
    }

    @Test
    fun `a text the notification path already delivered is left alone`() = runTest {
        val posted = mutableListOf<PhoneSmsEvent>()

        val delivered = deliverInboundSms(
            events = listOf(text),
            deliverWithinMs = SMS_DELIVER_WITHIN_MS,
            connect = {},
            live = {},
            post = { posted += it; true },
            note = { _, _ -> false },
        )

        assertEquals(0, delivered)
        assertTrue(posted.isEmpty())
    }

    @Test
    fun `a text is not claimed until this path can deliver it`() = runTest {
        val claims = mutableListOf<String>()
        var connects = 0

        val delivered = deliverInboundSms(
            events = listOf(text),
            deliverWithinMs = SMS_DELIVER_WITHIN_MS,
            connect = { connects += 1 },
            live = { awaitCancellation() },
            post = { true },
            note = { from, _ -> claims += from; true },
        )

        assertEquals(0, delivered)
        assertEquals(1, connects)
        assertTrue(claims.isEmpty(), "a path that cannot deliver must not shut the other one out")
    }

    @Test
    fun `the delivery gives up once its window has passed`() = runTest {
        var posted = 0
        val delivery = async {
            deliverInboundSms(
                events = listOf(text),
                deliverWithinMs = 60_000,
                connect = {},
                live = { awaitCancellation() },
                post = { posted += 1; true },
                note = { _, _ -> true },
            )
        }

        advanceTimeBy(59_999)
        runCurrent()
        assertFalse(delivery.isCompleted)

        advanceTimeBy(1)
        runCurrent()
        assertEquals(0, delivery.await())
        assertEquals(0, posted)
    }

    @Test
    fun `a request already on its way is finished when the window closes`() = runTest {
        var posted = 0
        val delivered = deliverInboundSms(
            events = listOf(text),
            deliverWithinMs = 1_000,
            connect = {},
            live = {},
            post = { delay(30_000); posted += 1; true },
            note = { _, _ -> true },
        )

        assertEquals(1, delivered)
        assertEquals(1, posted)
    }

    @Test
    fun `the broadcast is released inside the system's limit while the delivery goes on`() = runTest {
        var finished = 0
        val delivery = backgroundScope.async { awaitCancellation() }

        val hold = launch { holdBroadcastWhile(delivery) { finished += 1 } }
        advanceTimeBy(RECEIVER_CONNECT_BUDGET_MS - 1)
        runCurrent()
        assertEquals(0, finished)

        advanceTimeBy(1)
        runCurrent()
        assertEquals(1, finished)
        assertTrue(hold.isCompleted)
        assertTrue(RECEIVER_CONNECT_BUDGET_MS < 10_000, "Android 17 kills a receiver it has held for 10 s")
        advanceUntilIdle()
        assertFalse(delivery.isCompleted, "the delivery belongs to the app, not to the broadcast")
    }

    @Test
    fun `a text whose post failed is not lost as a duplicate`() = runTest {
        val unclaimed = mutableListOf<String>()

        val delivered = deliverInboundSms(
            events = listOf(text),
            deliverWithinMs = SMS_DELIVER_WITHIN_MS,
            connect = {},
            live = {},
            post = { false },
            note = { _, _ -> true },
            unclaim = { from, _ -> unclaimed += from },
        )

        assertEquals(0, delivered)
        assertEquals(listOf("13800000000"), unclaimed)
    }

    @Test
    fun `a withdrawn claim lets the next attempt deliver`() = runTest {
        val delivered = deliverInboundSms(
            events = listOf(text),
            deliverWithinMs = SMS_DELIVER_WITHIN_MS,
            connect = {},
            live = {},
            post = { false },
        )

        assertEquals(0, delivered)
        assertTrue(SmsEventDedup.note(text.from, text.text), "a failed post must withdraw its claim")
        SmsEventDedup.forget(text.from, text.text)
    }

    @Test
    fun `a Chinese country-code sender and its local form are one text`() {
        val body = "country-code dedupe test"
        try {
            assertTrue(SmsEventDedup.note("+86 138-0000-0000", body))
            assertFalse(SmsEventDedup.note("13800000000", body))
        } finally {
            SmsEventDedup.forget("+86 138-0000-0000", body)
            SmsEventDedup.forget("13800000000", body)
        }
    }

    @Test
    fun `another country's country code stays part of the sender`() {
        val body = "non-cn sender dedupe test"
        try {
            assertTrue(SmsEventDedup.note("13800000000", body))
            assertTrue(SmsEventDedup.note("+44 138-0000-0000", body))
        } finally {
            SmsEventDedup.forget("13800000000", body)
            SmsEventDedup.forget("+44 138-0000-0000", body)
        }
    }
}
