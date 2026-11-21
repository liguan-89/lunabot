package com.lunabot.companion.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
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
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import com.lunabot.companion.storage.BotAvatarStyle
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
/** Current visual character style pack for all drawn bot portraits. */
internal val LocalBotAvatarStyle = compositionLocalOf { BotAvatarStyle.ORB }

/** Optional local file path for a user-selected custom Luna portrait photo. */
internal val LocalCustomLunaAvatarPath = compositionLocalOf<String?> { null }

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
    style: BotAvatarStyle = LocalBotAvatarStyle.current,
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
    // Legacy crowns were retired in favor of clean unified portraits across desktop and mobile.
    val showCrown = false
    val headroom = 0.dp
    val soft = remember(color, preset.key) { softBotPaletteForColor(color ?: preset.key) }
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
                soft = soft,
                style = style,
                rim = rim,
                pose = pose,
                crown = showCrown,
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
    soft: SoftBotPalette,
    style: BotAvatarStyle,
    rim: Color,
    pose: FacePose,
    crown: Boolean,
    diameter: Float,
    middle: Offset,
    hands: BotHandsPose,
    handBrush: Brush,
    handEdge: Color,
) {
    when (style) {
        BotAvatarStyle.ORB -> drawOrbFace(soft, pose, crown, diameter, middle, hands, handBrush, handEdge)
        BotAvatarStyle.NEKO -> drawNekoFace(soft, pose, crown, diameter, middle)
        BotAvatarStyle.LIQUID -> drawLiquidFace(soft, pose, crown, diameter, middle)
        BotAvatarStyle.SYNTH -> drawSynthFace(soft, pose, crown, diameter, middle)
        BotAvatarStyle.SPIRIT -> drawSpiritFace(soft, pose, crown, diameter, middle)
        BotAvatarStyle.MINIBOT -> drawMiniBotFace(soft, pose, crown, diameter, middle)
        BotAvatarStyle.CLASSIC -> drawClassicFace(soft, rim, pose, crown, diameter, middle, hands, handBrush, handEdge)
    }
}

private data class SoftBotPalette(
    val top: Color,
    val mid: Color,
    val edge: Color,
    val bounce: Color,
    val blush: Color,
    val innerEar: Color,
    val eye: Color,
    val visorGlow: Color,
    val isLight: Boolean,
)

/**
 * Harmonized 15-color ceramic palettes synced directly with desktop `PresetFace.tsx`.
 * Every accent (bounce, cheek glow, inner ear) derives from the body's own tone so switching
 * colors never leaves clashing warm-peach or cyan-pink overlays.
 */
private fun softBotPaletteForColor(color: String?): SoftBotPalette {
    val key = when (color?.lowercase()) {
        "blue" -> "blue"
        "cyan" -> "cyan"
        "orange" -> "orange"
        "yellow" -> "yellow"
        "red" -> "red"
        "coral" -> "coral"
        "green" -> "green"
        "teal" -> "teal"
        "mint" -> "mint"
        "purple", "violet" -> "purple"
        "pink" -> "pink"
        "silver" -> "silver"
        "grey", "gray" -> "grey"
        "white", "cream", "sand", "chrome" -> "white"
        else -> "black"
    }
    val (top, mid, edge, eye, warm) = when (key) {
        "white" -> SwatchSpec(Color(0xFFFFFFFF), Color(0xFFF6F3EE), Color(0xFFDDD7CE), Color(0xFF1C1C1E), true)
        "silver" -> SwatchSpec(Color(0xFFE6EBF2), Color(0xFFC1C9D4), Color(0xFF9AA4B2), Color(0xFF1C1C1E), false)
        "blue" -> SwatchSpec(Color(0xFF6FA0F5), Color(0xFF3B76E1), Color(0xFF2656B3), Color(0xFFFEFEFE), false)
        "cyan" -> SwatchSpec(Color(0xFF6DD4E6), Color(0xFF28A7BE), Color(0xFF197C90), Color(0xFFFEFEFE), false)
        "orange" -> SwatchSpec(Color(0xFFF6B47B), Color(0xFFE48A42), Color(0xFFBD6824), Color(0xFFFEFEFE), true)
        "yellow" -> SwatchSpec(Color(0xFFF7DE8C), Color(0xFFE5BE4D), Color(0xFFBE9627), Color(0xFF1C1C1E), true)
        "purple" -> SwatchSpec(Color(0xFFB594EE), Color(0xFF845ED1), Color(0xFF613EA8), Color(0xFFFEFEFE), false)
        "pink" -> SwatchSpec(Color(0xFFF39BC4), Color(0xFFDA659D), Color(0xFFB04277), Color(0xFFFEFEFE), true)
        "green" -> SwatchSpec(Color(0xFF6FD298), Color(0xFF33A867), Color(0xFF207E4A), Color(0xFFFEFEFE), false)
        "teal" -> SwatchSpec(Color(0xFF67CFC3), Color(0xFF2AA093), Color(0xFF1B776D), Color(0xFFFEFEFE), false)
        "mint" -> SwatchSpec(Color(0xFF9BE8B8), Color(0xFF63CE8E), Color(0xFF3DA368), Color(0xFF1C1C1E), false)
        "red" -> SwatchSpec(Color(0xFFEE8A86), Color(0xFFD45450), Color(0xFFA63431), Color(0xFFFEFEFE), true)
        "coral" -> SwatchSpec(Color(0xFFF4A296), Color(0xFFE16E5E), Color(0xFFB84B3D), Color(0xFFFEFEFE), true)
        "grey" -> SwatchSpec(Color(0xFFA7ABB2), Color(0xFF7C818A), Color(0xFF5A5F68), Color(0xFFFEFEFE), false)
        else -> SwatchSpec(Color(0xFF33353A), Color(0xFF141518), Color(0xFF070709), Color(0xFFFDFEFD), false)
    }
    val luminance = 0.299f * mid.red + 0.587f * mid.green + 0.114f * mid.blue
    val isLight = luminance > 0.55f
    val bounceTint = lerp(top, Color.White, 0.55f).copy(alpha = if (isLight) 0.26f else 0.16f)
    val blushTint = if (warm) {
        Color(0xFFF5A3B0).copy(alpha = if (isLight) 0.24f else 0.18f)
    } else {
        lerp(top, Color.White, 0.45f).copy(alpha = 0.16f)
    }
    val innerEarTint = if (warm) {
        Color(0xFFF2B4C2).copy(alpha = if (isLight) 0.52f else 0.36f)
    } else {
        lerp(top, Color.White, 0.55f).copy(alpha = if (isLight) 0.50f else 0.34f)
    }
    return SoftBotPalette(
        top = top,
        mid = mid,
        edge = edge,
        bounce = bounceTint,
        blush = blushTint,
        innerEar = innerEarTint,
        eye = eye,
        visorGlow = Color(0xFFF5F9FF),
        isLight = isLight,
    )
}

