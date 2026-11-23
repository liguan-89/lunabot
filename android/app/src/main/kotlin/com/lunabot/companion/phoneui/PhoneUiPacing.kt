/*
 * Ported from Mika (https://github.com/wangzan101/Mika), files
 * core/src/main/kotlin/com/wangzan101/mika/core/cap/phone/OperatingPace.kt,
 * TypingPacing.kt, GesturePacing.kt, AppPacing.kt, and
 * core/src/main/kotlin/com/wangzan101/mika/core/uistate/Pace.kt.
 * Copyright 2026 wangzan101. The original is licensed under the Apache License,
 * Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 LunaBot contributors. Changes from the
 * original: repackaged under com.lunabot.companion.phoneui, comments
 * translated into English, no coroutines or Android types, gestures emit
 * integer arrays ready for PhoneUiShell.injectStroke, and the app-knowledge
 * verdict is a small map instead of a site-knowledge record.
 *
 * Everything here is pure: randomness and the clock arrive as parameters, no
 * function sleeps, and every duration is clamped by a value in
 * [PhoneUiPaceLimits]. Wiring into the executor is a separate change.
 */
package com.lunabot.companion.phoneui

import kotlin.math.ceil
import kotlin.math.hypot
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.roundToLong
import kotlin.random.Random

/**
 * Every bound the pacing logic uses, in one place so a reviewer can see the
 * whole profile at once. The numbers are provisional: they are Mika's, not yet
 * tuned against this app's traffic, and they are deliberately conservative
 * rather than fast.
 *
 * Durations are milliseconds and distances are pixels unless the name says
 * otherwise. A range is inclusive at both ends and a single-value range means
 * "always this".
 */
internal object PhoneUiPaceLimits {
    /** Typing bounds: per-character waits, grouping, punctuation pauses, total budget. */
    data class Typing(
        val latinMs: LongRange,
        val cjkMs: LongRange,
        val cjkGroup: IntRange,
        val pauseChance: Double,
        val pauseMs: LongRange,
        val maxSteps: Int,
        val maxTotalMs: Long,
    )

    /** Gesture bounds: approach, press, tap jitter, stroke shape and sampling. */
    data class Gesture(
        val approachMs: LongRange,
        val pressMs: LongRange,
        val jitterFraction: Double,
        val maxJitterPx: Int,
        val minJitterSpanPx: Int,
        val pointJitterPx: Int,
        val durationJitter: Double,
        val holdStretch: Double,
        val stillPx: Double,
        val bowFraction: Double,
        val maxBowPx: Double,
        val sampleMs: LongRange,
        val maxPoints: Int,
        val dragMs: Long,
        val flingEndSpeed: ClosedFloatingPointRange<Double>,
        val maxStrokeMs: Long,
        val instantSegments: Int,
    )

    /** Action bounds: dwell on the same and on a new screen, reading time, the dwell cap. */
    data class Action(
        val sameScreenMs: LongRange,
        val newScreenMs: LongRange,
        val readMsPerChar: Long,
        val maxReadMs: Long,
        val pauseChance: Double,
        val pauseMs: LongRange,
        val maxDwellMs: Long,
    )

    /** Standard typing: Latin 60-170 ms per character, CJK 160-380 ms per character, 1-3 CJK per step. */
    val TYPING = Typing(
        latinMs = 60L..170L,
        cjkMs = 160L..380L,
        cjkGroup = 1..3,
        pauseChance = 0.05,
        pauseMs = 300L..900L,
        maxSteps = 40,
        maxTotalMs = 6_000L,
    )

    /** Careful typing: slower characters, more pauses, and a longer total budget for a long message. */
    val CAREFUL_TYPING = Typing(
        latinMs = 90L..230L,
        cjkMs = 220L..520L,
        cjkGroup = 1..3,
        pauseChance = 0.1,
        pauseMs = 500L..1_400L,
        maxSteps = 60,
        maxTotalMs = 12_000L,
    )

    /**
     * Gestures. [maxStrokeMs] matches PhoneUiPolicy.STROKE_MAX_MS so a stroke
     * this file produces is always accepted by the injector; [maxPoints] stays
     * below its point cap for the same reason. [dragMs] and [flingEndSpeed] keep
     * a short swipe's release speed near the old constant-speed stroke, so
     * scroll distance does not change.
     */
    val GESTURE = Gesture(
        approachMs = 30L..120L,
        pressMs = 50L..120L,
        jitterFraction = 0.2,
        maxJitterPx = 12,
        minJitterSpanPx = 24,
        pointJitterPx = 3,
        durationJitter = 0.08,
        holdStretch = 0.12,
        stillPx = 3.0,
        bowFraction = 0.06,
        maxBowPx = 30.0,
        sampleMs = 8L..16L,
        maxPoints = 600,
        dragMs = 800L,
        flingEndSpeed = 0.9..1.0,
        maxStrokeMs = 10_000L,
        instantSegments = 8,
    )

