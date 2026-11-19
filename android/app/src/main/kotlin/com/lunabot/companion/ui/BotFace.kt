package com.lunabot.companion.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * How much of a life a face is given.
 *
 * [STILL] is a drawn still frame, for places where motion would compete with
 * what the person is reading. [GLANCE] adds the slow blink and gaze drift a
 * list row can carry. [ALIVE] adds the breath, for the one large portrait on a
 * screen.
 */
internal enum class FaceLife { STILL, GLANCE, ALIVE }

/**
 * What the face is doing, which is what its eyes are doing.
 *
 * These are not expressions in the mascot's sense — the flat portrait has no
 * mouth and cannot smile. What it has is attention, and attention is legible:
 * eyes up means thinking, eyes forward means listening, narrowed eyes mean
 * working.
 */
internal enum class FaceMood { IDLE, THINKING, WORKING, SPEAKING, LISTENING, DROWSY }

/** One frame of a face: everything that varies. */
internal data class FacePose(
    val openLeft: Float = 1f,
    val openRight: Float = 1f,
    /** Gaze offset in face units, where 1 is the circle's radius. */
    val gazeX: Float = 0f,
    val gazeY: Float = 0f,
    val scale: Float = 1f,
    /** Width against height: a breath that inflates one squashes the other. */
    val squash: Float = 0f,
    /** Degrees the whole face tips, added to its resting tilt. */
    val roll: Float = 0f,
    /**
     * Where a finger asked the eyes to look, in screen axes and face radii.
     * Added after the face's own tilt, because the finger is not tilted.
     */
    val lookX: Float = 0f,
    val lookY: Float = 0f,
)

/**
 * A little thing the face does between saccades: the head tips, the eyes
 * narrow, the gaze flits somewhere. Idle motion with only a blink in it reads
 * as a screensaver; this is what makes a face look like it is thinking about
 * something rather than waiting for input.
 */
private data class FaceGesture(
    val roll: Float = 0f,
    val squint: Float = 1f,
    val lookX: Float = 0f,
    val lookY: Float = 0f,
)

private val GESTURES = listOf(
    FaceGesture(),
    FaceGesture(),
    FaceGesture(roll = -4.5f),
    FaceGesture(roll = 4.5f),
    FaceGesture(squint = 0.74f),
    FaceGesture(squint = 1.12f),
    FaceGesture(lookX = -0.05f, lookY = -0.03f),
    FaceGesture(lookX = 0.05f, lookY = 0.02f),
    FaceGesture(roll = -3f, lookY = -0.03f),
    FaceGesture(roll = 3f, lookY = 0.03f),
)

/**
 * The geometry Grok Bot's portrait actually uses, measured off the reference
 * rather than guessed.
 *
 * The reference's two eyes are not level and are not centred: their connecting
 * line runs at about -19°, the pair sits a tenth of a radius below the circle's
 * centre, and each pill is about a quarter of the diameter long. Redrawing the
 * face is the only way to keep the blink honest, so the numbers are written
 * down here instead of being baked into eight PNGs.
 */
internal object BotFaceGeometry {
    /** Half the distance between the eyes, along the face's own tilted x axis. */
    const val EYE_OFFSET = 0.342f

    /**
     * How far the pair sits from the circle's centre, in radii.
     *
     * Negative is above the centre. The reference measures 0.100 *below*, which
     * on a phone read as cheeks; lifting the pair to just above the middle
     * leaves the lower half of the disc as a chin, which is what makes a circle
     * read as a head rather than a face pasted in the middle of a token.
     */
    const val EYE_DROP = -0.150f

    /** The tilt of the whole face, in degrees, clockwise on screen. */
    const val FACE_TILT_DEG = -19.1f

    /** Each pill's own tilt on top of the face's. */
    const val EYE_TILT_DEG = 2.4f

    /** Pill length and width, as fractions of the circle's diameter. */
    const val EYE_LENGTH = 0.245f
    const val EYE_WIDTH = 0.125f
}

/**
 * The schedule behind a face, as pure functions of [FaceClock]'s time.
 *
 * Kept out of the composable so the same numbers can be reasoned about (and
 * tested) without a frame clock.
 */
