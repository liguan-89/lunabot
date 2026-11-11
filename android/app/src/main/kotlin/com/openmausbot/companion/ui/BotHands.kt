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
 * The portrait's hands — fingers that answer the face.
 *
 * A circle with two eyes can blink and look around, but it has no hands to say
 * what the eyes are feeling. These do: a hand under the chin while the bot
 * thinks, one holding up a sleepy cheek, a palm up in a shrug, a hand waving.
 * No arms: the hand is placed against the silhouette and read as coming from
 * behind it, which is how the emoji the face is imitating do it.
 *
 * Every hand is positioned in the portrait's own units: one unit is the disc's
 * radius, (0, 0) is its centre, and positive x is the viewer's right. That is
 * the same space [BotFaceRig] uses for the eyes, so a hand on the chin is on
 * the chin and not a few pixels below it.
 *
 * The positions are a pure function of time, seed and mood, for the same reason
 * the face is: a test can sample them without a frame clock, and two bots do
 * not wave in unison.
 *
 * Hands only exist on a [FaceLife.ALIVE] face — the one large portrait on a
 * screen. At 24 dp in a chat header a 20 dp hand would be a smudge, and a list
 * of waving faces is a crowd, not a roster.
 */
internal class BotHand {
    var x: Float = 0f
    var y: Float = 0f
    /** Degrees clockwise on screen; 0 points the fingers up. */
    var angle: Float = 0f
    var scale: Float = 1f

    fun set(x: Float, y: Float, angle: Float, scale: Float = 1f) {
        this.x = x
        this.y = y
        this.angle = angle
        this.scale = scale
    }
}

/** Both hands of one frame, written in place — a face redraws every tick. */
internal class BotHandsPose {
    var shown: Boolean = false
        private set

    val left: BotHand = BotHand()
    val right: BotHand = BotHand()

    /** [shown] is set by whichever mood is current; the hands are always reset after. */
    fun start(shown: Boolean) {
        this.shown = shown
        left.set(0f, 0f, 0f)
        right.set(0f, 0f, 0f)
    }
}

internal object BotHandRig {
    /** At rest both palms cup the cheeks, fingers up — and clear of the status lamp. */
    const val REST_X = 0.60f
    const val REST_Y = 0.52f
    const val REST_ANGLE = 12f

    private const val TWO_PI = 2f * PI.toFloat()

    /**
     * What the hands are doing at [now]. [out] is the caller's buffer; the face
     * redraws every frame and should not allocate two hands per tick.
     */
    fun pose(now: Long, seed: Int, mood: FaceMood, life: FaceLife, out: BotHandsPose) {
        out.start(life == FaceLife.ALIVE)
        if (!out.shown) return

        out.left.set(-REST_X, REST_Y, -REST_ANGLE)
        out.right.set(REST_X, REST_Y, REST_ANGLE)

        when (mood) {
            // The moods that have something to say with a hand. Idle fidgets.
            FaceMood.IDLE -> idle(now, seed, out)
            FaceMood.THINKING -> thinking(now, out)
            FaceMood.WORKING -> working(now, out)
            FaceMood.SPEAKING -> speaking(now, out)
            FaceMood.LISTENING -> listening(out)
            FaceMood.DROWSY -> drowsy(now, out)
        }
    }

    /**
     * A face with nothing to do fidgets: mostly resting, with a gesture every
     * eight to thirteen seconds. The slot is the same length for the whole
     * gesture so the hands return to rest before the next one is picked; the
     * seed decides both when a bot starts and which gesture it does, which is
     * what keeps a screen with two portraits from moving as one.
     */
    private fun idle(now: Long, seed: Int, out: BotHandsPose) {
        val slot = 8_000L + (BotFaceRig.mix(seed + 31) ushr 8) % 5_000
        val offset = (BotFaceRig.mix(seed + 71) ushr 8) % slot
        val time = now + offset
        val local = time % slot
        when ((BotFaceRig.mix(seed * 97 + (time / slot).toInt()) ushr 9) % 10) {
            // Four slots in ten are rest. A gesture that never stops is a tic.
            4, 9 -> wave(local, out)
            5 -> shrug(local, out)
            6 -> cheer(local, out)
            7 -> cheeks(local, out)
            8 -> ponder(local, out)
            else -> Unit
        }
    }

