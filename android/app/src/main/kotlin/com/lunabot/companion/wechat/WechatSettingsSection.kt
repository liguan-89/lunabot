// Adapted from Mika's WechatApi and WechatRuntime (Apache-2.0).
package com.lunabot.companion.wechat

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Switch
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.ui.MinisCardShape
import com.lunabot.companion.ui.minisCard
import com.lunabot.companion.ui.minisDanger
import com.lunabot.companion.ui.minisInk
import com.lunabot.companion.ui.minisSecondary
import com.lunabot.companion.ui.minisSeparator
import com.lunabot.companion.ui.minisTertiary
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Settings › 手机工具 › 微信.
 *
 * Drawn as its own card, in its own file, with the same tokens as the screen's
 * own sections: the screen contributes one call, not a hundred lines. The card
 * owns nothing durable — every switch and every action goes through the one
 * [WechatRuntime] the service also uses.
 *
 * What this screen never shows: the bot token, the polling key, and message
 * text. The QR payload is the one thing rendered, and it lives only as long as
 * the bind sheet.
 */
@Composable
fun WechatSettingsSection(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val runtime = remember { WechatRuntimeHost.of(context) }
    val binder = remember(runtime) {
        WechatBinder(
            runtime = runtime,
            scope = scope,
            onBound = { WechatService.start(context) },
        )
    }
    val connection by runtime.state.collectAsState()
    val bind by binder.state.collectAsState()

    // The store is plain synchronous state, and reading it unwraps the token
    // through the Keystore — so every read happens in a LaunchedEffect on IO,
    // never in composition. Until the first read lands, the card renders the
    // neutral "not bound" shape rather than a guess.
    var bound by remember { mutableStateOf(false) }
    var enabled by remember { mutableStateOf(false) }
    var needsRebind by remember { mutableStateOf(false) }
    var confirmingUnbind by remember { mutableStateOf(false) }
    var saveResult by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }

    suspend fun reread() = withContext(Dispatchers.IO) {
        val account = runtime.store.account()
        val isEnabled = runtime.store.enabled()
        val rebind = runtime.store.needsRebind()
        runtime.refresh()
        bound = account != null
        enabled = isEnabled
        needsRebind = rebind
    }

    LaunchedEffect(bind, connection) { reread() }
    // Leaving the screen abandons a scan in progress; the binding itself is
    // durable and unaffected.
    DisposableEffect(binder) { onDispose { binder.cancel() } }

    WechatCard(modifier) {
        WechatRow(
            title = "微信消息转发",
            subtitle = when {
                needsRebind -> "绑定已失效，需要重新扫码。"
                !bound -> "扫码绑定后，微信消息会转给已配对的电脑。"
                enabled -> "已开启，微信私聊消息会转给电脑。"
                else -> "已暂停，绑定仍然保留。"
            },
            trailing = {
                if (bound) {
                    Switch(
                        checked = enabled,
                        onCheckedChange = { on ->
                            enabled = on
                            runtime.setEnabled(on)
                            if (on) WechatService.start(context) else WechatService.stop(context)
                        },
                    )
                }
            },
        )

        if (!bound || needsRebind) {
            WechatDivider()
            WechatRow(
                title = if (needsRebind) "重新绑定微信" else "绑定微信",
                subtitle = "用微信扫描二维码；也可以先把二维码存到相册，再从微信的扫一扫里选相册。",
                chevron = true,
                enabled = bind !is WechatBindState.Preparing,
                onClick = {
                    saveResult = null
                    binder.start()
                },
            )
        }

        when (val state = bind) {
            WechatBindState.Idle, is WechatBindState.Bound -> Unit
            WechatBindState.Preparing -> {
                WechatDivider()
                WechatRow(title = "正在获取二维码…", trailing = {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                })
            }
            is WechatBindState.Waiting -> {
                WechatDivider()
                Column(
                    modifier = Modifier.fillMaxWidth().padding(16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text("用微信扫描二维码", fontSize = 14.sp, color = minisInk)
                    // The payload is a QR *value*, drawn here; no image leaves
                    // the phone and nothing is written until "save" is tapped.
                    QrCodeCanvas(
                        content = state.content,
                        description = "微信绑定二维码",
                        modifier = Modifier.size(220.dp),
                    )
                    Text(
                        text = "打开微信 → 右上角 + → 扫一扫，或者先存到相册再从相册里选。",
                        fontSize = 12.sp,
                        lineHeight = 16.sp,
                        color = minisSecondary,
                        textAlign = TextAlign.Center,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(
                            onClick = {
                                saving = true
                                saveResult = null
                                scope.launch {
                                    val path = binder.saveQrToAlbum(context, state.content)
                                    saveResult = path ?: "保存失败，请检查相册权限后重试。"
                                    saving = false
                                }
                            },
                            enabled = !saving,
                        ) {
                            Text(if (state.savedPath == null) "保存到相册" else "重新保存", fontSize = 13.sp)
                        }
                        TextButton(onClick = { binder.cancel() }) {
                            Text("取消", fontSize = 13.sp)
                        }
                    }
                    state.savedPath?.let {
                        Text("已保存到 $it", fontSize = 12.sp, color = minisSecondary)
                    }
                    saveResult?.let { message ->
                        Text(message, fontSize = 12.sp, color = minisSecondary)
                    }
                }
            }
            is WechatBindState.Failed -> {
                WechatDivider()
                WechatRow(
                    title = state.message,
                    titleColor = minisDanger,
                    subtitle = "点上面的「绑定微信」重试。",
                )
            }
        }

        if (bound) {
            WechatDivider()
            WechatRow(
                title = "连接状态",
                value = connectionLabel(connection, needsRebind),
            )
            WechatDivider()
            WechatRow(
                title = "消息范围",
                value = "仅私聊文字与图片",
                subtitle = "群聊、朋友圈、支付和联系人都不转发。",
            )
            WechatDivider()
            WechatRow(
                title = "解除绑定",
                destructive = true,
                onClick = { confirmingUnbind = true },
            )
        }
    }

    if (confirmingUnbind) {
        AlertDialog(
            onDismissRequest = { confirmingUnbind = false },
            title = { Text("解除微信绑定？") },
            text = { Text("会删除这台手机上的微信绑定，需要重新扫码才能再开启。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmingUnbind = false
                        runtime.unbind()
                        WechatService.stop(context)
                        bound = false
                        enabled = false
                        needsRebind = false
                    },
                ) {
                    Text("解除绑定", color = minisDanger)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmingUnbind = false }) { Text("取消") }
            },
        )
    }
}