    /** Standard action dwell: half a second to 1.2 s on the same screen, 0.9-2 s on a new one. */
    val ACTION = Action(
        sameScreenMs = 500L..1_200L,
        newScreenMs = 900L..2_000L,
        readMsPerChar = 0L,
        maxReadMs = 0L,
        pauseChance = 0.05,
        pauseMs = 600L..1_500L,
        maxDwellMs = 3_500L,
    )

    /** Careful action dwell: longer, plus 15 ms per character of the new screen up to 8 s. */
    val CAREFUL_ACTION = Action(
        sameScreenMs = 900L..2_200L,
        newScreenMs = 2_500L..5_000L,
        readMsPerChar = 15L,
        maxReadMs = 8_000L,
        pauseChance = 0.1,
        pauseMs = 2_000L..5_000L,
        maxDwellMs = 15_000L,
    )

    /** New screens a careful app may reach in one task before the loop has to stop and ask. */
    const val CAREFUL_SCREEN_CAP = 24
}

/** What app knowledge says about one app's tolerance for speed; ported from Mika's PlacePace. */
internal enum class AppPace {
    /** No special instruction. */
    NORMAL,

    /** The app rate-limits or notices fast browsing: use the slow profile and count new screens. */
    CAREFUL,
}

/**
 * What app knowledge knows about apps, narrowed to the one fact pacing needs.
 * A package that is absent is [AppPace.NORMAL]; knowledge is never guessed from
 * the package name.
 */
internal data class AppKnowledge(val paces: Map<String, AppPace> = emptyMap()) {
    fun paceOf(packageName: String?): AppPace = packageName?.let { paces[it] } ?: AppPace.NORMAL
}

/**
 * How much the phone loop slows down to look human. Ported from Mika's
 * OperatingPace, with the same three levels:
 *
 * - [FAST]: no extra waits, the whole string in one write, no page cap (the
 *   old behaviour).
 * - [STANDARD] (the default): typing arrives in segments, actions pause
 *   briefly, gestures look human, and an app the knowledge marks
 *   [AppPace.CAREFUL] gets the slow typing and dwell profile.
 * - [HUMAN]: the slow typing and dwell profile everywhere. The new-screen cap
 *   still applies only to careful apps, as in Mika.
 *
 * One deliberate departure from Mika: Mika keeps gestures human at every level,
 * while [FAST] here also returns [GesturePace.Instant]. A FAST run has to stay
 * byte-for-byte the old touch until somebody opts in, and that is what the
 * Instant mode exists for; a caller that wants Mika's rule asks for
 * [GesturePace.human] explicitly.
 */
internal enum class OperatingPace {
    FAST,
    STANDARD,
    HUMAN,
    ;

    /**
     * The typing pace for an app with [app] knowledge. FAST wins over a careful
     * verdict: it is the "do exactly what we did before" setting.
     */
    fun typingPace(app: AppPace = AppPace.NORMAL, random: Random = Random.Default): TypingPace = when {
        this == FAST -> TypingPace.Instant
        this == HUMAN || app == AppPace.CAREFUL -> TypingPace.human(random, PhoneUiPaceLimits.CAREFUL_TYPING)
        else -> TypingPace.human(random)
    }

    /**
     * The gesture pace. [FAST] gets [GesturePace.Instant] so an opted-out run
     * keeps the old touch exactly; STANDARD and HUMAN get human gestures, as
     * Mika gives every level.
     */
    fun gesturePace(random: Random = Random.Default): GesturePace =
        if (this == FAST) GesturePace.Instant else GesturePace.human(random)

    /**
     * The wait between actions for an app with [app] knowledge. [now] is the
     * clock the returned pacer reads; nothing in it sleeps.
     */
    fun actionPace(
        app: AppPace = AppPace.NORMAL,
        random: Random = Random.Default,
        now: () -> Long = System::currentTimeMillis,
    ): ActionPace = when {
        this == FAST -> ActionPace.Off
        this == HUMAN || app == AppPace.CAREFUL ->
            ActionPace.human(random, now, limits = PhoneUiPaceLimits.CAREFUL_ACTION)
        else -> ActionPace.human(random, now)
    }

