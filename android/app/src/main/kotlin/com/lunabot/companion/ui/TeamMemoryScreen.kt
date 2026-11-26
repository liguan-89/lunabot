package com.lunabot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
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
import com.lunabot.companion.core.TeamMemoryEntry
import com.lunabot.companion.core.TeamMemoryResponse
import com.lunabot.companion.core.TeamMemoryWriteResult
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.launch

/**
 * 一个团队分区的共享记忆。手机这里做完整管理：查看、添加、修改、置顶、删除，
 * 以及采纳或跳过智能体提出的记忆；分区说明本身仍留在电脑的团队地图上改。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TeamMemoryScreen(
    section: String,
    onBack: () -> Unit,
) {
    val environment = LocalCompanion.current
    val session = environment.session
    val connection by session.connection.collectAsState()
    val connectionId = connection?.id
    val scope = rememberCoroutineScope()

    var view by remember(section, connectionId) { mutableStateOf<TeamMemoryResponse?>(null) }
    var loading by remember(section, connectionId) { mutableStateOf(true) }
    var loaded by remember(section, connectionId) { mutableStateOf(false) }
    var refreshing by remember(section, connectionId) { mutableStateOf(false) }
    var busyId by remember(section, connectionId) { mutableStateOf<String?>(null) }
    var error by remember(section, connectionId) { mutableStateOf<String?>(null) }
    var adding by remember(section, connectionId) { mutableStateOf(false) }
    var draftKind by remember(section, connectionId) { mutableStateOf("term") }
    var draftName by remember(section, connectionId) { mutableStateOf("") }
    var draftDetail by remember(section, connectionId) { mutableStateOf("") }
    var editingId by remember(section, connectionId) { mutableStateOf<String?>(null) }
    var editName by remember(section, connectionId) { mutableStateOf("") }
    var editDetail by remember(section, connectionId) { mutableStateOf("") }
    var confirmDeleteId by remember(section, connectionId) { mutableStateOf<String?>(null) }
    var expandedHistoryId by remember(section, connectionId) { mutableStateOf<String?>(null) }

    suspend fun refresh(showProgress: Boolean = false) {
        if (showProgress) refreshing = true
        try {
            view = session.loadTeamMemory(section)
            loaded = true
        } finally {
            if (showProgress) refreshing = false
        }
    }

    suspend fun mutate(id: String?, call: suspend () -> TeamMemoryWriteResult) {
        if (busyId != null) return
        busyId = id ?: "new"
        error = null
        when (val result = call()) {
            is TeamMemoryWriteResult.Saved -> {
                view = view?.copy(entries = result.mutation.entries, loadedIds = result.mutation.loadedIds)
                if (id == null) {
                    draftName = ""
                    draftDetail = ""
                    adding = false
                }
                editingId = null
                confirmDeleteId = null
            }
            TeamMemoryWriteResult.Changed -> {
                error = TeamMemoryRules.CHANGED
                refresh()
            }
            TeamMemoryWriteResult.Unavailable -> error = TeamMemoryRules.WRITE_UNAVAILABLE
        }
        busyId = null
    }

    LaunchedEffect(section, connectionId) {
        loading = true
        try {
            refresh()
        } finally {
            loading = false
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
                text = view?.label?.takeIf { it.isNotBlank() }?.let { "$it · 团队记忆" } ?: "团队记忆",
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
                    .padding(horizontal = MinisPagePadding, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                val current = view
                when {
                    loading -> Row(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp),
                        horizontalArrangement = Arrangement.Center,
                    ) {
                        CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp, color = minisTertiary)
                    }
                    !loaded || current == null -> MemoryNotice(TeamMemoryRules.UNAVAILABLE)
                    else -> {
                        error?.let { MemoryNotice(it) }
                        val proposed = current.entries.filter { it.status == "proposed" }
                        val accepted = current.entries.filter { it.status == "accepted" }
                        if (proposed.isNotEmpty()) {
                            MemorySectionTitle("等待确认")
                            MemoryCard {
                                proposed.forEachIndexed { index, entry ->
                                    if (index > 0) MemoryDivider()
                                    ProposedMemoryRow(
                                        entry = entry,
                                        busy = busyId != null,
                                        onAccept = {
                                            scope.launch { mutate(entry.id) { session.acceptTeamMemory(section, entry) } }
                                        },
                                        onSkip = {
                                            scope.launch { mutate(entry.id) { session.removeTeamMemory(section, entry) } }
                                        },
                                    )
                                }
                            }
                        }
                        if (accepted.isEmpty() && proposed.isEmpty()) MemoryNotice(TeamMemoryRules.EMPTY)
                        TeamMemoryRules.kindsInUse(accepted).forEach { kind ->
                            val rows = accepted.filter { it.kind == kind }
                            if (rows.isNotEmpty()) {
                                MemorySectionTitle(TeamMemoryRules.kindLabel(kind))
                                MemoryCard {
                                    rows.forEachIndexed { index, entry ->
                                        if (index > 0) MemoryDivider()
                                        AcceptedMemoryRow(
                                            entry = entry,
                                            loaded = entry.id in current.loadedIds,
                                            busy = busyId != null,
                                            editing = editingId == entry.id,
                                            editName = if (editingId == entry.id) editName else entry.name,
                                            editDetail = if (editingId == entry.id) editDetail else entry.detail,
                                            confirmingDelete = confirmDeleteId == entry.id,
                                            historyExpanded = expandedHistoryId == entry.id,
                                            onToggleHistory = {
                                                expandedHistoryId = if (expandedHistoryId == entry.id) null else entry.id
                                            },
                                            onRestoreVersion = { version ->
                                                scope.launch { mutate(entry.id) { session.editTeamMemory(section, entry, version.name, version.detail) } }
                                            },
                                            onEditName = { editName = it },
                                            onEditDetail = { editDetail = it },
                                            onStartEdit = {
                                                editingId = entry.id
                                                editName = entry.name
                                                editDetail = entry.detail
                                                confirmDeleteId = null
                                            },
                                            onCancelEdit = { editingId = null },
                                            onSaveEdit = {
                                                scope.launch { mutate(entry.id) { session.editTeamMemory(section, entry, editName.trim(), editDetail.trim()) } }
                                            },
                                            onPin = {
                                                scope.launch { mutate(entry.id) { session.pinTeamMemory(section, entry, entry.pinned != true) } }
                                            },
                                            onDelete = {
                                                if (confirmDeleteId == entry.id) {
                                                    scope.launch { mutate(entry.id) { session.removeTeamMemory(section, entry) } }
                                                } else {
                                                    confirmDeleteId = entry.id
                                                }
                                            },
                                        )
                                    }
                                }
                            }
                        }
                        if (adding) {
                            MemorySectionTitle("添加一条")
                            MemoryCard {
                                Column(modifier = Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        TeamMemoryRules.KINDS.forEach { kind ->
                                            MemoryAction(
                                                text = TeamMemoryRules.kindLabel(kind),
                                                emphasized = draftKind == kind,
                                                enabled = busyId == null,
                                            ) { draftKind = kind }
                                        }
                                    }
                                    MemoryInput(value = draftName, onValueChange = { draftName = it }, label = "名字")
                                    MemoryInput(value = draftDetail, onValueChange = { draftDetail = it }, label = "内容", singleLine = false)
                                    Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                                        MemoryAction(
                                            text = if (busyId == "new") "添加中…" else "添加",
                                            emphasized = true,
                                            enabled = busyId == null && draftName.isNotBlank() && draftDetail.isNotBlank(),
                                        ) {
                                            scope.launch {
                                                mutate(null) { session.addTeamMemory(section, draftKind, draftName.trim(), draftDetail.trim()) }
                                            }
                                        }
                                        MemoryAction(text = "取消", emphasized = false, enabled = busyId == null) { adding = false }
                                    }
                                }
                            }
                        } else {
                            MemoryAction(text = "＋ 添加一条", emphasized = false, enabled = busyId == null) { adding = true }
                        }
                    }
                }
            }
        }
    }
}

internal object TeamMemoryRules {
    const val UNAVAILABLE = "读不到团队记忆：这台电脑未允许此手机查看，或团队已不存在。"
    const val WRITE_UNAVAILABLE = "没有保存上。请确认电脑在线后重试。"
    const val CHANGED = "这条记忆刚在别处改过，已为你刷新；请确认后再试。"
    const val EMPTY = "这个团队还没有共享记忆。"
    val KINDS = listOf("person", "place", "decision", "term")

    /** 已知四类在前；电脑未来新增的种类仍按服务端顺序画出来。 */
    fun kindsInUse(entries: List<TeamMemoryEntry>): List<String> =
        KINDS + entries.map { it.kind }.distinct().filter { it !in KINDS }

    fun kindLabel(kind: String): String = when (kind) {
        "person" -> "人物"
        "place" -> "地点"
        "decision" -> "决定"
        "term" -> "术语"
        else -> kind
    }

    /** 服务端把人手动写的来源记作 `you`；手机上与空来源一样显示成“你”。 */
    fun sourceName(entry: TeamMemoryEntry): String =
        entry.source.botName.takeIf { it.isNotBlank() && it != "you" } ?: "你"

    fun meta(entry: TeamMemoryEntry, loaded: Boolean): String {
        val date = if (entry.updatedAt > 0) DateFormat.getDateInstance(DateFormat.SHORT).format(Date(entry.updatedAt)) else ""
        val load = if (loaded) "已加载" else "可搜索"
        return listOf(sourceName(entry), date, load).filter { it.isNotBlank() }.joinToString(" · ")
    }
}