internal object BotFaceRig {
    private const val BLINK_MILLIS = 320
    private const val WINK_MILLIS = 620
    /** How long a finger's direction holds before the eyes drift back. */
    private const val LOOK_MILLIS = 1_800L
    /** The eyes arrive on the finger and stay there for this long before fading. */
    private const val LOOK_HOLD_MILLIS = 260L
    /** The farthest a glance can move an eye, in radii. */
    private const val LOOK_STRENGTH = 0.13f

    fun pose(now: Long, seed: Int, mood: FaceMood, life: FaceLife): FacePose {
        if (life == FaceLife.STILL) return FacePose()

        // Blinks cluster at the end of each period, with a jittered start so
        // two faces that share a mood still do not blink together.
        val period = when (mood) {
            FaceMood.THINKING, FaceMood.WORKING -> 5_400L
            FaceMood.LISTENING -> 6_200L
            FaceMood.DROWSY -> 9_600L
            else -> if (life == FaceLife.GLANCE) 8_400L else 4_300L
        } + (mix(seed) ushr 8) % 900
        // Each face starts its schedule at a different point in the period, so
        // the list is not one chorus of closing eyes.
        val phase = ((mix(seed + 17) ushr 8) % period).toLong()
        val t = now + phase
        val cycle = t / period
        val local = t % period

        val jitter = ((mix((seed * 31 + cycle).toInt()) ushr 8) % 800).toLong()
        val first = period - 340 - jitter
        // About one period in six carries a second blink — the double blink is
        // what stops the rhythm from reading as a metronome.
        val double = (mix((seed * 97 + cycle).toInt()) ushr 9) % 6 == 0
        val second = if (double) first + 330 else Long.MIN_VALUE

        val left = 1f - max(pulse(local - first), pulse(local - second))
        val right = 1f - max(pulse(local - first - 18), pulse(local - second - 18))

        // Gaze: a saccade every few seconds, then a small drift while it rests.
        val gazePeriod = 2_900L + (mix(seed + 5) ushr 8) % 1_700
        val gazeIndex = t / gazePeriod
        val gazeLocal = (t % gazePeriod).toFloat()
        val from = anchor(seed, (gazeIndex - 1).toInt())
        val to = anchor(seed, gazeIndex.toInt())
        val move = (gazeLocal / 95f).coerceIn(0f, 1f)
        val eased = move * move * (3f - 2f * move)
        var gazeX = from.first + (to.first - from.first) * eased + 0.005f * sin(t / 1_900f)
        var gazeY = from.second + (to.second - from.second) * eased + 0.004f * sin(t / 2_300f)

        var openLeft = left.coerceIn(0f, 1f)
        var openRight = right.coerceIn(0f, 1f)
        var roll = 0f
        // Between saccades an idle face tips and squints a little. Working,
        // listening and sleepy faces are already saying something with their
        // eyes, and a gesture on top of that would contradict it.
        if (mood == FaceMood.IDLE) {
            val gesturePeriod = 2_200L + (mix(seed + 13) ushr 8) % 1_800
            val gestureIndex = t / gesturePeriod
            val gestureLocal = (t % gesturePeriod).toFloat()
            val gesture = GESTURES[(mix((seed * 17 + gestureIndex).toInt()) ushr 9) % GESTURES.size]
            val active = when {
                gestureLocal < 260f -> gestureLocal / 260f
                gestureLocal < 640f -> 1f
                gestureLocal < 900f -> 1f - (gestureLocal - 640f) / 260f
                else -> 0f
            }
            val amount = active * active * (3f - 2f * active)
            if (amount > 0f) {
                gazeX += gesture.lookX * amount
                gazeY += gesture.lookY * amount
                roll = gesture.roll * amount
                val squint = 1f + (gesture.squint - 1f) * amount
                openLeft *= squint
                openRight *= squint
            }
        }
        // A resting sway, much slower than the gestures: even a face doing
        // nothing is holding its head up. Only an idle large portrait gets it —
        // a working face holds still, and a row of heads all swaying would pull
        // the eye off the names.
        if (life == FaceLife.ALIVE && mood == FaceMood.IDLE) roll += 0.8f * sin(t / 7_300f)

        // A single-eye wink now and then: the cheapest way for a flat face to
        // look like it has a sense of humour. Rare enough not to become a tic.
        if (life != FaceLife.STILL && mood == FaceMood.IDLE) {
            val winkPeriod = 13_000L + (mix(seed + 71) ushr 8) % 9_000
            val closed = winkPulse(t % winkPeriod)
            if (closed > 0f) openRight *= 1f - 0.88f * closed
        }
        when (mood) {
            // Eyes up and slightly narrowed: the look of working something out.
            FaceMood.THINKING -> {
                gazeY -= 0.050f
                gazeX += 0.010f * sin(t / 700f)
                openLeft *= 0.88f
                openRight *= 0.92f
            }
            FaceMood.WORKING -> {
                gazeY -= 0.035f
                openLeft *= 0.92f
                openRight *= 0.94f
            }
            FaceMood.SPEAKING -> {
                gazeX *= 0.5f
                gazeY -= 0.010f
            }
            FaceMood.LISTENING -> {
                gazeX *= 0.35f
                gazeY *= 0.35f
                openLeft *= 1.08f
                openRight *= 1.08f
            }
            FaceMood.DROWSY -> {
                gazeY += 0.045f
                // A head that is falling asleep nods on a slow cycle; the eyes
                // stay half-lidded over it.
                roll += 2.2f * sin(t / 4_100f)
                val lid = 0.55f + 0.30f * (0.5f + 0.5f * sin(t / 2_600f))
                openLeft *= lid
                openRight *= lid
            }
            FaceMood.IDLE -> Unit
        }

        // The breath: the disc grows a little while narrowing a little, which
        // is what makes it read as breathing rather than pulsing.
        val breath = if (life == FaceLife.ALIVE) sin(t / 3_400f) else 0f
        // A sleeping body breathes deeper and slower than a waking one.
        val depth = if (mood == FaceMood.DROWSY) 1.5f else 1f
        return FacePose(
            openLeft = openLeft.coerceAtLeast(0.04f),
            openRight = openRight.coerceAtLeast(0.04f),
            gazeX = gazeX,
            gazeY = gazeY,
            scale = 1f + 0.012f * depth * breath,
            squash = 0.009f * depth * sin(t / 3_400f - 0.7f),
            roll = roll,
        )
    }

