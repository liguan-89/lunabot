package com.lunabot.companion.ui

import android.graphics.BitmapFactory
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.core.BotDataResponse
import com.lunabot.companion.core.DataCardEntry
import com.lunabot.companion.core.DataPageResponse
import com.lunabot.companion.core.DataTableEntry
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * 一个智能体的 Data 只读页。只读是有意的：跑 SQL、改卡片、导出都留在电脑上，
 * 这条路由群本来就只为手机设计了读面——sheet 概览、表与卡片结果的分页浏览、
 * 图表卡的服务端渲染 PNG。
 *
 * 表浏览是页内状态不是目的地：表层 ↔ 行浏览两级，返回键先回表层再出页。
 * null（拒答/太旧/够不到/引擎不可用）画一行说明，与 [BotActivityScreen] 同一个先例。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BotDataScreen(
    botId: String,
    initialCardId: String? = null,
    onBack: () -> Unit,
) {
    val environment = LocalCompanion.current
    val session = environment.session
    val connection by session.connection.collectAsState()
    val connectionId = connection?.id
    val scope = rememberCoroutineScope()

    var data by remember(botId, connectionId) { mutableStateOf<BotDataResponse?>(null) }
    var loading by remember(botId, connectionId) { mutableStateOf(true) }
    var loaded by remember(botId, connectionId) { mutableStateOf(false) }
    var refreshing by remember(botId, connectionId) { mutableStateOf(false) }
    var browsing by remember(botId, connectionId) { mutableStateOf<BotDataRules.BrowseTarget?>(null) }

    suspend fun refresh(showProgress: Boolean = false) {
        if (showProgress) refreshing = true
        try {
            data = session.loadBotData(botId)
            loaded = true
        } finally {
            if (showProgress) refreshing = false
        }
    }

    LaunchedEffect(botId, connectionId) {
        loading = true
        try {
            refresh()
            // A data_show receipt's chip lands here on its exact card.
            if (initialCardId != null && browsing == null) {
                data?.sheet?.cards?.firstOrNull { it.id == initialCardId }?.let { card ->
                    browsing = BotDataRules.BrowseTarget(table = null, cardId = card.id, title = card.title.ifBlank { card.id })
                }
            }
        } finally {
            loading = false
        }
    }

    // 行浏览压在表层上：返回键先退回表层，表层上才退出页面。
    BackHandler(enabled = browsing != null) { browsing = null }

    Column(modifier = Modifier.fillMaxSize().background(minisCanvas)) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            TouchTarget(
                onClick = { if (browsing != null) browsing = null else onBack() },
                contentDescription = "返回",
                size = 44.dp,
            ) {
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
                text = browsing?.title ?: BotDataRules.TITLE,
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
            val current = data
            val target = browsing
            when {
                loading -> DataScrollPage {
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
                !loaded || current == null -> DataScrollPage {
                    DataNotice(BotDataRules.UNAVAILABLE)
                }
                target != null -> DataTableBrowser(
                    botId = botId,
                    target = target,
                    connectionId = connectionId,
                )
                current.tables.isEmpty() && current.sheet.cards.isEmpty() && current.sheet.sources.isEmpty() -> DataScrollPage {
                    DataNotice(BotDataRules.EMPTY)
                }
                else -> DataSheetView(
                    data = current,
                    botId = botId,
                    connectionId = connectionId,
                    onBrowse = { browsing = it },
                )
            }
        }
    }
}