@Composable
private fun MemoryNotice(text: String) {
    Text(text = text, color = secondaryTint, fontSize = 14.sp, modifier = Modifier.padding(vertical = 4.dp))
}

@Composable
private fun MemorySectionTitle(text: String) {
    Text(text = text, color = minisSecondary, fontSize = 13.sp, fontWeight = FontWeight.Medium)
}

@Composable
private fun MemoryCard(content: @Composable () -> Unit) {
    val cardFill = if (minisIsDark()) minisGrouped else androidx.compose.ui.graphics.Color(0xFFF5F5F3)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(22.dp))
            .background(cardFill)
            .padding(horizontal = 14.dp),
    ) { content() }
}

@Composable
private fun MemoryDivider() {
    HorizontalDivider(thickness = 0.5.dp, color = minisSeparator.copy(alpha = 0.35f))
}

@Composable
private fun MemoryInput(value: String, onValueChange: (String) -> Unit, label: String, singleLine: Boolean = true) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        singleLine = singleLine,
        minLines = if (singleLine) 1 else 3,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun MemoryAction(text: String, emphasized: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Text(
        text = text,
        color = when {
            !enabled -> minisTertiary
            emphasized -> minisAccent
            else -> minisSecondary
        },
        fontSize = 13.sp,
        fontWeight = if (emphasized) FontWeight.Medium else FontWeight.Normal,
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 4.dp, vertical = 4.dp),
    )
}