    /**
     * Everything one run needs for [packageName], with [knowledge] deciding
     * whether the app is careful. The caller builds this once per app and
     * hands the pieces to the executor; it draws no randomness itself.
     */
    fun paceFor(
        packageName: String?,
        knowledge: AppKnowledge = AppKnowledge(),
        random: Random = Random.Default,
        now: () -> Long = System::currentTimeMillis,
    ): PhoneUiPaceProfile {
        val app = knowledge.paceOf(packageName)
        return PhoneUiPaceProfile(
            operating = this,
            app = app,
            typing = typingPace(app, random),
            gesture = gesturePace(random),
            action = actionPace(app, random, now),
        )
    }

    companion object {
        val DEFAULT = STANDARD

        /** The stored name, case-insensitive; null when it names no level. */
        fun parse(value: String?): OperatingPace? =
            entries.firstOrNull { it.name.equals(value?.trim(), ignoreCase = true) }
    }
}

/** One run's pacing: the chosen level, the app verdict, and the three pacers built from them. */
internal data class PhoneUiPaceProfile(
    val operating: OperatingPace,
    val app: AppPace,
    val typing: TypingPace,
    val gesture: GesturePace,
    val action: ActionPace,
)

/**
 * Typing a string the way a person does: growing prefixes instead of one
 * instant write. Latin characters arrive one at a time, CJK characters arrive
 * one to three at a time the way an IME commits them, punctuation and spaces
 * occasionally earn an extra pause, and a long message is scaled down to a
 * total budget instead of taking minutes.
 *
 * [plan] is the whole pure decision: the caller waits `delayBeforeMs` and then
 * writes `prefix`. The last step is always the full string. [Instant] returns
 * one step with no wait, which is what FAST and the old behaviour use.
 */
internal class TypingPace(
    private val random: Random?,
    val limits: PhoneUiPaceLimits.Typing = PhoneUiPaceLimits.TYPING,
) {
    /** One segment: wait [delayBeforeMs], then the field should hold [prefix]. */
    data class Step(val prefix: String, val delayBeforeMs: Long)

    /** Whether this pace draws randomness at all. */
    val paced: Boolean get() = random != null

    /**
     * The ordered segments for [text]. An empty string is one empty step with
     * no wait; [Instant] and a one-unit string are one step. The last step is
     * the full string, and every prefix is a prefix of the one after it.
     */
    fun plan(text: String): List<Step> {
        val r = random ?: return listOf(Step(text, 0))
        if (text.isEmpty()) return listOf(Step("", 0))
        val starts = units(text)
        if (starts.size <= 1) return listOf(Step(text, pick(r, limits.latinMs)))
        val per = ceil(starts.size.toDouble() / limits.maxSteps.coerceAtLeast(1)).toInt().coerceAtLeast(1)
        val steps = ArrayList<Step>()
        var i = 0
        while (i < starts.size) {
            // A CJK run commits as one IME word: pick a group size that stops
            // at the first non-CJK character, then never go below the size
            // forced by the step budget.
            val group = if (isCjk(text, starts[i])) {
                val want = pick(r, limits.cjkGroup)
                var k = 1
                while (k < want && i + k < starts.size && isCjk(text, starts[i + k])) k++
                k
            } else {
                1
            }
            val upto = minOf(i + maxOf(group, per), starts.size)
            var wait = 0L
            for (j in i until upto) {
                wait += pick(r, if (isCjk(text, starts[j])) limits.cjkMs else limits.latinMs)
            }
            val end = if (upto == starts.size) text.length else starts[upto]
            val last = text.codePointBefore(end)
            val boundary = Character.isWhitespace(last) || isPunctuation(last)
            // A pause is twice as likely after a boundary, because a person
            // hesitates at the end of a word or sentence.
            if (r.nextDouble() < limits.pauseChance * (if (boundary) 2 else 1)) {
                wait += pick(r, limits.pauseMs)
            }
            steps += Step(text.substring(0, end), wait)
            i = upto
        }
        val total = steps.sumOf { it.delayBeforeMs }
        if (total <= limits.maxTotalMs) return steps
        // A long message is compressed proportionally. Rounding each step can
        // leave the sum a few milliseconds over the budget, so the last step
        // gives that back: a 4,000-character paste finishes inside the promise.
        val scale = limits.maxTotalMs.toDouble() / total
        val scaled = steps.map { it.copy(delayBeforeMs = (it.delayBeforeMs * scale).roundToLong()) }
        val over = scaled.sumOf { it.delayBeforeMs } - limits.maxTotalMs
        if (over <= 0) return scaled
        val last = scaled.last()
        return scaled.dropLast(1) + last.copy(delayBeforeMs = (last.delayBeforeMs - over).coerceAtLeast(0))
    }

    /**
     * The pace to use for one field. A password field is never segmented
     * because its value cannot be read back, so a half-typed prefix cannot be
     * verified; a field that only accepts a paste (a web view) is never
     * segmented because the app would not receive the earlier writes. Both use
     * [Instant], which is what Mika does.
     */
    fun forField(web: Boolean, secret: Boolean): TypingPace = if (web || secret) Instant else this

    companion object {
        /** One write, no wait. */
        val Instant = TypingPace(null)

        /** Human typing; [random] can be a fixed seed in tests. */
        fun human(random: Random = Random.Default, limits: PhoneUiPaceLimits.Typing = PhoneUiPaceLimits.TYPING) =
            TypingPace(random, limits)

        /**
         * The start index of every character in [text]. A surrogate pair,
         * combining mark, variation selector, skin-tone modifier and a ZWJ
         * sequence all stay with the character before them, so a segment never
         * splits one character.
         */
        internal fun units(text: String): List<Int> {
            val out = mutableListOf<Int>()
            var i = 0
            var joinNext = false
            while (i < text.length) {
                val cp = text.codePointAt(i)
                val attach = out.isNotEmpty() && (joinNext || attaches(cp))
                if (!attach) out += i
                joinNext = cp == ZWJ
                i += Character.charCount(cp)
            }
            return out
        }

        private const val ZWJ = 0x200D

        private fun attaches(cp: Int): Boolean = when (Character.getType(cp)) {
            Character.NON_SPACING_MARK.toInt(),
            Character.ENCLOSING_MARK.toInt(),
            Character.COMBINING_SPACING_MARK.toInt(),
            -> true
            else -> cp == ZWJ || cp in 0xFE00..0xFE0F || cp in 0x1F3FB..0x1F3FF
        }

        private fun isCjk(text: String, at: Int): Boolean =
            when (Character.UnicodeScript.of(text.codePointAt(at))) {
                Character.UnicodeScript.HAN,
                Character.UnicodeScript.HIRAGANA,
                Character.UnicodeScript.KATAKANA,
                Character.UnicodeScript.HANGUL,
                -> true
                else -> false
            }

        private fun isPunctuation(cp: Int): Boolean = when (Character.getType(cp)) {
            Character.CONNECTOR_PUNCTUATION.toInt(),
            Character.DASH_PUNCTUATION.toInt(),
            Character.START_PUNCTUATION.toInt(),
            Character.END_PUNCTUATION.toInt(),
            Character.INITIAL_QUOTE_PUNCTUATION.toInt(),
            Character.FINAL_QUOTE_PUNCTUATION.toInt(),
            Character.OTHER_PUNCTUATION.toInt(),
            -> true
            else -> false
        }
    }
}

