package com.openmausbot.companion.ui

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.unit.dp
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.max
import kotlin.math.sin

/**
 * The portrait's hands — fingers that answer the face, on the face's clock.
 *
 * A circle with two eyes can blink and look around, but it has no hands to say
 * what the eyes are feeling. These do: a hand under the chin while the bot
 * thinks, one holding up a sleepy cheek, a palm up in a shrug, a hand waving.
 * No arms: the hand is placed against the silhouette and read as coming from
 * behind it, the way the emoji the face is imitating do it.
 *
 * The hands are not a permanent body part. A face with two palms pinned to its
 * cheeks all day reads as a sticker; an idle portrait keeps its hands away and
 * brings one — sometimes both — out for a few seconds when it has something to
 * say, then lets them sink out of sight. Only the sustained moods (thinking,
 * listening, speaking, dozing) hold a hand up for as long as they last.
 *
 * Every value here is *spring-driven*, because the face is not a slideshow
 * either: a hand arrives with a little overshoot, keeps drifting with its own
 * breath, leans after the head when the head tips, and its fingers curl and
 * uncurl as it goes. Whole-hand motion without finger motion reads as a
 * cut-out being slid around the portrait; the spring and the curl are what make
 * it look attached to something alive.
 *
 * Every hand is positioned in the portrait's own units: one unit is the disc's
 * radius, (0, 0) is its centre, and positive x is the viewer's right. That is
 * the same space [BotFaceRig] uses for the eyes, so a hand on the chin is on
 * the chin and not a few pixels below it.
 *
 * Hands only exist on a [FaceLife.ALIVE] face — the one large portrait on a
 * screen. At 24 dp in a chat header a 20 dp hand would be a smudge, and a list
 * of waving faces is a crowd, not a roster.
 */
internal class BotHand {
    /** The displayed pose, which is what the canvas draws. */
    var x: Float = 0f
    var y: Float = 0f
    var angle: Float = 0f
    var scale: Float = 1f
    var alpha: Float = 0f

    /**
     * Whether the palm faces the viewer rather than the face.
     *
     * A flat hand is the same blob either way; what changes is which side the
     * thumb is on. Waving or shrugging shows the palm, holding a chin shows the
     * back — and the thumb has to be on the correct side for the hand to read
     * as an anatomically right or left hand rather than a mirrored sticker.
     */
    var palmOut: Boolean = false

    /** Per-finger bend in degrees, positive clockwise, in the right hand's terms. */
    val curls: FloatArray = FloatArray(CURLS)

    internal var targetX: Float = 0f
    internal var targetY: Float = 0f
    internal var targetAngle: Float = 0f
    internal var targetScale: Float = 1f
    internal var targetAlpha: Float = 0f
    internal val targetCurls: FloatArray = FloatArray(CURLS)

    private var velocityX = 0f
    private var velocityY = 0f
    private var velocityAngle = 0f
    private var velocityScale = 0f

    /** Aim at a pose. [visible] is the target alpha; 1 means fully out. */
    internal fun aim(
        x: Float,
        y: Float,
        angle: Float,
        scale: Float = 1f,
        visible: Boolean = true,
        palmOut: Boolean = false,
    ) {
        targetX = x
        targetY = y + HAND_RISE * (1f - alpha)
        targetAngle = angle
        targetScale = scale
        targetAlpha = if (visible) 1f else 0f
        this.palmOut = palmOut
    }

    internal fun aimHidden() {
        // Hidden in place, not dragged to the origin: the fade should look like
        // the hand letting go, not like it being sucked into the face.
        targetX = x
        targetY = y
        targetAngle = angle
        targetScale = scale
        targetAlpha = 0f
        clearCurls()
    }

    /** A finger's target bend, 0..4 being index, middle, ring, pinky, thumb. */
    internal fun aimCurl(finger: Int, degrees: Float) {
        if (finger in 0 until CURLS) targetCurls[finger] = degrees
    }

    internal fun clearCurls() {
        targetCurls.fill(0f)
    }

    /** Jump straight to the targets — the first frame of a face, not a gesture. */
    internal fun snap() {
        x = targetX
        y = targetY
        angle = targetAngle
        scale = targetScale
        alpha = targetAlpha
        targetCurls.copyInto(curls)
        velocityX = 0f
        velocityY = 0f
        velocityAngle = 0f
        velocityScale = 0f
    }