/** sheet 概览：卡片、表、来源三段，一屏滚到底。 */
@Composable
private fun DataSheetView(
    data: BotDataResponse,
    botId: String,
    connectionId: String?,
    onBrowse: (BotDataRules.BrowseTarget) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .navigationBarsPadding()
            .padding(horizontal = MinisPagePadding, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        if (data.sheet.cards.isNotEmpty()) {
            DataSection(label = "卡片") {
                data.sheet.cards.forEachIndexed { index, card ->
                    if (index > 0) {
                        HorizontalDivider(thickness = 0.5.dp, color = minisSeparator.copy(alpha = 0.25f))
                    }
                    DataCardRow(card, botId, connectionId, onBrowse)
                }
            }
        }
        if (data.tables.isNotEmpty()) {
            DataSection(label = "表") {
                data.tables.forEachIndexed { index, table ->
                    if (index > 0) {
                        HorizontalDivider(thickness = 0.5.dp, color = minisSeparator.copy(alpha = 0.25f))
                    }
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onBrowse(BotDataRules.BrowseTarget(table = table.name, cardId = null, title = table.name)) }
                            .padding(vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = table.name,
                                fontSize = 15.sp,
                                color = minisInk,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                text = BotDataRules.tableDetail(table),
                                fontSize = 12.5.sp,
                                color = minisSecondary,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                            contentDescription = null,
                            tint = minisTertiary,
                            modifier = Modifier.size(16.dp),
                        )
                    }
                }
            }
        }
        if (data.sheet.sources.isNotEmpty()) {
            DataSection(label = "来源") {
                data.sheet.sources.forEachIndexed { index, source ->
                    if (index > 0) {
                        HorizontalDivider(thickness = 0.5.dp, color = minisSeparator.copy(alpha = 0.25f))
                    }
                    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
                        Text(
                            text = source.name,
                            fontSize = 15.sp,
                            color = minisInk,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            text = BotDataRules.sourceDetail(source.kind, source.rowCount),
                            fontSize = 12.5.sp,
                            color = minisSecondary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun DataSection(label: String, content: @Composable () -> Unit) {
    Column {
        Text(
            text = label,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            color = minisSecondary,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 6.dp),
        )
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(minisCard)
                .padding(horizontal = 14.dp),
        ) {
            content()
        }
    }
}

/**
 * 一张卡片：图表卡内联渲染 PNG，就绪的表卡可点进分页浏览，文本卡画原文，
 * 运行中与失败的卡只有状态行——它们没有结果可看。
 */
@Composable
private fun DataCardRow(
    card: DataCardEntry,
    botId: String,
    connectionId: String?,
    onBrowse: (BotDataRules.BrowseTarget) -> Unit,
) {
    val browsable = BotDataRules.cardBrowsable(card)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .then(
                if (browsable) {
                    Modifier.clickable {
                        onBrowse(BotDataRules.BrowseTarget(table = null, cardId = card.id, title = card.title.ifBlank { card.id }))
                    }
                } else {
                    Modifier
                },
            )
            .padding(vertical = 10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = card.title.ifBlank { card.id },
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
                color = minisInk,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = BotDataRules.cardDetail(card),
                fontSize = 12.5.sp,
                color = if (card.status == "failed") minisDanger else minisSecondary,
                maxLines = 1,
            )
        }
        val text = card.text
        when {
            card.kind == "chart" && card.status == "ready" -> DataChartImage(card.id, botId, connectionId)
            card.kind == "text" && !text.isNullOrBlank() -> Text(
                text = text,
                fontSize = 13.5.sp,
                color = minisSecondary,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
    }
}

/** 图表卡的 PNG：进入组合才取，滚走即取消；取不到就什么都不画。 */
@Composable
private fun DataChartImage(cardId: String, botId: String, connectionId: String?) {
    val environment = LocalCompanion.current
    val dark = minisIsDark()
    var bytes by remember(cardId, connectionId) { mutableStateOf<ByteArray?>(null) }
    LaunchedEffect(cardId, connectionId, dark) {
        bytes = environment.session.loadBotDataCardImage(botId, cardId, width = 800, scale = 2, dark = dark)
    }
    val bitmap = remember(bytes) {
        bytes?.let { runCatching { BitmapFactory.decodeByteArray(it, 0, it.size) }.getOrNull() }
    }
    if (bitmap != null) {
        Image(
            bitmap = bitmap.asImageBitmap(),
            contentDescription = null,
            contentScale = ContentScale.FillWidth,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 8.dp)
                .clip(RoundedCornerShape(10.dp)),
        )
    }
}

/**
 * 表或卡片结果的分页浏览。一页 100 行；上一页/下一页按 offset 走，
 * 横滚看全列——列多的表在手机上没有比这更老实的画法。
 */
@Composable
private fun DataTableBrowser(
    botId: String,
    target: BotDataRules.BrowseTarget,
    connectionId: String?,
) {
    val environment = LocalCompanion.current
    var page by remember(target, connectionId) { mutableStateOf<DataPageResponse?>(null) }
    var offset by remember(target, connectionId) { mutableIntStateOf(0) }
    var loading by remember(target, connectionId) { mutableStateOf(true) }
    var failed by remember(target, connectionId) { mutableStateOf(false) }

    LaunchedEffect(target, connectionId, offset) {
        loading = true
        try {
            val loaded = environment.session.loadBotDataPage(botId, target.table, target.cardId, offset, BotDataRules.PAGE_SIZE)
            page = loaded
            failed = loaded == null
        } finally {
            loading = false
        }
    }

    Column(modifier = Modifier.fillMaxSize().navigationBarsPadding()) {
        val current = page
        when {
            loading && current == null -> Row(
                modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp),
                horizontalArrangement = Arrangement.Center,
            ) {
                CircularProgressIndicator(
                    modifier = Modifier.size(22.dp),
                    strokeWidth = 2.dp,
                    color = minisTertiary,
                )
            }
            failed -> DataNotice(BotDataRules.PAGE_UNAVAILABLE)
            current != null -> {
                if (current.rows.isEmpty()) {
                    DataNotice(BotDataRules.PAGE_EMPTY)
                } else {
                    // 横滚包整个网格而不是每行各滚各的：列对齐是表格的半条命。
                    Column(
                        modifier = Modifier
                            .weight(1f)
                            .verticalScroll(rememberScrollState())
                            .horizontalScroll(rememberScrollState())
                            .padding(horizontal = MinisPagePadding),
                    ) {
                        DataGridRow(current.columns.map { it.name }, header = true)
                        current.rows.forEach { row ->
                            DataGridRow(row.map { BotDataRules.cellText(it) }, header = false)
                        }
                    }
                }
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = MinisPagePadding, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = BotDataRules.pagePosition(current),
                        fontSize = 12.5.sp,
                        color = minisSecondary,
                        modifier = Modifier.weight(1f),
                    )
                    if (loading) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(14.dp).padding(end = 0.dp),
                            strokeWidth = 2.dp,
                            color = minisTertiary,
                        )
                    }
                    PageButton(text = "上一页", enabled = offset > 0 && !loading) {
                        offset = (offset - BotDataRules.PAGE_SIZE).coerceAtLeast(0)
                    }
                    PageButton(
                        text = "下一页",
                        enabled = offset + current.rows.size < current.rowCount && !loading,
                    ) {
                        offset += BotDataRules.PAGE_SIZE
                    }
                }
            }
        }
    }
}

