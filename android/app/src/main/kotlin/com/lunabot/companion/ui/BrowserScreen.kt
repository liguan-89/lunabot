package com.lunabot.companion.ui

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
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
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import com.lunabot.companion.core.SSEEvent
import com.lunabot.companion.core.Session
import kotlin.math.min
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * A bot's own browser, live — the phone's half of the desktop's browser panel.
 *
 * The server holds the page (a real Chrome on the computer) and streams frames as server-sent events; this screen draws
 * them and posts the person's taps, drags and keys back. Frames wait for an acknowledgement each, so a slow link shows
 * fewer of them rather than a backlog.
 *
 * Watch-only until the person takes the hold: [control] says whether this view owns it, and a tap that is not ours asks
 * for it once rather than being silently dropped.
 */
@Composable
fun BrowserScreen(botId: String, onBack: () -> Unit) {
    val environment = LocalCompanion.current
    val session = environment.session
    val state by session.state.collectAsState()
    val bot = remember(state, botId) { state.bot(botId) }
    if (bot == null) {
        LaunchedEffect(botId) { onBack() }
        return
    }
    val threadId = bot.threadId
    val scope = rememberCoroutineScope()

    var frame by remember(botId) { mutableStateOf<ImageBitmap?>(null) }
    /** The page's own size in CSS pixels, which a frame is cut to; null until the server has said. */
    var page by remember(botId) { mutableStateOf<Pair<Int, Int>?>(null) }
    var notice by remember(botId) { mutableStateOf<String?>(null) }
    var ready by remember(botId) { mutableStateOf(false) }
    var ownsHold by remember(botId) { mutableStateOf(false) }
    var viewerId by remember(botId) { mutableStateOf<String?>(null) }
    var panel by remember(botId) { mutableStateOf<IntSize?>(null) }

    // The view is a live stream of its own: it opens when the screen appears and is torn down with it, so a phone that
    // leaves the screen stops asking the computer for frames.
    DisposableEffect(botId) {
        val watcher = scope.launch {
            while (true) {
                try {
                    val stream = session.browserLive(botId, threadId, panel?.let { it.width to it.height }, viewerId)
                        ?: return@launch
                    stream.collect { event ->
                        when (event.event) {
                            "ready" -> {
                                val data = event.json() ?: return@collect
                                viewerId = data["viewerId"]?.jsonPrimitive?.contentOrNull
                                ready = true
                                notice = null
                            }
                            "frame" -> {
                                val data = event.json() ?: return@collect
                                val seq = data["seq"]?.jsonPrimitive?.intOrNull ?: return@collect
                                val encoded = data["data"]?.jsonPrimitive?.contentOrNull ?: return@collect
                                val bytes = runCatching { Base64.decode(encoded, Base64.DEFAULT) }.getOrNull()
                                if (bytes != null) {
                                    val decoded = withContext(Dispatchers.Default) {
                                        runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }
                                            .getOrNull()
                                            ?.asImageBitmap()
                                    }
                                    if (decoded != null) frame = decoded
                                }
                                // A frame the server is still waiting on holds the next one back.
                                runCatching { session.browserAction(botId, threadId, buildJsonObject { put("type", "ack"); put("seq", seq) }) }
                            }
                            "control" -> {
                                val data = event.json() ?: return@collect
                                ownsHold = data["owned"]?.jsonPrimitive?.booleanOrNull == true ||
                                    data["controlling"]?.jsonPrimitive?.booleanOrNull == true
                            }
                            "status" -> {
                                val data = event.json() ?: return@collect
                                val width = data["viewportWidth"]?.jsonPrimitive?.intOrNull ?: return@collect
                                val height = data["viewportHeight"]?.jsonPrimitive?.intOrNull ?: return@collect
                                // The page's own size, before any frame has arrived: it is what a frame is cut to.
                                if (width > 0 && height > 0 && page == null) page = width to height
                            }
                            "waiting" -> notice = "正在打开浏览器…"
                            "error" -> {
                                val data = event.json()
                                notice = data?.get("message")?.jsonPrimitive?.contentOrNull ?: "浏览器连接中断了。"
                            }
                        }
                    }
                } catch (cancellation: kotlinx.coroutines.CancellationException) {
                    throw cancellation
                } catch (error: Exception) {
                    notice = error.message ?: "浏览器连接中断了。"
                }
                // The server drops a stream it cannot keep up with; a view that is still on asks again.
                delay(1_000)
            }
        }
        onDispose { watcher.cancel() }
    }

    // Edge to edge in black, as the computer viewer is: the page is the picture.
    val view = LocalView.current
    val darkTheme = minisIsDark()
    DisposableEffect(Unit) {
        SystemBarBackdrop.color = Color.Black
        val window = view.context.findActivity()?.window
        val controller = window?.let { WindowCompat.getInsetsController(it, view) }
        controller?.isAppearanceLightStatusBars = false
        controller?.isAppearanceLightNavigationBars = false
        onDispose {
            SystemBarBackdrop.color = null
            controller?.isAppearanceLightStatusBars = !darkTheme
            controller?.isAppearanceLightNavigationBars = !darkTheme
        }
    }
    BackHandler { onBack() }

    val take = {
        scope.launch { runCatching { session.browserAction(botId, threadId, buildJsonObject { put("type", "take") }) } }
        Unit
    }
    val release = {
        scope.launch { runCatching { session.browserAction(botId, threadId, buildJsonObject { put("type", "release") }) } }
        Unit
    }

    Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
        val image = frame
        if (image != null) {
            BrowserFrame(
                image = image,
                onSize = { panel = it },
                onPointer = { x, y, phase ->
                    scope.launch {
                        // A tap on a view that does not hold the browser asks for it instead of driving someone else's page.
                        if (!ownsHold) {
                            take()
                            return@launch
                        }
                        runCatching {
                            session.browserAction(botId, threadId, buildJsonObject {
                                put("type", "input_mouse")
                                put("eventType", phase)
                                put("x", x)
                                put("y", y)
                                put("button", if (phase == "mouseMoved") "none" else "left")
                                put("clickCount", if (phase == "mouseMoved") 0 else 1)
                                put("modifiers", 0)
                            })
                        }
                    }
                },
            )
        } else {
            BrowserWaiting(notice)
        }

        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 14.dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            TouchTarget(onClick = onBack, contentDescription = "返回") {
                Box(
                    modifier = Modifier.size(40.dp)
                        .background(Color.White.copy(alpha = 0.18f), CircleShape)
                        .border(0.5.dp, Color.White.copy(alpha = 0.28f), CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null, tint = Color.White, modifier = Modifier.size(20.dp))
                }
            }
            Text(
                text = "${bot.name} 的浏览器",
                color = Color.White,
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            if (ready) {
                TextButton(onClick = { if (ownsHold) release() else take() }) {
                    Text(if (ownsHold) "放手" else "接管", color = Color.White, fontSize = 14.sp)
                }
            }
            Text(
                text = when {
                    !ready -> "连接中"
                    ownsHold -> "你可以操作"
                    else -> "只看"
                },
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                color = if (ownsHold) minisSuccess else Color.White.copy(alpha = 0.6f),
            )
        }
    }
}