private data class SwatchSpec(
    val top: Color,
    val mid: Color,
    val edge: Color,
    val eye: Color,
    val warm: Boolean,
)

/** Style 1: Translucent moon-glass / porcelain orb with harmonized subsurface bounce, level sparkle eyes & tone-matched cheek glow. */
private fun DrawScope.drawOrbFace(
    soft: SoftBotPalette,
    pose: FacePose,
    crown: Boolean,
    diameter: Float,
    middle: Offset,
    hands: BotHandsPose,
    handBrush: Brush,
    handEdge: Color,
) {
    val radius = diameter / 2f
    val scaleX = pose.scale * (1f - pose.squash)
    val scaleY = pose.scale * (1f + pose.squash)
    val isLightBody = soft.isLight
    val baseTop = soft.top
    val baseMid = soft.mid
    val baseEdge = soft.edge
    val bounceGlow = soft.bounce

    // Subtle ambient contact shadow underneath so light porcelain orbs pop cleanly off ivory canvas
    drawOval(
        brush = Brush.radialGradient(
            colors = listOf(Color(0x1E000000), Color.Transparent),
            center = middle + Offset(0f, radius * 0.96f),
            radius = radius * 0.85f,
        ),
        topLeft = Offset(middle.x - radius * 0.72f, middle.y + radius * 0.78f),
        size = Size(radius * 1.44f, radius * 0.34f),
    )

    withTransform({ scale(scaleX, scaleY, pivot = middle) }) {
        val disc = Path().apply {
            addOval(Rect(middle.x - radius, middle.y - radius, middle.x + radius, middle.y + radius))
        }
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(baseTop, baseMid, baseEdge),
                center = middle + Offset(-radius * 0.28f, -radius * 0.34f),
                radius = radius * 1.46f,
            ),
            radius = radius,
            center = middle,
        )
        clipPath(disc) {
            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(bounceGlow, Color.Transparent),
                    center = middle + Offset(0f, radius * 0.76f),
                    radius = radius * 0.92f,
                ),
                radius = radius,
                center = middle,
            )
            drawOval(
                brush = Brush.radialGradient(
                    colors = listOf(Color.White.copy(alpha = if (isLightBody) 0.82f else 0.48f), Color.Transparent),
                    center = middle + Offset(-radius * 0.30f, -radius * 0.46f),
                    radius = radius * 0.56f,
                ),
                topLeft = Offset(middle.x - radius * 0.76f, middle.y - radius * 0.86f),
                size = Size(radius * 0.94f, radius * 0.70f),
            )

            val gazeX = (pose.gazeX + pose.lookX) * radius
            val gazeY = (pose.gazeY + pose.lookY) * radius
            val roll = pose.roll * (PI.toFloat() / 180f)
            val cosRoll = cos(roll)
            val sinRoll = sin(roll)

            val blushColor = soft.blush
            for (side in floatArrayOf(-1f, 1f)) {
                val bx = side * 0.50f * radius + gazeX * 0.5f
                val by = 0.14f * radius + gazeY * 0.5f
                val rx = bx * cosRoll - by * sinRoll
                val ry = bx * sinRoll + by * cosRoll
                drawCircle(
                    brush = Brush.radialGradient(
                        colors = listOf(blushColor, Color.Transparent),
                        center = middle + Offset(rx, ry),
                        radius = radius * 0.30f,
                    ),
                    radius = radius * 0.30f,
                    center = middle + Offset(rx, ry),
                )
            }

            // Level, upright glossy capsule eyes with crisp catchlights
            val eyeColor = soft.eye
            for (index in 0..1) {
                val side = if (index == 0) -1f else 1f
                val open = if (index == 0) pose.openLeft else pose.openRight
                val offsetX = side * 0.30f * radius + gazeX
                val offsetY = -0.04f * radius + gazeY
                val eyeX = offsetX * cosRoll - offsetY * sinRoll
                val eyeY = offsetX * sinRoll + offsetY * cosRoll
                val width = 0.145f * diameter
                val height = max(0.245f * diameter * open, width * 0.32f)
                val eyeCenter = middle + Offset(eyeX, eyeY)
                withTransform({
                    rotate(pose.roll, eyeCenter)
                }) {
                    drawRoundRect(
                        color = eyeColor,
                        topLeft = Offset(eyeCenter.x - width / 2f, eyeCenter.y - height / 2f),
                        size = Size(width, height),
                        cornerRadius = CornerRadius(width / 2f, width / 2f),
                    )
                    if (open > 0.36f) {
                        drawCircle(
                            color = Color.White.copy(alpha = 0.94f),
                            radius = width * 0.21f,
                            center = Offset(eyeCenter.x - width * 0.16f, eyeCenter.y - height * 0.22f),
                        )
                        drawCircle(
                            color = Color.White.copy(alpha = 0.52f),
                            radius = width * 0.10f,
                            center = Offset(eyeCenter.x + width * 0.15f, eyeCenter.y + height * 0.16f),
                        )
                    }
                }
            }
        }
        // Crisp subtle porcelain rim definition + inner white glass sheen
        drawCircle(
            color = if (isLightBody) Color(0x16000000) else Color(0x10000000),
            radius = radius,
            center = middle,
            style = Stroke(0.6.dp.toPx()),
        )
        drawCircle(
            brush = Brush.linearGradient(
                colors = listOf(Color.White.copy(alpha = 0.80f), Color.White.copy(alpha = 0.12f)),
                start = middle + Offset(-radius, -radius),
                end = middle + Offset(radius, radius),
            ),
            radius = radius - 0.8.dp.toPx(),
            center = middle,
            style = Stroke(1.dp.toPx()),
        )
        drawBotHands(hands, handEdge, handBrush, radius, middle)
        if (crown) drawSculptedCrown(pose, radius, middle)
    }
}

