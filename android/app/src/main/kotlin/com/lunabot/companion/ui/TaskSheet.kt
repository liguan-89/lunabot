package com.lunabot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.core.Bot
import com.lunabot.companion.core.BotTask
import com.lunabot.companion.core.Chat
import com.lunabot.companion.core.Session
import kotlinx.coroutines.launch
import com.lunabot.companion.core.ChatTarget
import com.lunabot.companion.core.target
import com.lunabot.companion.core.forTask
import com.lunabot.companion.core.BotThreadGroup
import com.lunabot.companion.core.isSnoozed
import com.lunabot.companion.core.threadGroups
import com.lunabot.companion.core.isArchived

/**
 * Separate contexts for an agent or channel — the port of
 * `ios/App/TaskManagerView.swift`.
 *
 * A compact dialog rather than a screen, because tasks are conversation
 * navigation, not host configuration.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaskSheet(
    chat: Chat,
    onDismiss: () -> Unit,
    onSelectTask: (ChatTarget) -> Unit,
    onDeletedCurrent: () -> Unit = {},
    nowMillis: () -> Long = System::currentTimeMillis,
) {
    val session = LocalCompanion.current.session
    val scope = rememberCoroutineScope()
    val state by session.state.collectAsState()

    // The live record, so busy and the task list stay current as frames land.
    val current = remember(state, chat) {
        when (chat) {
            is Chat.BotChat -> state.bots.firstOrNull { it.id == chat.id }?.let {
                Chat.BotChat(it.forTask(chat.threadId) ?: it)
            }
            is Chat.RoomChat -> state.rooms.firstOrNull { it.id == chat.id }?.let(Chat::RoomChat)
        }
    }
    if (current == null) {
        // Deleted while the sheet was open.
        LaunchedEffect(chat.id) { onDismiss() }
        return
    }

    var renaming by remember { mutableStateOf<BotTask?>(null) }
    var title by remember { mutableStateOf("") }
    var pendingDelete by remember { mutableStateOf<BotTask?>(null) }
    // The thread, not the snapshot the bell was tapped on: resolved live
    // below, so a task that started working over SSE still gates the dialog.
    var pendingSnooze by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun failed() {
        error = NoticeMessageFormat.humanize(session.actionError ?: "无法更新此话题，请重试。")
        session.actionError = null
    }

    // The person's own filing folds to the sheet's tail, out of the folders:
    // an archived thread that starts demanding attention is back above.
    val (groups, archived) = when (current) {
        is Chat.BotChat -> {
            val all = current.bot.threadGroups(
                includingClosed = true,
                queuedThreadIds = state.queuedThreadIds,
            )
            val folded = all.flatMap { it.tasks }.filter {
                it.pinned != true &&
                    it.isArchived &&
                    !TaskRules.demandsAttention(it, queued = it.threadId in state.queuedThreadIds) &&
                    !TaskRules.isCurrent(it, current)
            }
            val foldedIds = folded.map { it.threadId }.toSet()
            all.mapNotNull { group ->
                group.copy(tasks = group.tasks.filter { it.threadId !in foldedIds })
                    .takeIf { it.tasks.isNotEmpty() }
            } to folded
        }
        is Chat.RoomChat -> listOf(BotThreadGroup(null, TaskRules.tasks(current))) to emptyList()
    }

    val pinHandler: (BotTask) -> Unit = { task ->
        saving = true
        error = null
        scope.launch {
            val ok = pinTask(session, task, current, task.pinned != true)
            saving = false
            if (!ok) failed()
        }
    }

    val archiveHandler: (BotTask) -> Unit = { task ->
        saving = true
        error = null
        scope.launch {
            // A null clears the stamp — the server treats it as unarchive.
            val stamped = if (task.isArchived) null else System.currentTimeMillis().toDouble()
            val ok = archiveTask(session, task, current, stamped)
            saving = false
            if (!ok) failed()
        }
    }

    // A timed snooze can end while the sheet is open; the rows and the Stop
    // snoozing offer must notice without waiting for the next snapshot.
    val now = rememberSnoozeNow(groups.flatMap { it.tasks })
    val sheetState = rememberModalBottomSheetState(
        skipPartiallyExpanded = true,
        confirmValueChange = { value -> value != SheetValue.Hidden || !saving },
    )

    ModalBottomSheet(
        onDismissRequest = { if (!saving) onDismiss() },
        sheetState = sheetState,
        containerColor = minisCanvas,
        shape = MinisSheetShape,
        scrimColor = Color.Black.copy(alpha = 0.22f),
    ) {
        GlassBackdrop()
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                ChatAvatar(
                    chat = current,
                    size = 32.dp,
                    state = MausState.IDLE,
                    animated = false,
                    fallback = AvatarFallback.PRESET,
                )
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "${current.name} 的话题",
                        fontSize = 18.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = minisInk,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    val roleSubtitle = (current as? Chat.BotChat)?.bot?.title.orEmpty()
                    if (roleSubtitle.isNotEmpty()) {
                        Text(
                            text = roleSubtitle,
                            fontSize = 12.sp,
                            color = minisSecondary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                val canCreate = TaskRules.canCreate(current)
                Row(
                    modifier = Modifier
                        .heightIn(min = 38.dp)
                        .museFloatingPill(CircleShape, elevation = 3.dp)
                        .clickable(enabled = !saving && canCreate, role = Role.Button) {
                            saving = true
                            error = null
                            scope.launch {
                                val created = createTask(session, current, null)
                                saving = false
                                if (created == null) failed() else {
                                    onSelectTask(created.target)
                                    onDismiss()
                                }
                            }
                        }
                        .semantics { contentDescription = "新建话题" }
                        .padding(horizontal = 12.dp, vertical = 7.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Icon(
                        imageVector = Icons.Filled.Add,
                        contentDescription = null,
                        tint = if (canCreate) minisInk else minisTertiary,
                        modifier = Modifier.size(16.dp),
                    )
                    Text(
                        text = "新建",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium,
                        color = if (canCreate) minisInk else minisTertiary,
                    )
                }
            }

            error?.let {
                InlineNotice(
                    message = it,
                    tone = NoticeTone.ERROR,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp),
                )
            }

            val groupCardFill = if (minisIsDark()) minisGrouped else Color(0xFFF5F5F3)
            LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 460.dp)
                    .padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                groups.forEach { group ->
                    group.project?.let { project ->
                        item(key = "header:${group.id}") {
                            Text(
                                text = "${project.emoji ?: "📁"} ${project.name}",
                                fontSize = 13.sp,
                                fontWeight = FontWeight.Medium,
                                color = minisSecondary,
                                modifier = Modifier.padding(start = 6.dp, top = 4.dp),
                            )
                        }
                    }
                    item(key = "group:${group.id}") {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(22.dp))
                                .background(groupCardFill),
                        ) {
                            group.tasks.forEachIndexed { index, task ->
                                if (index > 0) {
                                    HorizontalDivider(
                                        modifier = Modifier.padding(horizontal = 16.dp),
                                        thickness = 0.5.dp,
                                        color = minisSeparator.copy(alpha = 0.22f),
                                    )
                                }
                                TaskRow(
                                    task = task,
                                    chat = current,
                                    enabled = !saving,
                                    now = now,
                                    queued = task.threadId in state.queuedThreadIds,
                                    onSwitch = {
                                        saving = true
                                        error = null
                                        scope.launch {
                                            val selected = switchTask(session, task, current)
                                            saving = false
                                            if (selected == null) failed() else {
                                                onSelectTask(selected.target)
                                                onDismiss()
                                            }
                                        }
                                    },
                                    onRename = {
                                        title = task.title
                                        error = null
                                        renaming = task
                                    },
                                    onSnooze = if (current is Chat.BotChat) {
                                        { error = null; pendingSnooze = task.threadId }
                                    } else {
                                        null
                                    },
                                    onDelete = { error = null; pendingDelete = task },
                                    onArchive = (current as? Chat.BotChat)?.let { archiveHandler },
                                    onPin = pinHandler,
                                )
                            }
                        }
                    }
                }
                if (archived.isNotEmpty()) {
                    item(key = "archived") {
                        Text(
                            text = "已归档",
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Medium,
                            color = minisSecondary,
                            modifier = Modifier.padding(start = 6.dp, top = 4.dp),
                        )
                    }
                    item(key = "archived-card") {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(22.dp))
                                .background(groupCardFill),
                        ) {
                            archived.forEachIndexed { index, task ->
                                if (index > 0) {
                                    HorizontalDivider(
                                        modifier = Modifier.padding(horizontal = 16.dp),
                                        thickness = 0.5.dp,
                                        color = minisSeparator.copy(alpha = 0.22f),
                                    )
                                }
                                TaskRow(
                                    task = task,
                                    chat = current,
                                    enabled = !saving,
                                    now = now,
                                    queued = task.threadId in state.queuedThreadIds,
                                    onSwitch = {
                                        saving = true
                                        error = null
                                        scope.launch {
                                            val selected = switchTask(session, task, current)
                                            saving = false
                                            if (selected == null) failed() else {
                                                onSelectTask(selected.target)
                                                onDismiss()
                                            }
                                        }
                                    },
                                    onRename = {
                                        title = task.title
                                        error = null
                                        renaming = task
                                    },
                                    onSnooze = null,
                                    onDelete = { error = null; pendingDelete = task },
                                    onArchive = (current as? Chat.BotChat)?.let { archiveHandler },
                                    onPin = pinHandler,
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    renaming?.let { task ->
        TaskTitleDialog(
            heading = "重命名话题",
            label = "标题",
            title = title,
            onTitleChange = { title = it },
            confirmText = "保存",
            // An empty rename is allowed: the server labels it the untitled task,
            // and iOS submits the field as typed.
            confirmEnabled = !saving && TaskDialogRules.renameEnabled(current, title),
            error = error,
            onConfirm = {
                val requested = TaskDialogRules.renameTitle(title)
                saving = true
                error = null
                scope.launch {
                    val renamed = renameTask(session, task, current, requested)
                    saving = false
                    if (renamed) renaming = null else failed()
                }
            },
            onCancel = { if (!saving) { renaming = null; error = null } },
        )
    }
    pendingDelete?.let { task ->
        AlertDialog(
            onDismissRequest = { if (!saving) pendingDelete = null },
            title = { Text("删除“${TaskRules.title(task)}”？") },
            text = { Text(error ?: "此对话将被删除。已生成的文件将保留。") },
            confirmButton = {
                TextButton(enabled = !saving && TaskRules.canDelete(task, current), onClick = {
                    if (!TaskRules.canDelete(task, current)) return@TextButton
                    saving = true
                    error = null
                    scope.launch {
                        val updated = deleteTask(session, task, current)
                        saving = false
                        if (updated == null) failed() else {
                            pendingDelete = null
                            if (task.threadId == chat.threadId) {
                                onDismiss()
                                if (chat is Chat.BotChat) onDeletedCurrent() else onSelectTask(updated.target)
                            }
                        }
                    }
                }) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(enabled = !saving, onClick = { pendingDelete = null; error = null }) { Text("取消") } },
        )
    }

    pendingSnooze?.let { threadId ->
        // Resolved from the live record, never the tapped snapshot: a task
        // that started working over SSE disables the actions, and one deleted
        // underneath closes the dialog.
        val task = snoozeTarget((current as? Chat.BotChat)?.bot, threadId) ?: return@let
        val working = TaskRules.isWorking(task)
        AlertDialog(
            onDismissRequest = { if (!saving) pendingSnooze = null },
            title = { Text("延后提醒 ${TaskRules.title(task)}") },
            text = {
                Column {
                    error?.let {
                        Text(it, color = MaterialTheme.colorScheme.error)
                    }
                    if (working) {
                        Text("请先停止此话题，然后再设置延后提醒。", color = secondaryTint)
                    } else {
                        SnoozeRules.presets.forEach { preset ->
                            TextButton(
                                enabled = !saving,
                                onClick = {
                                    val bot = (current as? Chat.BotChat)?.bot ?: return@TextButton
                                    // Re-resolved at click time — the composition can be a frame
                                    // behind the update that started this thread working, and the
                                    // PATCH has no server-side working check to catch it.
                                    val live = snoozeTarget(bot, threadId) ?: return@TextButton
                                    if (TaskRules.isWorking(live)) return@TextButton
                                    saving = true
                                    error = null
                                    val until = preset.until(nowMillis())
                                    scope.launch {
                                        val snoozed = session.snoozeTask(live, bot, until)
                                        saving = false
                                        if (snoozed) pendingSnooze = null else failed()
                                    }
                                },
                                modifier = Modifier.fillMaxWidth(),
                            ) { Text(preset.label) }
                        }
                        if (task.isSnoozed(now)) {
                            TextButton(
                                enabled = !saving,
                                onClick = {
                                    val bot = (current as? Chat.BotChat)?.bot ?: return@TextButton
                                    val live = snoozeTarget(bot, threadId) ?: return@TextButton
                                    if (TaskRules.isWorking(live)) return@TextButton
                                    saving = true
                                    error = null
                                    scope.launch {
                                        val woken = session.snoozeTask(live, bot, null)
                                        saving = false
                                        if (woken) pendingSnooze = null else failed()
                                    }
                                },
                                modifier = Modifier.fillMaxWidth(),
                            ) { Text(SnoozeRules.STOP_SNOOZING) }
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = {
                TextButton(enabled = !saving, onClick = { pendingSnooze = null; error = null }) {
                    Text("取消")
                }
            },
        )
    }
}

/**
 * The live task behind an open snooze dialog, resolved from the bot's current
 * task list rather than the snapshot the bell was tapped on. A deleted thread
 * resolves to nothing and closes the dialog; a routine run was never a row.
 */