/**
 * Where and how a finger lands. A tap's point is jittered inside the element
 * (never outside its bounds), the press lasts a little longer or shorter, and
 * a pre-touch pause comes first. A swipe follows a slight arc, accelerates
 * from rest and decelerates into the release, and its duration floats around
 * the requested one. All of it is bounded by [PhoneUiPaceLimits.GESTURE], so
 * one action has a bounded duration.
 *
 * [Instant] is the old behaviour exactly: centre point, a 50 ms press, a
 * straight line, no jitter, no pause. Wiring to it changes nothing until
 * someone opts into [human].
 *
 * A [Stroke] exposes `xs`, `ys` and `times`, which are exactly the arrays
 * `PhoneUiShell.injectStroke(displayId, xs, ys, times)` takes.
 */
internal class GesturePace(
    private val random: Random?,
    val limits: PhoneUiPaceLimits.Gesture = PhoneUiPaceLimits.GESTURE,
) {
    /** One point of a stroke: the finger is at ([x], [y]) [t] ms after the press. */
    data class Point(val x: Int, val y: Int, val t: Long)

    /** A whole press-to-lift stroke. The first time is 0; the last time is the duration. */
    data class Stroke(val points: List<Point>) {
        val durationMs: Long get() = points.last().t
        val xs: IntArray get() = IntArray(points.size) { points[it].x }
        val ys: IntArray get() = IntArray(points.size) { points[it].y }
        val times: LongArray get() = LongArray(points.size) { points[it].t }
    }

    /** A tap before it is turned into a stroke: where, how long the press, how long to hover first. */
    data class Tap(val x: Int, val y: Int, val pressMs: Long, val approachMs: Long) {
        /** The two-point stroke an injector can send: press at 0, lift after the press. */
        fun stroke(): Stroke = Stroke(
            listOf(Point(x, y, 0), Point(x, y, pressMs.coerceAtLeast(1))),
        )
    }

    /** A rectangle the finger must stay inside; right and bottom are exclusive. */
    data class Area(val left: Int, val top: Int, val right: Int, val bottom: Int)

    /** Whether this pace draws randomness at all. */
    val paced: Boolean get() = random != null

    /** How long to hover before touching down; 0 for [Instant]. */
    fun approach(): Long = random?.let { pick(it, limits.approachMs) } ?: 0L

    /** How long the finger stays down for a tap; [TAP_MS] for [Instant]. */
    fun press(): Long = random?.let { pick(it, limits.pressMs) } ?: TAP_MS

    /** A tap on the element ([left], [top])-([right], [bottom]), with the point kept inside it. */
    fun tap(left: Int, top: Int, right: Int, bottom: Int): Tap {
        val (x, y) = within(left, top, right, bottom)
        return Tap(x, y, press(), approach())
    }

    /** A tap at a coordinate, jittered by at most [PhoneUiPaceLimits.Gesture.pointJitterPx] and never negative. */
    fun tapAt(x: Int, y: Int): Tap {
        val (jx, jy) = near(x, y)
        return Tap(jx, jy, press(), approach())
    }

    /**
     * The point a tap lands on inside the element. It is the centre plus a
     * triangular offset (dense near the centre) of at most a fifth of the span
     * and 12 px; a span narrower than 24 px is not offset at all. The result is
     * clamped into the element, so it is always a point the element owns.
     */
    fun within(left: Int, top: Int, right: Int, bottom: Int): Pair<Int, Int> {
        val cx = (left + right) shr 1
        val cy = (top + bottom) shr 1
        val r = random ?: return cx to cy
        fun reach(span: Int) =
            if (span < limits.minJitterSpanPx) 0 else minOf((span * limits.jitterFraction).toInt(), limits.maxJitterPx)
        return (cx + offset(r, reach(right - left))).coerceIn(left, maxOf(left, right - 1)) to
            (cy + offset(r, reach(bottom - top))).coerceIn(top, maxOf(top, bottom - 1))
    }

    /** The point a coordinate tap lands on: within a few pixels of the given point, never negative. */
    fun near(x: Int, y: Int): Pair<Int, Int> {
        val r = random ?: return x to y
        return (x + offset(r, limits.pointJitterPx)).coerceAtLeast(0) to
            (y + offset(r, limits.pointJitterPx)).coerceAtLeast(0)
    }

    /**
     * A one-finger swipe from ([fromX], [fromY]) to ([toX], [toY]) lasting about
     * [durationMs]. Paced, it bows slightly and eases in and out; [Instant] is
     * the old straight line with the old eight segments and the requested
     * duration exactly. [area] clamps every point, including the arc, into the
     * element or screen the swipe belongs to.
     */
    fun swipe(
        fromX: Int,
        fromY: Int,
        toX: Int,
        toY: Int,
        durationMs: Long,
        bow: Boolean = true,
        area: Area? = null,
    ): Stroke {
        val total = durationMs.coerceIn(1L, limits.maxStrokeMs)
        if (random == null) return Stroke(instantLine(fromX, fromY, toX, toY, total, limits.instantSegments, area))
        return stroke(listOf(fromX to fromY, toX to toY), total, bow, area)
    }

    /**
     * A stroke along [path] (at least two points). The endpoints never move
     * unless [area] excludes them, in which case every point is clamped into
     * it; a two-point path with [bow] curves between them, while a longer path
     * is followed as drawn. A path shorter than
     * [PhoneUiPaceLimits.Gesture.stillPx] is a hold: only the start and end are
     * emitted, and the duration may stretch but never shrink, so a long press
     * stays long.
     */
    fun stroke(
        path: List<Pair<Int, Int>>,
        durationMs: Long,
        bow: Boolean = false,
        area: Area? = null,
    ): Stroke {
        require(path.size >= 2) { "a stroke needs at least two points" }
        val total = durationMs.coerceIn(1L, limits.maxStrokeMs)
        val r = random ?: return Stroke(uniform(path, total, area))
        val start = path.first()
        val end = path.last()
        val length = lengthOf(path)
        if (length < limits.stillPx) {
            val hold = (total * (1 + jitterAbove(r, limits.holdStretch))).roundToLong()
                .coerceIn(total, limits.maxStrokeMs)
            return Stroke(
                listOf(
                    Point(clampX(start.first, area), clampY(start.second, area), 0),
                    Point(clampX(end.first, area), clampY(end.second, area), hold),
                ),
            )
        }
        val jittered = (total * (1 + jitterAround(r, limits.durationJitter))).roundToLong()
            .coerceIn(1L, limits.maxStrokeMs)
        val shape = if (bow && path.size == 2) {
            val from = start.first.toDouble() to start.second.toDouble()
            val to = end.first.toDouble() to end.second.toDouble()
            val control = controlPoint(start, end, bowOf(r, length, limits.bowFraction, limits.maxBowPx))
            (0..CURVE_SEGMENTS).map { bezier(from, control, to, it.toDouble() / CURVE_SEGMENTS) }
        } else {
            path.map { it.first.toDouble() to it.second.toDouble() }
        }
        // A short swipe releases near its average speed, so a fling still
        // travels as far as the old constant-speed stroke. A slow drag comes
        // to rest before the finger lifts, which reads as a deliberate drag.
        val endSpeed = if (jittered >= limits.dragMs) 0.0 else pickEndSpeed(r, limits.flingEndSpeed)
        val step = pick(r, limits.sampleMs).coerceAtLeast(1)
        val n = ceil(jittered.toDouble() / step).toInt().coerceIn(1, maxOf(1, limits.maxPoints - 1))
        val cum = cumulativePoints(shape)
        val points = (0..n).map { i ->
            val time = if (i == n) jittered else (jittered * i.toDouble() / n).roundToLong()
            val (x, y) = when (i) {
                0 -> start.first.toDouble() to start.second.toDouble()
                n -> end.first.toDouble() to end.second.toDouble()
                else -> at(shape, cum, cum.last() * progress(i.toDouble() / n, endSpeed))
            }
            Point(clampX(x.roundToInt(), area), clampY(y.roundToInt(), area), time)
        }
        return Stroke(points)
    }

    companion object {
        /** The press length of the old instantaneous tap. */
        const val TAP_MS = 50L

        /** No pause, no jitter, no arc. */
        val Instant = GesturePace(null)

        /** Human gestures; [random] can be a fixed seed in tests. */
        fun human(random: Random = Random.Default, limits: PhoneUiPaceLimits.Gesture = PhoneUiPaceLimits.GESTURE) =
            GesturePace(random, limits)

        /**
         * Fraction of the distance covered at time [u] (0..1): a cubic Hermite
         * that starts at rest and ends at [endSpeed] times the average speed.
         * Zero ends at rest; one releases at the average speed. The curve is
         * monotonic for the 0..1 values this file uses.
         */
        internal fun progress(u: Double, endSpeed: Double): Double {
            val u2 = u * u
            val u3 = u2 * u
            return (-2 * u3 + 3 * u2) + endSpeed * (u3 - u2)
        }

        private const val CURVE_SEGMENTS = 32

        private fun lengthOf(path: List<Pair<Int, Int>>): Double = cumulative(path).last()

        private fun cumulative(path: List<Pair<Int, Int>>): DoubleArray {
            val out = DoubleArray(path.size)
            for (i in 1 until path.size) {
                out[i] = out[i - 1] + hypot(
                    (path[i].first - path[i - 1].first).toDouble(),
                    (path[i].second - path[i - 1].second).toDouble(),
                )
            }
            return out
        }

        private fun cumulativePoints(path: List<Pair<Double, Double>>): DoubleArray {
            val out = DoubleArray(path.size)
            for (i in 1 until path.size) {
                out[i] = out[i - 1] + hypot(path[i].first - path[i - 1].first, path[i].second - path[i - 1].second)
            }
            return out
        }

        /** Where the finger is after walking [distance] along the polyline. */
        private fun at(path: List<Pair<Double, Double>>, cumulative: DoubleArray, distance: Double): Pair<Double, Double> {
            var i = 1
            while (i < path.size - 1 && cumulative[i] < distance) i++
            val segment = cumulative[i] - cumulative[i - 1]
            val f = if (segment <= 0) 1.0 else ((distance - cumulative[i - 1]) / segment).coerceIn(0.0, 1.0)
            val (x0, y0) = path[i - 1]
            val (x1, y1) = path[i]
            return x0 + (x1 - x0) * f to y0 + (y1 - y0) * f
        }

        /** The old straight-line stroke: fixed segments, linear interpolation, truncated to pixels. */
        private fun instantLine(
            fromX: Int,
            fromY: Int,
            toX: Int,
            toY: Int,
            total: Long,
            segments: Int,
            area: Area?,
        ): List<Point> {
            val n = segments.coerceAtLeast(1)
            return (0..n).map { i ->
                val f = i.toFloat() / n
                val x = (fromX + (toX - fromX) * f).toInt()
                val y = (fromY + (toY - fromY) * f).toInt()
                Point(clampX(x, area), clampY(y, area), total * i / n)
            }
        }

        /** [Instant]'s multi-point path: the given points, times spread by distance. */
        private fun uniform(path: List<Pair<Int, Int>>, total: Long, area: Area?): List<Point> {
            val distances = cumulative(path)
            val length = distances.last()
            return path.mapIndexed { i, (x, y) ->
                val time = when {
                    i == path.lastIndex -> total
                    length <= 0.0 -> 0L
                    else -> (total * distances[i] / length).roundToLong()
                }
                Point(clampX(x, area), clampY(y, area), time)
            }
        }

        /**
         * An area clamps a coordinate into itself. No area means no clamp, which
         * is what Mika's stroke does when it is given no bounds, and it keeps
         * [Instant] byte-for-byte the old stroke.
         */
        private fun clampX(x: Int, area: Area?): Int = when {
            area == null -> x
            area.right <= area.left -> area.left
            else -> x.coerceIn(area.left, area.right - 1)
        }

        private fun clampY(y: Int, area: Area?): Int = when {
            area == null -> y
            area.bottom <= area.top -> area.top
            else -> y.coerceIn(area.top, area.bottom - 1)
        }
    }
}