/** Style: Matte porcelain rounded cat avatar with blush inner ears, glossy eyes & tiny nose. */
private fun DrawScope.drawNekoFace(
    soft: SoftBotPalette,
    pose: FacePose,
    crown: Boolean,
    diameter: Float,
    middle: Offset,
) {
    val radius = diameter / 2f
    val scaleX = pose.scale * (1f - pose.squash)
    val scaleY = pose.scale * (1f + pose.squash)
    val isLightBody = soft.isLight

    drawOval(
        brush = Brush.radialGradient(
            colors = listOf(Color(0x1C000000), Color.Transparent),
            center = middle + Offset(0f, radius * 0.94f),
            radius = radius * 0.84f,
        ),
        topLeft = Offset(middle.x - radius * 0.72f, middle.y + radius * 0.76f),
        size = Size(radius * 1.44f, radius * 0.34f),
    )

    withTransform({ scale(scaleX, scaleY, pivot = middle) }) {
        val earBrush = Brush.linearGradient(
            colors = listOf(soft.top, soft.mid, soft.edge),
            start = middle + Offset(0f, -radius * 1.05f),
            end = middle + Offset(0f, -radius * 0.25f),
        )
        val innerEarColor = soft.innerEar
        for (side in floatArrayOf(-1f, 1f)) {
            val earTwitch = side * pose.roll * 0.6f
            withTransform({ rotate(earTwitch, middle + Offset(side * radius * 0.56f, -radius * 0.45f)) }) {
                val outer = Path().apply {
                    moveTo(middle.x + side * radius * 0.86f, middle.y - radius * 0.16f)
                    quadraticTo(
                        middle.x + side * radius * 0.84f, middle.y - radius * 0.96f,
                        middle.x + side * radius * 0.56f, middle.y - radius * 0.98f,
                    )
                    quadraticTo(
                        middle.x + side * radius * 0.28f, middle.y - radius * 0.96f,
                        middle.x + side * radius * 0.22f, middle.y - radius * 0.68f,
                    )
                    close()
                }
                drawPath(outer, earBrush)
                val inner = Path().apply {
                    moveTo(middle.x + side * radius * 0.73f, middle.y - radius * 0.34f)
                    quadraticTo(
                        middle.x + side * radius * 0.71f, middle.y - radius * 0.80f,
                        middle.x + side * radius * 0.55f, middle.y - radius * 0.82f,
                    )
                    quadraticTo(
                        middle.x + side * radius * 0.39f, middle.y - radius * 0.80f,
                        middle.x + side * radius * 0.35f, middle.y - radius * 0.58f,
                    )
                    close()
                }
                drawPath(inner, innerEarColor)
            }
        }

        val headRect = Rect(middle.x - radius * 0.96f, middle.y - radius * 0.82f, middle.x + radius * 0.96f, middle.y + radius * 0.94f)
        val headPath = Path().apply {
            addRoundRect(androidx.compose.ui.geometry.RoundRect(headRect, CornerRadius(radius * 0.88f, radius * 0.84f)))
        }
        drawPath(
            path = headPath,
            brush = Brush.radialGradient(
                colors = listOf(soft.top, soft.mid, soft.edge),
                center = middle + Offset(-radius * 0.24f, -radius * 0.32f),
                radius = radius * 1.45f,
            ),
        )
        clipPath(headPath) {
            val gazeX = (pose.gazeX + pose.lookX) * radius
            val gazeY = (pose.gazeY + pose.lookY) * radius
            for (side in floatArrayOf(-1f, 1f)) {
                val bc = middle + Offset(side * 0.50f * radius + gazeX * 0.45f, 0.16f * radius + gazeY * 0.45f)
                drawCircle(
                    brush = Brush.radialGradient(listOf(soft.blush, Color.Transparent), bc, radius * 0.28f),
                    radius = radius * 0.28f,
                    center = bc,
                )
            }
            for (index in 0..1) {
                val side = if (index == 0) -1f else 1f
                val open = if (index == 0) pose.openLeft else pose.openRight
                val eyeCenter = middle + Offset(side * 0.33f * radius + gazeX, -0.02f * radius + gazeY)
                val w = 0.135f * diameter
                val h = max(0.185f * diameter * open, w * 0.34f)
                drawOval(soft.eye, Offset(eyeCenter.x - w / 2f, eyeCenter.y - h / 2f), Size(w, h))
                if (open > 0.36f) {
                    drawCircle(Color.White.copy(alpha = 0.94f), w * 0.22f, Offset(eyeCenter.x - w * 0.16f, eyeCenter.y - h * 0.20f))
                }
            }
            // Tiny ceramic cat nose harmonized with the eye tone
            val noseCenter = middle + Offset(gazeX * 0.7f, 0.08f * radius + gazeY * 0.7f)
            drawOval(
                color = soft.eye.copy(alpha = 0.72f),
                topLeft = Offset(noseCenter.x - radius * 0.085f, noseCenter.y - radius * 0.048f),
                size = Size(radius * 0.17f, radius * 0.096f),
            )
        }
        drawPath(headPath, color = if (isLightBody) Color(0x14000000) else Color(0x10000000), style = Stroke(0.6.dp.toPx()))
        if (crown) drawSculptedCrown(pose, radius, middle)
    }
}

