/*
 * Pins the pure pacing logic: typing splits into growing prefixes with bounded
 * waits, a gesture's tap lands inside its element and its swipe stays in its
 * area, the action dwell is measured against an injected clock, and the
 * Instant / FAST profiles reproduce the old behaviour exactly. Every random
 * draw comes from a seeded Random here, so a failure names a seed.
 */
package com.lunabot.companion.phoneui

import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PhoneUiPacingTest {
    // MARK: - Typing

    @Test
    fun planEndsWithTheFullStringAndPrefixesGrow() {
        val texts = listOf("hello world", "你好，世界！", "a🙂b", "line\nbreak", "  spaced  ")
        for (text in texts) {
            for (seed in 0 until 20) {
                val plan = TypingPace.human(Random(seed)).plan(text)
                assertTrue(plan.isNotEmpty(), "seed $seed, text $text")
                assertEquals(text, plan.last().prefix, "the last step is the whole string")
                for (i in 1 until plan.size) {
                    assertTrue(
                        plan[i].prefix.length > plan[i - 1].prefix.length,
                        "prefixes grow at seed $seed: ${plan[i - 1].prefix} -> ${plan[i].prefix}",
                    )
                    assertTrue(
                        plan[i].prefix.startsWith(plan[i - 1].prefix),
                        "each prefix extends the previous one at seed $seed",
                    )
                }
            }
        }
    }

    @Test
    fun cjkSegmentsDifferFromLatin() {
        val cjk = "你好世界你好世界你好世界"
        val latin = "abcdefghijkl"
        var shorterSomewhere = false
        for (seed in 0 until 20) {
            val cjkPlan = TypingPace.human(Random(seed)).plan(cjk)
            val latinPlan = TypingPace.human(Random(seed)).plan(latin)
            // Latin is one character per step; a CJK run commits one to three
            // characters at a time, so it can never need more steps.
            assertTrue(cjkPlan.size <= latinPlan.size, "seed $seed")
            if (cjkPlan.size < latinPlan.size) shorterSomewhere = true
        }
        assertTrue(shorterSomewhere, "at least one seed groups CJK characters")
        assertTrue(
            TypingPace.units(cjk).size == 12,
            "each CJK character is one unit, no surrogate splitting",
        )
    }

    @Test
    fun punctuationAddsAPause() {
        // With a 0.5 chance and a doubled chance after a boundary, a trailing
        // period always earns the pause while a trailing letter sometimes does
        // not; both texts draw the same numbers up to that last decision.
        val limits = PhoneUiPaceLimits.TYPING.copy(pauseChance = 0.5, pauseMs = 500L..500L)
        var strictlyLonger = false
        for (seed in 0 until 50) {
            val plain = TypingPace.human(Random(seed), limits).plan("abcd").last().delayBeforeMs
            val punct = TypingPace.human(Random(seed), limits).plan("abc.").last().delayBeforeMs
            assertTrue(punct >= plain, "a punctuation pause is never less at seed $seed")
            if (punct > plain) strictlyLonger = true
        }
        assertTrue(strictlyLonger, "punctuation makes the last pause longer for some seed")
    }

    @Test
    fun fixedSeedGivesAFixedPlan() {
        val text = "hello, 世界! 123"
        val first = TypingPace.human(Random(7)).plan(text)
        val second = TypingPace.human(Random(7)).plan(text)
        assertEquals(first, second)
        val other = TypingPace.human(Random(8)).plan(text)
        assertTrue(first != other, "a different seed draws different waits")
    }

    @Test
    fun everyDelayIsWithinItsBounds() {
        // The budget is lifted so the bound under test is the per-step one.
        val limits = PhoneUiPaceLimits.TYPING.copy(maxTotalMs = Long.MAX_VALUE)
        for (seed in 0 until 50) {
            val latin = TypingPace.human(Random(seed), limits).plan("short and plain")
            for (step in latin) {
                assertTrue(step.delayBeforeMs >= limits.latinMs.first, "latin seed $seed")
                assertTrue(step.delayBeforeMs <= limits.latinMs.last + limits.pauseMs.last, "latin seed $seed")
            }
            // A CJK step can hold up to cjkGroup.last characters.
            val cjk = TypingPace.human(Random(seed), limits).plan("你好世界你好世界")
            for (step in cjk) {
                assertTrue(step.delayBeforeMs >= limits.cjkMs.first, "cjk seed $seed")
                assertTrue(
                    step.delayBeforeMs <= limits.cjkMs.last * limits.cjkGroup.last + limits.pauseMs.last,
                    "cjk seed $seed",
                )
            }
        }
    }

    @Test
    fun aLongMessageStaysWithinTheTotalBudget() {
        val text = "a".repeat(PhoneUiRules.MAX_TYPE_TEXT)
        for (seed in 0 until 5) {
            val plan = TypingPace.human(Random(seed)).plan(text)
            assertEquals(text, plan.last().prefix)
            assertTrue(plan.size <= PhoneUiPaceLimits.TYPING.maxSteps, "steps are capped at seed $seed")
            assertTrue(
                plan.sumOf { it.delayBeforeMs } <= PhoneUiPaceLimits.TYPING.maxTotalMs,
                "total stays inside the budget at seed $seed",
            )
        }
    }

    @Test
    fun fastYieldsOneSegment() {
        val plan = OperatingPace.FAST.typingPace().plan("你好，世界!")
        assertEquals(1, plan.size)
        assertEquals("你好，世界!", plan.single().prefix)
        assertEquals(0L, plan.single().delayBeforeMs)
        assertEquals(1, TypingPace.Instant.plan("anything").size)
        assertEquals(0L, TypingPace.Instant.plan("anything").single().delayBeforeMs)
    }

    @Test
    fun aSecretOrPasteOnlyFieldIsNeverSegmented() {
        val human = TypingPace.human(Random(2))
        assertTrue(human.paced)
        assertTrue(human.forField(web = false, secret = false).paced)
        assertFalse(human.forField(web = true, secret = false).paced)
        assertFalse(human.forField(web = false, secret = true).paced)
        assertEquals(1, human.forField(web = true, secret = false).plan("abcdef").size)
    }

    // MARK: - Gestures

    @Test
    fun instantGestureIsTheOldBehaviour() {
        val tap = GesturePace.Instant.tap(left = 100, top = 200, right = 301, bottom = 401)
        assertEquals(200, tap.x, "the centre is (left + right) / 2, truncated")
        assertEquals(300, tap.y)
        assertEquals(GesturePace.TAP_MS, tap.pressMs)
        assertEquals(0L, tap.approachMs)

        val stroke = tap.stroke()
        assertEquals(listOf(0L, GesturePace.TAP_MS), stroke.times.toList())
        assertEquals(GesturePace.TAP_MS, stroke.durationMs)

        val (xs, ys, times) = oldStroke(100, 500, 400, 500, 280)
        val swipe = GesturePace.Instant.swipe(100, 500, 400, 500, 280)
        assertEquals(xs.toList(), swipe.xs.toList())
        assertEquals(ys.toList(), swipe.ys.toList())
        assertEquals(times.toList(), swipe.times.toList())
        assertEquals(280L, swipe.durationMs)
    }

    @Test
    fun jitteredTapPointsStayInsideTheElement() {
        for (seed in 0 until 500) {
            val (x, y) = GesturePace.human(Random(seed)).within(100, 200, 301, 401)
            assertTrue(x in 100..300, "x=$x at seed $seed")
            assertTrue(y in 200..400, "y=$y at seed $seed")
        }
        // A narrow element is not jittered at all, so a tiny control is never missed.
        for (seed in 0 until 50) {
            val (x, y) = GesturePace.human(Random(seed)).within(10, 10, 20, 20)
            assertEquals(15, x)
            assertEquals(15, y)
        }
    }

    @Test
    fun coordinateTapStaysNearThePointAndNonNegative() {
        for (seed in 0 until 200) {
            val (x, y) = GesturePace.human(Random(seed)).near(1, 1)
            assertTrue(x in 0..1 + PhoneUiPaceLimits.GESTURE.pointJitterPx, "x=$x at seed $seed")
            assertTrue(y in 0..1 + PhoneUiPaceLimits.GESTURE.pointJitterPx, "y=$y at seed $seed")
        }
    }

    @Test
    fun aSwipeStaysInsideItsAreaAndBows() {
        val area = GesturePace.Area(0, 0, 720, 1_280)
        var bowedSomewhere = false
        for (seed in 0 until 100) {
            val stroke = GesturePace.human(Random(seed)).swipe(100, 500, 400, 500, 280, bow = true, area = area)
            assertTrue(stroke.points.size >= 2)
            assertEquals(0L, stroke.points.first().t)
            for (point in stroke.points) {
                assertTrue(point.x in 0..719, "x=${point.x} at seed $seed")
                assertTrue(point.y in 0..1_279, "y=${point.y} at seed $seed")
            }
            assertEquals(100, stroke.points.first().x, "the press point does not move")
            assertEquals(500, stroke.points.first().y)
            assertEquals(400, stroke.points.last().x, "the lift point does not move")
            assertEquals(500, stroke.points.last().y)
            if (stroke.points.drop(1).dropLast(1).any { it.y != 500 }) bowedSomewhere = true
            // The duration floats around the request by at most the jitter bound.
            val jitter = PhoneUiPaceLimits.GESTURE.durationJitter
            assertTrue(
                stroke.durationMs in (280 * (1 - jitter)).toLong()..(280 * (1 + jitter)).toLong() + 1,
                "duration=${stroke.durationMs} at seed $seed",
            )
        }
        assertTrue(bowedSomewhere, "the arc leaves the straight line for some seed")
    }

    @Test
    fun aHoldNeverShrinksThePress() {
        for (seed in 0 until 50) {
            val stroke = GesturePace.human(Random(seed)).stroke(listOf(10 to 10, 11 to 10), 500)
            assertEquals(2, stroke.points.size)
            assertTrue(stroke.durationMs >= 500, "seed $seed")
            assertTrue(stroke.durationMs <= (500 * (1 + PhoneUiPaceLimits.GESTURE.holdStretch)).toLong() + 1, "seed $seed")
        }
    }

    @Test
    fun aPacedStrokeNeverExceedsTheInjectorLimits() {
        for (seed in 0 until 20) {
            val stroke = GesturePace.human(Random(seed)).swipe(0, 0, 719, 1_279, 60_000)
            assertTrue(stroke.points.size <= PhoneUiPaceLimits.GESTURE.maxPoints, "seed $seed")
            assertTrue(stroke.durationMs <= PhoneUiPaceLimits.GESTURE.maxStrokeMs, "seed $seed")
            assertEquals(0L, stroke.times.first())
            assertTrue(stroke.times.toList().zipWithNext().all { (a, b) -> a <= b }, "times never go backwards")
        }
    }

    @Test
    fun fastUsesInstantGestures() {
        // FAST is the opted-out level, so its touch is the old touch exactly;
        // STANDARD and HUMAN look human.
        assertFalse(OperatingPace.FAST.gesturePace(Random(1)).paced)
        assertTrue(OperatingPace.STANDARD.gesturePace(Random(1)).paced)
        assertTrue(OperatingPace.HUMAN.gesturePace(Random(1)).paced)
    }

    // MARK: - Actions

    @Test
    fun fastOwesNothing() {
        val pace = ActionPace.Off
        pace.noteAction("com.example", newScreen = true)
        assertEquals(0L, pace.waitBefore(textChars = 10_000))
        assertFalse(pace.paced)
        val fast = OperatingPace.FAST.actionPace(random = Random(1))
        fast.noteAction("com.example", newScreen = true)
        assertEquals(0L, fast.waitBefore())
        assertFalse(fast.capReached("com.example", AppPace.CAREFUL))
    }

    @Test
    fun sameScreenOwesTheSameScreenRange() {
        var clock = 0L
        val limits = PhoneUiPaceLimits.ACTION.copy(pauseChance = 0.0)
        val pace = ActionPace.human(Random(3), { clock }, limits = limits)
        pace.noteAction("com.example", newScreen = false)
        val owed = pace.waitBefore()
        assertTrue(owed in limits.sameScreenMs, "owed=$owed")
        clock = owed / 2
        assertEquals(owed - clock, pace.waitBefore(), "only the shortfall is owed")
        clock = owed
        assertEquals(0L, pace.waitBefore())
    }

    @Test
    fun newScreenOwesTheNewScreenRangePlusReadingTime() {
        var clock = 0L
        val limits = PhoneUiPaceLimits.CAREFUL_ACTION.copy(pauseChance = 0.0)
        val pace = ActionPace.human(Random(4), { clock }, limits = limits, careful = limits)
        pace.noteAction("com.example", newScreen = true, pace = AppPace.CAREFUL)
        val chars = 100
        val read = chars * limits.readMsPerChar
        val owed = pace.waitBefore(textChars = chars)
        assertTrue(
            owed in (limits.newScreenMs.first + read)..(limits.newScreenMs.last + read),
            "owed=$owed",
        )
        // Reading time only counts after a new screen, not after a same-screen action.
        var clock2 = 0L
        val same = ActionPace.human(Random(4), { clock2 }, limits = limits, careful = limits)
        same.noteAction("com.example", newScreen = false, pace = AppPace.CAREFUL)
        assertTrue(same.waitBefore(textChars = chars) in limits.sameScreenMs)
    }

    @Test
    fun aDwellIsNeverMoreThanTheCap() {
        val limits = PhoneUiPaceLimits.ACTION.copy(
            sameScreenMs = 900L..2_000L,
            newScreenMs = 900L..2_000L,
            maxDwellMs = 1_000L,
            pauseChance = 1.0,
            pauseMs = 5_000L..5_000L,
        )
        for (seed in 0 until 20) {
            var clock = 0L
            val pace = ActionPace.human(Random(seed), { clock }, limits = limits)
            pace.noteAction("com.example", newScreen = true)
            val owed = pace.waitBefore(textChars = 1_000_000)
            assertTrue(owed <= limits.maxDwellMs, "owed=$owed at seed $seed")
            assertTrue(owed >= 0L, "owed=$owed at seed $seed")
        }
    }

    @Test
    fun aCarefulAppIsCappedUntilItActsOutwardOrTheUserReplies() {
        var clock = 0L
        val pace = ActionPace.human(Random(6), { clock }, screenCap = 3)
        repeat(3) {
            pace.noteAction("com.example", newScreen = true, pace = AppPace.CAREFUL)
        }
        assertEquals(3, pace.screensIn("com.example"))
        assertTrue(pace.capReached("com.example", AppPace.CAREFUL))
        assertFalse(pace.capReached("com.example", AppPace.NORMAL), "a normal app is never capped")
        pace.userAnswered()
        assertFalse(pace.capReached("com.example", AppPace.CAREFUL), "a user reply resets the count")
        repeat(3) {
            pace.noteAction("com.example", newScreen = true, pace = AppPace.CAREFUL)
        }
        pace.outwardDone("com.example")
        assertFalse(pace.capReached("com.example", AppPace.CAREFUL), "an outward action lifts the cap")
    }

    @Test
    fun paceForHonoursACarefulApp() {
        val knowledge = AppKnowledge(mapOf("com.example.careful" to AppPace.CAREFUL))
        val careful = OperatingPace.STANDARD.paceFor("com.example.careful", knowledge, Random(9))
        assertEquals(AppPace.CAREFUL, careful.app)
        assertEquals(PhoneUiPaceLimits.CAREFUL_TYPING, careful.typing.limits)
        assertEquals(PhoneUiPaceLimits.CAREFUL_ACTION, careful.action.careful)

        val normal = OperatingPace.STANDARD.paceFor("com.example.normal", knowledge, Random(9))
        assertEquals(AppPace.NORMAL, normal.app)
        assertEquals(PhoneUiPaceLimits.TYPING, normal.typing.limits)
        assertEquals(PhoneUiPaceLimits.ACTION, normal.action.limits)

        val human = OperatingPace.HUMAN.paceFor("com.example.normal", knowledge, Random(9))
        assertEquals(PhoneUiPaceLimits.CAREFUL_TYPING, human.typing.limits)
        assertEquals(PhoneUiPaceLimits.CAREFUL_ACTION, human.action.careful)

        val fast = OperatingPace.FAST.paceFor("com.example.careful", knowledge, Random(9))
        assertFalse(fast.typing.paced)
        assertFalse(fast.gesture.paced)
        assertFalse(fast.action.paced)
    }

    @Test
    fun paceParsingIsCaseInsensitiveAndRejectsUnknown() {
        assertEquals(OperatingPace.STANDARD, OperatingPace.parse(" standard "))
        assertEquals(OperatingPace.HUMAN, OperatingPace.parse("Human"))
        assertEquals(null, OperatingPace.parse("warp"))
        assertEquals(OperatingPace.STANDARD, OperatingPace.DEFAULT)
    }

    // MARK: - The old gesture, spelled out

    /** The executor's pre-pacing stroke: eight segments, linear, Float arithmetic, truncated. */
    private fun oldStroke(fx: Int, fy: Int, tx: Int, ty: Int, total: Long): Triple<IntArray, IntArray, LongArray> {
        val points = 8
        val xs = IntArray(points + 1)
        val ys = IntArray(points + 1)
        val times = LongArray(points + 1)
        for (i in 0..points) {
            val t = i.toFloat() / points
            xs[i] = (fx + (tx - fx) * t).toInt()
            ys[i] = (fy + (ty - fy) * t).toInt()
            times[i] = total * i / points
        }
        return Triple(xs, ys, times)
    }
}
