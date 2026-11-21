package com.lunabot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.R
import com.lunabot.companion.core.Bot
import com.lunabot.companion.core.BotOverview
import com.lunabot.companion.core.Chat
import com.lunabot.companion.core.McpServerEntry
import com.lunabot.companion.core.Routine
import kotlinx.coroutines.launch

/**
 * "What this bot does" — a read-only, server-authored explanation of one bot's
 * standing configuration. The port of the same explanation
 * `ios/App/AgentProfileView.swift` opens from the profile sheet, drawn on the
 * Grok Bot profile's surface: the grey canvas, a hero with the agent's face,
 * and each section as a white rounded card.
 *
 * Nothing here is editable. Identity, notifications and voice stay on
 * [AgentProfileSheet]; this screen only asks the paired computer what it wrote
 * about the agent and shows the sentences back — who it is, what it does, what
 * it can reach, what it refuses, and its most recent changes. It invents no
 * rows of its own: the profile editor is the screen that offers fields.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BotOverviewScreen(
    botId: String,
    onBack: () -> Unit,
    onOpenRoutines: (String) -> Unit = {},
    onOpenComputer: (String) -> Unit = {},
    onOpenBrowser: (String) -> Unit = {},
) {
    val environment = LocalCompanion.current
    val session = environment.session
    val state by session.state.collectAsState()
    val connection by session.connection.collectAsState()
    val connectionId = connection?.id
    val scope = rememberCoroutineScope()

    var overview by remember(botId, connectionId) { mutableStateOf<BotOverview?>(null) }
    var loading by remember(botId, connectionId) { mutableStateOf(true) }
    var refreshing by remember(botId, connectionId) { mutableStateOf(false) }
    var failed by remember(botId, connectionId) { mutableStateOf(false) }
    // The profile's first card is real configuration, not prose: the protocol
    // keys routines by botId, so "定时任务" can show an honest count and next
    // run, and the computer row can show the state the roster already knows.
    var routines by remember(botId, connectionId) { mutableStateOf<List<Routine>>(emptyList()) }
    // MCP servers are a second read: the overview says what the bot does in
    // prose, this says which tool servers it can actually start. Null means the
    // computer refused (a member's session has no admin scope) or did not
    // answer; the card says so with one line instead of hiding itself.
    var mcpServers by remember(botId, connectionId) { mutableStateOf<List<McpServerEntry>?>(null) }
    var mcpLoaded by remember(botId, connectionId) { mutableStateOf(false) }

    suspend fun refresh(showProgress: Boolean = false) {
        if (showProgress) refreshing = true
        try {
            val loaded = session.loadOverview(botId)
            failed = loaded == null
            if (loaded != null) overview = loaded
            mcpServers = session.loadMcpServers(botId)
            mcpLoaded = true
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

    // A tool server toggled on the computer does not push a bot frame; without
    // this the card keeps saying what it said when the screen opened.
    LaunchedEffect(botId, connectionId) {
        session.mcpChanged.collect {
            mcpServers = session.loadMcpServers(botId)
            mcpLoaded = true
        }
    }

    LaunchedEffect(botId, connectionId, state.routineRevision) {
        routines = try {
            session.loadRoutines().routines.filter { it.botId == botId }
        } catch (cancellation: kotlinx.coroutines.CancellationException) {
            throw cancellation
        } catch (_: Exception) {
            emptyList()
        }
    }

    // The current record in state, when the fleet has one: the hero's face is
    // drawn from it, and it is also where the name comes from before the
    // overview arrives. The prose's own name wins once loaded, because it is
    // what the computer wrote about this agent.
    val bot = state.bot(botId)
    val name = overview?.who?.name ?: bot?.name.orEmpty()

    Column(modifier = Modifier.fillMaxSize().background(minisCanvas)) {
        // The profile's bar: one white circle on the left, the name centred,
        // nothing on the right, and no hairline under it.
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
                text = name.ifEmpty { "智能体" },
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                color = minisInk,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
                // The reserved side margins keep a long name centred instead of
                // running under the back circle.
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
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                OverviewHero(bot = bot, overview = overview)

                bot?.let { record ->
                    OverviewCard(label = null) {
                        OverviewActionRow(
                            icon = R.drawable.ic_muse_schedule_outline,
                            title = "定时任务",
                            detail = routineSummary(routines),
                            onClick = { onOpenRoutines(botId) },
                        )
                        HorizontalDivider(thickness = 0.5.dp, color = minisSeparator.copy(alpha = 0.22f))
                        OverviewActionRow(
                            icon = R.drawable.ic_display_line,
                            title = "电脑",
                            detail = if (record.busy == true) "工作中" else "空闲",
                            onClick = { onOpenComputer(botId) },
                        )
                        HorizontalDivider(thickness = 0.5.dp, color = minisSeparator.copy(alpha = 0.22f))
                        OverviewActionRow(
                            icon = R.drawable.ic_display_line,
                            title = "浏览器",
                            detail = "看它正在看的网页",
                            onClick = { onOpenBrowser(botId) },
                        )
                    }
                }

                if (mcpLoaded) {
                    McpServersCard(mcpServers)
                }

                val current = overview
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
                    current != null -> OverviewBody(current)
                    failed -> OverviewCard(label = null) {
                        Text(
                            OverviewRules.FAILED,
                            color = secondaryTint,
                            fontSize = 17.sp,
                            modifier = Modifier.padding(vertical = 16.dp),
                        )
                    }
                }
            }
        }
    }
}

/**
 * Which tool servers this bot can start, and which switch is holding each one.
 * Read-only on purpose: the switches live in the computer's MCP settings, and
 * the phone does not carry `/api/mcp/servers` (commands and arguments) at all —
 * this route answers names and states only.
 */