/** Style: Translucent iridescent opal liquid-glass droplet with spatial refraction & floating glossy eyes. */
private fun DrawScope.drawLiquidFace(
    soft: SoftBotPalette,
    pose: FacePose,
    crown: Boolean,
    diameter: Float,
    middle: Offset,
) {
    val radius = diameter / 2f
    val scaleX = pose.scale * (1f - pose.squash)
    val scaleY = pose.scale * (1f + pose.squash)

    drawOval(
        brush = Brush.radialGradient(
            colors = listOf(soft.edge.copy(alpha = 0.30f), Color.Transparent),
            center = middle + Offset(0f, radius * 0.95f),
            radius = radius * 0.80f,
        ),
        topLeft = Offset(middle.x - radius * 0.68f, middle.y + radius * 0.78f),
        size = Size(radius * 1.36f, radius * 0.32f),
    )

    withTransform({ scale(scaleX, scaleY, pivot = middle) }) {
        val dropPath = Path().apply {
            moveTo(middle.x, middle.y - radius * 0.98f)
            cubicTo(
                middle.x + radius * 0.50f, middle.y - radius * 0.94f,
                middle.x + radius * 0.98f, middle.y - radius * 0.18f,
                middle.x + radius * 0.94f, middle.y + radius * 0.30f,
            )
            cubicTo(
                middle.x + radius * 0.90f, middle.y + radius * 0.82f,
                middle.x + radius * 0.48f, middle.y + radius * 0.96f,
                middle.x, middle.y + radius * 0.96f,
            )
            cubicTo(
                middle.x - radius * 0.48f, middle.y + radius * 0.96f,
                middle.x - radius * 0.90f, middle.y + radius * 0.82f,
                middle.x - radius * 0.94f, middle.y + radius * 0.30f,
            )
            cubicTo(
                middle.x - radius * 0.98f, middle.y - radius * 0.18f,
                middle.x - radius * 0.50f, middle.y - radius * 0.94f,
                middle.x, middle.y - radius * 0.98f,
            )
            close()
        }
        drawPath(
            path = dropPath,
            brush = Brush.radialGradient(
                colors = listOf(soft.top, soft.mid, soft.edge),
                center = middle + Offset(-radius * 0.20f, -radius * 0.25f),
                radius = radius * 1.45f,
            ),
        )
        clipPath(dropPath) {
            // Tone-harmonized opal refraction bands
            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(lerp(soft.top, Color.White, 0.55f).copy(alpha = 0.42f), Color.Transparent),
                    center = middle + Offset(-radius * 0.34f, -radius * 0.14f),
                    radius = radius * 0.85f,
                ),
                radius = radius * 0.85f,
                center = middle + Offset(-radius * 0.34f, -radius * 0.14f),
            )
            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(lerp(soft.top, Color.White, 0.40f).copy(alpha = 0.30f), Color.Transparent),
                    center = middle + Offset(radius * 0.34f, radius * 0.32f),
                    radius = radius * 0.82f,
                ),
                radius = radius * 0.82f,
                center = middle + Offset(radius * 0.34f, radius * 0.32f),
            )
            // Glass specular arc
            drawOval(
                brush = Brush.radialGradient(
                    colors = listOf(Color.White.copy(alpha = 0.88f), Color.Transparent),
                    center = middle + Offset(-radius * 0.32f, -radius * 0.42f),
                    radius = radius * 0.50f,
                ),
                topLeft = Offset(middle.x - radius * 0.68f, middle.y - radius * 0.76f),
                size = Size(radius * 0.68f, radius * 0.56f),
            )
            val gazeX = (pose.gazeX + pose.lookX) * radius
            val gazeY = (pose.gazeY + pose.lookY) * radius
            for (index in 0..1) {
                val side = if (index == 0) -1f else 1f
                val open = if (index == 0) pose.openLeft else pose.openRight
                val eyeCenter = middle + Offset(side * 0.29f * radius + gazeX, 0.02f * radius + gazeY)
                val w = 0.135f * diameter
                val h = max(0.205f * diameter * open, w * 0.32f)
                drawOval(soft.eye, Offset(eyeCenter.x - w / 2f, eyeCenter.y - h / 2f), Size(w, h))
                if (open > 0.36f) {
                    drawCircle(Color.White.copy(alpha = 0.92f), w * 0.23f, Offset(eyeCenter.x - w * 0.16f, eyeCenter.y - h * 0.22f))
                }
            }
        }
        drawPath(dropPath, color = Color.White.copy(alpha = 0.85f), style = Stroke(1.1.dp.toPx()))
        drawPath(dropPath, color = Color(0x16000000), style = Stroke(0.5.dp.toPx()))
        if (crown) drawSculptedCrown(pose, radius, middle)
    }
}

