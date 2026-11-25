package com.lunabot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.core.McpServerEntry
import kotlinx.coroutines.launch

/**
 * 一个智能体可启用的 MCP 服务器只读页。只读是有意的：开关在电脑的 MCP 设置里，
 * 手机本来就拿不到 `/api/mcp/servers`（命令与参数）——这条路由只回答名字与状态。
 * null（电脑拒答/太旧/够不到）画一行说明，与 [BotActivityScreen] 同一个先例。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BotMcpServersScreen(
    botId: String,
    onBack: () -> Unit,
) {
    val environment = LocalCompanion.current
    val session = environment.session
    val connection by session.connection.collectAsState()
    val connectionId = connection?.id
    val scope = rememberCoroutineScope()

    var servers by remember(botId, connectionId) { mutableStateOf<List<McpServerEntry>?>(null) }
    var loading by remember(botId, connectionId) { mutableStateOf(true) }
    var loaded by remember(botId, connectionId) { mutableStateOf(false) }
    var refreshing by remember(botId, connectionId) { mutableStateOf(false) }

    suspend fun refresh(showProgress: Boolean = false) {
        if (showProgress) refreshing = true
        try {
            servers = session.loadMcpServers(botId)
            loaded = true
        } finally {
            if (showProgress) refreshing = false
        }
    }

    LaunchedEffect(botId, connectionId) {
        loading = true
        try {
            refresh()
        } finally {
            loading = false
        }
    }

    // 电脑上拨动的开关不会推 bot 帧；不监听这个信号，页面上就一直是进来时的样子。
    LaunchedEffect(botId, connectionId) {
        session.mcpChanged.collect {
            servers = session.loadMcpServers(botId)
            loaded = true
        }
    }

    Column(modifier = Modifier.fillMaxSize().background(minisCanvas)) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            TouchTarget(onClick = onBack, contentDescription = "返回", size = 44.dp) {
                Box(
                    modifier = Modifier
                        .size(44.dp)
                        .museFloatingPill(CircleShape, elevation = 4.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                        contentDescription = null,
                        tint = minisInk,
                        modifier = Modifier.size(20.dp),
                    )
                }
            }
            Text(
                text = "MCP 服务器",
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                color = minisInk,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .align(Alignment.Center)
                    .padding(horizontal = 56.dp),
            )
        }

        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { scope.launch { refresh(showProgress = true) } },
            modifier = Modifier.fillMaxSize(),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .navigationBarsPadding()
                    .padding(horizontal = MinisPagePadding, vertical = 16.dp),
            ) {
                val current = servers
                when {
                    loading -> Row(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp),
                        horizontalArrangement = Arrangement.Center,
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(22.dp),
                            strokeWidth = 2.dp,
                            color = minisTertiary,
                        )
                    }
                    !loaded || current == null -> McpNotice(McpServerRules.UNAVAILABLE)
                    current.isEmpty() -> McpNotice(McpServerRules.EMPTY)
                    else -> McpServerListCard(current)
                }
            }
        }
    }
}

internal object McpServerRules {
    const val UNAVAILABLE = "读不到 MCP 服务器：这台电脑未允许此手机查看。"
    const val EMPTY = "此智能体没有可启用的 MCP 服务器。"

    /**
     * The three switches that decide whether a server runs for this bot, in the
     * order the person can fix them: the server itself, an explicit refusal for
     * this bot, then the bot's own switch.
     */
    fun stateText(server: McpServerEntry): String = when {
        !server.enabled -> "已在电脑上停用"
        server.offFor == true -> "不为此智能体启动"
        !server.on -> "此智能体已关闭"
        else -> "已启用"
    }
}

@Composable
private fun McpNotice(text: String) {
    Text(
        text = text,
        color = secondaryTint,
        fontSize = 15.sp,
        modifier = Modifier.padding(vertical = 8.dp),
    )
}

@Composable
private fun McpServerListCard(servers: List<McpServerEntry>) {
    val cardFill = if (minisIsDark()) minisGrouped else androidx.compose.ui.graphics.Color(0xFFF5F5F3)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(22.dp))
            .background(cardFill)
            .padding(horizontal = 16.dp),
    ) {
        servers.forEachIndexed { index, server ->
            if (index > 0) MinisDivider()
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = server.name,
                    fontSize = 17.sp,
                    color = minisInk,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = McpServerRules.stateText(server),
                    fontSize = 14.sp,
                    color = if (server.enabled && server.on && server.offFor != true) {
                        minisSuccess
                    } else {
                        secondaryTint
                    },
                )
            }
        }
    }
}