internal fun snoozeTarget(bot: Bot?, threadId: String): BotTask? =
    bot?.tasks.orEmpty().firstOrNull { it.threadId == threadId && it.routineRunId == null }

@Composable
private fun TaskRow(
    task: BotTask,
    chat: Chat,
    enabled: Boolean,
    now: Long,
    queued: Boolean,
    shape: androidx.compose.ui.graphics.Shape = MinisCardShape,
    onSwitch: () -> Unit,
    onRename: () -> Unit,
    onSnooze: (() -> Unit)?,
    onDelete: () -> Unit,
    onArchive: ((BotTask) -> Unit)? = null,
    onPin: (BotTask) -> Unit,
) {
    val current = TaskRules.isCurrent(task, chat)
    val canSwitch = enabled && TaskRules.canSwitch(task, chat)
    val canDelete = enabled && TaskRules.canDelete(task, chat)
    val canArchive = enabled && TaskRules.canArchive(task, chat)
    val canSnooze = onSnooze != null && enabled && !TaskRules.isWorking(task)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = canSwitch, onClick = onSwitch)
            .padding(start = 16.dp, end = 6.dp, top = 11.dp, bottom = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        BotThreadRow(task, selected = current, modifier = Modifier.weight(1f), now = now, queued = queued)

        var actionsOpen by remember { mutableStateOf(false) }
        Box {
            TouchTarget(
                onClick = { actionsOpen = true },
                size = 40.dp,
                contentDescription = "更多操作 ${TaskRules.title(task)}",
            ) {
                Icon(
                    imageVector = Icons.Filled.MoreVert,
                    contentDescription = null,
                    tint = secondaryTint,
                    modifier = Modifier.size(18.dp),
                )
            }
            DropdownMenu(
                expanded = actionsOpen,
                onDismissRequest = { actionsOpen = false },
                shape = RoundedCornerShape(16.dp),
                containerColor = minisCard,
            ) {
                DropdownMenuItem(
                    text = { Text("重命名") },
                    leadingIcon = { Icon(Icons.Filled.Edit, null, modifier = Modifier.size(18.dp)) },
                    enabled = enabled && TaskRules.canRename(chat),
                    modifier = Modifier.semantics { contentDescription = "重命名 ${TaskRules.title(task)}" },
                    onClick = {
                        actionsOpen = false
                        onRename()
                    },
                )
                val pinLabel = if (task.pinned == true) "取消置顶" else "置顶"
                DropdownMenuItem(
                    text = { Text(pinLabel) },
                    enabled = enabled,
                    onClick = {
                        actionsOpen = false
                        onPin(task)
                    },
                )
                if (onSnooze != null) {
                    DropdownMenuItem(
                        text = { Text("延后提醒") },
                        leadingIcon = { Icon(Icons.Filled.Notifications, null, modifier = Modifier.size(18.dp)) },
                        enabled = canSnooze,
                        modifier = Modifier.semantics { contentDescription = "延后提醒 ${TaskRules.title(task)}" },
                        onClick = {
                            actionsOpen = false
                            onSnooze()
                        },
                    )
                }
                if (onArchive != null) {
                    DropdownMenuItem(
                        text = { Text(if (task.isArchived) "取消归档" else "归档") },
                        enabled = canArchive,
                        onClick = {
                            actionsOpen = false
                            onArchive(task)
                        },
                    )
                }
                HorizontalDivider(thickness = 0.5.dp, color = minisSeparator)
                DropdownMenuItem(
                    text = {
                        Text(
                            text = "删除",
                            color = if (canDelete) MaterialTheme.colorScheme.error else secondaryTint.copy(alpha = 0.4f),
                        )
                    },
                    leadingIcon = {
                        Icon(
                            Icons.Filled.Delete,
                            null,
                            tint = if (canDelete) MaterialTheme.colorScheme.error else secondaryTint.copy(alpha = 0.4f),
                            modifier = Modifier.size(18.dp),
                        )
                    },
                    enabled = canDelete,
                    modifier = Modifier.semantics { contentDescription = "删除 ${TaskRules.title(task)}" },
                    onClick = {
                        actionsOpen = false
                        onDelete()
                    },
                )
            }
        }
    }
}