    /**
     * How shut one eye is during a wink, [since] milliseconds into it.
     *
     * Quicker than a blink and held a moment longer: a wink is a deliberate
     * gesture, not a lid falling.
     */
    fun winkPulse(since: Long): Float = when {
        since < 0 || since > WINK_MILLIS -> 0f
        since < 70 -> since / 70f
        since < 230 -> 1f
        else -> {
            val u = (since - 230) / (WINK_MILLIS - 230f)
            1f - u * u * (3f - 2f * u)
        }
    }

    /**
     * Where a finger asks the eyes to look.
     *
     * The direction is a unit vector from the face's own centre to the touch,
     * kept inside the disc and faded over [LOOK_MILLIS]: the eyes arrive on the
     * finger at once and drift back, which is how a glance works. A touch
     * almost on top of the face has no meaningful direction, so its strength
     * fades in with distance instead of jittering.
     */
    fun look(
        centerX: Float,
        centerY: Float,
        pointerX: Float,
        pointerY: Float,
        ageMillis: Long,
    ): Pair<Float, Float> {
        if (ageMillis < 0 || ageMillis > LOOK_MILLIS) return 0f to 0f
        val dx = pointerX - centerX
        val dy = pointerY - centerY
        val distance = sqrt(dx * dx + dy * dy)
        // A finger almost on top of the face has no direction worth following.
        if (distance < 24f) return 0f to 0f
        // Arrive at once, hold for a moment, then drift home. The hold is what
        // makes the glance legible on a screenshot and in the corner of an eye.
        val weight = if (ageMillis <= LOOK_HOLD_MILLIS) {
            1f
        } else {
            val left = (LOOK_MILLIS - ageMillis).toFloat() /
                (LOOK_MILLIS - LOOK_HOLD_MILLIS).toFloat()
            left * left
        }
        val reach = (distance / 160f).coerceAtMost(1f)
        val amount = LOOK_STRENGTH * weight * reach
        return dx / distance * amount to dy / distance * amount
    }

