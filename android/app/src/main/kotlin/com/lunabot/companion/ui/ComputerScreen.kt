package com.lunabot.companion.ui

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import androidx.activity.compose.BackHandler
import com.lunabot.companion.core.Message
import com.lunabot.companion.vnc.LocalVmViewerScreen
import com.lunabot.companion.vnc.ThisComputerViewerScreen
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * A bot's computer, live — the port of `ios/App/ComputerView.swift`.
 *
 * Watch-only: no clicking, no typing, no zoom. The frame is fit to the bounds and
 * lands as a letterbox, because the desktop is wider than the phone.
 *
 * Frames are expensive — hundreds of kilobytes of base64 each — so `Session` only
 * asks for them while this screen is on. [ScreenWatch] holds exactly one watcher
 * for the composable's lifetime.
 */
@Composable
fun ComputerScreen(botId: String, onBack: () -> Unit) {
    val environment = LocalCompanion.current
    val session = environment.session
    val scope = rememberCoroutineScope()
    val state by session.state.collectAsState()

    val bot = remember(state, botId) { state.bot(botId) }
    if (bot == null) {
        LaunchedEffect(botId) { onBack() }
        return
    }

    // A Local VM has a real desktop behind the still; taking it over replaces
    // this screen (and stops the still watcher below from running at all).
    var takingOver by remember(botId) { mutableStateOf(false) }
    var confirmingTakeover by remember(botId) { mutableStateOf(false) }
    // This computer's own screen has no VNC behind it, so it is its own screen from the start: it polls the desktop's
    // capture route and stays read-only until the person taps 接管控制 there.
    if (ComputerPolicy.isThisComputer(bot)) {
        BackHandler(onBack = onBack)
        ThisComputerViewerScreen(botId = botId, title = bot.name, onExit = onBack)
        return
    }
    if (takingOver) {
        BackHandler { takingOver = false }
        LocalVmViewerScreen(botId = botId, title = bot.name, onExit = { takingOver = false })
        return
    }

    // Enter asks the stream for screens, leave asks it to stop and drops the
    // frame. Backgrounding does not pass through here: the stream is torn down
    // whole and resumes with screens still on, which is what iOS does.
    DisposableEffect(botId) {
        val watch = ScreenWatch(
            start = session::watchScreen,
            stop = session::stopWatchingScreen,
        )
        watch.watch(botId)
        onDispose { watch.release() }
    }

    // The viewer is black edge to edge. The root paints the strips outside its
    // safe-drawing inset, so this screen replaces that colour and asks the
    // system for light icons while it is up; both are restored on dispose.
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

    // A completed turn that touched the screen settles one capture into the
    // transcript. When there is no live frame (the common case for a bot that
    // works through the shell), that still is the honest picture of the
    // computer — far better than the same black rectangle as "nothing".
    val threadId = bot.threadId
    val lastScreen = remember(state, threadId) {
        state.visibleTranscript(threadId).lastOrNull { it.kind == Message.Kind.SCREEN }
    }
    var fallback by remember(threadId) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(threadId, lastScreen?.id) {
        val message = lastScreen ?: return@LaunchedEffect
        fallback = withContext(Dispatchers.Default) {
            val bytes = message.png
                ?.let { runCatching { Base64.decode(it, Base64.DEFAULT) }.getOrNull() }
                ?: if (message.hasImage == true) {
                    runCatching { session.image(threadId, message.id) }.getOrNull()
                } else {
                    null
                }
            bytes
                ?.let { runCatching { BitmapFactory.decodeByteArray(it, 0, it.size) }.getOrNull() }
                ?.asImageBitmap()
        }
    }

    // Cloud and Local VM have an HTTP capture route, so the viewer can show a
    // fresh still even while the bot is idle. Live frames win when they exist;
    // this is what makes an idle "截图" mean something on those surfaces.
    var polled by remember(botId) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(botId, bot.computer) {
        if (!ComputerPolicy.hasRemoteCapture(bot)) return@LaunchedEffect
        while (true) {
            val current = session.state.value.bot(botId)
            // A running turn already streams frames; a second capture would
            // steal command bandwidth from the bot.
            if (session.state.value.screens[botId] == null) {
                val bytes = session.captureScreen(bot)?.data
                if (bytes != null) {
                    polled = withContext(Dispatchers.Default) {
                        runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }
                            .getOrNull()
                            ?.asImageBitmap()
                    }
                }
            }
            delay(if (current?.busy == true) 4_000 else 30_000)
        }
    }

    var confirming by remember { mutableStateOf(false) }
    var opening by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }

    val frame = state.screens[botId]
    val liveImage: ImageBitmap? = remember(frame) {
        frame?.data
            ?.let { runCatching { BitmapFactory.decodeByteArray(it, 0, it.size) }.getOrNull() }
            ?.asImageBitmap()
    }
    val snapshot = liveImage == null && polled != null
    val stale = liveImage == null && polled == null && fallback != null
    val image = liveImage ?: polled ?: fallback

    Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
        if (image != null) {
            Image(
                bitmap = image,
                contentDescription = "${bot.name} 的电脑",
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            Waiting(
                headline = ComputerPolicy.waitingHeadline(bot),
                explanation = ComputerPolicy.waitingExplanation(bot),
                busy = bot.busy == true,
            )
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 14.dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            TouchTarget(onClick = onBack, contentDescription = "返回") {
                Box(
                    modifier = Modifier
                        .size(40.dp)
                        .background(Color.White.copy(alpha = 0.18f), CircleShape)
                        .border(0.5.dp, Color.White.copy(alpha = 0.28f), CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                        contentDescription = null,
                        tint = Color.White,
                        modifier = Modifier.size(20.dp),
                    )
                }
            }
            Text(
                text = bot.name,
                color = Color.White,
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            if (bot.computer == "vm") {
                TextButton(onClick = { confirmingTakeover = true }) {
                    Text(ComputerPolicy.LOCAL_TAKEOVER, color = Color.White, fontSize = 14.sp)
                }
            }
            Text(
                text = ComputerPolicy.statusLabel(bot, stale = stale, snapshot = snapshot),
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                color = if (bot.busy == true && !stale) {
                    minisSuccess
                } else {
                    Color.White.copy(alpha = 0.6f)
                },
            )
        }

        // The still needs a caption, or it reads as a frozen live feed.
        if (stale && !ComputerPolicy.showsCloudDesktop(bot)) {
            Text(
                text = ComputerPolicy.STALE_NOTE,
                fontSize = 12.sp,
                color = Color.White.copy(alpha = 0.6f),
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(horizontal = 28.dp, vertical = 18.dp),
            )
        }

        if (ComputerPolicy.showsCloudDesktop(bot)) {
            Column(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .background(Color.Black.copy(alpha = 0.55f))
                    .padding(horizontal = 18.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                failure?.let {
                    Text(
                        text = it,
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.error,
                        textAlign = TextAlign.Center,
                    )
                }
                Button(
                    onClick = { confirming = true },
                    enabled = !opening,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (opening) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(18.dp),
                            strokeWidth = 2.dp,
                        )
                    } else {
                        Text(ComputerPolicy.OPEN_DESKTOP)
                    }
                }
                Text(
                    text = ComputerPolicy.VNC_NOTE,
                    fontSize = 12.sp,
                    color = Color.White.copy(alpha = 0.6f),
                    textAlign = TextAlign.Center,
                )
            }
        }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text(ComputerPolicy.CONFIRM_TITLE) },
            text = { Text(ComputerPolicy.CONFIRM_MESSAGE) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirming = false
                        opening = true
                        failure = null
                        scope.launch {
                            try {
                                // Minted per join, handed straight to the browser
                                // and kept nowhere: no field, no saved state, no
                                // log. The next join asks the harness again.
                                failure = environment.openCloudDesktop(session.cloudDesktop(bot))
                            } catch (error: Throwable) {
                                if (error is kotlinx.coroutines.CancellationException) throw error
                                failure = error.message ?: "无法打开云端桌面。"
                            } finally {
                                opening = false
                            }
                        }
                    },
                ) { Text("打开桌面") }
            },
            dismissButton = {
                TextButton(onClick = { confirming = false }) { Text("取消") }
            },
        )
    }

    if (confirmingTakeover) {
        AlertDialog(
            onDismissRequest = { confirmingTakeover = false },
            title = { Text(ComputerPolicy.LOCAL_TAKEOVER_TITLE) },
            text = { Text(ComputerPolicy.LOCAL_TAKEOVER_MESSAGE) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmingTakeover = false
                        takingOver = true
                    },
                ) { Text(ComputerPolicy.LOCAL_TAKEOVER) }
            },
            dismissButton = {
                TextButton(onClick = { confirmingTakeover = false }) { Text("取消") }
            },
        )
    }
}

/**
 * Nothing to show yet. The spinner is only honest while a turn is running; an
 * idle bot is not waiting for a frame that is already on its way, and spinning
 * there made a working feature look broken.
 */
@Composable
private fun Waiting(headline: String, explanation: String?, busy: Boolean) {
    Column(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (busy) {
            CircularProgressIndicator(
                modifier = Modifier.size(24.dp),
                strokeWidth = 2.dp,
                color = Color.White,
            )
        }
        Text(
            text = headline,
            fontSize = 15.sp,
            color = Color.White.copy(alpha = 0.7f),
        )
        explanation?.let {
            Text(
                text = it,
                fontSize = 13.sp,
                color = Color.White.copy(alpha = 0.45f),
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(horizontal = 32.dp),
            )
        }
    }
}
