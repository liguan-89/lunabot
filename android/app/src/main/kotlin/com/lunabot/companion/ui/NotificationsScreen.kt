package com.lunabot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.core.InboxResult
import com.lunabot.companion.core.InboxRowLine
import com.lunabot.companion.core.InboxViewResponse
import com.lunabot.companion.core.NotificationLogRow
import kotlinx.coroutines.launch

/**
 * 通知收件箱——这台电脑的通知日志与「需要你处理」收件箱，一个全局页，
 * 两个分段。手机版的纪律比桌面简单：历史列表、点按已读、全部已读、
 * 非 ask 行可办结；卡片的回答在会话里做，这里一行也不展开。
 *
 * 降级：收件箱 404（团队云上没有的人、太旧的电脑）画一行「这里没有收件箱」，
 * 不是错误横幅；够不到电脑是另一行。通知日志拒答/太旧同样只有一行说明。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NotificationsScreen(
    onBack: () -> Unit,
) {
    val environment = LocalCompanion.current
    val session = environment.session
    val connection by session.connection.collectAsState()
    val connectionId = connection?.id
    val scope = rememberCoroutineScope()

    var segment by rememberSaveable { mutableIntStateOf(0) }

    var inbox by remember(connectionId) { mutableStateOf<InboxResult?>(null) }
    var notifications by remember(connectionId) { mutableStateOf<List<NotificationLogRow>?>(null) }
    var loading by remember(connectionId) { mutableStateOf(true) }
    var loaded by remember(connectionId) { mutableStateOf(false) }
    var refreshing by remember(connectionId) { mutableStateOf(false) }

    suspend fun refresh(showProgress: Boolean = false) {
        if (showProgress) refreshing = true
        try {
            inbox = session.loadInbox()
            notifications = session.loadNotifications()
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

    fun markInboxRead(row: InboxRowLine) {
        if (!row.unread) return
        // 先本地翻已读让点按有反应，服务端的最新视图到了再整体换掉；
        // 失败静默——下一次刷新带回真实状态。
        (inbox as? InboxResult.Loaded)?.let { current ->
            inbox = InboxResult.Loaded(
                current.view.copy(
                    rows = current.view.rows.map { if (it.id == row.id) it.copy(unread = false) else it },
                ),
            )
        }
        scope.launch {
            session.markInboxRow(row.id, done = false)?.let { view ->
                inbox = InboxResult.Loaded(view)
            }
        }
    }

    fun markInboxDone(row: InboxRowLine) {
        scope.launch {
            session.markInboxRow(row.id, done = true)?.let { view ->
                inbox = InboxResult.Loaded(view)
            }
        }
    }

    fun markNotificationRead(row: NotificationLogRow) {
        if (row.read) return
        notifications = notifications?.map { if (it.id == row.id) it.copy(read = true) else it }
        scope.launch { session.markNotificationRead(row.id) }
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
                text = NotificationRules.TITLE,
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                color = minisInk,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .align(Alignment.Center)
                    .padding(horizontal = 56.dp),
            )
            // 「全部已读」只在通知日志分段、且确有未读时出现——点了什么也不变的
            // 按钮不如不在。
            val unreadCount = notifications?.count { !it.read } ?: 0
            if (segment == 1 && unreadCount > 0) {
                Text(
                    text = NotificationRules.READ_ALL,
                    fontSize = 13.5.sp,
                    fontWeight = FontWeight.Medium,
                    color = minisAccent,
                    modifier = Modifier
                        .align(Alignment.CenterEnd)
                        .clip(RoundedCornerShape(8.dp))
                        .clickable {
                            notifications = notifications?.map { it.copy(read = true) }
                            scope.launch { session.markAllNotificationsRead() }
                        }
                        .padding(horizontal = 8.dp, vertical = 6.dp),
                )
            }
        }

        NotificationSegmentRow(
            segment = segment,
            inboxBadge = (inbox as? InboxResult.Loaded)?.view?.rows?.count { NotificationRules.inboxRowWaits(it) } ?: 0,
            onSelect = { segment = it },
        )

        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { scope.launch { refresh(showProgress = true) } },
            modifier = Modifier.fillMaxSize(),
        ) {
            when {
                // 列表之外的三个状态都要可滚动，下拉刷新在任何状态下都拉得动。
                loading -> NotificationScrollPage {
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
                !loaded -> NotificationScrollPage {
                    NotificationNotice(NotificationRules.UNREACHABLE)
                }
                segment == 0 -> InboxSegment(
                    inbox = inbox,
                    now = System.currentTimeMillis(),
                    onRead = ::markInboxRead,
                    onDone = ::markInboxDone,
                )
                else -> NotificationLogSegment(
                    rows = notifications,
                    now = System.currentTimeMillis(),
                    onRead = ::markNotificationRead,
                )
            }
        }
    }
}

@Composable
private fun NotificationSegmentRow(segment: Int, inboxBadge: Int, onSelect: (Int) -> Unit) {
    val dark = minisIsDark()
    val activePillFill = if (dark) minisGrouped else androidx.compose.ui.graphics.Color(0xFFF1F1EF)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp)
            .clip(CircleShape)
            .background(minisCard)
            .padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        listOf(NotificationRules.SEGMENT_INBOX, NotificationRules.SEGMENT_LOG).forEachIndexed { index, label ->
            val selected = segment == index
            Box(
                modifier = Modifier
                    .weight(1f)
                    .clip(CircleShape)
                    .background(if (selected) activePillFill else androidx.compose.ui.graphics.Color.Transparent)
                    .clickable { onSelect(index) }
                    .padding(vertical = 8.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = if (index == 0 && inboxBadge > 0) "$label（$inboxBadge）" else label,
                    fontSize = 14.5.sp,
                    fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (selected) minisInk else minisSecondary,
                    maxLines = 1,
                )
            }
        }
    }
}

@Composable
private fun InboxSegment(
    inbox: InboxResult?,
    now: Long,
    onRead: (InboxRowLine) -> Unit,
    onDone: (InboxRowLine) -> Unit,
) {
    when (val current = inbox) {
        // inbox 在 loaded 之前是 null——加载中的骨架已经由外层 spinner 画过，
        // 这里什么也不用画。
        null -> NotificationScrollPage {}
        is InboxResult.Missing -> NotificationScrollPage {
            NotificationNotice(NotificationRules.INBOX_MISSING)
        }
        is InboxResult.Unreachable -> NotificationScrollPage {
            NotificationNotice(NotificationRules.INBOX_UNREACHABLE)
        }
        is InboxResult.Loaded -> {
            if (current.view.rows.isEmpty()) {
                NotificationScrollPage {
                    NotificationNotice(NotificationRules.INBOX_EMPTY)
                }
            } else {
                InboxList(current.view, now, onRead, onDone)
            }
        }
    }
}

@Composable
private fun InboxList(
    view: InboxViewResponse,
    now: Long,
    onRead: (InboxRowLine) -> Unit,
    onDone: (InboxRowLine) -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize().navigationBarsPadding(),
        contentPadding = PaddingValues(horizontal = MinisPagePadding, vertical = 8.dp),
    ) {
        view.rows.forEachIndexed { index, row ->
            item(key = row.id) {
                InboxRowView(
                    row = row,
                    now = now,
                    onRead = { onRead(row) },
                    onDone = { onDone(row) },
                )
                if (index < view.rows.lastIndex) {
                    HorizontalDivider(
                        modifier = Modifier.padding(start = 17.dp),
                        thickness = 0.5.dp,
                        color = minisSeparator.copy(alpha = 0.4f),
                    )
                }
            }
        }
    }
}

/** 收件箱一行：左侧圆点（等待你处理的行才亮），中间来源与正文，右侧时间与办结。 */
@Composable
private fun InboxRowView(
    row: InboxRowLine,
    now: Long,
    onRead: () -> Unit,
    onDone: () -> Unit,
) {
    val waits = NotificationRules.inboxRowWaits(row)
    val dimmed = row.tab == "done"
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onRead)
            .padding(vertical = 9.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            modifier = Modifier
                .padding(top = 7.dp)
                .size(7.dp)
                .background(
                    when {
                        dimmed -> androidx.compose.ui.graphics.Color.Transparent
                        waits -> minisDanger
                        row.unread -> minisAccent
                        else -> androidx.compose.ui.graphics.Color.Transparent
                    },
                    CircleShape,
                ),
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = NotificationRules.inboxRowTitle(row),
                fontSize = 15.sp,
                fontWeight = if (row.unread) FontWeight.SemiBold else FontWeight.Normal,
                color = if (dimmed) minisTertiary else minisInk,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (row.text.isNotBlank()) {
                Text(
                    text = row.text,
                    fontSize = 13.sp,
                    color = if (dimmed) minisTertiary else minisSecondary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(
                text = RelativeStamp.list(row.at.toDouble(), now),
                fontSize = 12.sp,
                color = minisTertiary,
            )
            // ask 行必须回答不能办结——它的出口在会话里的卡片上，办结键不给他。
            if (!dimmed && row.kind != "ask") {
                Text(
                    text = NotificationRules.DONE,
                    fontSize = 12.5.sp,
                    color = minisAccent,
                    modifier = Modifier
                        .padding(top = 4.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .clickable(onClick = onDone)
                        .padding(horizontal = 6.dp, vertical = 3.dp),
                )
            }
        }
    }
}

@Composable
private fun NotificationLogSegment(
    rows: List<NotificationLogRow>?,
    now: Long,
    onRead: (NotificationLogRow) -> Unit,
) {
    when {
        rows == null -> NotificationScrollPage {
            NotificationNotice(NotificationRules.UNREACHABLE)
        }
        rows.isEmpty() -> NotificationScrollPage {
            NotificationNotice(NotificationRules.LOG_EMPTY)
        }
        else -> LazyColumn(
            modifier = Modifier.fillMaxSize().navigationBarsPadding(),
            contentPadding = PaddingValues(horizontal = MinisPagePadding, vertical = 8.dp),
        ) {
            rows.forEachIndexed { index, row ->
                item(key = row.id) {
                    NotificationRowView(row, now, onRead = { onRead(row) })
                    if (index < rows.lastIndex) {
                        HorizontalDivider(
                            modifier = Modifier.padding(start = 17.dp),
                            thickness = 0.5.dp,
                            color = minisSeparator.copy(alpha = 0.4f),
                        )
                    }
                }
            }
        }
    }
}

/** 通知日志一行：未读圆点、标题与一行来源正文、右侧相对时间。 */
@Composable
private fun NotificationRowView(
    row: NotificationLogRow,
    now: Long,
    onRead: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onRead)
            .padding(vertical = 9.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            modifier = Modifier
                .padding(top = 7.dp)
                .size(7.dp)
                .background(
                    if (row.read) androidx.compose.ui.graphics.Color.Transparent else minisAccent,
                    CircleShape,
                ),
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = row.title,
                fontSize = 15.sp,
                fontWeight = if (row.read) FontWeight.Normal else FontWeight.SemiBold,
                color = minisInk,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val detail = NotificationRules.notificationDetail(row)
            if (detail.isNotEmpty()) {
                Text(
                    text = detail,
                    fontSize = 13.sp,
                    color = minisSecondary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Text(
            text = RelativeStamp.list(row.at.toDouble(), now),
            fontSize = 12.sp,
            color = minisTertiary,
            modifier = Modifier.padding(top = 2.dp),
        )
    }
}

@Composable
private fun NotificationScrollPage(content: @Composable () -> Unit) {
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
private fun NotificationNotice(text: String) {
    Text(
        text = text,
        color = secondaryTint,
        fontSize = 15.sp,
        modifier = Modifier.padding(horizontal = 24.dp, vertical = 16.dp),
    )
}

/** 文案与行的语义判断，纯函数，离开 Compose 可测。 */
internal object NotificationRules {
    const val TITLE = "通知"
    const val SEGMENT_INBOX = "待处理"
    const val SEGMENT_LOG = "全部"
    const val READ_ALL = "全部已读"
    const val DONE = "办结"

    /** 旧电脑没有这条路由、会话被拒、传输失败，日志段同一行说明。 */
    const val UNREACHABLE = "读不到通知：这台电脑未允许、版本太旧，或当前够不到。"

    /** 404 的两种来源同义：团队云上没有这个收件箱，或电脑旧得还没有它。 */
    const val INBOX_MISSING = "这台电脑没有收件箱。"
    const val INBOX_UNREACHABLE = "读不到收件箱：电脑当前够不到。"
    const val INBOX_EMPTY = "没有等你处理的事。"
    const val LOG_EMPTY = "还没有通知。"

    /**
     * 这一行还在等人——决定圆点与徽章计数，与桌面端 count 同一个口径：
     * needs-you 全部，加未读的 info；done 永远不等。
     */
    fun inboxRowWaits(row: InboxRowLine): Boolean =
        row.tab == "needs-you" || (row.tab == "info" && row.unread)

    /** 行标题：谁来的。经手的行带上转手者，一行说清来历。 */
    fun inboxRowTitle(row: InboxRowLine): String {
        val from = row.from.name.ifBlank { "智能体" }
        val workingFor = row.workingFor?.name?.takeIf(String::isNotBlank)
        return if (workingFor != null) "$from · 为 $workingFor 工作" else from
    }

    /** 日志行第二行：智能体名 · 正文；没名字或没正文时有多少画多少。 */
    fun notificationDetail(row: NotificationLogRow): String {
        val body = row.body.trim()
        val name = row.botName.trim()
        return when {
            name.isEmpty() -> body
            body.isEmpty() -> name
            else -> "$name · $body"
        }
    }
}