    /** How closed one blink is at [since] milliseconds after it started. */
    fun pulse(since: Long): Float = when {
        since < 0 || since > BLINK_MILLIS -> 0f
        // Close fast, hold, open slowly: the lids fall under their own weight.
        since < 80 -> since / 80f
        since < 110 -> 1f
        else -> {
            val u = (since - 110) / (BLINK_MILLIS - 110f)
            1f - u * u * (3f - 2f * u)
        }
    }

    /** Where the gaze rests between saccades: mostly on the person looking at it. */
    private fun anchor(seed: Int, index: Int): Pair<Float, Float> =
        when (((mix(seed * 131 + index) ushr 10) and 7)) {
            0, 1, 2 -> 0f to 0f
            3 -> -0.045f to 0.010f
            4 -> 0.050f to 0.015f
            5 -> -0.030f to -0.025f
            6 -> 0.035f to -0.020f
            else -> 0.010f to 0.035f
        }

    /** A cheap integer hash: the same seed must schedule the same face. */
    fun mix(value: Int): Int {
        var h = value
        h = h xor (h ushr 16)
        h *= 0x7feb352d
        h = h xor (h ushr 15)
        h *= 0x846ca68b.toInt()
        h = h xor (h ushr 16)
        return h
    }
}

/**
 * The Grok-style portrait, drawn rather than painted.
 *
 * A bitmap cannot blink: the eyes are pixels, and scaling the whole disc to
 * suggest one only shakes the picture. So the face is a circle and two pills,
 * recomputed every frame, which is what makes the reference's flat portrait
 * read as alive without adding a single asset.
 *
 * The draw lambda reads the clock itself, so a tick repaints this canvas and
 * nothing else — no recomposition, no layout, no state per face.
 */
