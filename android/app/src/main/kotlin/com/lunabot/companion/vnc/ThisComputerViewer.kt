/*
 * This computer's own screen on the phone: a polled picture, and taps that land on the Mac.
 *
 * Not the RFB viewer. A Local VM speaks VNC through a relay socket, which is a protocol the desktop container runs.
 * This Mac has no VNC server and will not get one — the desktop's own Cua Driver already captures the screen and
 * already injects input, so both halves ride its HTTP routes instead: `desktop/screenshot` for the picture and
 * `desktop/action` for a tap, key or typed run.
 *
 * Two things this deliberately does not do:
 *
 * - It does not hold the control lease while merely watching. The point of this screen is to see what the bot is
 *   doing; a lease would stop the bot and turn the viewer into a takeover. The lease is taken only when the person
 *   asks to act, and released the moment they stop.
 * - It does not stream. Each frame is a JPEG the server re-encoded from a retina capture, so polling a few seconds
 *   apart is honest about what it costs; the live SSE `screen` frames still arrive on top while a turn runs.
 */
package com.lunabot.companion.vnc

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.core.DesktopScreenFrame
import com.lunabot.companion.core.Session
import com.lunabot.companion.ui.LocalCompanion
import java.util.UUID
import kotlin.math.min
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

/** Where the viewer is. [Live] means a picture and, when the person took control, a lease this phone holds. */
sealed interface ThisComputerState {
    data object Connecting : ThisComputerState
    data class Live(val controlling: Boolean) : ThisComputerState
    data class Failed(val message: String) : ThisComputerState
}