/** Style: Dieter Rams / Teenage Engineering pocket synth cube with dot-matrix LCD & coral dial. */
private fun DrawScope.drawSynthFace(
    soft: SoftBotPalette,
    pose: FacePose,
    crown: Boolean,
    diameter: Float,
    middle: Offset,
) {
    val radius = diameter / 2f
    val scaleX = pose.scale * (1f - pose.squash)
    val scaleY = pose.scale * (1f + pose.squash)

    withTransform({ scale(scaleX, scaleY, pivot = middle) }) {
        val boxW = diameter * 0.90f
        val boxH = diameter * 0.88f
        val topLeft = Offset(middle.x - boxW / 2f, middle.y - boxH / 2f)
        val corner = CornerRadius(boxW * 0.26f, boxH * 0.26f)

        // Side coral-orange tactile dial
        drawRoundRect(
            color = Color(0xFFE67855),
            topLeft = Offset(topLeft.x + boxW - boxW * 0.05f, middle.y - boxH * 0.18f),
            size = Size(boxW * 0.11f, boxH * 0.24f),
            cornerRadius = CornerRadius(boxW * 0.05f, boxW * 0.05f),
        )
        // Matte hardware shell
        drawRoundRect(
            brush = Brush.linearGradient(listOf(soft.top, soft.mid, soft.edge), topLeft, topLeft + Offset(boxW, boxH)),
            topLeft = topLeft,
            size = Size(boxW, boxH),
            cornerRadius = corner,
        )
        drawRoundRect(
            color = Color(0x18000000),
            topLeft = topLeft,
            size = Size(boxW, boxH),
            cornerRadius = corner,
            style = Stroke(0.7.dp.toPx()),
        )
        // Recessed warm-dark LCD screen
        val lcdW = boxW * 0.72f
        val lcdH = boxH * 0.48f
        val lcdTopLeft = Offset(middle.x - lcdW / 2f, topLeft.y + boxH * 0.16f)
        drawRoundRect(
            color = Color(0xFF2B2723),
            topLeft = lcdTopLeft,
            size = Size(lcdW, lcdH),
            cornerRadius = CornerRadius(lcdW * 0.18f, lcdW * 0.18f),
        )
        val gazeX = (pose.gazeX + pose.lookX) * radius * 0.7f
        val gazeY = (pose.gazeY + pose.lookY) * radius * 0.6f
        val ledColor = Color(0xFFFFF3DC)
        for (index in 0..1) {
            val side = if (index == 0) -1f else 1f
            val open = if (index == 0) pose.openLeft else pose.openRight
            val c = Offset(lcdTopLeft.x + lcdW / 2f + side * lcdW * 0.24f + gazeX, lcdTopLeft.y + lcdH * 0.48f + gazeY)
            val w = lcdW * 0.16f
            val h = max(lcdH * 0.36f * open, w * 0.34f)
            drawRoundRect(ledColor, Offset(c.x - w / 2f, c.y - h / 2f), Size(w, h), CornerRadius(w * 0.32f, w * 0.32f))
        }

        // Tactile speaker grille dots along bottom
        val dotR = max(0.9.dp.toPx(), boxW * 0.020f)
        val grilleY1 = topLeft.y + boxH * 0.75f
        val grilleY2 = topLeft.y + boxH * 0.83f
        for (col in -3..3) {
            val gx = middle.x + col * boxW * 0.095f
            drawCircle(Color(0x523B3530), dotR, Offset(gx, grilleY1))
            drawCircle(Color(0x523B3530), dotR, Offset(gx, grilleY2))
        }
        if (crown) drawSculptedCrown(pose, radius, middle)
    }
}

