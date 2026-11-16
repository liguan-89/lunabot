/*
 * Pins the wireless-debugging repair rules: every stop reason is reachable, a
 * write that throws or returns false is Refused, the write budget ends in
 * GaveUp, each of the four triggers clears a stop, and the gap between writes
 * grows so a phone that keeps losing the switch is not written to in a loop.
 */
package com.openmausbot.companion.phoneui

import com.openmausbot.companion.phoneui.PhoneUiSelfRepair.Decision
import com.openmausbot.companion.phoneui.PhoneUiSelfRepair.Event
import com.openmausbot.companion.phoneui.PhoneUiSelfRepair.SkipReason
import com.openmausbot.companion.phoneui.PhoneUiSelfRepair.State
import com.openmausbot.companion.phoneui.PhoneUiSelfRepair.Stop
import com.openmausbot.companion.phoneui.PhoneUiSelfRepair.Trigger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PhoneUiSelfRepairTest {
    @Test
    fun `first write is allowed with no gap`() {
        val decision = PhoneUiSelfRepair.shouldWrite(
            off = true,
            helperAttached = false,
            state = State(),
            nowMs = 1_000,
        )
        assertEquals(Decision.Write, decision)
    }

    @Test
    fun `an attached helper means no write even when the switch is off`() {
        val decision = PhoneUiSelfRepair.shouldWrite(
            off = true,
            helperAttached = true,
            state = State(),
            nowMs = 1_000,
        )
        assertIs<Decision.Skip>(decision)
        assertEquals(SkipReason.HelperAttached, decision.reason)
    }

    @Test
    fun `an already-on switch is not written`() {
        val decision = PhoneUiSelfRepair.shouldWrite(
            off = false,
            helperAttached = false,
            state = State(),
            nowMs = 1_000,
        )
        assertIs<Decision.Skip>(decision)
        assertEquals(SkipReason.AlreadyOn, decision.reason)
    }

    @Test
    fun `a second write waits out the gap and is allowed after it`() {
        val wrote = PhoneUiSelfRepair.next(State(), Event.Wrote(atMs = 10_000))
        assertEquals(1, wrote.writes)

        val tooSoon = PhoneUiSelfRepair.shouldWrite(off = true, helperAttached = false, state = wrote, nowMs = 12_000)
        assertIs<Decision.Wait>(tooSoon)
        assertEquals(PhoneUiSelfRepair.BASE_GAP_MS - 2_000, tooSoon.ms)

        val allowed = PhoneUiSelfRepair.shouldWrite(off = true, helperAttached = false, state = wrote, nowMs = 20_000)
        assertEquals(Decision.Write, allowed)
    }

    @Test
    fun `the gap doubles with each write and is capped`() {
        assertEquals(0L, PhoneUiSelfRepair.gapAfter(0))
        assertEquals(PhoneUiSelfRepair.BASE_GAP_MS, PhoneUiSelfRepair.gapAfter(1))
        assertEquals(PhoneUiSelfRepair.BASE_GAP_MS * 2, PhoneUiSelfRepair.gapAfter(2))
        assertEquals(PhoneUiSelfRepair.MAX_GAP_MS, PhoneUiSelfRepair.gapAfter(100))
    }

    @Test
    fun `a clock that moved backwards waits instead of writing`() {
        val wrote = PhoneUiSelfRepair.next(State(), Event.Wrote(atMs = 50_000))
        val decision = PhoneUiSelfRepair.shouldWrite(off = true, helperAttached = false, state = wrote, nowMs = 10_000)
        assertIs<Decision.Wait>(decision)
        assertEquals(PhoneUiSelfRepair.BASE_GAP_MS, decision.ms)
    }

    @Test
    fun `an accepted write that is flipped back is NotAllowedHere`() {
        val wrote = PhoneUiSelfRepair.attemptWrite(State(), atMs = 1_000) { true }
        assertEquals(1, wrote.writes)
        assertNull(wrote.stopped)

        val settled = PhoneUiSelfRepair.next(wrote, Event.Settled(stillOff = true))
        assertEquals(Stop.NotAllowedHere, settled.stopped)
        assertIs<Decision.Skip>(
            PhoneUiSelfRepair.shouldWrite(off = true, helperAttached = false, state = settled, nowMs = 60_000),
        )
    }

    @Test
    fun `a write that survives the settle period records no stop`() {
        val wrote = PhoneUiSelfRepair.attemptWrite(State(), atMs = 1_000) { true }
        val settled = PhoneUiSelfRepair.next(wrote, Event.Settled(stillOff = false))
        assertNull(settled.stopped)
        assertEquals(1, settled.writes)
    }

    @Test
    fun `a write that returns false is Refused`() {
        val state = PhoneUiSelfRepair.attemptWrite(State(), atMs = 1_000) { false }
        assertEquals(Stop.Refused, state.stopped)
        assertEquals(1, state.writes)
    }

    @Test
    fun `a write that throws is Refused`() {
        val state = PhoneUiSelfRepair.attemptWrite(State(), atMs = 1_000) {
            throw IllegalStateException("no WRITE_SECURE_SETTINGS")
        }
        assertEquals(Stop.Refused, state.stopped)
        assertEquals(1, state.writes)
    }

    @Test
    fun `reaching MAX_WRITES is GaveUp`() {
        var state = State()
        repeat(PhoneUiSelfRepair.MAX_WRITES) { index ->
            state = PhoneUiSelfRepair.attemptWrite(state, atMs = index * 100_000L) { true }
        }
        assertEquals(PhoneUiSelfRepair.MAX_WRITES, state.writes)
        assertEquals(Stop.GaveUp, PhoneUiSelfRepair.stop(state))

        val decision = PhoneUiSelfRepair.shouldWrite(
            off = true,
            helperAttached = false,
            state = state,
            nowMs = 10_000_000,
        )
        assertIs<Decision.Skip>(decision)
        assertEquals(SkipReason.Stopped, decision.reason)
    }

    @Test
    fun `a stop survives later writes being recorded`() {
        val refused = PhoneUiSelfRepair.attemptWrite(State(), atMs = 1_000) { false }
        val flipped = PhoneUiSelfRepair.next(refused, Event.Settled(stillOff = true))
        assertEquals(Stop.Refused, flipped.stopped, "the first reason is the true one")
    }

    @Test
    fun `a write budget spent with the helper still down is GaveUp`() {
        var state = State()
        repeat(PhoneUiSelfRepair.MAX_WRITES) { index ->
            state = PhoneUiSelfRepair.attemptWrite(state, atMs = index * 100_000L) { true }
            state = PhoneUiSelfRepair.next(state, Event.Settled(stillOff = false))
        }
        assertEquals(Stop.GaveUp, PhoneUiSelfRepair.stop(state))
    }

    @Test
    fun `every trigger clears a stop and the write count`() {
        val stopped = State(writes = 2, lastWriteAtMs = 5_000, stopped = Stop.GaveUp)
        for (trigger in Trigger.entries) {
            val cleared = PhoneUiSelfRepair.next(stopped, Event.Cleared(trigger))
            assertEquals(State(), cleared, "trigger $trigger must clear the stop and the count")
            assertTrue(
                PhoneUiSelfRepair.shouldWrite(off = true, helperAttached = false, state = cleared, nowMs = 6_000) == Decision.Write,
                "trigger $trigger must allow a write again",
            )
        }
    }

    @Test
    fun `the gate takes the clearing trigger directly`() {
        val stopped = State(writes = 1, lastWriteAtMs = 5_000, stopped = Stop.NotAllowedHere)
        for (trigger in Trigger.entries) {
            assertEquals(
                Decision.Write,
                PhoneUiSelfRepair.shouldWrite(
                    off = true,
                    helperAttached = false,
                    state = stopped,
                    nowMs = 6_000,
                    clearedBy = trigger,
                ),
                "trigger $trigger must clear the stop in the gate itself",
            )
        }
    }

    @Test
    fun `a stop cleared by a trigger does not clear an attached helper`() {
        val stopped = State(stopped = Stop.GaveUp)
        val decision = PhoneUiSelfRepair.shouldWrite(
            off = true,
            helperAttached = true,
            state = stopped,
            nowMs = 6_000,
            clearedBy = Trigger.RetryRequested,
        )
        assertIs<Decision.Skip>(decision)
        assertEquals(SkipReason.HelperAttached, decision.reason)
    }

    @Test
    fun `the four triggers are exactly the ones Mika names`() {
        assertEquals(
            setOf(Trigger.WifiChanged, Trigger.ToggledByHand, Trigger.RetryRequested, Trigger.HelperAttached),
            Trigger.entries.toSet(),
        )
    }
}