    internal fun step(dt: Float) {
        // A spring, not a lerp: the hand arrives a little late and settles with
        // one small overshoot, which is what makes it look heavy.
        velocityX += (POSITION_STIFFNESS * (targetX - x) - POSITION_DAMPING * velocityX) * dt
        velocityY += (POSITION_STIFFNESS * (targetY - y) - POSITION_DAMPING * velocityY) * dt
        x += velocityX * dt
        y += velocityY * dt

        velocityAngle += (ANGLE_STIFFNESS * (targetAngle - angle) - ANGLE_DAMPING * velocityAngle) * dt
        angle += velocityAngle * dt

        velocityScale += (ANGLE_STIFFNESS * (targetScale - scale) - ANGLE_DAMPING * velocityScale) * dt
        scale += velocityScale * dt

        // Visibility and fingers are eased rather than sprung: a fade overshoot
        // would read as a flicker, and fingers settling through a spring would
        // carry too much inertia to follow the face.
        val alphaRate = minOf(1f, dt * ALPHA_RATE)
        alpha += (targetAlpha - alpha) * alphaRate
        val curlRate = minOf(1f, dt * CURL_RATE)
        for (index in 0 until CURLS) {
            curls[index] += (targetCurls[index] - curls[index]) * curlRate
        }

        if (!x.isFinite() || !y.isFinite() || !angle.isFinite() || !scale.isFinite()) {
            snap()
        }
    }

    internal fun reset() {
        x = 0f
        y = 0f
        angle = 0f
        scale = 1f
        alpha = 0f
        palmOut = false
        curls.fill(0f)
        targetCurls.fill(0f)
        velocityX = 0f
        velocityY = 0f
        velocityAngle = 0f
        velocityScale = 0f
    }

    companion object {
        const val CURLS = 5
    }
}

/** Both hands of one frame, plus the clock the springs need. */
internal class BotHandsPose {
    var shown: Boolean = false
        private set

    val left: BotHand = BotHand()
    val right: BotHand = BotHand()

    private var lastMillis: Long = UNSET

    fun start(shown: Boolean) {
        this.shown = shown
        if (!shown) {
            left.reset()
            right.reset()
            lastMillis = UNSET
        }
    }

    /**
     * How long since the previous frame, in seconds, or null on the first frame
     * (when the hands should snap rather than crawl in from the origin).
     */
    fun tick(now: Long): Float? {
        if (lastMillis == UNSET) {
            lastMillis = now
            return null
        }
        val dt = ((now - lastMillis) / 1000f).coerceIn(0f, 0.1f)
        lastMillis = now
        return dt
    }

    fun step(dt: Float) {
        left.step(dt)
        right.step(dt)
    }

    fun snap() {
        left.snap()
        right.snap()
    }

    private companion object {
        const val UNSET = Long.MIN_VALUE
    }
}

internal object BotHandRig {
    private const val TWO_PI = 2f * PI.toFloat()

