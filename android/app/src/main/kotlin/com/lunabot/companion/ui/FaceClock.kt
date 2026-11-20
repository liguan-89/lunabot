package com.lunabot.companion.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.MotionDurationScale
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlin.coroutines.coroutineContext

/**
 * The one clock every face in the app reads.
 *
 * A face is a pure function of time: eyes open and close, the gaze moves
 * between resting points. Driving each face with its own
 * `rememberInfiniteTransition` would put one animation driver behind every
 * portrait on the roster — twenty on a busy screen — which is both wasteful and
 * out of sync, so every face would blink on the same beat.
 *
 * Here one `withFrameNanos` loop ticks while at least one face is on screen and
 * publishes the frame time; each face derives its own schedule from that time
 * and its own seed. Readers are counted, so a screen with no faces runs no
 * loop at all, and a face reads the value *inside its draw lambda*, which
 * repaints it without recomposing anything.
 *
 * The clock is also the app's note of when a person last touched it, which is
 * what lets a face fall asleep on a screen nobody has used.
 */
@Stable
internal class FaceClock(private val scope: CoroutineScope) {
    private val elapsed = mutableLongStateOf(0L)

    /** Milliseconds of wall time since the app's first frame. */
    val millis: State<Long> get() = elapsed

    private val interacted = mutableLongStateOf(0L)

    /** The [millis] of the last pointer event, for the idle faces. */
    val interactedAt: State<Long> get() = interacted

    private val pointer = mutableStateOf<FacePointer?>(null)

    /** Where the last finger went, in window pixels, and when it was there. */
    val lastPointer: State<FacePointer?> get() = pointer

    private var readers = 0
    private var loop: Job? = null

    /** Start the loop for one more face. Paired with [release]. */
    fun acquire() {
        readers++
        if (loop != null) return
        loop = scope.launch {
            while (true) {
                // The frame clock suspends while the window is not drawing, so
                // a face in the background costs nothing.
                withFrameNanos { frame -> elapsed.longValue = frame / 1_000_000L }
            }
        }
    }

    /** Stop counting one face; the loop stops with the last one. */
    fun release() {
        if (readers == 0) return
        readers--
        if (readers > 0) return
        loop?.cancel()
        loop = null
    }

    fun touch() {
        interacted.longValue = elapsed.longValue
    }

    /**
     * A finger touched the screen at [x], [y] (window pixels). Unlike [touch],
     * this also gives the large portrait somewhere to look: a face that follows
     * the finger reads as present in a way no idle animation does.
     */
    fun touched(x: Float, y: Float) {
        interacted.longValue = elapsed.longValue
        pointer.value = FacePointer(x, y, elapsed.longValue)
    }

    /** How long since the last touch, in milliseconds. */
    fun idleMillis(): Long = elapsed.longValue - interacted.longValue
}

/** One finger position, in window pixels, stamped with the clock's time. */
internal data class FacePointer(val x: Float, val y: Float, val at: Long)

/**
 * Null where no provider was installed — a test that mounts a face on its own,
 * or a preview. A face without a clock draws a still frame rather than
 * inventing one.
 */
private val LocalFaceClock = staticCompositionLocalOf<FaceClock?> { null }

/**
 * Installs the clock for the whole app. Every dialog and sheet composed below
 * this point inherits it, which is why it sits at the activity's content root.
 */
@Composable
internal fun FaceClockProvider(content: @Composable () -> Unit) {
    val scope = rememberCoroutineScope()
    val clock = remember { FaceClock(scope) }
    CompositionLocalProvider(LocalFaceClock provides clock, content = content)
}

/** The app's clock, for the screens that need to report a touch. */
@Composable
internal fun rememberFaceClock(): FaceClock? = LocalFaceClock.current

/**
 * The frame time to draw a face from, or null when the face should hold still.
 *
 * Null in three cases, all of them deliberate: no provider (a test), Android's
 * animator duration scale at zero ("remove animations"), and the caller saying
 * this face does not move. Reading the scale needs a suspend context, so it is
 * read once per composition rather than per frame.
 */
@Composable
internal fun rememberFaceTime(): State<Long>? {
    val clock = LocalFaceClock.current
    var animate by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) {
        animate = (coroutineContext[MotionDurationScale]?.scaleFactor ?: 1f) > 0f
    }
    if (clock == null || !animate) return null
    DisposableEffect(clock) {
        clock.acquire()
        onDispose { clock.release() }
    }
    return clock.millis
}