@Composable
private fun DataGridRow(cells: List<String?>, header: Boolean) {
    Row {
        cells.forEach { cell ->
            Text(
                text = cell ?: "NULL",
                fontSize = if (header) 12.sp else 12.5.sp,
                fontWeight = if (header) FontWeight.SemiBold else FontWeight.Normal,
                color = when {
                    header -> minisSecondary
                    cell == null -> minisTertiary
                    else -> minisInk
                },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .width(120.dp)
                    .padding(vertical = 5.dp, horizontal = 4.dp),
            )
        }
    }
}

@Composable
private fun PageButton(text: String, enabled: Boolean, onClick: () -> Unit) {
    Text(
        text = text,
        fontSize = 13.5.sp,
        fontWeight = FontWeight.Medium,
        color = if (enabled) minisAccent else minisTertiary,
        modifier = Modifier
            .padding(start = 8.dp)
            .clip(RoundedCornerShape(8.dp))
            .then(if (enabled) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 10.dp, vertical = 6.dp),
    )
}

@Composable
private fun DataScrollPage(content: @Composable () -> Unit) {
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
private fun DataNotice(text: String) {
    Text(
        text = text,
        color = secondaryTint,
        fontSize = 15.sp,
        modifier = Modifier.padding(horizontal = 24.dp, vertical = 16.dp),
    )
}

/** 文案、分页与单元格格式化，纯函数，离开 Compose 可测。 */
internal object BotDataRules {
    const val TITLE = "数据"
    const val PAGE_SIZE = 100

    /** 拒答、太旧、够不到、引擎不可用（503）同一行说明，不细分。 */
    const val UNAVAILABLE = "读不到数据：这台电脑未允许此手机查看、版本太旧，或数据引擎不可用。"
    const val EMPTY = "这个智能体还没有数据。"
    const val PAGE_UNAVAILABLE = "这一页读不到：电脑当前够不到，或结果已被清掉。"
    const val PAGE_EMPTY = "这里没有行。"

    /** 浏览目标：表名或卡片 id 有且只能有一个——服务端对 page 接口的同一个要求。 */
    data class BrowseTarget(val table: String?, val cardId: String?, val title: String)

    /** 只有就绪的表卡有结果可翻；图表卡的图内联在卡片上，文本卡原文即是全部。 */
    fun cardBrowsable(card: DataCardEntry): Boolean =
        card.kind == "table" && card.status == "ready"

    /** 卡片行的右侧细节：状态不就绪先说状态，就绪的表卡说行数。 */
    fun cardDetail(card: DataCardEntry): String {
        if (card.status == "running") return "运行中"
        if (card.status == "failed") return "已失败"
        val kind = when (card.kind) {
            "chart" -> "图表"
            "table" -> "表"
            "text" -> "文本"
            else -> card.kind
        }
        val rows = card.rowCount
        return if (rows != null && card.kind == "table") "$kind · ${rowCountText(rows)}" else kind
    }

    fun tableDetail(table: DataTableEntry): String =
        "${rowCountText(table.rowCount)} · ${table.columns.size} 列"

    fun sourceDetail(kind: String, rowCount: Long): String =
        if (kind.isBlank()) rowCountText(rowCount) else "$kind · ${rowCountText(rowCount)}"

    /** 页脚位置行：「1–100 / 共 3,204 行」，空页只有总数。 */
    fun pagePosition(page: DataPageResponse): String {
        if (page.rows.isEmpty()) return "共 ${page.rowCount} 行"
        val first = page.offset + 1
        val last = page.offset + page.rows.size
        return "$first–$last / 共 ${page.rowCount} 行"
    }

    /** 单元格文本：JSON null 画 null（页面再画成灰的 NULL），其余取原始内容。 */
    fun cellText(cell: kotlinx.serialization.json.JsonElement): String? =
        if (cell is JsonNull) null else cell.jsonPrimitive.content

    private fun rowCountText(count: Long): String = "$count 行"
}