/** Style 2: Plump organic moon-spirit cloud/pebble creature with ear-nubs, smile, blush & floating crescent moon. */
private fun DrawScope.drawSpiritFace(
    soft: SoftBotPalette,
    pose: FacePose,
    crown: Boolean,
    diameter: Float,
    middle: Offset,
) {
    val radius = diameter / 2f
    val scaleX = pose.scale * (1f - pose.squash)
    val scaleY = pose.scale * (1f + pose.squash)
    val bodyTop = soft.top
    val bodyMid = soft.mid
    val bodyLow = soft.edge

    withTransform({ scale(scaleX, scaleY, pivot = middle) }) {
        val earR = radius * 0.23f
        val earBrush = Brush.radialGradient(
            colors = listOf(bodyTop, bodyLow),
            center = middle + Offset(0f, -radius * 0.8f),
            radius = radius,
        )
        drawCircle(earBrush, earR, middle + Offset(-radius * 0.54f, -radius * 0.66f))
        drawCircle(earBrush, earR, middle + Offset(radius * 0.54f, -radius * 0.66f))

        val bodyPath = Path().apply {
            moveTo(middle.x, middle.y - radius * 0.86f)
            cubicTo(
                middle.x + radius * 0.66f, middle.y - radius * 0.86f,
                middle.x + radius * 1.02f, middle.y - radius * 0.16f,
                middle.x + radius * 0.96f, middle.y + radius * 0.36f,
            )
            cubicTo(
                middle.x + radius * 0.90f, middle.y + radius * 0.82f,
                middle.x + radius * 0.44f, middle.y + radius * 0.96f,
                middle.x, middle.y + radius * 0.96f,
            )
            cubicTo(
                middle.x - radius * 0.44f, middle.y + radius * 0.96f,
                middle.x - radius * 0.90f, middle.y + radius * 0.82f,
                middle.x - radius * 0.96f, middle.y + radius * 0.36f,
            )
            cubicTo(
                middle.x - radius * 1.02f, middle.y - radius * 0.16f,
                middle.x - radius * 0.66f, middle.y - radius * 0.86f,
                middle.x, middle.y - radius * 0.86f,
            )
            close()
        }
        drawPath(
            path = bodyPath,
            brush = Brush.radialGradient(
                colors = listOf(bodyTop, bodyMid, bodyLow),
                center = middle + Offset(-radius * 0.25f, -radius * 0.35f),
                radius = radius * 1.45f,
            ),
        )
        drawPath(
            path = bodyPath,
            color = Color.White.copy(alpha = 0.65f),
            style = Stroke(0.9.dp.toPx()),
        )

        val gazeX = (pose.gazeX + pose.lookX) * radius
        val gazeY = (pose.gazeY + pose.lookY) * radius
        val roll = pose.roll * (PI.toFloat() / 180f)
        val cosRoll = cos(roll)
        val sinRoll = sin(roll)

        val blush = soft.blush
        for (side in floatArrayOf(-1f, 1f)) {
            val bx = side * 0.48f * radius + gazeX * 0.45f
            val by = 0.16f * radius + gazeY * 0.45f
            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(blush, Color.Transparent),
                    center = middle + Offset(bx, by),
                    radius = radius * 0.28f,
                ),
                radius = radius * 0.28f,
                center = middle + Offset(bx, by),
            )
        }

        val eyeColor = soft.eye
        for (index in 0..1) {
            val side = if (index == 0) -1f else 1f
            val open = if (index == 0) pose.openLeft else pose.openRight
            val ox = side * 0.30f * radius + gazeX
            val oy = -0.02f * radius + gazeY
            val ex = ox * cosRoll - oy * sinRoll
            val ey = ox * sinRoll + oy * cosRoll
            val w = 0.13f * diameter
            val h = max(0.16f * diameter * open, w * 0.30f)
            val center = middle + Offset(ex, ey)
            drawOval(
                color = eyeColor,
                topLeft = Offset(center.x - w / 2f, center.y - h / 2f),
                size = Size(w, h),
            )
            if (open > 0.36f) {
                drawCircle(
                    color = Color.White,
                    radius = w * 0.24f,
                    center = Offset(center.x - w * 0.16f, center.y - h * 0.18f),
                )
            }
        }



        if (crown) drawMoonStarCrest(pose, radius, middle)
    }
}