/**
 * The wait between actions in one app. After an action that changed the
 * screen, [noteAction] records when it finished; before the next action,
 * [waitBefore] reports how much of the dwell is still owed. Time the model
 * spends thinking or reading counts towards the dwell, so only the shortfall
 * is waited.
 *
 * - Same screen: a value from `sameScreenMs`.
 * - New screen: a value from `newScreenMs` plus reading time for the new
 *   screen's text, at most `maxReadMs`.
 * - An occasional longer pause, and one dwell never exceeds `maxDwellMs`.
 * - A careful app uses the `careful` bounds and may reach at most [screenCap]
 *   new screens per task; an outward action lifts the cap and a user reply
 *   resets the count.
 *
 * Pure: the clock is injected and nothing sleeps. [Off] never waits and never
 * caps, which is what FAST uses.
 */
internal class ActionPace(
    private val random: Random?,
    private val now: () -> Long = System::currentTimeMillis,
    val limits: PhoneUiPaceLimits.Action = PhoneUiPaceLimits.ACTION,
    val careful: PhoneUiPaceLimits.Action = PhoneUiPaceLimits.CAREFUL_ACTION,
    val screenCap: Int = PhoneUiPaceLimits.CAREFUL_SCREEN_CAP,
) {
    private class Last(
        val atMs: Long,
        val newScreen: Boolean,
        val baseMs: Long,
        val limits: PhoneUiPaceLimits.Action,
    )

    private var last: Last? = null

    /** New screens reached per careful app in this task, since the last user reply. */
    private val screens = HashMap<String, Int>()

    /** Apps that performed an outward action: their cap no longer applies, even across a user reply. */
    private val outward = HashSet<String>()

    /** Whether this pace waits at all. */
    val paced: Boolean get() = random != null

    /**
     * Record that an action that changed the screen finished now. [newScreen]
     * means the screen was replaced; [counts] says whether it counts towards a
     * careful app's cap (scrolling down the same page does not).
     */
    @Synchronized
    fun noteAction(
        app: String?,
        newScreen: Boolean,
        pace: AppPace = AppPace.NORMAL,
        counts: Boolean = newScreen,
    ) {
        val r = random ?: return
        val l = limitsFor(pace)
        var base = pick(r, if (newScreen) l.newScreenMs else l.sameScreenMs)
        if (r.nextDouble() < l.pauseChance) base += pick(r, l.pauseMs)
        last = Last(now(), newScreen, base.coerceAtMost(l.maxDwellMs), l)
        if (newScreen && counts && pace == AppPace.CAREFUL && app != null) {
            screens[app] = (screens[app] ?: 0) + 1
        }
    }

    /**
     * How much longer the next action must wait: the part of the recorded dwell
     * that has not elapsed, or 0. [textChars] is the text on the current screen;
     * it only adds reading time when the recorded action reached a new screen.
     * Never more than the dwell cap, and never negative.
     */
    @Synchronized
    fun waitBefore(textChars: Int = 0): Long {
        val l = last ?: return 0
        val read = if (l.newScreen) {
            (textChars.coerceAtLeast(0).toLong() * l.limits.readMsPerChar).coerceAtMost(l.limits.maxReadMs)
        } else {
            0L
        }
        val dwell = (l.baseMs + read).coerceAtMost(l.limits.maxDwellMs)
        return (dwell - (now() - l.atMs)).coerceIn(0L, l.limits.maxDwellMs)
    }

    /** New screens reached in [app] in this task. */
    @Synchronized
    fun screensIn(app: String): Int = screens[app] ?: 0

    /**
     * Whether [app] has used up its new-screen allowance. Only a careful app
     * with a known package can be capped; an outward action lifts the cap, and
     * [Off] never caps.
     */
    @Synchronized
    fun capReached(app: String?, pace: AppPace): Boolean =
        random != null && app != null && pace == AppPace.CAREFUL && app !in outward && screensIn(app) >= screenCap

    /** [app] performed an outward action (send, submit): no more screen cap for it. */
    @Synchronized
    fun outwardDone(app: String) {
        if (random != null) outward += app
    }

    /** The user replied (answered a question, took over): every app's screen count restarts. */
    @Synchronized
    fun userAnswered() {
        screens.clear()
    }

    private fun limitsFor(pace: AppPace) = if (pace == AppPace.CAREFUL) careful else limits

    companion object {
        /** Never waits, never caps. */
        val Off = ActionPace(null)

        /** Human dwell; [random] and [now] can be fixed in tests. */
        fun human(
            random: Random = Random.Default,
            now: () -> Long = System::currentTimeMillis,
            limits: PhoneUiPaceLimits.Action = PhoneUiPaceLimits.ACTION,
            careful: PhoneUiPaceLimits.Action = PhoneUiPaceLimits.CAREFUL_ACTION,
            screenCap: Int = PhoneUiPaceLimits.CAREFUL_SCREEN_CAP,
        ) = ActionPace(random, now, limits, careful, screenCap)
    }
}

