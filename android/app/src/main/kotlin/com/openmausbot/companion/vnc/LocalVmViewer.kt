package com.openmausbot.companion.vnc

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicTextField
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
import com.openmausbot.companion.core.Session
import com.openmausbot.companion.ui.LocalCompanion
import java.util.UUID
import kotlin.math.min
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import androidx.core.graphics.createBitmap

internal sealed interface LocalVmState {
    data object Connecting : LocalVmState

    data object Live : LocalVmState

    data class Failed(val message: String) : LocalVmState
}

/**
 * One Local VM takeover: lease the bot's computer, open the viewer relay, and
 * speak RFB over the WebSocket it hands back.
 *
 * Lifetime is the screen's: [stop] closes the socket, closes the viewer session
 * and releases the lease, in that order, so the sidecar's lease check and the
 * harness's ownership cannot disagree for longer than a round trip.
 */
@Stable
internal class LocalVmViewer(
    private val session: Session,
    private val botId: String,
    private val scope: CoroutineScope,
) {
    /** The lease this phone names; the sidecar checks it every few seconds. */
    private val leaseId = "phone-" + UUID.randomUUID().toString().replace("-", "")

    var state by mutableStateOf<LocalVmState>(LocalVmState.Connecting)
        private set
    var frame by mutableStateOf<ImageBitmap?>(null)
        private set

    private var rfb: RfbClient? = null
    private var socket: WebSocket? = null
    private var bitmap: Bitmap? = null
    private var started = false

    fun start() {
        if (started) return
        started = true
        scope.launch { connect() }
    }

    private suspend fun connect() {
        state = LocalVmState.Connecting
        if (!session.takeLocalComputer(botId, leaseId)) {
            fail("没能取得这台电脑的控制权。")
            return
        }
        val join = session.joinLocalComputer(botId, leaseId)
        val path = join?.socketPath
        if (path == null) {
            releaseLease()
            fail("这台电脑暂时没有可用的实时桌面。")
            return
        }
        val client = RfbClient()
        rfb = client
        val opened = session.openViewerSocket(path, SocketListener(client))
        if (opened == null) {
            releaseLease()
            fail("无法连接到实时桌面。")
            return
        }
        socket = opened
    }

    fun pointer(x: Int, y: Int, buttonMask: Int) {
        rfb?.pointer(x, y, buttonMask)
        flush()
    }

    /** Type one character for the remote: ASCII keysyms, one key event each. */
    fun typeCharacter(char: Char) {
        val client = rfb ?: return
        val code = char.code
        if (code !in 0x20..0x7E) return
        // A keysym is not a keycode: 'A' is 0x41, Shift is unnecessary, and
        // sending one for punctuation would invert the character on the host.
        client.key(code, true)
        client.key(code, false)
        flush()
    }

    fun backspace() {
        rfb?.key(BACKSPACE, true)
        rfb?.key(BACKSPACE, false)
        flush()
    }

    fun enter() {
        rfb?.let {
            it.key(RETURN, true)
            it.key(RETURN, false)
        }
        flush()
    }

    fun stop() {
        started = false
        socket?.close(1000, null)
        socket = null
        rfb = null
        scope.launch {
            session.closeComputerViewer(botId)
            releaseLease()
        }
    }

    private fun releaseLease() {
        scope.launch { session.releaseLocalComputer(botId, leaseId) }
    }

    private fun flush() {
        val client = rfb ?: return
        val bytes = client.takeOutbound()
        if (bytes.isEmpty()) return
        socket?.send(bytes.toByteString())
    }

    private fun handle(events: List<RfbClient.Event>) {
        for (event in events) {
            when (event) {
                is RfbClient.Event.Ready -> {
                    bitmap = createBitmap(event.width, event.height, Bitmap.Config.ARGB_8888)
                    state = LocalVmState.Live
                }
                is RfbClient.Event.Rectangle -> {
                    val target = bitmap ?: continue
                    if (event.x < 0 || event.y < 0) continue
                    val width = min(event.width, target.width - event.x)
                    val height = min(event.height, target.height - event.y)
                    if (width <= 0 || height <= 0) continue
                    target.setPixels(event.pixels, 0, event.width, event.x, event.y, width, height)
                    frame = target.asImageBitmap()
                }
                is RfbClient.Event.Bell -> Unit
                is RfbClient.Event.Clipboard -> Unit
                is RfbClient.Event.Closed -> fail(event.reason)
            }
        }
        // Ask for the next change only after the last one landed; a full frame
        // arrives on Ready.
        if (state == LocalVmState.Live) {
            rfb?.requestUpdate(incremental = true)
            flush()
        }
    }

    private fun fail(message: String) {
        if (state is LocalVmState.Failed) return
        state = LocalVmState.Failed(message)
    }

    private inner class SocketListener(private val client: RfbClient) : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            webSocket.send(client.start().toByteString())
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            val events = client.feed(bytes.toByteArray())
            handle(events)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (state !is LocalVmState.Failed) {
                fail(reason.ifBlank { "实时桌面已断开。" })
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            fail(t.message?.takeIf { it.isNotBlank() } ?: "无法连接到实时桌面。")
        }
    }

    private companion object {
        const val BACKSPACE = 0xFF08
        const val RETURN = 0xFF0D
    }
}