    /**
     * What the hands are doing at [now]. [out] is the caller's buffer; the face
     * redraws every frame and should not allocate two hands per tick.
     *
     * [rollDegrees] is the head's own tilt this frame; the hands lean after it
     * with the spring's lag, which is what keeps them reading as part of the
     * same head instead of two objects in front of it.
     */
    fun pose(
        now: Long,
        seed: Int,
        mood: FaceMood,
        life: FaceLife,
        rollDegrees: Float,
        out: BotHandsPose,
    ) {
        out.start(life == FaceLife.ALIVE)
        if (!out.shown) return
        val dt = out.tick(now)

        // A frame starts with no hand asked for; whichever mood or gesture
        // wants one aims it below. When a gesture ends, this is what lets the
        // hand go instead of leaving it frozen at its last pose.
        out.left.aimHidden()
        out.right.aimHidden()

        when (mood) {
            FaceMood.IDLE -> idle(now, seed, out)
            FaceMood.THINKING -> {
                val tap = 0.5f + 0.5f * sin(now / 1000f * TWO_PI * 1.15f)
                out.right.aim(0.18f, 0.84f - 0.018f * tap, -28f)
                out.right.aimCurl(0, 12f * tap)
                out.right.aimCurl(1, -3f)
                out.right.aimCurl(2, 2f)
                out.right.aimCurl(3, 4f)
                out.left.aimHidden()
            }
            FaceMood.WORKING -> {
                val beat = sin(now / 1000f * TWO_PI * 3.1f)
                out.left.aim(-0.55f, 0.72f - 0.03f * max(0f, beat), 10f)
                out.right.aim(0.55f, 0.72f - 0.03f * max(0f, -beat), -10f)
                out.left.aimCurl(0, -8f * max(0f, beat))
                out.left.aimCurl(1, -4f * max(0f, beat))
                out.right.aimCurl(0, -8f * max(0f, -beat))
                out.right.aimCurl(1, -4f * max(0f, -beat))
            }
            FaceMood.SPEAKING -> {
                val beat = sin(now / 1000f * TWO_PI * 1.3f)
                out.right.aim(0.72f, 0.30f + 0.02f * beat, -12f + 8f * beat, palmOut = true)
                wiggle(out.right, now, amplitude = 4f, speed = 110f)
                out.left.aimHidden()
            }
            FaceMood.LISTENING -> {
                out.right.aim(0.84f, 0.10f, 8f)
                out.right.aimCurl(0, -4f)
                out.right.aimCurl(4, -3f)
                out.left.aimHidden()
            }
            FaceMood.DROWSY -> {
                val breathe = sin(now / 1000f * TWO_PI * 0.27f)
                out.right.aim(0.44f, 0.56f + 0.012f * breathe, -20f + 2f * breathe)
                // A sleepy hand is relaxed: the fingers close a little and move
                // only with the breath.
                val loose = 4f + 2f * breathe
                out.right.aimCurl(0, -loose * 0.6f)
                out.right.aimCurl(1, -loose * 0.3f)
                out.right.aimCurl(2, loose * 0.3f)
                out.right.aimCurl(3, loose * 0.7f)
                out.right.aimCurl(4, loose * 0.5f)
                out.left.aimHidden()
            }
        }

        // A little continuous drift on every pose: the bot is breathing, not
        // holding a screenshot. Different phases per hand keep the two from
        // moving as one object.
        drift(out.left, now, phase = 0f)
        drift(out.right, now, phase = 2.1f)

        // The head's tilt, with lag from the spring. Only a fraction: the body
        // itself does not rotate, so the hands lean rather than swing.
        if (out.left.targetAlpha > 0f) out.left.targetAngle += rollDegrees * 0.35f
        if (out.right.targetAlpha > 0f) out.right.targetAngle += rollDegrees * 0.35f

        if (dt == null) out.snap() else out.step(dt)
    }

    /**
     * A face with nothing to do fidgets: mostly handless, with a gesture every
     * eight to thirteen seconds. The seed decides both when a bot starts and
     * which gesture it does, which is what keeps a screen with two portraits
     * from moving as one.
     */
    private fun idle(now: Long, seed: Int, out: BotHandsPose) {
        val slot = 8_000L + (BotFaceRig.mix(seed + 31) ushr 8) % 5_000
        val offset = (BotFaceRig.mix(seed + 71) ushr 8) % slot
        val time = now + offset
        val local = time % slot
        when ((BotFaceRig.mix(seed * 97 + (time / slot).toInt()) ushr 9) % 10) {
            // Half the slots are empty. A gesture that never stops is a tic.
            4, 9 -> wave(local, now, out)
            5 -> shrug(local, now, out)
            6 -> cheer(local, now, out)
            7 -> cheeks(local, now, out)
            8 -> ponder(local, now, out)
            else -> Unit
        }
    }

    /** 👋 — one hand up beside the head, fingers wagging one after another. */
    private fun wave(local: Long, now: Long, out: BotHandsPose) {
        if (!active(local, 2_800)) return
        out.right.aim(
            x = 0.91f,
            y = -0.02f,
            angle = 15f * sin(local / 1000f * TWO_PI * 2.05f),
            scale = 1.04f,
            palmOut = true,
        )
        wiggle(out.right, local + now, amplitude = 9f, speed = 95f)
    }

    /** 🤷 — both palms out at the sides: "no idea", or "what can you do". */
    private fun shrug(local: Long, now: Long, out: BotHandsPose) {
        if (!active(local, 2_500)) return
        val lift = 0.03f * sin(local / 1000f * TWO_PI * 1.4f)
        out.left.aim(-0.88f, 0.32f + lift, -34f, palmOut = true)
        out.right.aim(0.88f, 0.32f + lift, 34f, palmOut = true)
        wiggle(out.left, now, amplitude = 3f, speed = 130f)
        wiggle(out.right, now, amplitude = 3f, speed = 130f)
    }