// MARK: - Shared randomness and geometry

/** A value from [range], inclusive at both ends; a single-value range is returned without drawing. */
private fun pick(random: Random, range: LongRange): Long =
    if (range.first >= range.last) range.first else random.nextLong(range.first, range.last + 1)

/** A value from [range], inclusive at both ends; a single-value range is returned without drawing. */
private fun pick(random: Random, range: IntRange): Int =
    if (range.first >= range.last) range.first else random.nextInt(range.first, range.last + 1)

/** A symmetric offset in (-[amount], [amount]); zero when the jitter is disabled. */
private fun jitterAround(random: Random, amount: Double): Double =
    if (amount <= 0.0) 0.0 else random.nextDouble(-amount, amount)

/** An upward-only stretch in [0, [amount]); zero when the stretch is disabled. */
private fun jitterAbove(random: Random, amount: Double): Double =
    if (amount <= 0.0) 0.0 else random.nextDouble(0.0, amount)

/** A release speed in [range]; the low end when the range is degenerate. */
private fun pickEndSpeed(random: Random, range: ClosedFloatingPointRange<Double>): Double =
    if (range.start >= range.endInclusive) range.start else random.nextDouble(range.start, range.endInclusive)

/** The two uniform draws summed make a triangular distribution, so most points sit near the centre. */
private fun offset(random: Random, reach: Int): Int =
    if (reach <= 0) 0 else ((random.nextDouble() + random.nextDouble() - 1.0) * reach).roundToInt().coerceIn(-reach, reach)