private fun connectionLabel(state: WechatConnectionState, needsRebind: Boolean): String = when {
    needsRebind -> "需要重新绑定"
    else -> when (state) {
        WechatConnectionState.Connected -> "已连接"
        WechatConnectionState.Connecting -> "连接中"
        WechatConnectionState.Off -> "已暂停"
        WechatConnectionState.NeedsBinding -> "需要重新绑定"
        is WechatConnectionState.Failed -> "连接失败"
    }
}

/**
 * The QR, drawn module by module.
 *
 * The matrix is built once per payload and the canvas paints runs of dark
 * modules so a version-10 code is a few hundred rectangles rather than a few
 * thousand.
 */
@Composable
internal fun QrCodeCanvas(content: String, description: String, modifier: Modifier = Modifier) {
    val matrix = remember(content) { runCatching { encodeQr(content) }.getOrNull() }
    Box(
        modifier = modifier
            .clip(MinisCardShape)
            .background(Color.White)
            .semantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) {
        if (matrix == null) {
            Text("二维码无法生成", fontSize = 12.sp, color = Color.Black)
            return@Box
        }
        // Four modules of quiet zone, as the spec requires and as scanners expect.
        val quiet = 4
        val modules = matrix.size + quiet * 2
        // fillMaxSize, not fillMaxWidth: a Canvas is a Spacer, which has no
        // intrinsic height, so width-only fills measure zero high and every
        // module below scales to nothing — the box shows a blank white square.
        Canvas(modifier = Modifier.fillMaxSize().padding(10.dp)) {
            val module = size.minDimension / modules
            drawRect(Color.White)
            for (y in 0 until matrix.size) {
                var x = 0
                while (x < matrix.size) {
                    if (!matrix[x, y]) {
                        x++
                        continue
                    }
                    val start = x
                    while (x < matrix.size && matrix[x, y]) x++
                    drawRect(
                        color = Color.Black,
                        topLeft = Offset((start + quiet) * module, (y + quiet) * module),
                        size = Size((x - start) * module, module),
                    )
                }
            }
        }
    }
}

@Composable
private fun WechatCard(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = modifier) {
        Text(
            text = "微信",
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            letterSpacing = 0.2.sp,
            color = minisInk.copy(alpha = 0.45f),
            modifier = Modifier.semantics { heading() },
        )
        Column(
            modifier = Modifier.fillMaxWidth().clip(MinisCardShape).background(minisCard),
        ) {
            content()
        }
    }
}

@Composable
private fun WechatDivider() {
    HorizontalDivider(
        modifier = Modifier.padding(horizontal = 16.dp),
        thickness = 0.5.dp,
        color = minisSeparator,
    )
}

@Composable
private fun WechatRow(
    title: String,
    subtitle: String? = null,
    value: String? = null,
    titleColor: Color? = null,
    destructive: Boolean = false,
    enabled: Boolean = true,
    chevron: Boolean = false,
    trailing: (@Composable () -> Unit)? = null,
    onClick: (() -> Unit)? = null,
) {
    val tone = when {
        !enabled -> minisTertiary
        destructive -> minisDanger
        titleColor != null -> titleColor
        else -> minisInk
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(enabled = enabled, onClick = onClick) else Modifier)
            .heightIn(min = if (subtitle == null) 50.dp else 58.dp)
            .padding(horizontal = 16.dp, vertical = if (subtitle == null) 0.dp else 9.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = title,
                fontSize = 15.sp,
                color = tone,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            subtitle?.let {
                Text(
                    text = it,
                    fontSize = 12.sp,
                    lineHeight = 16.sp,
                    color = minisSecondary,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        value?.let {
            Text(
                text = it,
                fontSize = 13.sp,
                textAlign = TextAlign.End,
                color = minisSecondary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 180.dp),
            )
        }
        trailing?.invoke()
        if (chevron) {
            Text("›", fontSize = 16.sp, color = minisTertiary)
        }
    }
}
