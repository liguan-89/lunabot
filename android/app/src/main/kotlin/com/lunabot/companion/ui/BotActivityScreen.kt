package com.lunabot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.core.BotActivityRow
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.launch

/**
 * 一个智能体的活动记录只读页——桌面端 ActivityPanel 的手机版：用过的每件工具
 * 与求过的每次批准，新的在前。只读是有意的：批准的回答在会话里的卡片上，
 * 这页只是记录。null（电脑拒答/太旧/够不到）画一行说明，不是错误横幅——
 * 与 [BotMcpServersScreen] 同一个先例。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BotActivityScreen(
    botId: String,
    onBack: () -> Unit,
) {
    val environment = LocalCompanion.current
    val session = environment.session
    val state by session.state.collectAsState()
    val connection by session.connection.collectAsState()
    val connectionId = connection?.id
    val scope = rememberCoroutineScope()

    var rows by remember(botId, connectionId) { mutableStateOf<List<BotActivityRow>?>(null) }
    var loading by remember(botId, connectionId) { mutableStateOf(true) }
    var loaded by remember(botId, connectionId) { mutableStateOf(false) }
    var refreshing by remember(botId, connectionId) { mutableStateOf(false) }

    suspend fun refresh(showProgress: Boolean = false) {
        if (showProgress) refreshing = true
        try {
            rows = session.loadBotActivity(botId)
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

    val botName = state.bot(botId)?.name.orEmpty()

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
                text = BotActivityRules.TITLE,
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
            val current = rows
            when {
                // 列表之外的三个状态都要可滚动，下拉刷新在任何状态下都拉得动。
                loading -> ActivityScrollPage {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp),
                        horizontalArrangement = Arrangement.Center,
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(22.dp),
                            strokeWidth = 2.dp,
                            color = minisTertiary,
                        )
                    }
                }
                !loaded || current == null -> ActivityScrollPage {
                    ActivityNotice(BotActivityRules.UNAVAILABLE)
                }
                current.isEmpty() -> ActivityScrollPage {
                    ActivityNotice(BotActivityRules.emptyText(botName))
                }
                else -> ActivityList(current)
            }
        }
    }
}

@Composable
private fun ActivityScrollPage(content: @Composable () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .navigationBarsPadding()
            .padding(horizontal = MinisPagePadding, vertical = 8.dp),
    ) {
        content()
    }
}

@Composable
private fun ActivityNotice(text: String) {
    Text(
        text = text,
        color = secondaryTint,
        fontSize = 15.sp,
        modifier = Modifier.padding(horizontal = 24.dp, vertical = 16.dp),
    )
}

@Composable
private fun ActivityList(rows: List<BotActivityRow>) {
    val now = System.currentTimeMillis()
    val groups = remember(rows) { BotActivityRules.groupByDay(rows, now) }
    LazyColumn(
        modifier = Modifier.fillMaxSize().navigationBarsPadding(),
        contentPadding = PaddingValues(horizontal = MinisPagePadding, vertical = 8.dp),
    ) {
        // key 里带上组序号与行序号：at 写坏的行会落进空标题组，仅靠内容拼 key
        // 在重复行或散落的坏行之间会撞 key。
        groups.forEachIndexed { groupIndex, group ->
            item(key = "day:$groupIndex") {
                Text(
                    text = group.label,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    color = minisSecondary,
                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 6.dp),
                )
            }
            group.rows.forEachIndexed { index, row ->
                item(key = "row:$groupIndex:$index") {
                    ActivityLine(row)
                }
            }
        }
    }
}

/** 一行记录：左侧钟点，中间应用名与动作（及一行参数摘要），右侧结局徽标。 */
@Composable
private fun ActivityLine(row: BotActivityRow) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 7.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            text = BotActivityRules.timeText(row.at),
            fontSize = 12.sp,
            color = minisTertiary,
            modifier = Modifier.padding(top = 2.dp),
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = BotActivityRules.lineTitle(row),
                fontSize = 15.sp,
                color = minisInk,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            row.summary?.takeIf(String::isNotBlank)?.let { summary ->
                Text(
                    text = summary,
                    fontSize = 12.sp,
                    color = minisSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        val outcome = BotActivityRules.outcomeText(row.outcome)
        if (outcome.isNotEmpty()) {
            Text(
                text = outcome,
                fontSize = 11.5.sp,
                fontWeight = FontWeight.Medium,
                color = if (row.outcome == "failed" || row.outcome == "denied") minisDanger else minisSecondary,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
    }
}

/** 文案、分组与格式化，纯函数，离开 Compose 可测。 */
internal object BotActivityRules {
    const val TITLE = "活动"
    const val UNAVAILABLE = "读不到活动记录：这台电脑未允许此手机查看。"

    /** 与桌面端 zh 的 activity.panel.empty 同义。 */
    fun emptyText(botName: String): String =
        if (botName.isBlank()) "暂无内容。等智能体使用了工具或请求批准后，就会显示在这里。"
        else "暂无内容。等 $botName 使用了工具或请求批准后，就会显示在这里。"

    /** 结局徽标词，与桌面端 zh 的 activity.outcome.* 一致；新结局类型不画徽标。 */
    fun outcomeText(outcome: String): String = when (outcome) {
        "ran" -> "已运行"
        "failed" -> "已失败"
        "running" -> "运行中"
        "allowed" -> "已允许"
        "denied" -> "已拒绝"
        "waiting" -> "需要你处理"
        else -> ""
    }

    /** 行的主文：应用名在前（Gmail · 已发送邮件），没有应用名只有动作。 */
    fun lineTitle(row: BotActivityRow): String {
        val label = row.label.ifBlank { row.tool }
        return row.app?.takeIf(String::isNotBlank)?.let { "$it · $label" } ?: label
    }

    /** 行的钟点，HH:mm；服务器写坏的 at 不断行，画占位。 */
    fun timeText(isoAt: String, zone: ZoneId = ZoneId.systemDefault()): String {
        val at = parse(isoAt) ?: return "--:--"
        return DateTimeFormatter.ofPattern("HH:mm").format(at.atZone(zone))
    }

    /**
     * 按本地日期分组，组与组内都保持服务端的新在前顺序。标题：今天/昨天/
     * 同年 M月d日/跨年 yyyy年M月d日。
     */
    fun groupByDay(
        rows: List<BotActivityRow>,
        nowMillis: Long,
        zone: ZoneId = ZoneId.systemDefault(),
    ): List<DayGroup> {
        val today = Instant.ofEpochMilli(nowMillis).atZone(zone).toLocalDate()
        val groups = mutableListOf<DayGroup>()
        rows.forEach { row ->
            val label = dayLabel(row.at, today, zone)
            val last = groups.lastOrNull()
            if (last != null && last.label == label) {
                last.rows += row
            } else {
                groups += DayGroup(label, mutableListOf(row))
            }
        }
        return groups
    }

    class DayGroup(val label: String, val rows: MutableList<BotActivityRow>)

    private fun dayLabel(isoAt: String, today: LocalDate, zone: ZoneId): String {
        val at = parse(isoAt)?.atZone(zone) ?: return ""
        val date = at.toLocalDate()
        val formatter = if (date.year == today.year) {
            DateTimeFormatter.ofPattern("M月d日")
        } else {
            DateTimeFormatter.ofPattern("yyyy年M月d日")
        }
        return when (date) {
            today -> "今天"
            today.minusDays(1) -> "昨天"
            else -> formatter.format(at)
        }
    }

    private fun parse(isoAt: String): Instant? = runCatching { Instant.parse(isoAt) }.getOrNull()
}
