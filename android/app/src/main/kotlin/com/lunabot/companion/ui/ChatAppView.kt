package com.lunabot.companion.ui

import android.webkit.WebView
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.net.toUri
import com.lunabot.companion.core.AppDocument
import com.lunabot.companion.core.AppRpcOutcome
import com.lunabot.companion.core.Chat
import com.lunabot.companion.core.Message
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

private fun appVersionName(context: android.content.Context): String =
    runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() ?: "unknown"

/** One live app at a time. Lazy rows release as they leave composition. */
object ChatAppPool {
    var owner by mutableStateOf<String?>(null)
        private set
    private val heights = mutableMapOf<String, Int>()

    fun claim(key: String) {
        owner = key
    }

    fun claimIfFree(key: String) {
        if (owner == null) owner = key
    }

    fun release(key: String) {
        if (owner == key) owner = null
    }

    fun height(key: String): Int? = heights[key]

    fun rememberHeight(key: String, height: Int) {
        heights[key] = height
        if (heights.size > 80) heights.remove(heights.keys.first())
    }
}

@Composable
fun ChatAppMessageCard(
    chat: Chat,
    message: Message,
    openLink: ((String, Message) -> Unit)?,
) {
    val payload = message.app
    if (payload == null || payload.v != 1 || payload.doc.isEmpty() || payload.title.isEmpty()) {
        AppSummaryCard(message)
        return
    }

    val key = "${chat.threadId}:${message.id}:${payload.rev}"
    val poolOwner = ChatAppPool.owner
    val ownsPool = poolOwner == key
    val session = LocalCompanion.current.session
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val documentCache = remember { ChatAppDocumentCache(File(context.cacheDir, "app-documents")) }
    val dark = minisIsDark()
    val configuration = LocalConfiguration.current
    val density = LocalDensity.current
    val maxHeightDp = (configuration.screenHeightDp * 0.70f).toInt().coerceIn(240, 720)
    // WebView page units are CSS pixels, which match Android dp in a normally
    // scaled viewport; passing physical pixels would let a page grow several
    // times past the intended screen fraction.
    var widthCss by remember(key) { mutableIntStateOf((configuration.screenWidthDp - 52).coerceAtLeast(320)) }
    val maxHeightCss = maxHeightDp

    var document by remember(key) { mutableStateOf<AppDocument?>(null) }
    var loadError by remember(key) { mutableStateOf<String?>(null) }
    var collapsed by remember(key) { mutableStateOf(false) }
    var initialized by remember(key) { mutableStateOf(false) }
    var bridgeProblem by remember(key) { mutableStateOf<String?>(null) }
    var heightDp by remember(key, payload.height) { mutableIntStateOf((ChatAppPool.height(key) ?: payload.height ?: 160).coerceIn(48, maxHeightDp)) }
    var reloadTick by remember(key) { mutableIntStateOf(0) }

    LaunchedEffect(poolOwner, collapsed, key) {
        if (poolOwner == null && !collapsed) ChatAppPool.claimIfFree(key)
    }

    DisposableEffect(key) {
        onDispose { ChatAppPool.release(key) }
    }

    LaunchedEffect(ownsPool, key, reloadTick, collapsed) {
        if (!ownsPool || collapsed) return@LaunchedEffect
        document = null
        loadError = null
        initialized = false
        bridgeProblem = null
        try {
            val fetched = session.appDocument(chat.threadId, message.id)
            val usable = fetched.takeIf { it.valid && it.rev >= payload.rev }
                ?: throw IllegalStateException("电脑返回了无法识别的应用页面。")
            document = usable
            withContext(Dispatchers.IO) { documentCache.write(chat.threadId, usable) }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            val cached = withContext(Dispatchers.IO) { documentCache.read(chat.threadId, message.id, payload.rev) }
            if (cached != null) document = cached
            else loadError = error.message ?: "应用页面加载失败。"
        }
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .musePaperCard()
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(payload.title, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = minisInk, maxLines = 1)
                Text(
                    when {
                        payload.source == "mcp" -> "来自 ${payload.mcp?.serverTitle ?: payload.mcp?.server ?: "MCP 服务器"} 的应用"
                        chat is Chat.BotChat -> "由 ${chat.bot.name} 制作的页面"
                        else -> "Bot 页面"
                    },
                    fontSize = 12.sp,
                    color = minisTertiary,
                )
            }
            if (ownsPool && !collapsed && document != null) {
                Text(
                    "重新加载",
                    fontSize = 12.sp,
                    color = minisAccent,
                    modifier = Modifier.clickable { reloadTick += 1 }.padding(8.dp),
                )
            }
        }

        payload.blocked?.let { blocked ->
            Text("此应用已被阻止：$blocked", fontSize = 12.sp, color = minisDanger)
        }

        when {
            !ownsPool -> ChatAppClosed(
                text = "此页面在手机上按需打开。",
                action = "打开应用",
                onClick = { ChatAppPool.claim(key) },
            )
            collapsed -> ChatAppClosed(
                text = "应用已由页面收起到摘要。",
                action = "重新打开",
                onClick = {
                    collapsed = false
                    reloadTick += 1
                    ChatAppPool.claim(key)
                },
            )
            loadError != null -> ChatAppClosed(
                text = listOfNotNull(message.text?.takeIf { it.isNotBlank() }, loadError).joinToString("\n"),
                action = "重试",
                danger = true,
                onClick = { reloadTick += 1 },
            )
            document == null -> Box(
                modifier = Modifier.fillMaxWidth().height(heightDp.dp),
                contentAlignment = Alignment.Center,
            ) { CircularProgressIndicator(color = minisAccent, strokeWidth = 2.dp) }
            else -> {
                val doc = document ?: return@Column
                val delegate = remember(doc.messageId, doc.rev, reloadTick) {
                    object : ChatAppBridgeDelegate {
                        override suspend fun rpc(method: String, params: JsonObject): AppRpcOutcome =
                            session.appRpc((chat as? Chat.BotChat)?.bot?.id.orEmpty(), chat.threadId, message.id, method, params)

                        override suspend fun message(text: String) {
                            val botId = (chat as? Chat.BotChat)?.bot?.id ?: throw IllegalStateException("此线程不能代表 bot 发送消息。")
                            session.sendAppMessage(botId, chat.threadId, message.id, text, UUID.randomUUID().toString())
                        }

                        override suspend fun openLink(url: String) {
                            val uri = url.toUri()
                            val valid = url.length <= 2_048 &&
                                (uri.scheme == "https" || uri.scheme == "http") &&
                                !uri.host.isNullOrEmpty() && uri.userInfo == null
                            if (!valid) throw IllegalStateException("只允许打开网页链接。")
                            if (openLink != null) openLink.invoke(url, message)
                            else CustomTabsIntent.Builder().build().launchUrl(context, uri)
                        }

                        override suspend fun context(update: JsonObject) {
                            val botId = (chat as? Chat.BotChat)?.bot?.id ?: throw IllegalStateException("此线程不能保存应用上下文。")
                            session.postAppContext(botId, chat.threadId, message.id, update)
                        }

                        override fun resize(height: Int) {
                            heightDp = height.coerceIn(48, maxHeightCss)
                            ChatAppPool.rememberHeight(key, heightDp)
                        }

                        override fun initialized() {
                            initialized = true
                        }

                        override fun teardownRequested() {
                            collapsed = true
                            ChatAppPool.release(key)
                        }

                        override fun failure(text: String) {
                            bridgeProblem = text
                        }
                    }
                }
                val controller = remember(doc.messageId, doc.rev, reloadTick) {
                    ChatAppWebController(context, scope, delegate, appVersionName(context))
                }
                if (!controller.supported) {
                    ChatAppClosed(
                        text = listOfNotNull(message.text?.takeIf { it.isNotBlank() }, "当前 Android System WebView 太旧，无法安全运行应用页面。请更新 WebView 后重试。").joinToString("\n"),
                        action = "显示摘要",
                        onClick = { collapsed = true },
                    )
                } else {
                    AndroidView(
                        factory = { viewContext ->
                            WebView(viewContext).also(controller::attach)
                        },
                        update = { view ->
                            controller.attach(view)
                            controller.resize(widthCss, maxHeightCss)
                            controller.load(doc, widthCss, maxHeightCss, dark, heightDp)
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(heightDp.dp)
                            .onSizeChanged { size ->
                                widthCss = with(density) { size.width.toDp() }.value.toInt().coerceAtLeast(1)
                            },
                    )
                    DisposableEffect(controller) {
                        onDispose {
                            controller.teardown()
                            controller.destroy()
                        }
                    }
                    if (!initialized) {
                        Text("正在连接应用…", fontSize = 12.sp, color = minisTertiary)
                    }
                }
            }
        }

        bridgeProblem?.let { problem ->
            Text(problem, fontSize = 12.sp, color = minisDanger)
        }
        document?.network?.refused?.takeIf { it.isNotEmpty() }?.let { refused ->
            Text("已拦截 ${refused.size} 个页面声明外的网络源", fontSize = 11.sp, color = minisTertiary)
        }
        document?.blocked?.let { blocked ->
            Text(blocked.text ?: blocked.reason, fontSize = 11.sp, color = minisTertiary)
        }
    }
}

@Composable
private fun ChatAppClosed(text: String, action: String, danger: Boolean = false, onClick: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(text, fontSize = 13.sp, color = if (danger) minisDanger else minisSecondary)
        Text(
            action,
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
            color = minisAccent,
            modifier = Modifier.clickable(onClick = onClick).padding(vertical = 8.dp),
        )
    }
}
