package com.lunabot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.core.TeamMapResponse
import kotlinx.coroutines.launch

/**
 * 团队地图只读页——桌面端 team-map 的手机版：哪些 bot 两两有协作 DM，
 * 哪些委派正排队、正在跑。只读是有意的：team-map 本来就没有写路由，
 * 这页只是观测面。null（电脑拒答/太旧/够不到）画一行说明，与
 * [BotActivityScreen] 同一个先例。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TeamMapScreen(
    onBack: () -> Unit,
) {
    val environment = LocalCompanion.current
    val session = environment.session
    val state by session.state.collectAsState()
    val connection by session.connection.collectAsState()
    val connectionId = connection?.id
    val scope = rememberCoroutineScope()

    var map by remember(connectionId) { mutableStateOf<TeamMapResponse?>(null) }
    var loading by remember(connectionId) { mutableStateOf(true) }
    var loaded by remember(connectionId) { mutableStateOf(false) }
    var refreshing by remember(connectionId) { mutableStateOf(false) }

    suspend fun refresh(showProgress: Boolean = false) {
        if (showProgress) refreshing = true
        try {
            map = session.loadTeamMap()
            loaded = true
        } finally {
            if (showProgress) refreshing = false
        }
    }

    LaunchedEffect(connectionId) {
        loading = true
        try {
            refresh()
        } finally {
            loading = false
        }
    }

    fun botName(botId: String) = state.bot(botId)?.name ?: botId

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
                text = "团队地图",
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                color = minisInk,
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
            val current = map
            Column(
                verticalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp, vertical = 8.dp),
            ) {
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
                    !loaded || current == null -> Text(
                        text = "这台电脑答不了团队地图——版本太旧，或现在够不到它。",
                        fontSize = 13.5.sp,
                        color = minisSecondary,
                        modifier = Modifier.padding(vertical = 12.dp),
                    )
                    else -> {
                        if (current.running.isEmpty() && current.queued.isEmpty() && current.collaborations.isEmpty()) {
                            Text(
                                text = "还没有协作——bot 之间还没有说过话。",
                                fontSize = 13.5.sp,
                                color = minisSecondary,
                                modifier = Modifier.padding(vertical = 12.dp),
                            )
                        }
                        if (current.running.isNotEmpty()) {
                            TeamMapSection("进行中") {
                                current.running.forEach { edge ->
                                    TeamMapRow(
                                        title = "${botName(edge.sourceBotId)} → ${botName(edge.targetBotId)}",
                                        subtitle = "委派正在跑",
                                    )
                                }
                            }
                        }
                        if (current.queued.isNotEmpty()) {
                            TeamMapSection("排队中") {
                                current.queued.forEach { edge ->
                                    TeamMapRow(
                                        title = "${botName(edge.sourceBotId)} → ${botName(edge.targetBotId)}",
                                        subtitle = "等对方腾出手",
                                    )
                                }
                            }
                        }
                        if (current.collaborations.isNotEmpty()) {
                            TeamMapSection("协作") {
                                current.collaborations.forEach { collab ->
                                    val names = collab.botIds.map(::botName)
                                    TeamMapRow(
                                        title = names.joinToString(" ↔ "),
                                        subtitle = "两两直聊",
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TeamMapSection(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            text = title,
            fontSize = 12.5.sp,
            fontWeight = FontWeight.SemiBold,
            color = minisSecondary,
        )
        Column(
            verticalArrangement = Arrangement.spacedBy(2.dp),
            modifier = Modifier
                .fillMaxWidth()
                .background(minisCard, RoundedCornerShape(14.dp))
                .padding(horizontal = 14.dp, vertical = 8.dp),
        ) {
            content()
        }
    }
}

@Composable
private fun TeamMapRow(title: String, subtitle: String) {
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 7.dp)) {
        Text(text = title, fontSize = 14.sp, fontWeight = FontWeight.Medium, color = minisInk)
        Text(text = subtitle, fontSize = 12.sp, color = minisSecondary)
    }
}