    /** 🙌 — both hands up beside the head, the shape of a small cheer. */
    private fun cheer(local: Long, now: Long, out: BotHandsPose) {
        if (!active(local, 3_000)) return
        val sway = 0.02f * sin(local / 800f)
        out.left.aim(-0.72f + sway, -0.42f, -10f, palmOut = true)
        out.right.aim(0.72f - sway, -0.42f, 10f, palmOut = true)
        wiggle(out.left, now, amplitude = 6f, speed = 85f)
        wiggle(out.right, now, amplitude = 6f, speed = 85f)
    }

    /** ☺️ — both palms pressed to the cheeks, with a tiny bounce. */
    private fun cheeks(local: Long, now: Long, out: BotHandsPose) {
        if (!active(local, 2_600)) return
        val bounce = 0.015f * sin(local / 1000f * TWO_PI * 1.6f)
        out.left.aim(-0.62f, 0.55f + bounce, 16f)
        out.right.aim(0.62f, 0.55f + bounce, -16f)
        wiggle(out.left, now, amplitude = 4f, speed = 150f)
        wiggle(out.right, now, amplitude = 4f, speed = 150f)
    }

    /** 🤔 — one hand under the chin, the index finger tapping while it thinks. */
    private fun ponder(local: Long, now: Long, out: BotHandsPose) {
        if (!active(local, 3_100)) return
        val tap = 0.5f + 0.5f * sin(local / 1000f * TWO_PI * 1.15f)
        out.right.aim(0.18f, 0.84f - 0.018f * tap, -28f)
        out.right.aimCurl(0, 12f * tap)
        out.right.aimCurl(1, -3f)
        out.right.aimCurl(2, 2f)
        out.right.aimCurl(3, 4f)
    }

    /** True while [local] is inside a gesture of [durationMillis]. */
    private fun active(local: Long, durationMillis: Long): Boolean =
        local >= 0 && local < durationMillis

    /**
     * A slow travelling bend down the fingers: each one lags the last, which is
     * the cheapest way for a flat hand to look like it is being used rather
     * than posed.
     */
    private fun wiggle(hand: BotHand, now: Long, amplitude: Float, speed: Float) {
        for (finger in 0..3) {
            hand.aimCurl(finger, amplitude * sin(now / speed + finger * 0.65f))
        }
        hand.aimCurl(4, amplitude * 0.4f * sin(now / (speed * 1.4f) + 1.7f))
    }

    /** The breathing drift every visible hand carries, whatever it is doing. */
    private fun drift(hand: BotHand, now: Long, phase: Float) {
        if (hand.targetAlpha <= 0f) return
        hand.targetX += 0.010f * sin(now / 3900f + phase)
        hand.targetY += 0.012f * sin(now / 3100f + phase * 1.7f)
        hand.targetAngle += 2f * sin(now / 4700f + phase * 0.6f)
    }
}

/**
 * One drawn part of a hand, plus the point it bends around.
 *
 * The fingers are capsules, not rectangles: at portrait size the rounded tips
 * and the notches between them are most of what makes five sausages read as a
 * hand rather than an oven mitt. The thumb points up and toward the face, so
 * the left and right hands are two sets of pieces rather than one mirrored.
 *
 * The pieces are kept apart rather than unioned: `Path.op` leaves an empty path
 * on some devices, and a hand that silently disappears is worse than a hand
 * made of overlapping parts. They are drawn stroke-first, fill-after, so each
 * fill covers every seam inside the hand and only the outer contour survives —
 * the same silhouette a union would give, with nothing device-specific.
 */
internal class BotHandPiece(val path: Path, val pivotX: Float, val pivotY: Float)

internal object BotHandShape {
    val right: Array<BotHandPiece> by lazy(LazyThreadSafetyMode.NONE) { hand(left = false) }
    val left: Array<BotHandPiece> by lazy(LazyThreadSafetyMode.NONE) { hand(left = true) }

