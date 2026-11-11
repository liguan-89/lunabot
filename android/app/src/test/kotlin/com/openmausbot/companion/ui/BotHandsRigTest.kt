package com.openmausbot.companion.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/**
 * The hands are a pure function of time, seed and mood, like the face. These
 * tests are what keep a gesture from reaching out of the portrait or from
 * becoming a tic that never stops.
 */
class BotHandsRigTest {
    private fun poseAt(
        now: Long,
        mood: FaceMood = FaceMood.IDLE,
        life: FaceLife = FaceLife.ALIVE,
        seed: Int = 7,
    ): BotHandsPose = BotHandsPose().also { BotHandRig.pose(now, seed, mood, life, it) }

    @Test
    fun `only the one large living portrait has hands`() {
        assertFalse(poseAt(1_000, life = FaceLife.STILL).shown)
        assertFalse(poseAt(1_000, life = FaceLife.GLANCE).shown)
        assertTrue(poseAt(1_000, life = FaceLife.ALIVE).shown)
    }

    @Test
    fun `every mood keeps both hands on the body`() {
        for (mood in FaceMood.entries) {
            (0 until 30_000 step 37).forEach { millis ->
                val pose = poseAt(millis.toLong(), mood = mood)
                for (hand in listOf(pose.left, pose.right)) {
                    assertTrue("$mood x drifted to ${hand.x}", abs(hand.x) <= 1.15f)
                    assertTrue("$mood y drifted to ${hand.y}", hand.y in -0.70f..0.95f)
                    assertTrue("$mood angle is not finite", hand.angle.isFinite())
                    assertTrue("$mood scale is off: ${hand.scale}", hand.scale in 0.9f..1.2f)
                }
            }
        }
    }

    @Test
    fun `the resting hands lie against the jaw`() {
        val pose = poseAt(0)
        assertTrue("the resting hand should sit left of centre", pose.left.x < -0.4f)
        assertTrue("the other hand should sit right of centre", pose.right.x > 0.4f)
        assertEquals(BotHandRig.REST_Y, pose.left.y, 0.001f)
        assertEquals(BotHandRig.REST_Y, pose.right.y, 0.001f)
    }

    /** 🤔 — the defining pose: one hand under the chin, near the centre line. */
    @Test
    fun `a thinking hand sits under the chin`() {
        val pose = poseAt(0, mood = FaceMood.THINKING)
        assertTrue("the supporting hand is not under the chin: ${pose.right.y}", pose.right.y > 0.8f)
        assertTrue("the supporting hand left the chin: ${pose.right.x}", abs(pose.right.x) < 0.4f)
        assertEquals("the other hand should stay at rest", BotHandRig.REST_Y, pose.left.y, 0.001f)
    }

    /**
     * A face that never fidgets is a badge; one that fidgets all the time is a
     * tic. Both halves of that are asserted here, across several seeds so one
     * unlucky schedule cannot fail the run.
     */
    @Test
    fun `an idle face gestures now and then, and rests in between`() {
        val poses = (1..8).flatMap { seed ->
            (0 until 40_000 step 40).map { poseAt(it.toLong(), seed = seed) }
        }
        val lifted = poses.count { it.left.y < 0.2f || it.right.y < 0.2f }
        val resting = poses.count {
            abs(it.left.y - BotHandRig.REST_Y) < 0.02f &&
                abs(it.right.y - BotHandRig.REST_Y) < 0.02f
        }
        assertTrue("no idle gesture in eight 40-second runs", lifted > 0)
        assertTrue("the hands never rest: $resting of ${poses.size}", resting > poses.size / 5)
    }

    @Test
    fun `the sleepy face props its cheek up`() {
        (0 until 10_000 step 31).forEach { millis ->
            val pose = poseAt(millis.toLong(), mood = FaceMood.DROWSY)
            assertTrue("the supporting hand left the cheek: ${pose.right.x}", pose.right.x in 0.3f..0.6f)
            assertTrue("the supporting hand is not under the face: ${pose.right.y}", pose.right.y in 0.4f..0.62f)
        }
    }

    @Test
    fun `working hands alternate instead of moving together`() {
        val apart = (0 until 4_000 step 20).count { millis ->
            val pose = poseAt(millis.toLong(), mood = FaceMood.WORKING)
            abs(pose.left.y - pose.right.y) > 0.01f
        }
        assertTrue("hands typed in unison", apart > 20)
    }

    @Test
    fun `the same seed and time draw the same hands`() {
        repeat(40) { index ->
            val now = index * 317L
            val first = poseAt(now, seed = 5)
            val second = poseAt(now, seed = 5)
            assertEquals(first.left.x, second.left.x, 0f)
            assertEquals(first.right.y, second.right.y, 0f)
        }
    }

    /** A screen with two portraits must not have them waving in unison. */
    @Test
    fun `two bots do not wave on the same beat`() {
        val signatures = (1..6).map { seed ->
            (0 until 60_000 step 50).fold(0f) { sum, millis ->
                val pose = poseAt(millis.toLong(), seed = seed)
                sum + pose.left.x * 3.1f + pose.right.y * 7.3f + pose.right.angle
            }
        }
        assertEquals("hand schedules repeat across seeds: $signatures", 6, signatures.toSet().size)
    }

    @Test
    fun `an idle bot rests with its hands low and visible`() {
        val pose = poseAt(0)
        assertTrue("the resting hand should sit left of centre", pose.left.x < -0.4f)
        assertTrue("the other hand should sit right of centre", pose.right.x > 0.4f)
        assertEquals(BotHandRig.REST_Y, pose.left.y, 0.001f)
        assertEquals(BotHandRig.REST_Y, pose.right.y, 0.001f)
    }
}