@Composable
private fun MemoryTitleLine(entry: TeamMemoryEntry) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = entry.name,
            color = minisInk,
            fontSize = 15.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (entry.aliases.isNotEmpty()) {
            Text(
                text = "（也叫 ${entry.aliases.joinToString("、")}）",
                color = minisSecondary,
                fontSize = 12.5.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 4.dp),
            )
        }
    }
}

@Composable
private fun ProposedMemoryRow(entry: TeamMemoryEntry, busy: Boolean, onAccept: () -> Unit, onSkip: () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(text = TeamMemoryRules.kindLabel(entry.kind), color = minisAccent, fontSize = 12.sp)
        MemoryTitleLine(entry)
        Text(text = entry.detail, color = minisInk, fontSize = 14.sp)
        val quote = entry.source.quote
        Text(
            text = listOfNotNull(
                entry.source.botName.ifBlank { null }?.let { "来自 ${TeamMemoryRules.sourceName(entry)}" },
                quote?.let { "“$it”" },
            ).joinToString(" · "),
            color = minisSecondary,
            fontSize = 12.sp,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            MemoryAction(text = "记住", emphasized = true, enabled = !busy, onClick = onAccept)
            MemoryAction(text = "跳过", emphasized = false, enabled = !busy, onClick = onSkip)
        }
    }
}

@Composable
private fun AcceptedMemoryRow(
    entry: TeamMemoryEntry,
    loaded: Boolean,
    busy: Boolean,
    editing: Boolean,
    editName: String,
    editDetail: String,
    confirmingDelete: Boolean,
    historyExpanded: Boolean,
    onToggleHistory: () -> Unit,
    onRestoreVersion: (com.lunabot.companion.core.TeamMemoryHistoryEntry) -> Unit,
    onEditName: (String) -> Unit,
    onEditDetail: (String) -> Unit,
    onStartEdit: () -> Unit,
    onCancelEdit: () -> Unit,
    onSaveEdit: () -> Unit,
    onPin: () -> Unit,
    onDelete: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
        if (editing) {
            MemoryInput(value = editName, onValueChange = onEditName, label = "名字")
            MemoryInput(value = editDetail, onValueChange = onEditDetail, label = "内容", singleLine = false)
        } else {
            MemoryTitleLine(entry)
            Text(text = entry.detail, color = minisInk, fontSize = 14.sp)
        }
        Text(text = TeamMemoryRules.meta(entry, loaded), color = minisSecondary, fontSize = 12.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            if (editing) {
                MemoryAction(text = "保存", emphasized = true, enabled = !busy && editName.isNotBlank() && editDetail.isNotBlank(), onClick = onSaveEdit)
                MemoryAction(text = "取消", emphasized = false, enabled = !busy, onClick = onCancelEdit)
            } else {
                MemoryAction(text = if (entry.pinned == true) "取消置顶" else "置顶", emphasized = entry.pinned == true, enabled = !busy, onClick = onPin)
                MemoryAction(text = "编辑", emphasized = false, enabled = !busy, onClick = onStartEdit)
                if (!entry.history.isNullOrEmpty()) {
                    MemoryAction(text = "历史", emphasized = historyExpanded, enabled = !busy, onClick = onToggleHistory)
                }
                MemoryAction(text = if (confirmingDelete) "确认删除" else "删除", emphasized = confirmingDelete, enabled = !busy, onClick = onDelete)
            }
        }
        if (historyExpanded && !entry.history.isNullOrEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                entry.history.orEmpty().forEach { version ->
                    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = "${DateFormat.getDateInstance(DateFormat.SHORT).format(Date(version.at))}: ${version.name} — ${version.detail}",
                            color = minisSecondary,
                            fontSize = 12.sp,
                            modifier = Modifier.weight(1f),
                        )
                        MemoryAction(text = "恢复", emphasized = false, enabled = !busy) { onRestoreVersion(version) }
                    }
                }
            }
        }
    }
}