    /**
     * The right hand's layout, in unit space: base x, tip x, base y, tip y and
     * radius for index, middle, ring, pinky, thumb.
     *
     * The thumb sits on the viewer's left and the index must be the finger next
     * to it — with the fingers in the other order, the hand reads as a mirrored
     * right hand at best and a left hand with a thumb on the wrong side at
     * worst. The left hand is this table with x negated, which mirrors the
     * whole hand: the thumb moves to the right and the index follows it.
     *
     * The four fingers fan by a hair and are of different lengths, so the
     * silhouette is a hand rather than a comb.
     */
    private val BASE_X = floatArrayOf(-0.70f, -0.24f, 0.24f, 0.70f, -0.72f)
    private val TIP_X = floatArrayOf(-0.74f, -0.26f, 0.28f, 0.78f, -1.42f)
    private val BASE_Y = floatArrayOf(-0.52f, -0.58f, -0.56f, -0.46f, 0.16f)
    private val TIP_Y = floatArrayOf(-1.56f, -1.78f, -1.64f, -1.30f, -0.62f)
    private val RADIUS = floatArrayOf(0.155f, 0.160f, 0.155f, 0.145f, 0.175f)

    /**
     * Where one finger's root sits, in the portrait's units. Exposed so the
     * thumb/index relationship can be asserted without building a Path.
     */
    internal fun baseX(finger: Int, left: Boolean): Float =
        BASE_X[finger] * if (left) -1f else 1f

    /** Index, middle, ring, pinky, thumb, palm — the order [BotHand.curls] uses. */
    private fun hand(left: Boolean): Array<BotHandPiece> {
        val mirror = if (left) -1f else 1f
        val fingers = Array(BotHand.CURLS) { index ->
            finger(
                BASE_X[index] * mirror,
                BASE_Y[index],
                TIP_X[index] * mirror,
                TIP_Y[index],
                RADIUS[index],
            )
        }
        return fingers + BotHandPiece(
            path = Path().apply { addOval(Rect(-1f, -1f, 1f, 1f)) },
            pivotX = 0f,
            pivotY = 0f,
        )
    }

    private fun finger(x1: Float, y1: Float, x2: Float, y2: Float, radius: Float): BotHandPiece =
        BotHandPiece(capsule(x1, y1, x2, y2, radius), pivotX = x1, pivotY = y1)

    /** A round-ended finger between two points, at any angle. */
    private fun capsule(x1: Float, y1: Float, x2: Float, y2: Float, radius: Float): Path {
        val dx = x2 - x1
        val dy = y2 - y1
        val degrees = atan2(dy, dx) * 180f / PI.toFloat()
        return Path().apply {
            // One clockwise subpath: the cap at the first end, round the second,
            // and close along the other side. Tracing it, rather than unioning a
            // rectangle with two circles, keeps the winding consistent — a
            // mirrored thumb would otherwise punch a hole where it meets the palm.
            arcTo(
                Rect(x1 - radius, y1 - radius, x1 + radius, y1 + radius),
                degrees + 90f,
                180f,
                forceMoveTo = false,
            )
            arcTo(
                Rect(x2 - radius, y2 - radius, x2 + radius, y2 + radius),
                degrees - 90f,
                180f,
                forceMoveTo = false,
            )
            close()
        }
    }
}

/**
 * The light on a hand, in the same space as [BotHandShape] (palm radius one).
 * Built once per palette rather than per frame: the hands are drawn inside a
 * transform, so one unit-space brush lights every hand of that colour.
 */
internal fun botHandBrush(palette: PresetAvatar): Brush = Brush.radialGradient(
    colors = listOf(
        lerp(palette.body, Color.White, 0.18f),
        palette.body,
        lerp(palette.body, Color.Black, 0.16f),
    ),
    center = Offset(-0.34f, -0.55f),
    radius = 2.2f,
)

/**
 * The line around a hand.
 *
 * The portrait's own rim is the interface separator, which is nearly invisible
 * on a cream body and lost on a black one. A hand needs a contour of its own,
 * or it reads as a smudge painted on the face: darken a light body, lighten a
 * dark one, and keep the result close enough to the body that it still looks
 * like the same rubber.
 */
internal fun botHandEdge(palette: PresetAvatar): Color {
    val body = palette.body
    val luminance = 0.299f * body.red + 0.587f * body.green + 0.114f * body.blue
    return if (luminance > 0.55f) {
        lerp(body, Color.Black, 0.22f)
    } else {
        lerp(body, Color.White, 0.30f)
    }
}