/**
 * The takeover screen: the VM's framebuffer, one finger as the pointer, and a
 * small text strip because a phone keyboard cannot send raw key events.
 */
@Composable
internal fun LocalVmViewerScreen(botId: String, title: String, onExit: () -> Unit) {
    val environment = LocalCompanion.current
    val session = environment.session
    // Process scope, not the composition's: stop() must release the lease after
    // this screen is gone, and rememberCoroutineScope is cancelled right then.
    val scope = environment.appScope
    val viewer = remember(botId) { LocalVmViewer(session, botId, scope) }
    LaunchedEffect(viewer) { viewer.start() }
    DisposableEffect(viewer) {
        onDispose { viewer.stop() }
    }

    var typing by remember { mutableStateOf("") }

    Column(modifier = Modifier.fillMaxSize().background(Color.Black)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 4.dp, end = 8.dp, top = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            TextButton(onClick = onExit) { Text("交还控制", color = Color.White) }
            Text(
                text = title,
                fontSize = 15.sp,
                color = Color.White.copy(alpha = 0.8f),
                modifier = Modifier.weight(1f),
            )
            if (viewer.state == LocalVmState.Live) {
                Text("单击或拖动", fontSize = 12.sp, color = Color.White.copy(alpha = 0.5f))
            }
        }

        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            when (val state = viewer.state) {
                LocalVmState.Connecting -> Row(
                    modifier = Modifier.align(Alignment.Center),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
                    Text("正在接管…", color = Color.White.copy(alpha = 0.8f))
                }
                is LocalVmState.Failed -> Column(
                    modifier = Modifier.align(Alignment.Center).padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text(state.message, color = Color.White, fontSize = 15.sp)
                    TextButton(onClick = onExit) { Text("返回") }
                }
                LocalVmState.Live -> VncFrame(viewer)
            }
        }

        // A phone IME cannot deliver key events; this strip sends what it has as
        // keysyms. It is a convenience, not a full keyboard.
        Row(
            modifier = Modifier.fillMaxWidth().padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = 44.dp)
                    .background(Color.White.copy(alpha = 0.12f), androidx.compose.foundation.shape.RoundedCornerShape(10.dp))
                    .padding(horizontal = 12.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                BasicTextField(
                    value = typing,
                    onValueChange = { next ->
                        when {
                            next.length > typing.length ->
                                next.substring(typing.length).forEach(viewer::typeCharacter)
                            next.length < typing.length ->
                                repeat(typing.length - next.length) { viewer.backspace() }
                        }
                        typing = next
                    },
                    singleLine = true,
                    textStyle = TextStyle(color = Color.White, fontSize = 15.sp),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (typing.isEmpty()) {
                    Text("输入英文字母或数字", color = Color.White.copy(alpha = 0.35f), fontSize = 14.sp)
                }
            }
            TextButton(onClick = { viewer.enter() }) { Text("回车", color = Color.White) }
        }
    }
}

@Composable
private fun VncFrame(viewer: LocalVmViewer) {
    val image = viewer.frame ?: return
    var bounds by remember { mutableStateOf(IntSize.Zero) }
    Box(
        modifier = Modifier
            .fillMaxSize()
            .onSizeChanged { bounds = it }
            .pointerInput(image, bounds) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    toFramebuffer(down.position.x, down.position.y, bounds, image)?.let {
                        viewer.pointer(it.first, it.second, 1)
                    }
                    var lastX = down.position.x
                    var lastY = down.position.y
                    drag(down.id) { change ->
                        lastX = change.position.x
                        lastY = change.position.y
                        toFramebuffer(lastX, lastY, bounds, image)?.let {
                            viewer.pointer(it.first, it.second, 1)
                        }
                        change.consume()
                    }
                    toFramebuffer(lastX, lastY, bounds, image)?.let {
                        viewer.pointer(it.first, it.second, 0)
                    }
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
    }
}

/** Screen point → framebuffer pixel, or null outside the letterboxed picture. */
private fun toFramebuffer(
    x: Float,
    y: Float,
    bounds: IntSize,
    image: ImageBitmap,
): Pair<Int, Int>? {
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