/** How far the arc bows: at most [fraction] of the distance and [maxPx], either side of the line. */
private fun bowOf(random: Random, distance: Double, fraction: Double, maxPx: Double): Double =
    min(distance * fraction, maxPx) * random.nextDouble(-1.0, 1.0)

/** The quadratic control point: the midpoint pushed along the normal by [bow]. */
private fun controlPoint(
    from: Pair<Int, Int>,
    to: Pair<Int, Int>,
    bow: Double,
): Pair<Double, Double> {
    val x0 = from.first.toDouble()
    val y0 = from.second.toDouble()
    val x1 = to.first.toDouble()
    val y1 = to.second.toDouble()
    val distance = hypot(x1 - x0, y1 - y0)
    if (distance == 0.0) return (x0 + x1) / 2 to (y0 + y1) / 2
    return (x0 + x1) / 2 - (y1 - y0) / distance * bow to
        (y0 + y1) / 2 + (x1 - x0) / distance * bow
}

/** The quadratic Bezier point at [t] (0..1). */
private fun bezier(
    from: Pair<Double, Double>,
    control: Pair<Double, Double>,
    to: Pair<Double, Double>,
    t: Double,
): Pair<Double, Double> {
    val u = 1 - t
    return (u * u * from.first + 2 * u * t * control.first + t * t * to.first) to
        (u * u * from.second + 2 * u * t * control.second + t * t * to.second)
}