@Composable
internal fun BotFace(
    color: String?,
    size: Dp,
    life: FaceLife,
    modifier: Modifier = Modifier,
    mood: FaceMood = FaceMood.IDLE,
    contentDescription: String? = null,
    /**
     * Whether this face may doze off on a screen nobody has touched. Only the
     * one large portrait opts in: a face in a list that falls asleep reads as
     * a broken avatar, and a face inside a dialog never hears the touches
     * happening in the dialog's own window.
     */
    drowsy: Boolean = false,
    /**
     * What makes this face's schedule its own. Two faces that share a seed
     * blink together, so this must be something that differs between bots —
     * their id, not their colour. Seeding on the palette is what made a list
     * of black avatars blink in unison.
     */
    seed: Int = 0,
    /**
     * Whether this face wears the commander's crown.
     *
     * Drawn by the rig rather than placed over it as an image, because a hat
     * that does not move with the head reads as a sticker on the screen. Here
     * it breathes with the portrait and tips with its gestures, which is what
     * makes it look worn.
     */
    crown: Boolean = false,
) {
    val preset = remember(color) { PresetAvatars.forColor(color) }
    val faceSeed = remember(preset.key, seed) {
        BotFaceRig.mix(preset.key.hashCode() * 31 + seed)
    }
    // Hands belong to the one large portrait; a rig buffer and its one brush
    // live as long as the face, so a frame allocates neither.
    val hands = remember { BotHandsPose() }
    val handBrush = remember(preset) { botHandBrush(preset) }
    val handEdge = remember(preset) { botHandEdge(preset) }
    // A still face never asks for the clock, because a still face is not on
    // screen for its motion — it is there to be looked at.
    val time = if (life == FaceLife.STILL) null else rememberFaceTime()
    val clock = rememberFaceClock()

    // Sleeping is a slow state, so it is polled slowly rather than read every
    // frame. The value is read inside the draw lambda, which is what keeps a
    // face dozing off from recomposing anything.
    val asleep = remember { mutableStateOf(false) }
    LaunchedEffect(clock, drowsy, mood) {
        asleep.value = false
        if (!drowsy || clock == null) return@LaunchedEffect
        while (true) {
            asleep.value = mood == FaceMood.IDLE && clock.idleMillis() > DROWSY_AFTER_MILLIS
            delay(DROWSY_POLL_MILLIS)
        }
    }

    val named = if (contentDescription == null) {
        modifier
    } else {
        modifier.semantics { this.contentDescription = contentDescription }
    }
    // The rim is read here because the draw lambda is not composable, and the
    // circle is drawn rather than filled by a background: with a crown on, the
    // portrait may draw a little outside its own square, so the node cannot
    // clip to a circle and cannot paint a rectangle behind the face.
    val rim = minisSeparator
    // A crown rests on the silhouette, which means it lives above the circle —
    // and a Canvas cannot paint past its own node. Wearing one buys the room
    // for it, pushing the head down inside a slightly taller box.
    val headroom = if (crown) size * CROWN_HEADROOM else 0.dp
    // Where the disc is on screen, so a touch elsewhere can be turned into a
    // direction. Null until the first layout pass.
    val density = LocalDensity.current
    var faceCentre by remember { mutableStateOf<Offset?>(null) }
    Box(
        modifier = named
            .size(width = size, height = size + headroom)
            .onGloballyPositioned { coordinates ->
                val bounds = coordinates.boundsInWindow()
                val head = with(density) { headroom.toPx() }
                faceCentre = Offset(
                    x = bounds.center.x,
                    y = bounds.top + (bounds.height + head) / 2f,
                )
            },
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val now = time?.value
            // Read inside the draw: a finger arriving repaints the face without
            // recomposing it, the same way the clock does.
            val finger = clock?.lastPointer?.value
            val centre = faceCentre
            val look = if (now != null && finger != null && centre != null && life == FaceLife.ALIVE) {
                BotFaceRig.look(centre.x, centre.y, finger.x, finger.y, now - finger.at)
            } else {
                0f to 0f
            }
            val pose = if (now == null) {
                FacePose()
            } else {
                val effective = if (asleep.value) FaceMood.DROWSY else mood
                BotFaceRig.pose(now, faceSeed, effective, life)
                    .copy(lookX = look.first, lookY = look.second)
            }
            // The hands read the same mood and the same clock as the eyes:
            // sleepy eyes come with a hand under the cheek, a working face
            // with both hands in front.
            if (now == null) {
                hands.start(false)
            } else {
                val effective = if (asleep.value) FaceMood.DROWSY else mood
                // The head's tilt goes with the hands: they lean after it with
                // the spring's lag, so they belong to the same head.
                BotHandRig.pose(now, faceSeed, effective, life, pose.roll, hands)
            }
            val top = headroom.toPx()
            drawFace(
                palette = preset,
                rim = rim,
                pose = pose,
                crown = crown,
                diameter = this.size.height - top,
                middle = Offset(this.size.width / 2f, top + (this.size.height - top) / 2f),
                hands = hands,
                handBrush = handBrush,
                handEdge = handEdge,
            )
        }
    }
}

/** How much taller than the portrait the crowned box is, as a fraction. */
private const val CROWN_HEADROOM = 0.28f

/**
 * The crown on its own, for a portrait that is a photograph.
 *
 * An uploaded picture cannot wear the crown in-rig — the face it would ride on
 * is a bitmap, not the drawn one — so this draws the same crown above it, on
 * the same clock. The picture breathes through [portraitMotion]; the crown
 * breathes through the same pose, at a similar amplitude, and a bot without a
 * drawn face keeps its rank.
 */
@Composable
internal fun CrownLayer(portrait: Dp, seed: Int, modifier: Modifier = Modifier) {
    val time = rememberFaceTime()
    val headroom = portrait * CROWN_HEADROOM
    Canvas(modifier.size(width = portrait, height = portrait + headroom)) {
        val top = headroom.toPx()
        val diameter = size.height - top
        val pose = time?.value?.let {
            BotFaceRig.pose(it, seed, FaceMood.IDLE, FaceLife.ALIVE)
        } ?: FacePose()
        drawCrown(pose, diameter / 2f * pose.scale, Offset(size.width / 2f, top + diameter / 2f))
    }
}