/** Style 3: Matte ceramic rounded-squircle mini-bot with recessed glossy obsidian visor, glowing eyes & gold halo. */
private fun DrawScope.drawMiniBotFace(
    soft: SoftBotPalette,
    pose: FacePose,
    crown: Boolean,
    diameter: Float,
    middle: Offset,
) {
    val radius = diameter / 2f
    val scaleX = pose.scale * (1f - pose.squash)
    val scaleY = pose.scale * (1f + pose.squash)
    val shellTop = soft.top
    val shellBot = soft.edge
    val glowEye = soft.visorGlow

    withTransform({ scale(scaleX, scaleY, pivot = middle) }) {
        val podW = diameter * 0.96f
        val podH = diameter * 0.90f
        val podTopLeft = Offset(middle.x - podW / 2f, middle.y - podH / 2f)
        val podCorner = CornerRadius(podW * 0.38f, podH * 0.38f)

        drawRoundRect(
            brush = Brush.linearGradient(
                colors = listOf(shellTop, shellBot),
                start = podTopLeft,
                end = podTopLeft + Offset(podW, podH),
            ),
            topLeft = podTopLeft,
            size = Size(podW, podH),
            cornerRadius = podCorner,
        )
        drawRoundRect(
            color = Color.White.copy(alpha = 0.72f),
            topLeft = podTopLeft,
            size = Size(podW, podH),
            cornerRadius = podCorner,
            style = Stroke(1.dp.toPx()),
        )

        val visorW = podW * 0.74f
        val visorH = podH * 0.64f
        val visorTopLeft = Offset(middle.x - visorW / 2f, middle.y - visorH / 2f)
        val visorCorner = CornerRadius(visorW * 0.34f, visorH * 0.34f)
        drawRoundRect(
            brush = Brush.verticalGradient(
                colors = listOf(Color(0xFF23252E), Color(0xFF0E0F14)),
                startY = visorTopLeft.y,
                endY = visorTopLeft.y + visorH,
            ),
            topLeft = visorTopLeft,
            size = Size(visorW, visorH),
            cornerRadius = visorCorner,
        )
        drawRoundRect(
            brush = Brush.verticalGradient(
                colors = listOf(Color.White.copy(alpha = 0.16f), Color.Transparent),
                startY = visorTopLeft.y,
                endY = visorTopLeft.y + visorH * 0.45f,
            ),
            topLeft = visorTopLeft + Offset(visorW * 0.08f, visorH * 0.05f),
            size = Size(visorW * 0.84f, visorH * 0.38f),
            cornerRadius = CornerRadius(visorW * 0.24f, visorH * 0.24f),
        )

        val gazeX = (pose.gazeX + pose.lookX) * radius * 0.85f
        val gazeY = (pose.gazeY + pose.lookY) * radius * 0.85f
        for (index in 0..1) {
            val side = if (index == 0) -1f else 1f
            val open = if (index == 0) pose.openLeft else pose.openRight
            val eyeCenter = middle + Offset(side * visorW * 0.22f + gazeX, gazeY)
            val w = visorW * 0.16f
            val h = max(visorH * 0.34f * open, w * 0.34f)
            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(glowEye.copy(alpha = 0.36f), Color.Transparent),
                    center = eyeCenter,
                    radius = max(w, h) * 1.15f,
                ),
                radius = max(w, h) * 1.15f,
                center = eyeCenter,
            )
            drawRoundRect(
                color = glowEye,
                topLeft = Offset(eyeCenter.x - w / 2f, eyeCenter.y - h / 2f),
                size = Size(w, h),
                cornerRadius = CornerRadius(w / 2f, w / 2f),
            )
        }

        if (crown) drawGoldHalo(pose, radius, middle)
    }
}

/** Style 4: Original classic flat Grok-style portrait. */
private fun DrawScope.drawClassicFace(
    soft: SoftBotPalette,
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
    val scaleX = pose.scale * (1f - pose.squash)
    val scaleY = pose.scale * (1f + pose.squash)

    withTransform({ scale(scaleX, scaleY, pivot = middle) }) {
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(soft.top, soft.mid, soft.edge),
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

        val gazeX = pose.gazeX * radius * cosTilt - pose.gazeY * radius * sinTilt +
            pose.lookX * radius
        val gazeY = pose.gazeX * radius * sinTilt + pose.gazeY * radius * cosTilt +
            pose.lookY * radius

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
                val height = max(BotFaceGeometry.EYE_LENGTH * diameter * open, width * 0.34f)
                withTransform({
                    rotate(
                        BotFaceGeometry.FACE_TILT_DEG + BotFaceGeometry.EYE_TILT_DEG + pose.roll,
                        middle + Offset(eyeX, eyeY),
                    )
                }) {
                    drawRoundRect(
                        color = soft.eye,
                        topLeft = Offset(middle.x + eyeX - width / 2f, middle.y + eyeY - height / 2f),
                        size = Size(width, height),
                        cornerRadius = CornerRadius(width / 2f, width / 2f),
                    )
                }
            }
        }

        drawCircle(rim, radius, middle, style = Stroke(0.5.dp.toPx()))
        drawBotHands(hands, handEdge, handBrush, radius, middle)
        if (crown) drawCrown(pose, radius, middle)
    }
}

