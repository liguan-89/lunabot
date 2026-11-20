/*
 * Pins the effects half of the two self-repairs: one step performs at most one
 * action, the wireless write is attempted once per accepted observation and
 * never after a flip-back or a refusal, the helper coming up clears an earlier
 * stop, and the accessibility repair writes only the list the decision hands
 * it — with a remove-and-re-add pair and a connect timeout around the write.
 *
 * The loop has no Android dependency, so these are plain JVM tests with a fake
 * clock: [Fixture.sleep] records the delay and advances the clock, which is
 * what the controller's real `delay` would do.
 */
package com.lunabot.companion.phoneui

import com.lunabot.companion.phoneui.PhoneUiSelfRepair.Stop
import com.lunabot.companion.phoneui.PhoneUiSelfRepair.Trigger
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PhoneUiRepairLoopTest {
    private val ours = "com.lunabot.companion/com.lunabot.companion.phoneui.PhoneUiAccessibilityService"

    /**
     * The loop plus everything it reads, as mutable fields: a test changes one
     * field and calls [PhoneUiRepairLoop.step], the way the system changes
     * under the controller.
     */
    private inner class Fixture {
        var nowMs = 1_000L
        val delays = mutableListOf<Long>()

        /** The wireless-debugging switch as the system reports it. */
        var switchOff = true

        /** Whether the shell helper is up. */
        var helper = false

        /** Whether the system takes the `adb_wifi_enabled` write. */
        var wirelessAccept = true

        /** Whether an accepted write survives the settle read, or is flipped back. */
        var switchSurvives = false

        /** Whether a writer exists at all: the app holds the grant, or a helper can give it. */
        var writer = true

        val wirelessWrites = mutableListOf<Long>()

        var a11yEnabled = true
        var a11yConnected = true
        var a11ySetting: String? = null
        val a11yWrites = mutableListOf<String?>()

        val loop = PhoneUiRepairLoop(
            component = ours,
            now = { nowMs },
            switchOff = { switchOff },
            helperAttached = { helper },
            wirelessWrite = {
                wirelessWrites += nowMs
                if (!wirelessAccept) {
                    false
                } else {
                    if (switchSurvives) switchOff = false
                    true
                }
            },
            wirelessWriter = { writer },
            a11yEnabled = { a11yEnabled },
            a11yConnected = { a11yConnected },
            a11ySetting = { a11ySetting },
            a11yWrite = { value ->
                a11yWrites += value
                true
            },
            sleep = { ms ->
                delays += ms
                nowMs += ms
            },
        )
    }

    // MARK: - Wireless debugging

    @Test
    fun `a flipped-back write stops the loop and is never repeated`() = runBlocking {
        val f = Fixture()
        f.switchOff = true
        // Accepted by the system, then flipped back: Android is asking the
        // person about this network, so the loop must stop.
        f.wirelessAccept = true
        f.switchSurvives = false

        assertEquals(0L, f.loop.step())
        assertEquals(1, f.wirelessWrites.size)
        assertEquals(Stop.NotAllowedHere, f.loop.wirelessStop)
        assertTrue(f.delays.contains(PhoneUiSelfRepair.SETTLE_MS))

        repeat(5) { f.loop.step() }
        assertEquals(1, f.wirelessWrites.size, "a stopped episode must not write again")
    }

    @Test
    fun `a refused write stops the loop and is never retried`() = runBlocking {
        val f = Fixture()
        f.switchOff = true
        f.wirelessAccept = false

        f.loop.step()
        assertEquals(1, f.wirelessWrites.size)
        assertEquals(Stop.Refused, f.loop.wirelessStop)

        repeat(5) { f.loop.step() }
        assertEquals(1, f.wirelessWrites.size)
    }

    @Test
    fun `no writer means no attempt and no refusal to spend the budget on`() = runBlocking {
        val f = Fixture()
        f.switchOff = true
        // The clean reboot: the switch is off, the helper is gone, and the app
        // does not hold the grant yet. Nothing can write, and nothing is
        // recorded — a refusal here would stop the loop for good.
        f.helper = false
        f.writer = false
        f.wirelessAccept = false

        repeat(5) { f.loop.step() }
        assertEquals(0, f.wirelessWrites.size)
        assertNull(f.loop.wirelessStop)

        // The helper comes back and brings the grant: the first write now
        // happens, with the write count still at zero.
        f.writer = true
        f.wirelessAccept = true
        f.switchSurvives = true
        f.loop.step()
        assertEquals(1, f.wirelessWrites.size)
        assertNull(f.loop.wirelessStop)
    }

    @Test
    fun `a switch that stays on is not written again before the gap elapses`() = runBlocking {
        val f = Fixture()
        f.switchOff = true
        f.switchSurvives = true

        f.loop.step()
        assertEquals(1, f.wirelessWrites.size)
        assertNull(f.loop.wirelessStop, "a write that survives the settle read records no stop")

        // The switch is lost again (reboot, Wi-Fi change) while the gap is
        // still open: the loop must wait it out.
        f.switchOff = true
        val wait = f.loop.step()
        assertEquals(PhoneUiSelfRepair.gapAfter(1) - PhoneUiSelfRepair.SETTLE_MS, wait)
        assertEquals(1, f.wirelessWrites.size)

        // Still too early.
        f.loop.step()
        assertEquals(1, f.wirelessWrites.size)

        // The gap is over; one more write is allowed.
        f.nowMs += wait
        f.loop.step()
        assertEquals(2, f.wirelessWrites.size)
    }

    @Test
    fun `a spent write budget is GaveUp and a retry starts a fresh count`() = runBlocking {
        val f = Fixture()
        f.switchSurvives = true
        repeat(PhoneUiSelfRepair.MAX_WRITES) {
            f.switchOff = true
            f.nowMs += PhoneUiSelfRepair.MAX_GAP_MS
            f.loop.step()
        }
        assertEquals(PhoneUiSelfRepair.MAX_WRITES, f.wirelessWrites.size)
        assertEquals(Stop.GaveUp, f.loop.wirelessStop)

        f.switchOff = true
        f.loop.step()
        assertEquals(PhoneUiSelfRepair.MAX_WRITES, f.wirelessWrites.size, "GaveUp is not retried by itself")

        f.loop.cleared(Trigger.RetryRequested)
        f.loop.step()
        assertEquals(PhoneUiSelfRepair.MAX_WRITES + 1, f.wirelessWrites.size, "a retry writes again")
    }

    @Test
    fun `an attached helper never writes and clears an earlier GaveUp`() = runBlocking {
        val f = Fixture()
        f.switchSurvives = true
        repeat(PhoneUiSelfRepair.MAX_WRITES) {
            f.switchOff = true
            f.nowMs += PhoneUiSelfRepair.MAX_GAP_MS
            f.loop.step()
        }
        assertEquals(Stop.GaveUp, f.loop.wirelessStop)
        val before = f.wirelessWrites.size

        f.helper = true
        f.switchOff = true
        repeat(3) { f.loop.step() }
        assertEquals(before, f.wirelessWrites.size, "the helper is up, so the switch is not needed")
        assertNull(f.loop.wirelessStop, "the helper attaching clears the stop")

        f.helper = false
        f.switchOff = true
        f.loop.step()
        assertEquals(before + 1, f.wirelessWrites.size, "a later detach may write again")
    }

    // MARK: - Accessibility

    @Test
    fun `a listed but dead service is removed and re-added with a timeout between`() = runBlocking {
        val f = Fixture()
        f.helper = true // the wireless half stays quiet
        f.a11yEnabled = true
        f.a11yConnected = false
        f.a11ySetting = ours // ours is the only entry

        assertEquals(PhoneUiAccessibilityRepair.GRACE_MS, f.loop.step(), "the grace period comes first")
        f.nowMs += PhoneUiAccessibilityRepair.GRACE_MS

        assertEquals(0L, f.loop.step())
        assertEquals(
            listOf<String?>(null, ours),
            f.a11yWrites,
            "ours was the only entry, so the removal deletes the setting before re-adding it",
        )
        assertEquals(
            listOf(PhoneUiAccessibilityRepair.GAP_MS, PhoneUiAccessibilityRepair.CONNECT_TIMEOUT_MS),
            f.delays,
        )
        assertEquals(1, f.loop.a11yFailures, "the service did not bind within the timeout")
    }

    @Test
    fun `a service the person disabled is never written`() = runBlocking {
        val f = Fixture()
        f.helper = true
        f.a11yEnabled = false
        f.a11yConnected = false
        f.a11ySetting = "$ours:com.one/.One"

        repeat(3) { f.loop.step() }
        assertTrue(f.a11yWrites.isEmpty())
        assertEquals(0, f.loop.a11yFailures)
    }

    @Test
    fun `a connected service is not written and the episode resets`() = runBlocking {
        val f = Fixture()
        f.helper = true
        f.a11yEnabled = true
        f.a11yConnected = false
        f.a11ySetting = "com.one/.One:$ours"

        f.loop.step() // grace
        f.nowMs += PhoneUiAccessibilityRepair.GRACE_MS
        f.loop.step() // one attempt, one failure
        assertEquals(1, f.loop.a11yFailures)
        val writes = f.a11yWrites.size

        f.a11yConnected = true
        f.loop.step()
        assertEquals(writes, f.a11yWrites.size, "a bound service needs no write")
        assertEquals(0, f.loop.a11yFailures, "a bound service ends the episode")
    }

    @Test
    fun `the written list keeps every other accessibility service`() = runBlocking {
        val f = Fixture()
        f.helper = true
        f.a11yEnabled = true
        f.a11yConnected = false
        f.a11ySetting = "com.one/.One:com.two/com.two.Two"

        f.loop.step() // grace
        f.nowMs += PhoneUiAccessibilityRepair.GRACE_MS
        f.loop.step()

        assertEquals(
            listOf("com.one/.One:com.two/com.two.Two:$ours"),
            f.a11yWrites.toList(),
            "only our component is appended; both other entries stay in place",
        )
    }

    // MARK: - One action per step

    @Test
    fun `a step that writes the switch does not also write accessibility`() = runBlocking {
        val f = Fixture()
        f.helper = true
        f.a11yEnabled = true
        f.a11yConnected = false
        f.a11ySetting = "com.one/.One:$ours"

        f.loop.step() // the accessibility half observes and starts its grace period
        f.nowMs += PhoneUiAccessibilityRepair.GRACE_MS

        // The helper goes away and the switch is off: the next step must spend
        // itself on the switch, even though the grace has elapsed and the
        // service is still unbound.
        f.helper = false
        f.switchOff = true
        f.switchSurvives = true
        val a11yBefore = f.a11yWrites.size

        f.loop.step()
        assertEquals(1, f.wirelessWrites.size)
        assertEquals(a11yBefore, f.a11yWrites.size, "one step performs at most one action")
    }
}