/** Long enough to read a screen without touching it, short enough to be noticed. */
private const val DROWSY_AFTER_MILLIS = 45_000L
private const val DROWSY_POLL_MILLIS = 5_000L

private fun DrawScope.drawFace(
    palette: PresetAvatar,
    rim: Color,
    pose: FacePose,
    crown: Boolean,
    diameter: Float,
    middle: Offset,
    hands: BotHandsPose,
    handBrush: Brush,
    handEdge: Color,
) {
    val radius = diameter / 2f
    // The breath squashes as it stretches: the disc is a soft body, not a
    // balloon, so it never grows in both directions at once.
    val scaleX = pose.scale * (1f - pose.squash)
    val scaleY = pose.scale * (1f + pose.squash)

    withTransform({ scale(scaleX, scaleY, pivot = middle) }) {
        // A light from the upper left, so the flat disc has a near side and a
        // far side instead of reading as a sticker cut out of one colour.
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(
                    lerp(palette.body, Color.White, 0.13f),
                    palette.body,
                    lerp(palette.body, Color.Black, 0.15f),
                ),
                center = middle + Offset(-radius * 0.38f, -radius * 0.42f),
                radius = radius * 1.55f,
            ),
            radius = radius,
            center = middle,
        )
        val disc = Path().apply {
            addOval(Rect(middle.x - radius, middle.y - radius, middle.x + radius, middle.y + radius))
        }

        val tilt = BotFaceGeometry.FACE_TILT_DEG * (PI.toFloat() / 180f)
        val cosTilt = cos(tilt)
        val sinTilt = sin(tilt)

        // The gaze moves along the face's own tilted axes, not the screen's.
        // A finger's look is in screen axes, so it is added after the tilt.
        val gazeX = pose.gazeX * radius * cosTilt - pose.gazeY * radius * sinTilt +
            pose.lookX * radius
        val gazeY = pose.gazeX * radius * sinTilt + pose.gazeY * radius * cosTilt +
            pose.lookY * radius

        // A gesture tips the whole face, so the pair swings around the circle's
        // centre rather than each eye turning in place.
        val roll = pose.roll * (PI.toFloat() / 180f)
        val cosRoll = cos(roll)
        val sinRoll = sin(roll)

        clipPath(disc) {
            for (index in 0..1) {
                val side = if (index == 0) -1f else 1f
                val open = if (index == 0) pose.openLeft else pose.openRight
                val offsetX = side * BotFaceGeometry.EYE_OFFSET * radius * cosTilt + gazeX
                val offsetY = BotFaceGeometry.EYE_DROP * radius + side * BotFaceGeometry.EYE_OFFSET * radius * sinTilt + gazeY
                val eyeX = offsetX * cosRoll - offsetY * sinRoll
                val eyeY = offsetX * sinRoll + offsetY * cosRoll
                val width = BotFaceGeometry.EYE_WIDTH * diameter
                // A closed eye is a slit, not nothing: the reference's pills have a
                // visible lid line, and a hole in the face would read as a glitch.
                val height = max(BotFaceGeometry.EYE_LENGTH * diameter * open, width * 0.34f)
                withTransform({
                    rotate(
                        BotFaceGeometry.FACE_TILT_DEG + BotFaceGeometry.EYE_TILT_DEG + pose.roll,
                        middle + Offset(eyeX, eyeY),
                    )
                }) {
                    drawRoundRect(
                        color = palette.eye,
                        topLeft = Offset(middle.x + eyeX - width / 2f, middle.y + eyeY - height / 2f),
                        size = Size(width, height),
                        cornerRadius = CornerRadius(width / 2f, width / 2f),
                    )
                }
            }
        }

        drawCircle(rim, radius, middle, style = Stroke(0.5.dp.toPx()))
        // The hands sit in front of the body, over the rim: a limb held across
        // the belly, not a sticker behind the portrait.
        drawBotHands(hands, handEdge, handBrush, radius, middle)
        if (crown) drawCrown(pose, radius, middle)
    }
}