/** How big a palm is, in portrait radii. With the fingers, a hand spans ~0.5r. */
private const val PALM_RADIUS = 0.20f
/** How far below its pose a hand starts; it rises as it fades in. */
private const val HAND_RISE = 0.34f
/** A hand's contour, a touch heavier than the disc's hairline. */
private val HAND_EDGE_WIDTH = 0.6.dp

/** The springs: a little under critical damping, so a hand settles with one small overshoot. */
private const val POSITION_STIFFNESS = 90f
private const val POSITION_DAMPING = 13f
private const val ANGLE_STIFFNESS = 70f
private const val ANGLE_DAMPING = 11f
/** Fades and finger bends are eased rather than sprung; a sprung fade flickers. */
private const val ALPHA_RATE = 9f
private const val CURL_RATE = 16f

/**
 * Whether this hand is drawn with the mirrored table.
 *
 * A right hand seen from the back has its thumb on the viewer's left; the same
 * hand palm-forward is its mirror image. So the anatomical side and the facing
 * together decide: mirrored = left hand seen from the back, or right hand seen
 * from the palm. Exposed because it is the whole of the left/right correctness
 * and is worth pinning without a Path.
 */
internal fun handIsMirrored(leftHand: Boolean, palmOut: Boolean): Boolean = leftHand != palmOut

/**
 * The hands, over the face and touching its edge.
 *
 * Call this after the disc and the eyes, before the crown. The breath transform
 * is already applied by the caller, so a hand rises and falls with the body.
 * A hand whose gesture has faded out is not drawn at all.
 */
internal fun DrawScope.drawBotHands(
    hands: BotHandsPose,
    edge: Color,
    brush: Brush,
    radius: Float,
    middle: Offset,
) {
    if (!hands.shown) return
    drawBotHand(hands.left, left = true, edge, brush, radius, middle)
    drawBotHand(hands.right, left = false, edge, brush, radius, middle)
}

private fun DrawScope.drawBotHand(
    hand: BotHand,
    left: Boolean,
    edge: Color,
    brush: Brush,
    radius: Float,
    middle: Offset,
) {
    if (hand.alpha <= 0.01f) return
    val centre = Offset(middle.x + hand.x * radius, middle.y + hand.y * radius)
    val palm = PALM_RADIUS * radius * hand.scale
    if (palm <= 0f) return
    withTransform({
        translate(centre.x, centre.y)
        rotate(hand.angle, Offset.Zero)
        // The pivot matters: the default is the canvas centre, which throws a
        // hand translated to the face's edge clear across the portrait.
        scale(palm, palm, Offset.Zero)
    }) {
        // A palm facing the viewer is the same hand seen from the other side:
        // its thumb moves to the opposite edge, so it is drawn with the mirrored
        // table. The anatomical side and the facing together decide which table
        // that is — and the finger bends flip with it, or a curling index would
        // bend backwards.
        val useLeftShape = handIsMirrored(left, hand.palmOut)
        val pieces = if (useLeftShape) BotHandShape.left else BotHandShape.right
        val curlSign = if (useLeftShape) -1f else 1f
        // Stroke the pieces first, fill them after: every seam inside the hand
        // is buried by a fill, so what is left is the contour of their union.
        // The transform scales strokes too, hence the double width divided back
        // out — the visible half is the usual hairline at any portrait size.
        val outline = Stroke(width = HAND_EDGE_WIDTH.toPx() * 2f / palm)

        for (index in pieces.indices) {
            val piece = pieces[index]
            val curl = if (index < BotHand.CURLS) hand.curls[index] * curlSign else 0f
            withTransform({
                if (curl != 0f) rotate(curl, Offset(piece.pivotX, piece.pivotY))
            }) {
                drawPath(piece.path, edge, alpha = hand.alpha, style = outline)
            }
        }
        for (index in pieces.indices) {
            val piece = pieces[index]
            val curl = if (index < BotHand.CURLS) hand.curls[index] * curlSign else 0f
            withTransform({
                if (curl != 0f) rotate(curl, Offset(piece.pivotX, piece.pivotY))
            }) {
                drawPath(piece.path, brush, alpha = hand.alpha)
            }
        }
    }
}
