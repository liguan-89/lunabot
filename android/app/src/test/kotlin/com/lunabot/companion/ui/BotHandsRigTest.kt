package com.lunabot.companion.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/**
 * The hands are driven frame by frame: a spring follows a target, the target
 * drifts with the face's breath, and the fingers curl on their own. These tests
 * sample that loop, which is the only way to check that a hand is alive rather
 * than a pose frozen at the right coordinates.
 */
class BotHandsRigTest {
    private fun simulate(
        durationMillis: Long,
        mood: FaceMood = FaceMood.IDLE,
        seed: Int = 7,
        life: FaceLife = FaceLife.ALIVE,
        roll: (Long) -> Float = { 0f },
        stepMillis: Long = 33,
        block: (now: Long, pose: BotHandsPose) -> Unit,
    ) {
        val pose = BotHandsPose()
        var t = 0L
        while (t <= durationMillis) {
            BotHandRig.pose(t, seed, mood, life, roll(t), pose)
            block(t, pose)
            t += stepMillis
        }
    }

    @Test
    fun `only the one large living portrait has hands`() {
        val still = BotHandsPose().also { BotHandRig.pose(0, 7, FaceMood.IDLE, FaceLife.STILL, 0f, it) }
        val glance = BotHandsPose().also { BotHandRig.pose(0, 7, FaceMood.IDLE, FaceLife.GLANCE, 0f, it) }
        val alive = BotHandsPose().also { BotHandRig.pose(0, 7, FaceMood.IDLE, FaceLife.ALIVE, 0f, it) }
        assertFalse(still.shown)
        assertFalse(glance.shown)
        assertTrue(alive.shown)
    }

    @Test
    fun `every mood keeps both hands on the body`() {
        for (mood in FaceMood.entries) {
            simulate(3_000, mood = mood) { _, pose ->
                for (hand in listOf(pose.left, pose.right)) {
                    assertTrue("$mood alpha is off: ${hand.alpha}", hand.alpha in 0f..1f)
                    if (hand.alpha <= 0.2f) continue
                    assertTrue("$mood x drifted to ${hand.x}", abs(hand.x) <= 1.15f)
                    assertTrue("$mood y drifted to ${hand.y}", hand.y in -0.70f..1.20f)
                    assertTrue("$mood angle is not finite", hand.angle.isFinite())
                    assertTrue("$mood scale is off: ${hand.scale}", hand.scale in 0.9f..1.2f)
                }
            }
        }
    }

    /**
     * Two palms pinned to the cheeks all day read as a sticker. An idle face
     * keeps its hands away most of the time and brings them out now and then.
     */
    @Test
    fun `an idle portrait is handless most of the time and gestures sometimes`() {
        var hidden = 0
        var oneHanded = 0
        var twoHanded = 0
        var frames = 0
        simulate(60_000, seed = 3, stepMillis = 40) { _, pose ->
            frames++
            val left = pose.left.alpha > 0.5f
            val right = pose.right.alpha > 0.5f
            when {
                !left && !right -> hidden++
                left && right -> twoHanded++
                else -> oneHanded++
            }
        }
        assertTrue("the hands never rest: $hidden of $frames", hidden > frames * 2 / 5)
        assertTrue("no one-handed gesture", oneHanded > 0)
        assertTrue("no two-handed gesture", twoHanded > 0)
    }

    /** 🤔 — the defining pose: one hand under the chin, the other stays away. */
    @Test
    fun `thinking holds one hand under the chin`() {
        simulate(1_600, mood = FaceMood.THINKING) { _, pose ->
            assertEquals("the other hand should not be out", 0f, pose.left.alpha, 0.02f)
            if (pose.right.alpha > 0.8f) {
                assertTrue("the hand is not under the chin: ${pose.right.y}", pose.right.y > 0.7f)
                assertTrue("the hand left the chin: ${pose.right.x}", abs(pose.right.x) < 0.4f)
            }
        }
    }

    /** 😴 — one cheek propped up, not two hands on the face. */
    @Test
    fun `the sleepy face props its cheek up with one hand`() {
        simulate(2_000, mood = FaceMood.DROWSY) { now, pose ->
            assertEquals(0f, pose.left.alpha, 0.02f)
            // The first frame snaps the hand to its entrance position, one
            // HAND_RISE below the pose; the spring brings it up from there.
            if (now > 800 && pose.right.alpha > 0.8f) {
                assertTrue("the hand left the cheek: ${pose.right.x}", pose.right.x in 0.2f..0.7f)
                assertTrue("the hand is not under the face: ${pose.right.y}", pose.right.y in 0.35f..0.7f)
            }
        }
    }

    /**
     * The face never holds still, and a hand that does is instantly wrong. Even
     * a hand supporting a chin has to breathe.
     */
    @Test
    fun `a held hand keeps drifting`() {
        var minX = Float.MAX_VALUE
        var maxX = -Float.MAX_VALUE
        var minAngle = Float.MAX_VALUE
        var maxAngle = -Float.MAX_VALUE
        var minCurl = Float.MAX_VALUE
        var maxCurl = -Float.MAX_VALUE
        simulate(8_000, mood = FaceMood.THINKING) { _, pose ->
            if (pose.right.alpha < 0.9f) return@simulate
            minX = minOf(minX, pose.right.x)
            maxX = maxOf(maxX, pose.right.x)
            minAngle = minOf(minAngle, pose.right.angle)
            maxAngle = maxOf(maxAngle, pose.right.angle)
            minCurl = minOf(minCurl, pose.right.curls[0])
            maxCurl = maxOf(maxCurl, pose.right.curls[0])
        }
        assertTrue("the hand is frozen in x", maxX - minX > 0.005f)
        assertTrue("the hand is frozen in angle", maxAngle - minAngle > 1.0f)
        assertTrue("the index finger does not tap", maxCurl - minCurl > 4f)
    }