@Stable
internal class ThisComputerViewer(
    private val session: Session,
    private val botId: String,
    private val scope: CoroutineScope,
) {
    /** The lease this phone names. Only exists while [controlling]. */
    private var leaseId: String? = null

    var state by mutableStateOf<ThisComputerState>(ThisComputerState.Connecting)
        private set
    var frame by mutableStateOf<ImageBitmap?>(null)
        private set
    /** The newest capture, kept for the point a tap has to be scaled into. */
    private var latest: DesktopScreenFrame? = null
    /** The last refusal from the server, so a tap that did nothing says why. */
    var actionError by mutableStateOf<String?>(null)
        private set

    private var poll: Job? = null
    private var started = false
    /** Bumped when a picture is wanted now; the poll loop skips its wait when it changes. */
    private var refreshNow by mutableStateOf(0)
    /** True while one action owns the link; the poll loop stands down meanwhile. */
    @Volatile
    private var acting = false
    /** Serialises actions, so two quick taps cannot interleave into one confusing order. */
    private val actionLock = Mutex()
    /** Counts refusals, so an older error's timer cannot clear a newer one. */
    private var errorGeneration = 0

    fun start() {
        if (started) return
        started = true
        poll = scope.launch {
            var misses = 0
            while (isActive) {
                // An action owns the link while it runs: a frame competing with a tap is what made a tap take 20 seconds
                // and then time out on a relay.
                if (acting) {
                    delay(120)
                    continue
                }
                val seenRefresh = refreshNow
                val startedAt = System.currentTimeMillis()
                val shot = session.captureDesktopScreen(botId)
                if (shot == null) {
                    misses += 1
                    // One miss is a race with a sleeping Mac; a run of them is the surface being unavailable.
                    if (misses >= 3 && frame == null) {
                        state = ThisComputerState.Failed(
                            "这台电脑没有回应。请在电脑上打开 Luna Bot，并确认「手机和设备」里已允许这台手机查看屏幕。",
                        )
                        return@launch
                    }
                } else {
                    misses = 0
                    latest = shot
                    val decoded = shot.data
                        ?.let { runCatching { BitmapFactory.decodeByteArray(it, 0, it.size) }.getOrNull() }
                        ?.asImageBitmap()
                    if (decoded != null) frame = decoded
                    if (state !is ThisComputerState.Live) {
                        state = ThisComputerState.Live(controlling = leaseId != null)
                    }
                }
                // Never two captures back to back: the wait is at least as long as the capture took, so a slow link
                // cannot be saturated by the viewer alone.
                val took = System.currentTimeMillis() - startedAt
                val wanted = if (leaseId != null) 1_500L else 5_000L
                val wait = (wanted - took).coerceAtLeast(400L)
                if (refreshNow == seenRefresh) delay(wait)
            }
        }
    }

    /** Ask the poll loop for a picture now, after an action changed the screen. */
    private fun refreshSoon() {
        refreshNow += 1
    }

    /** Take the computer so taps land, which also refuses the bot's own hands for as long as it is held. */
    suspend fun takeControl(): Boolean {
        val id = leaseId ?: ("phone-" + UUID.randomUUID().toString().replace("-", "")).also { leaseId = it }
        return try {
            if (session.takeLocalComputer(botId, id)) {
                state = ThisComputerState.Live(controlling = true)
                true
            } else {
                leaseId = null
                false
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            leaseId = null
            actionError = error.message
            false
        }
    }

    /** Hand the computer back; the bot may use it again on its next call. */
    suspend fun releaseControl() {
        val id = leaseId ?: return
        leaseId = null
        state = ThisComputerState.Live(controlling = false)
        runCatching { session.releaseLocalComputer(botId, id) }
    }

    /** A tap on the drawn picture, in its own pixels; scaled to the screen points the server takes. */
    suspend fun tap(x: Float, y: Float) {
        val shot = latest ?: return
        val (screenX, screenY) = shot.toScreen(x, y)
        send(
            buildJsonObject {
                put("action", "click")
                put("x", screenX.toDouble())
                put("y", screenY.toDouble())
            },
        )
    }

    suspend fun scroll(x: Float, y: Float, direction: String) {
        val shot = latest ?: return
        val (screenX, screenY) = shot.toScreen(x, y)
        send(
            buildJsonObject {
                put("action", "scroll")
                put("x", screenX.toDouble())
                put("y", screenY.toDouble())
                put("key", direction)
                put("amount", 3)
            },
        )
    }

    suspend fun type(text: String) {
        if (text.isEmpty()) return
        send(buildJsonObject { put("action", "type_text"); put("text", text) })
    }

    suspend fun key(name: String, modifiers: List<String> = emptyList()) {
        send(
            buildJsonObject {
                put("action", if (modifiers.isEmpty()) "press_key" else "hotkey")
                put("key", name)
                if (modifiers.isNotEmpty()) putJsonArray("modifiers") { modifiers.forEach { add(it) } }
            },
        )
    }

    fun clearActionError() {
        actionError = null
    }

    private suspend fun send(body: JsonObject) {
        val id = leaseId ?: run {
            actionError = "先点「接管控制」，才能操作这台电脑。"
            return
        }
        val withLease = buildJsonObject {
            body.forEach { (name, value) -> put(name, value) }
            put("controlLeaseId", id)
        }
        // One action at a time, and no frame captured while it runs: on a relay a 110 KB picture in flight is enough to
        // push a tap past its timeout.
        actionLock.withLock {
            acting = true
            try {
                session.desktopScreenAction(botId, withLease)
                actionError = null
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                showError(error.message ?: "这台电脑没有接受这次操作。")
            } finally {
                acting = false
                // The screen changed under the finger; show it without waiting for the next tick.
                refreshSoon()
            }
        }
    }

    /**
     * Show a refusal for a few seconds, then let it go. A permanent red line under the picture reads as a broken screen
     * long after the one action that failed.
     */
    private fun showError(message: String) {
        actionError = message
        errorGeneration += 1
        val generation = errorGeneration
        scope.launch {
            delay(5_000)
            if (errorGeneration == generation) actionError = null
        }
    }

    fun stop() {
        started = false
        poll?.cancel()
        poll = null
        val id = leaseId
        leaseId = null
        if (id != null) scope.launch { runCatching { session.releaseLocalComputer(botId, id) } }
    }
}

/**
 * The screen itself: the picture, a tap that lands on the Mac once the person has taken control, and a text strip.
 *
 * Watching is the default state, so opening this page never stops the bot. The takeover button is what flips it, and
 * it says so: while the lease is held the bot's own calls are refused, which is the same rule the Local VM viewer
 * follows. Leaving the screen hands the computer back.
 */
@Composable
internal fun ThisComputerViewerScreen(botId: String, title: String, onExit: () -> Unit) {
    val environment = LocalCompanion.current
    val session = environment.session
    // Process scope: releasing the lease must survive this screen being disposed.
    val scope = environment.appScope
    val viewer = remember(botId) { ThisComputerViewer(session, botId, scope) }
    LaunchedEffect(viewer) { viewer.start() }
    DisposableEffect(viewer) { onDispose { viewer.stop() } }

    var typing by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }

    Column(modifier = Modifier.fillMaxSize().background(Color.Black)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 4.dp, end = 8.dp, top = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            TextButton(onClick = onExit) { Text("返回", color = Color.White) }
            Text(
                text = title,
                fontSize = 15.sp,
                color = Color.White.copy(alpha = 0.8f),
                modifier = Modifier.weight(1f),
            )
            val live = viewer.state as? ThisComputerState.Live
            if (live?.controlling == true) {
                Text("正在接管", fontSize = 12.sp, color = Color(0xFF6BD98A))
                TextButton(onClick = { scope.launch { viewer.releaseControl() } }) {
                    Text("交还", color = Color.White, fontSize = 13.sp)
                }
            } else if (live != null) {
                TextButton(onClick = { confirming = true }) {
                    Text("接管控制", color = Color.White, fontSize = 13.sp)
                }
            }
        }

        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            when (val state = viewer.state) {
                ThisComputerState.Connecting -> Row(
                    modifier = Modifier.align(Alignment.Center),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
                    Text("正在读取电脑画面…", color = Color.White.copy(alpha = 0.8f))
                }
                is ThisComputerState.Failed -> Column(
                    modifier = Modifier.align(Alignment.Center).padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text(state.message, color = Color.White, fontSize = 15.sp)
                    TextButton(onClick = onExit) { Text("返回") }
                }
                is ThisComputerState.Live -> DesktopFrame(viewer, controlling = state.controlling)
            }
        }

        viewer.actionError?.let { message ->
            Text(
                text = message,
                color = Color(0xFFFF8A80),
                fontSize = 12.sp,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth().padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = 44.dp)
                    .background(Color.White.copy(alpha = 0.12f), RoundedCornerShape(10.dp))
                    .padding(horizontal = 12.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                BasicTextField(
                    value = typing,
                    onValueChange = { typing = it },
                    singleLine = true,
                    textStyle = TextStyle(color = Color.White, fontSize = 15.sp),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (typing.isEmpty()) {
                    Text("输入文字，然后点「发送」", color = Color.White.copy(alpha = 0.35f), fontSize = 14.sp)
                }
            }
            TextButton(
                enabled = !busy && typing.isNotEmpty(),
                onClick = {
                    busy = true
                    scope.launch {
                        viewer.type(typing)
                        typing = ""
                        busy = false
                    }
                },
            ) { Text("发送", color = Color.White) }
            TextButton(
                enabled = !busy,
                onClick = {
                    busy = true
                    scope.launch {
                        viewer.key("Return")
                        busy = false
                    }
                },
            ) { Text("回车", color = Color.White) }
        }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("接管这台电脑？") },
            text = { Text("接管期间，这台手机会直接操作你的 Mac，该机器人自己的操作会被拒绝。交还控制或离开此页会立即结束接管。") },
            confirmButton = {
                TextButton(onClick = {
                    confirming = false
                    scope.launch { viewer.takeControl() }
                }) { Text("接管") }
            },
            dismissButton = {
                TextButton(onClick = { confirming = false }) { Text("取消") }
            },
        )
    }
}