/** Smooth sculptural brushed-gold mini crown floating subtly above the Moon-Glass Orb. */
private fun DrawScope.drawSculptedCrown(pose: FacePose, radius: Float, middle: Offset) {
    val lean = 16f + pose.roll + pose.gazeX * 50f
    withTransform({ rotate(lean, middle) }) {
        val baseCenter = Offset(middle.x, middle.y - radius * 1.15f)
        val w = radius * 0.64f
        val h = radius * 0.36f
        val crownPath = Path().apply {
            moveTo(baseCenter.x - w * 0.44f, baseCenter.y + h * 0.22f)
            lineTo(baseCenter.x - w * 0.52f, baseCenter.y - h * 0.52f)
            quadraticTo(baseCenter.x - w * 0.25f, baseCenter.y - h * 0.10f, baseCenter.x, baseCenter.y - h * 0.76f)
            quadraticTo(baseCenter.x + w * 0.25f, baseCenter.y - h * 0.10f, baseCenter.x + w * 0.52f, baseCenter.y - h * 0.52f)
            lineTo(baseCenter.x + w * 0.44f, baseCenter.y + h * 0.22f)
            quadraticTo(baseCenter.x, baseCenter.y + h * 0.42f, baseCenter.x - w * 0.44f, baseCenter.y + h * 0.22f)
            close()
        }
        drawOval(
            color = Color(0xFF8A6724).copy(alpha = 0.55f),
            topLeft = Offset(baseCenter.x - w * 0.42f, baseCenter.y + h * 0.14f),
            size = Size(w * 0.84f, h * 0.26f),
        )
        drawPath(
            path = crownPath,
            brush = Brush.linearGradient(
                colors = listOf(Color(0xFFF8E0A0), Color(0xFFC89B3E), Color(0xFFE9C774)),
                start = Offset(baseCenter.x - w * 0.5f, baseCenter.y - h),
                end = Offset(baseCenter.x + w * 0.5f, baseCenter.y + h * 0.4f),
            ),
        )
        drawPath(
            path = crownPath,
            color = Color(0xFFFFF4D2).copy(alpha = 0.80f),
            style = Stroke(width = max(0.8.dp.toPx(), radius * 0.025f), join = StrokeJoin.Round),
        )
    }
}

/** Floating champagne-gold crescent moon and tiny star for the Spirit style. */
private fun DrawScope.drawMoonStarCrest(pose: FacePose, radius: Float, middle: Offset) {
    val bobY = -radius * 1.18f - pose.squash * radius * 2.5f
    val moonCenter = Offset(middle.x - radius * 0.04f, middle.y + bobY)
    val r = radius * 0.22f
    withTransform({ rotate(pose.roll * 0.6f - 10f, moonCenter) }) {
        val moonPath = Path().apply {
            addOval(Rect(moonCenter.x - r, moonCenter.y - r, moonCenter.x + r, moonCenter.y + r))
        }
        val cutPath = Path().apply {
            addOval(Rect(moonCenter.x - r * 0.42f, moonCenter.y - r * 1.08f, moonCenter.x + r * 1.32f, moonCenter.y + r * 0.66f))
        }
        val crescent = Path.combine(androidx.compose.ui.graphics.PathOperation.Difference, moonPath, cutPath)
        drawPath(
            path = crescent,
            brush = Brush.linearGradient(
                colors = listOf(Color(0xFFF6DC9B), Color(0xFFCFA34E)),
                start = moonCenter + Offset(-r, -r),
                end = moonCenter + Offset(r, r),
            ),
        )
        val starCenter = moonCenter + Offset(r * 0.62f, -r * 0.16f)
        val sr = r * 0.34f
        val star = Path().apply {
            moveTo(starCenter.x, starCenter.y - sr)
            quadraticTo(starCenter.x, starCenter.y, starCenter.x + sr, starCenter.y)
            quadraticTo(starCenter.x, starCenter.y, starCenter.x, starCenter.y + sr)
            quadraticTo(starCenter.x, starCenter.y, starCenter.x - sr, starCenter.y)
            quadraticTo(starCenter.x, starCenter.y, starCenter.x, starCenter.y - sr)
            close()
        }
        drawPath(star, Color(0xFFE7C26B))
    }
}

/** Minimalist floating brushed-gold halo ring for the Ceramic Mini-Bot style. */
private fun DrawScope.drawGoldHalo(pose: FacePose, radius: Float, middle: Offset) {
    val haloCenter = Offset(middle.x, middle.y - radius * 1.15f - pose.squash * radius * 2f)
    val rx = radius * 0.46f
    val ry = radius * 0.11f
    withTransform({ rotate(pose.roll * 0.5f, haloCenter) }) {
        drawOval(
            brush = Brush.linearGradient(
                colors = listOf(Color(0xFFF5DA97), Color(0xFFC79B44), Color(0xFFF2D48A)),
                start = Offset(haloCenter.x - rx, haloCenter.y),
                end = Offset(haloCenter.x + rx, haloCenter.y),
            ),
            topLeft = Offset(haloCenter.x - rx, haloCenter.y - ry),
            size = Size(rx * 2f, ry * 2f),
            style = Stroke(width = max(2.dp.toPx(), radius * 0.085f)),
        )
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