    /** The head's own tilt must reach the hands, or they float in front of it. */
    @Test
    fun `a tipping head takes the hands with it`() {
        var untilted = 0f
        var tilted = 0f
        simulate(2_000, mood = FaceMood.THINKING, roll = { 6f }) { _, pose ->
            if (pose.right.alpha > 0.9f) tilted = pose.right.angle
        }
        simulate(2_000, mood = FaceMood.THINKING, roll = { 0f }) { _, pose ->
            if (pose.right.alpha > 0.9f) untilted = pose.right.angle
        }
        assertTrue(
            "hands ignored the head tilt: untilted=$untilted tilted=$tilted",
            abs(tilted - untilted) > 0.5f,
        )
    }

    @Test
    fun `working hands alternate instead of moving together`() {
        var apart = 0
        simulate(4_000, mood = FaceMood.WORKING) { _, pose ->
            if (abs(pose.left.y - pose.right.y) > 0.01f) apart++
        }
        assertTrue("hands typed in unison", apart > 20)
    }

    /**
     * The thumb and the index have to be neighbours: with the fingers laid out
     * in the other order, a hand reads as a mirror image at best. This is the
     * relationship that got swapped once, so it is pinned.
     */
    @Test
    fun `the index is the finger next to the thumb on both hands`() {
        for (left in listOf(false, true)) {
            val index = BotHandShape.baseX(0, left)
            val middle = BotHandShape.baseX(1, left)
            val ring = BotHandShape.baseX(2, left)
            val pinky = BotHandShape.baseX(3, left)
            val thumb = BotHandShape.baseX(4, left)
            assertTrue("left=$left thumb and index are on opposite sides", index * thumb > 0f)
            assertTrue("left=$left index is inboard of the middle", abs(index) > abs(middle))
            assertTrue("left=$left middle and ring share a side", middle * ring < 0f)
            assertTrue("left=$left ring and pinky share a side", ring * pinky > 0f)
            assertTrue("left=$left pinky is outboard of the ring", abs(pinky) > abs(ring))
            assertTrue("left=$left index and pinky are on opposite sides", index * pinky < 0f)
        }
    }

    /**
     * A palm facing the viewer is the same hand seen from the other side: the
     * thumb has to move to the other edge, or a waving hand shows its back.
     */
    @Test
    fun `a palm facing the viewer flips the thumb to the other edge`() {
        assertFalse("right hand from the back is unmirrored", handIsMirrored(leftHand = false, palmOut = false))
        assertTrue("right palm must be mirrored", handIsMirrored(leftHand = false, palmOut = true))
        assertTrue("left hand from the back must be mirrored", handIsMirrored(leftHand = true, palmOut = false))
        assertFalse("left palm is unmirrored", handIsMirrored(leftHand = true, palmOut = true))
    }

    @Test
    fun `palms face out to wave and in to hold a chin`() {
        simulate(1_200, mood = FaceMood.SPEAKING) { _, pose ->
            assertTrue("a speaking hand should show its palm", pose.right.palmOut)
        }
        simulate(1_200, mood = FaceMood.THINKING) { _, pose ->
            assertFalse("a chin-resting hand should show its back", pose.right.palmOut)
        }
        simulate(1_200, mood = FaceMood.DROWSY) { _, pose ->
            assertFalse("a cheek-supporting hand should show its back", pose.right.palmOut)
        }
    }

    @Test
    fun `the same seed and time draw the same hands`() {
        val first = mutableListOf<FloatArray>()
        val second = mutableListOf<FloatArray>()
        val record: (Long, BotHandsPose) -> Unit = { _, pose ->
            first += floatArrayOf(pose.left.x, pose.left.alpha, pose.right.y, pose.right.curls[0])
        }
        simulate(3_000, seed = 5, block = record)
        simulate(3_000, seed = 5) { _, pose ->
            second += floatArrayOf(pose.left.x, pose.left.alpha, pose.right.y, pose.right.curls[0])
        }
        assertEquals(first.size, second.size)
        first.indices.forEach { index ->
            assertTrue(
                "frame $index differs",
                first[index].contentEquals(second[index]),
            )
        }
    }

    /** A screen with two portraits must not have them gesturing in unison. */
    @Test
    fun `two bots do not gesture on the same beat`() {
        fun signature(seed: Int): Float {
            var sum = 0f
            simulate(45_000, seed = seed, stepMillis = 50) { _, pose ->
                sum += pose.left.x * pose.left.alpha * 3.1f +
                    pose.right.y * pose.right.alpha * 7.3f +
                    pose.right.angle * pose.right.alpha
            }
            return sum
        }
        val signatures = (1..5).map(::signature)
        assertEquals("hand schedules repeat across seeds: $signatures", 5, signatures.toSet().size)
    }
}