    /** 👋 — one hand up beside the head, fingers wagging. */
    private fun wave(local: Long, out: BotHandsPose) {
        val grow = envelope(local, durationMillis = 2_800, enterMillis = 380, exitMillis = 420)
        if (grow <= 0f) return
        val hand = out.right
        hand.x = blend(hand.x, 0.91f, grow)
        hand.y = blend(hand.y, -0.02f, grow)
        hand.angle = blend(hand.angle, 0f, grow) +
            16f * grow * sin(local / 1000f * TWO_PI * 2.05f)
        hand.scale = 1f + 0.04f * grow
    }

    /** 🤷 — both palms out at the sides: "no idea", or "what can you do". */
    private fun shrug(local: Long, out: BotHandsPose) {
        val grow = envelope(local, durationMillis = 2_500, enterMillis = 320, exitMillis = 460)
        if (grow <= 0f) return
        val lift = 0.03f * sin(local / 1000f * TWO_PI * 1.4f)
        out.left.x = blend(out.left.x, -0.88f, grow)
        out.left.y = blend(out.left.y, 0.32f + lift, grow)
        out.left.angle = blend(out.left.angle, -34f, grow)
        out.right.x = blend(out.right.x, 0.88f, grow)
        out.right.y = blend(out.right.y, 0.32f + lift, grow)
        out.right.angle = blend(out.right.angle, 34f, grow)
    }

    /** 🙌 — both hands up beside the head, the shape of a small cheer. */
    private fun cheer(local: Long, out: BotHandsPose) {
        val grow = envelope(local, durationMillis = 3_000, enterMillis = 480, exitMillis = 560)
        if (grow <= 0f) return
        val sway = 0.02f * sin(local / 800f)
        out.left.x = blend(out.left.x, -0.72f + sway, grow)
        out.left.y = blend(out.left.y, -0.42f, grow)
        out.left.angle = blend(out.left.angle, -10f, grow)
        out.right.x = blend(out.right.x, 0.72f - sway, grow)
        out.right.y = blend(out.right.y, -0.42f, grow)
        out.right.angle = blend(out.right.angle, 10f, grow)
    }

    /** ☺️ — both palms pressed to the cheeks, with a tiny bounce. */
    private fun cheeks(local: Long, out: BotHandsPose) {
        val grow = envelope(local, durationMillis = 2_600, enterMillis = 360, exitMillis = 420)
        if (grow <= 0f) return
        val bounce = 0.015f * sin(local / 1000f * TWO_PI * 1.6f)
        out.left.x = blend(out.left.x, -0.62f, grow)
        out.left.y = blend(out.left.y, 0.55f + bounce, grow)
        out.left.angle = blend(out.left.angle, 16f, grow)
        out.right.x = blend(out.right.x, 0.62f, grow)
        out.right.y = blend(out.right.y, 0.55f + bounce, grow)
        out.right.angle = blend(out.right.angle, -16f, grow)
    }

    /** 🤔 — the same chin support, offered as one of the idle gestures. */
    private fun ponder(local: Long, out: BotHandsPose) {
        val grow = envelope(local, durationMillis = 3_100, enterMillis = 420, exitMillis = 480)
        if (grow <= 0f) return
        val tap = 0.5f + 0.5f * sin(local / 1000f * TWO_PI * 1.15f)
        out.right.x = blend(out.right.x, 0.26f, grow)
        out.right.y = blend(out.right.y, 0.88f - 0.018f * tap, grow)
        out.right.angle = blend(out.right.angle, -28f, grow)
    }

    /** 🤔 — a hand under the chin, tapping while the bot works it out. */
    private fun thinking(now: Long, out: BotHandsPose) {
        val tap = 0.5f + 0.5f * sin(now / 1000f * TWO_PI * 1.15f)
        out.right.set(0.26f, 0.88f - 0.018f * tap, -28f)
        out.left.set(-REST_X, REST_Y, -REST_ANGLE)
    }