@Composable
private fun McpServersCard(servers: List<McpServerEntry>?) {
    OverviewCard(label = "MCP 服务器") {
        when {
            servers == null -> OverviewRow {
                Text(
                    McpServerRules.UNAVAILABLE,
                    fontSize = 15.sp,
                    color = secondaryTint,
                )
            }
            servers.isEmpty() -> OverviewRow {
                Text(
                    McpServerRules.EMPTY,
                    fontSize = 15.sp,
                    color = secondaryTint,
                )
            }
            else -> servers.forEachIndexed { index, server ->
                if (index > 0) MinisDivider()
                OverviewRow {
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

/**
 * The profile's hero: the agent's face, its name under it, its title under
 * that. The face comes from the bot record in state — [ChatAvatar] needs one —
 * so before the fleet delivers the record but after the overview has loaded,
 * the hero falls back to the name alone.
 */
@Composable
private fun OverviewHero(bot: Bot?, overview: BotOverview?) {
    val record = bot
    val name = overview?.who?.name ?: record?.name.orEmpty()
    if (record == null && name.isEmpty()) return

    Column(
        modifier = Modifier.fillMaxWidth().padding(top = 2.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (record != null) {
            ChatAvatar(
                chat = Chat.BotChat(record),
                size = 84.dp,
                fallback = AvatarFallback.PRESET,
                motion = AvatarMotion.BREATH,
                // The name sits right under the face; naming both reads twice.
                contentDescription = null,
            )
        }
        Text(
            text = name,
            fontSize = 20.sp,
            fontWeight = FontWeight.SemiBold,
            color = minisInk,
            textAlign = TextAlign.Center,
            // One line: the hero is a fixed block, and a long name should not
            // push the action rows off the screen.
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .padding(horizontal = 24.dp)
                .semantics { heading() },
        )
        val title = overview?.who?.title.orEmpty()
        if (title.isNotBlank()) {
            Text(
                text = title,
                fontSize = 14.sp,
                color = minisSecondary,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun OverviewBody(overview: BotOverview) {
    OverviewCard(label = OverviewRules.WHO) {
        OverviewRow {
            Text(
                overview.who.name,
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                color = minisInk,
                modifier = Modifier.weight(1f),
            )
        }
        if (overview.who.title.isNotBlank()) {
            MinisDivider()
            OverviewRow {
                Text(
                    overview.who.title,
                    fontSize = 17.sp,
                    color = minisInk,
                    modifier = Modifier.weight(1f),
                )
            }
        }
        if (overview.who.blurb.isNotBlank()) {
            MinisDivider()
            OverviewRow {
                Text(
                    overview.who.blurb,
                    fontSize = 17.sp,
                    color = minisInk,
                    modifier = Modifier.weight(1f),
                )
            }
        }
        if (overview.who.soulLead.isNotBlank()) {
            MinisDivider()
            OverviewRow {
                Text(
                    overview.who.soulLead,
                    color = secondaryTint,
                    fontSize = 13.sp,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }

    OverviewCard(label = OverviewRules.DOES) {
        if (overview.does.isEmpty()) {
            OverviewRow {
                Text(
                    OverviewRules.EMPTY_DOES,
                    color = secondaryTint,
                    fontSize = 17.sp,
                    modifier = Modifier.weight(1f),
                )
            }
        } else {
            overview.does.forEachIndexed { index, line ->
                if (index > 0) MinisDivider()
                OverviewNoteRow(text = line, painter = R.drawable.ic_schedule)
            }
        }
    }

    // No empty-state copy on either phone: the server sends this only when
    // there is something to say, and an empty list here is just a header
    // with nothing under it (`ios/App/BotOverviewView.swift:39-43`).
    OverviewCard(label = OverviewRules.REACHES) {
        overview.reaches.forEachIndexed { index, line ->
            if (index > 0) MinisDivider()
            OverviewNoteRow(text = line, painter = R.drawable.ic_hub)
        }
    }

    OverviewCard(label = OverviewRules.WONT) {
        overview.wont.forEachIndexed { index, line ->
            if (index > 0) MinisDivider()
            OverviewNoteRow(text = line, painter = R.drawable.ic_block)
        }
    }

    OverviewCard(label = OverviewRules.RECENT) {
        if (overview.recent.isEmpty()) {
            OverviewRow {
                Text(
                    OverviewRules.EMPTY_RECENT,
                    color = secondaryTint,
                    fontSize = 17.sp,
                    modifier = Modifier.weight(1f),
                )
            }
        } else {
            overview.recent.forEachIndexed { index, entry ->
                if (index > 0) MinisDivider()
                OverviewRow {
                    Column(
                        modifier = Modifier
                            .weight(1f)
                            .padding(vertical = 8.dp),
                    ) {
                        Text(
                            entry.summary,
                            fontSize = 17.sp,
                            color = minisInk,
                        )
                        Text(
                            RelativeStamp.dateAndTime(entry.at),
                            color = secondaryTint,
                            fontSize = 13.sp,
                        )
                    }
                }
            }
        }
    }
}

/**
 * One section as the profile draws it: a quiet grey label above a white
 * rounded card of rows. [label] is null where the card speaks for itself —
 * the failure card.
 */
@Composable
private fun OverviewCard(label: String?, content: @Composable ColumnScope.() -> Unit) {
    val cardFill = if (minisIsDark()) minisGrouped else Color(0xFFF5F5F3)
    Column(modifier = Modifier.fillMaxWidth()) {
        label?.let {
            Text(
                text = it,
                modifier = Modifier.padding(horizontal = 6.dp, vertical = 6.dp),
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                color = minisSecondary,
            )
        }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(22.dp))
                .background(cardFill)
                .padding(horizontal = 16.dp),
            content = content,
        )
    }
}

/** One row of a card, at the reading height the profile's rows keep. */
@Composable
private fun OverviewRow(
    onClick: (() -> Unit)? = null,
    content: @Composable RowScope.() -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 54.dp)
            .then(
                if (onClick != null) {
                    Modifier.clickable(role = Role.Button, onClick = onClick)
                } else {
                    Modifier
                },
            ),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

@Composable
private fun OverviewActionRow(
    icon: Int,
    title: String,
    detail: String,
    onClick: () -> Unit,
) {
    OverviewRow(onClick = onClick) {
        Box(
            modifier = Modifier
                .size(34.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(minisCard),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                painter = painterResource(icon),
                contentDescription = null,
                tint = minisInk,
                modifier = Modifier.size(18.dp),
            )
        }
        Spacer(Modifier.width(12.dp))
        Text(
            text = title,
            fontSize = 15.5.sp,
            fontWeight = FontWeight.Medium,
            color = minisInk,
            modifier = Modifier.weight(1f),
        )
        Text(
            text = detail,
            fontSize = 14.sp,
            color = minisSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.width(4.dp))
        Icon(
            imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = minisTertiary,
            modifier = Modifier.size(18.dp),
        )
    }
}

/** "3 个 · 19:00" when enabled routines have a next run, else the count alone. */
private fun routineSummary(routines: List<Routine>): String {
    if (routines.isEmpty()) return "暂无"
    val count = "${routines.size} 个"
    val next = routines.filter { it.enabled }.mapNotNull { it.nextRunAt }.minOrNull()
        ?: return count
    return "$count · ${RelativeStamp.list(next, System.currentTimeMillis())}"
}

/**
 * [IconNote] as this page draws it — the same quiet sentence with a monochrome
 * icon, at the profile's sizes: a 20 dp secondary icon beside 17 sp body text.
 * The shared [IconNote] keeps its own measurements, so the sheets that use it
 * do not move.
 */
@Composable
private fun OverviewNoteRow(text: String, painter: Int) {
    OverviewRow {
        Icon(
            painter = painterResource(painter),
            contentDescription = null,
            tint = secondaryTint,
            modifier = Modifier.size(20.dp),
        )
        Text(
            text = text,
            fontSize = 17.sp,
            color = secondaryTint,
            modifier = Modifier.weight(1f),
        )
    }
}
