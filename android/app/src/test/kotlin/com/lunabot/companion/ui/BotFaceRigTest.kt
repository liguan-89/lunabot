package com.openmausbot.companion.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/**
 * The face's schedule is a pure function of time, which is what makes it worth
 * testing at all: no frames, no composition, no flakiness.
 */
class BotFaceRigTest {
    @Test
    fun `a still face is neutral whatever the time`() {
        val pose = BotFaceRig.pose(now = 12_345L, seed = 3, mood = FaceMood.IDLE, life = FaceLife.STILL)
        assertEquals(1f, pose.openLeft)
        assertEquals(1f, pose.openRight)
        assertEquals(0f, pose.gazeX)
        assertEquals(0f, pose.gazeY)
        assertEquals(1f, pose.scale)
    }

    @Test
    fun `the same seed and time always draw the same frame`() {
        repeat(50) { index ->
            val now = index * 137L
            assertEquals(
                BotFaceRig.pose(now, seed = 11, mood = FaceMood.IDLE, life = FaceLife.ALIVE),
                BotFaceRig.pose(now, seed = 11, mood = FaceMood.IDLE, life = FaceLife.ALIVE),
            )
        }
    }

    /** A list of faces that blink on one beat is a chorus, not a crowd. */
    @Test
    fun `two seeds do not blink together`() {
        val differing = (0 until 40).count { index ->
            val now = index * 250L
            BotFaceRig.pose(now, seed = 1, mood = FaceMood.IDLE, life = FaceLife.ALIVE) !=
                BotFaceRig.pose(now, seed = 2, mood = FaceMood.IDLE, life = FaceLife.ALIVE)
        }
        assertTrue("expected different schedules, got $differing of 40 samples", differing > 30)
    }

    @Test
    fun `every full period contains a closed eye`() {
        // Ten seconds covers two periods of the slowest schedule this face uses.
        val closed = (0 until 10_000 step 10).map { millis ->
            BotFaceRig.pose(millis.toLong(), seed = 7, mood = FaceMood.IDLE, life = FaceLife.GLANCE).openLeft
        }.min()
        assertTrue("eye never closed: min openness $closed", closed < 0.2f)
    }

    @Test
    fun `the eyes never leave the face`() {
        (0 until 20_000 step 17).forEach { millis ->
            val pose = BotFaceRig.pose(millis.toLong(), seed = 5, mood = FaceMood.THINKING, life = FaceLife.ALIVE)
            assertTrue("gaze x drifted to ${pose.gazeX}", abs(pose.gazeX) < 0.12f)
            assertTrue("gaze y drifted to ${pose.gazeY}", abs(pose.gazeY) < 0.14f)
            assertTrue("scale out of range: ${pose.scale}", pose.scale in 0.95f..1.05f)
        }
    }

    /**
     * Those numbers came off the reference screenshot once; this test is what
     * stops them drifting away from it silently.
     */
    @Test
    fun `the eye geometry matches the reference portrait`() {
        assertEquals(0.342f, BotFaceGeometry.EYE_OFFSET, 0.002f)
        // Above the middle: the lower half of the disc is the chin, which is
        // what keeps the pair from reading as centred on a token.
        assertTrue("eyes should sit above the centre", BotFaceGeometry.EYE_DROP < -0.1f)
        assertEquals(-19.1f, BotFaceGeometry.FACE_TILT_DEG, 0.05f)
        // A quarter of the diameter long, an eighth wide.
        assertEquals(2f, BotFaceGeometry.EYE_LENGTH / BotFaceGeometry.EYE_WIDTH, 0.05f)
    }

    @Test
    fun `a mood changes the eyes without changing their schedule`() {
        val idle = BotFaceRig.pose(3_000, seed = 9, mood = FaceMood.IDLE, life = FaceLife.ALIVE)
        val listening = BotFaceRig.pose(3_000, seed = 9, mood = FaceMood.LISTENING, life = FaceLife.ALIVE)
        val working = BotFaceRig.pose(3_000, seed = 9, mood = FaceMood.WORKING, life = FaceLife.ALIVE)
        assertNotEquals(idle.openLeft, listening.openLeft)
        assertTrue("working should look up", working.gazeY < idle.gazeY)
    }

    /**
     * A face that only blinks is a screensaver. Between blinks it should tip
     * its head or narrow its eyes now and then.
     */
    @Test
    fun `an idle face does more than blink`() {
        val poses = (0 until 24_000 step 40).map {
            BotFaceRig.pose(it.toLong(), seed = 4, mood = FaceMood.IDLE, life = FaceLife.GLANCE)
        }
        val tipping = poses.count { kotlin.math.abs(it.roll) > 1f }
        val squinting = poses.count { it.openLeft < 0.85f && it.openLeft > 0.2f }
        assertTrue("face never tipped its head: ${poses.map { it.roll }.maxOrNull()}", tipping > 0)
        assertTrue("face never squinted", squinting > 0)
    }

    /** Working and sleepy faces already say something; gestures would contradict it. */
    @Test
    fun `gestures stay out of the way while working`() {
        (0 until 16_000 step 40).forEach {
            val pose = BotFaceRig.pose(it.toLong(), seed = 4, mood = FaceMood.WORKING, life = FaceLife.ALIVE)
            assertEquals(0f, pose.roll)
        }
    }

    /**
     * Two bots that share a palette must not share a blink — the list used to
     * seed on colour, and every black avatar closed its eyes at once.
     */
    @Test
    fun `the same palette with different bot ids keeps different schedules`() {
        val first = BotFaceRig.mix("black".hashCode() * 31 + "bot-a".hashCode())
        val second = BotFaceRig.mix("black".hashCode() * 31 + "bot-b".hashCode())
        assertNotEquals(first, second)
        val differing = (0 until 30).count { index ->
            val now = index * 200L
            BotFaceRig.pose(now, first, FaceMood.IDLE, FaceLife.GLANCE) !=
                BotFaceRig.pose(now, second, FaceMood.IDLE, FaceLife.GLANCE)
        }
        assertTrue("expected different faces, got $differing of 30 samples", differing > 20)
    }

    /** A touch asks the eyes to look at it, then the glance fades. */
    @Test
    fun `a finger to the right turns the eyes right and the glance fades`() {
        val fresh = BotFaceRig.look(
            centerX = 500f,
            centerY = 500f,
            pointerX = 900f,
            pointerY = 500f,
            ageMillis = 0,
        )
        assertTrue("eyes should move right: $fresh", fresh.first > 0.05f)
        assertEquals(0f, fresh.second, 1e-6f)

        val held = BotFaceRig.look(500f, 500f, 900f, 500f, ageMillis = 200)
        assertEquals(fresh, held)

        val fading = BotFaceRig.look(500f, 500f, 900f, 500f, ageMillis = 1_200)
        assertTrue("the glance should be smaller as it fades", fading.first < fresh.first)

        val over = BotFaceRig.look(500f, 500f, 900f, 500f, ageMillis = 1_800)
        assertEquals(0f to 0f, over)

        // A finger on the face itself has no direction to give.
        assertEquals(0f to 0f, BotFaceRig.look(500f, 500f, 502f, 500f, ageMillis = 0))

        val up = BotFaceRig.look(500f, 500f, 500f, 100f, ageMillis = 0)
        assertTrue("eyes should move up: $up", up.second < -0.05f)
    }
}