/**
 * The commander's crown, resting on the head.
 *
 * The band is an arc of the portrait's own circle, drawn just outside its
 * radius: a crown sits *on* the skull's curve, not sunk into the face, so the
 * band's inner edge is the silhouette line itself. It takes the same [FacePose]
 * as the face, so it breathes with the portrait, leans with its gestures — and,
 * because a hat follows the eyes, tips toward wherever the bot is looking.
 */
private fun DrawScope.drawCrown(pose: FacePose, radius: Float, middle: Offset) {
    // Worn askew, the way the face is: the eyes are tilted off vertical, and a
    // crown sitting dead centre on a tilted face looks like it belongs to a
    // different object. It then leans further toward whatever the eyes are
    // looking at, which is most of what sells "worn".
    val lean = BotFaceGeometry.FACE_TILT_DEG + pose.roll + pose.gazeX * CROWN_GAZE_LEAN
    withTransform({ rotate(lean, middle) }) {
        fun at(degrees: Float, factor: Float): Offset {
            val angle = degrees * (PI.toFloat() / 180f)
            return Offset(
                x = middle.x + radius * factor * sin(angle),
                y = middle.y - radius * factor * cos(angle),
            )
        }

        // The points first, so the band covers where they meet the head.
        CROWN_PEAKS.forEachIndexed { index, angle ->
            val tip = at(angle, CROWN_APEX[index])
            val left = at(angle - CROWN_PEAK_HALF, CROWN_OUTER)
            val right = at(angle + CROWN_PEAK_HALF, CROWN_OUTER)
            val peak = Path().apply {
                moveTo(left.x, left.y)
                lineTo(tip.x, tip.y)
                lineTo(right.x, right.y)
                close()
            }
            drawPath(peak, CrownInk)
            drawPath(peak, CrownGold, style = Stroke(0.03f * radius, join = StrokeJoin.Round))
            drawCircle(CrownGoldLight, 0.045f * radius, tip)
        }

        // The band: an annular sector of the head's own circle.
        val band = Path()
        val steps = 14
        for (index in 0..steps) {
            val p = at(-CROWN_SPAN + 2f * CROWN_SPAN * index / steps, CROWN_OUTER)
            if (index == 0) band.moveTo(p.x, p.y) else band.lineTo(p.x, p.y)
        }
        for (index in steps downTo 0) {
            val p = at(-CROWN_SPAN + 2f * CROWN_SPAN * index / steps, CROWN_INNER)
            band.lineTo(p.x, p.y)
        }
        band.close()
        drawPath(band, CrownGold)
        for (index in 0 until steps) {
            drawLine(
                color = CrownGoldLight,
                start = at(-CROWN_SPAN + 2f * CROWN_SPAN * index / steps, CROWN_OUTER),
                end = at(-CROWN_SPAN + 2f * CROWN_SPAN * (index + 1) / steps, CROWN_OUTER),
                strokeWidth = 0.026f * radius,
            )
        }
        for (angle in CROWN_STONES) {
            drawCircle(CrownInk, 0.036f * radius, at(angle, CROWN_STONE_RADIUS))
        }
    }
}

/** All as fractions of the portrait's radius. */
private const val CROWN_SPAN = 28f
/** The band's inner edge sits on the silhouette, not inside it. */
private const val CROWN_INNER = 0.99f
private const val CROWN_OUTER = 1.11f
private const val CROWN_PEAK_HALF = 7f
private const val CROWN_STONE_RADIUS = 1.05f

/** Degrees of lean per unit of gaze, so the crown follows the eyes. */
private const val CROWN_GAZE_LEAN = 90f

/** The three points, in degrees either side of the top. */
private val CROWN_PEAKS = floatArrayOf(-18f, 0f, 18f)

/** How far each point rises, in radii from the centre. */
private val CROWN_APEX = floatArrayOf(1.34f, 1.45f, 1.34f)

/** The stones across the band, in degrees. */
private val CROWN_STONES = floatArrayOf(-12f, 0f, 12f)

private val CrownInk = Color(0xFF17171B)
private val CrownGold = Color(0xFFC9A227)
private val CrownGoldLight = Color(0xFFECC564)