    /** Both hands at the jaw, fingers drumming: the body is busy, the face is not. */
    private fun working(now: Long, out: BotHandsPose) {
        val beat = sin(now / 1000f * TWO_PI * 3.1f)
        out.left.set(-0.55f, 0.72f - 0.03f * max(0f, beat), 10f)
        out.right.set(0.55f, 0.72f - 0.03f * max(0f, -beat), -10f)
    }

    /** One hand talking along with the sentence, beating time with it. */
    private fun speaking(now: Long, out: BotHandsPose) {
        val beat = sin(now / 1000f * TWO_PI * 1.3f)
        out.right.set(0.72f, 0.32f + 0.02f * beat, -12f + 8f * beat)
        out.left.set(-REST_X, REST_Y, -REST_ANGLE)
    }

    /** A hand cupped beside the cheek: the bot is taking something in. */
    private fun listening(out: BotHandsPose) {
        out.right.set(0.86f, 0.06f, 8f)
        out.left.set(-REST_X, REST_Y, -REST_ANGLE)
    }

    /** 😴 — the cheek propped on a palm, breathing slowly over it. */
    private fun drowsy(now: Long, out: BotHandsPose) {
        val breathe = sin(now / 1000f * TWO_PI * 0.27f)
        out.right.set(0.52f, 0.60f + 0.012f * breathe, -18f + 2f * breathe)
        out.left.set(-REST_X, REST_Y, -REST_ANGLE)
    }

    /**
     * How present a gesture is [local] milliseconds after it started: rises over
     * [enterMillis], holds, then leaves over [exitMillis], and is gone once
     * [durationMillis] has passed. Smoothstepped so a hand never snaps.
     */
    private fun envelope(local: Long, durationMillis: Long, enterMillis: Long, exitMillis: Long): Float {
        if (local < 0 || local >= durationMillis) return 0f
        val rise = (local.toFloat() / enterMillis).coerceIn(0f, 1f)
        val fall = ((durationMillis - local).toFloat() / exitMillis).coerceIn(0f, 1f)
        val t = minOf(rise, fall)
        return t * t * (3f - 2f * t)
    }
}

/** Linear blend used by the rig; [t] is already eased by the caller. */
private fun blend(from: Float, to: Float, t: Float): Float = from + (to - from) * t

/**
 * A hand, in its own unit space: a palm of radius one, four fingers, a thumb.
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
internal object BotHandShape {
    val right: Array<Path> by lazy(LazyThreadSafetyMode.NONE) { hand(thumbX = -1f) }
    val left: Array<Path> by lazy(LazyThreadSafetyMode.NONE) { hand(thumbX = 1f) }

    private fun hand(thumbX: Float): Array<Path> {
        val palm = Path().apply { addOval(Rect(-1f, -1f, 1f, 1f)) }
        return arrayOf(
            palm,
            // Index, middle, ring, pinky: spread enough that the gaps survive at
            // 84 dp, of different lengths so the outline is not a comb.
            capsule(0.70f, -0.52f, 0.74f, -1.56f, 0.155f),
            capsule(0.24f, -0.58f, 0.26f, -1.78f, 0.160f),
            capsule(-0.24f, -0.56f, -0.28f, -1.64f, 0.155f),
            capsule(-0.70f, -0.46f, -0.78f, -1.30f, 0.145f),
            // The thumb leaves the palm low and points up and out.
            capsule(thumbX * 0.72f, 0.16f, thumbX * 1.42f, -0.62f, 0.175f),
        )
    }

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
/** A hand's contour, a touch heavier than the disc's hairline. */
private val HAND_EDGE_WIDTH = 0.6.dp

/**
 * The hands, over the face and touching its edge.
 *
 * Call this after the disc and the eyes, before the crown. The breath transform
 * is already applied by the caller, so a hand rises and falls with the body.
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
        val pieces = if (left) BotHandShape.left else BotHandShape.right
        // Stroke the pieces first, fill them after: every seam inside the hand
        // is buried by a fill, so what is left is the contour of their union.
        // The transform scales strokes too, hence the double width divided back
        // out — the visible half is the usual hairline at any portrait size.
        val outline = Stroke(width = HAND_EDGE_WIDTH.toPx() * 2f / palm)
        for (piece in pieces) drawPath(piece, edge, style = outline)
        for (piece in pieces) drawPath(piece, brush)
    }
}