@Composable
private fun DesktopFrame(viewer: ThisComputerViewer, controlling: Boolean) {
    val image = viewer.frame ?: return
    var bounds by remember { mutableStateOf(IntSize.Zero) }
    val scope = rememberCoroutineScope()
    Box(
        modifier = Modifier
            .fillMaxSize()
            .onSizeChanged { bounds = it }
            .pointerInput(image, bounds, controlling) {
                if (!controlling) return@pointerInput
                detectTapGestures { offset ->
                    val point = toPicturePoint(offset.x, offset.y, bounds, image) ?: return@detectTapGestures
                    scope.launch { viewer.tap(point.first, point.second) }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Image(
            bitmap = image,
            contentDescription = null,
            contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxSize(),
        )
        if (!controlling) {
            Text(
                text = "只读画面。要点击或输入，先点右上角「接管控制」。",
                fontSize = 12.sp,
                color = Color.White.copy(alpha = 0.7f),
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .background(Color.Black.copy(alpha = 0.55f), RoundedCornerShape(8.dp))
                    .padding(horizontal = 10.dp, vertical = 6.dp),
            )
        }
    }
}

/** Screen point → picture pixel, or null outside the letterboxed picture. */
private fun toPicturePoint(x: Float, y: Float, bounds: IntSize, image: ImageBitmap): Pair<Float, Float>? {
    if (bounds.width <= 0 || bounds.height <= 0) return null
    val scale = min(bounds.width.toFloat() / image.width, bounds.height.toFloat() / image.height)
    val drawnWidth = image.width * scale
    val drawnHeight = image.height * scale
    val left = (bounds.width - drawnWidth) / 2f
    val top = (bounds.height - drawnHeight) / 2f
    if (x < left || y < top || x > left + drawnWidth || y > top + drawnHeight) return null
    return ((x - left) / scale) to ((y - top) / scale)
}