/** One `data:` line as an object; anything else is a message this build does not know. */
private fun SSEEvent.json(): JsonObject? = runCatching {
    Json.parseToJsonElement(data) as? JsonObject
}.getOrNull()

/**
 * The page, drawn fit to the bounds with its own letterbox, and the person's pointer translated back into page
 * coordinates: a press, any movement, then the release.
 */
@Composable
private fun BrowserFrame(
    image: ImageBitmap,
    onSize: (IntSize) -> Unit,
    onPointer: (x: Int, y: Int, phase: String) -> Unit,
) {
    var bounds by remember { mutableStateOf(IntSize.Zero) }
    Box(
        modifier = Modifier
            .fillMaxSize()
            .onSizeChanged { bounds = it; onSize(it) }
            .pointerInput(image, bounds) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    var lastX = down.position.x
                    var lastY = down.position.y
                    toPage(lastX, lastY, bounds, image)?.let { onPointer(it.first, it.second, "mousePressed") }
                    drag(down.id) { change ->
                        lastX = change.position.x
                        lastY = change.position.y
                        toPage(lastX, lastY, bounds, image)?.let { onPointer(it.first, it.second, "mouseMoved") }
                        change.consume()
                    }
                    toPage(lastX, lastY, bounds, image)?.let { onPointer(it.first, it.second, "mouseReleased") }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Image(bitmap = image, contentDescription = null, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
    }
}

/** Screen point → page pixel, or null outside the letterboxed picture. */
private fun toPage(x: Float, y: Float, bounds: IntSize, image: ImageBitmap): Pair<Int, Int>? {
    if (bounds.width <= 0 || bounds.height <= 0) return null
    val scale = min(bounds.width.toFloat() / image.width, bounds.height.toFloat() / image.height)
    val drawnWidth = image.width * scale
    val drawnHeight = image.height * scale
    val left = (bounds.width - drawnWidth) / 2f
    val top = (bounds.height - drawnHeight) / 2f
    if (x < left || y < top || x > left + drawnWidth || y > top + drawnHeight) return null
    val px = ((x - left) / scale).toInt().coerceIn(0, image.width - 1)
    val py = ((y - top) / scale).toInt().coerceIn(0, image.height - 1)
    return px to py
}

@Composable
private fun BrowserWaiting(notice: String?) {
    Column(
        modifier = Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = notice ?: "正在连接这台电脑上的浏览器…",
            color = Color.White.copy(alpha = 0.7f),
            fontSize = 14.sp,
            textAlign = TextAlign.Center,
        )
    }
}