private suspend fun createTask(session: Session, chat: Chat, title: String?): Chat? =
    when (chat) {
        is Chat.BotChat -> session.createTask(chat.bot, title)?.let(Chat::BotChat)
        is Chat.RoomChat -> session.createTask(chat.room, title)?.let(Chat::RoomChat)
    }

private suspend fun switchTask(session: Session, task: BotTask, chat: Chat): Chat? =
    when (chat) {
        is Chat.BotChat -> session.state.value.bots.firstOrNull { it.id == chat.id }
            ?.forTask(task.threadId)?.let(Chat::BotChat)
        is Chat.RoomChat -> session.switchTask(task, chat.room)?.let(Chat::RoomChat)
    }

private suspend fun renameTask(
    session: Session,
    task: BotTask,
    chat: Chat,
    title: String,
): Boolean =
    when (chat) {
        is Chat.BotChat -> session.renameTask(task, chat.bot, title)
        is Chat.RoomChat -> session.renameTask(task, chat.room, title)
    }

private suspend fun deleteTask(session: Session, task: BotTask, chat: Chat): Chat? =
    when (chat) {
        is Chat.BotChat -> session.deleteTask(task, chat.bot)?.let(Chat::BotChat)
        is Chat.RoomChat -> session.deleteTask(task, chat.room)?.let(Chat::RoomChat)
    }

private suspend fun pinTask(session: Session, task: BotTask, chat: Chat, pinned: Boolean): Boolean =
    session.pinTask(task, chat, pinned)

private suspend fun archiveTask(session: Session, task: BotTask, chat: Chat, archivedAt: Double?): Boolean =
    when (chat) {
        is Chat.BotChat -> session.archiveTask(task, chat.bot, archivedAt)
        is Chat.RoomChat -> false
    }

@Composable
private fun TaskTitleDialog(
    heading: String,
    label: String,
    title: String,
    onTitleChange: (String) -> Unit,
    confirmText: String,
    confirmEnabled: Boolean,
    error: String? = null,
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onCancel,
        shape = MinisSheetShape,
        containerColor = minisCanvas,
        title = { Text(heading, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, color = minisInk) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                error?.let { Text(it, fontSize = 13.sp, color = MaterialTheme.colorScheme.error) }
                MinisSheetField(
                    value = title,
                    onValueChange = onTitleChange,
                    placeholder = label,
                    singleLine = true,
                )
            }
        },
        confirmButton = {
            TextButton(onClick = onConfirm, enabled = confirmEnabled) { Text(confirmText) }
        },
        dismissButton = { TextButton(onClick = onCancel) { Text("取消") } },
    )
}
