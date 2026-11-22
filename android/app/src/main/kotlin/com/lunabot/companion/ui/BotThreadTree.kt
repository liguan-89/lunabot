package com.lunabot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.core.Bot
import com.lunabot.companion.core.BotTask
import com.lunabot.companion.core.Chat
import com.lunabot.companion.core.ChatSummary
import com.lunabot.companion.core.forTask
import com.lunabot.companion.core.threadGroups

/** Local search includes desktop folder names and every visible conversation title. */
internal fun rosterThreadRows(
    summaries: List<ChatSummary>,
    query: String,
    queuedThreadIds: Set<String> = emptySet(),
): List<ChatSummary> {
    val matching = RosterLayout.rows(summaries, query).mapTo(mutableSetOf()) { it.id }
    return summaries.filter { summary ->
        summary.id in matching || (summary.chat as? Chat.BotChat)?.bot
            ?.threadGroups(matching = query, queuedThreadIds = queuedThreadIds)?.isNotEmpty() == true
    }
}

/**
 * The disclosure affordance for a bot's threads — a small chevron and count
 * that lives on the bot row itself, beside the timestamp, instead of a whole
 * "话题 N" line under it. Returns null when there is nothing to expand.
 */
@Composable
internal fun ThreadToggle(
    bot: Bot,
    expanded: Boolean,
    searching: Boolean,
    onToggle: () -> Unit,
    queuedThreadIds: Set<String> = emptySet(),
) {
    val count = bot.threadGroups(queuedThreadIds = queuedThreadIds).sumOf { it.tasks.size }
    if (!searching && count <= 1 && !expanded) return
    Row(
        modifier = Modifier
            .testTag("threads-toggle.${bot.id}")
            .semantics(mergeDescendants = true) {
                contentDescription = "${bot.name} 的话题"
                stateDescription = "${if (expanded) "已展开" else "已折叠"}，$count 个话题"
            }
            .clickable(enabled = !searching, role = Role.Button, onClick = onToggle)
            .heightIn(min = 24.dp)
            .padding(start = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            modifier = Modifier
                .background(if (minisIsDark()) minisGrouped else Color(0xFFF2F2F0), RoundedCornerShape(50))
                .padding(start = 7.dp, end = 4.dp, top = 2.dp, bottom = 2.dp),
            horizontalArrangement = Arrangement.spacedBy(1.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("${count} 个话题", fontSize = 11.sp, fontWeight = FontWeight.Medium, color = minisSecondary)
            DisclosureIcon(expanded)
        }
    }
}

@Composable
internal fun BotThreadTree(
    bot: Bot,
    query: String,
    expanded: Boolean,
    collapsedFolders: Set<String>,
    creating: Boolean,
    onToggleFolder: (String) -> Unit,
    onCreate: () -> Unit,
    onManage: () -> Unit,
    onOpen: (Chat) -> Unit,
    queuedThreadIds: Set<String> = emptySet(),
) {
    val searching = query.isNotBlank()
    val isExpanded = searching || expanded
    val now = rememberSnoozeNow(bot.tasks.orEmpty())
    val groups = bot.threadGroups(
        matching = if (bot.name.contains(query, ignoreCase = true)) "" else query,
        now = now,
        queuedThreadIds = queuedThreadIds,
    )

    if (!isExpanded) return
    val containerFill = if (minisIsDark()) minisGrouped else Color(0xFFF5F5F3)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 76.dp, end = 16.dp, top = 2.dp, bottom = 10.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(containerFill)
            .padding(horizontal = 6.dp, vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 8.dp, end = 2.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "话题",
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                color = minisSecondary,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                TouchTarget(
                    onClick = onCreate,
                    enabled = !creating,
                    size = 32.dp,
                    contentDescription = "与 ${bot.name} 新建话题",
                ) {
                    Icon(Icons.Filled.Add, contentDescription = null, tint = secondaryTint, modifier = Modifier.size(18.dp))
                }
                TouchTarget(
                    onClick = onManage,
                    size = 32.dp,
                    contentDescription = "管理 ${bot.name} 的话题",
                ) {
                    Icon(Icons.Filled.MoreVert, contentDescription = null, tint = secondaryTint, modifier = Modifier.size(18.dp))
                }
            }
        }
        groups.forEach { group ->
            val folder = group.project
            if (folder == null) {
                ThreadLinks(group.tasks, bot, now, queuedThreadIds, onOpen)
            } else {
                val key = "${bot.id}:${folder.id}"
                val folderExpanded = searching || key !in collapsedFolders
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(10.dp))
                        .testTag("thread-folder.$key")
                        .semantics(mergeDescendants = true) {
                            contentDescription = "${folder.name} 文件夹"
                            stateDescription = if (folderExpanded) "已展开" else "已收起"
                        }
                        .clickable(enabled = !searching, role = Role.Button) { onToggleFolder(key) }
                        .heightIn(min = 34.dp)
                        .padding(horizontal = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    DisclosureIcon(folderExpanded)
                    Text(folder.emoji?.takeIf { it.isNotBlank() } ?: "📁", fontSize = 13.sp)
                    Text(
                        folder.name,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium,
                        color = secondaryTint,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (folderExpanded) {
                    Column(
                        modifier = Modifier.padding(start = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) { ThreadLinks(group.tasks, bot, now, queuedThreadIds, onOpen) }
                }
            }
        }
    }
}

@Composable
private fun ThreadLinks(
    tasks: List<BotTask>,
    bot: Bot,
    now: Long,
    queuedThreadIds: Set<String>,
    onOpen: (Chat) -> Unit,
) {
    tasks.forEach { task ->
        val projected = bot.forTask(task.threadId)
        if (projected != null) {
            val active = task.threadId == bot.threadId
            val activeFill = if (minisIsDark()) minisRaised else minisCard
            BotThreadRow(
                task,
                selected = active,
                now = now,
                queued = task.threadId in queuedThreadIds,
                modifier = Modifier
                    .testTag("thread.${task.threadId}")
                    .clip(RoundedCornerShape(10.dp))
                    .then(if (active) Modifier.background(activeFill) else Modifier)
                    .clickable(role = Role.Button) { onOpen(Chat.BotChat(projected)) }
                    .padding(horizontal = 8.dp, vertical = 5.dp),
            )
        }
    }
}

@Composable
private fun DisclosureIcon(expanded: Boolean) {
    Icon(
        if (expanded) Icons.Filled.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = null,
        tint = secondaryTint,
        modifier = Modifier.size(16.dp),
    )
}
