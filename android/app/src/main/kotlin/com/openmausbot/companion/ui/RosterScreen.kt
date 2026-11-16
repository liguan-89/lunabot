package com.openmausbot.companion.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Image
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Create
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import dev.chrisbanes.haze.hazeSource
import dev.chrisbanes.haze.rememberHazeState
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick as semanticsOnClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import com.openmausbot.companion.R
import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.ChatSummary
import com.openmausbot.companion.core.Connection
import com.openmausbot.companion.core.Room
import com.openmausbot.companion.core.SearchHit
import com.openmausbot.companion.core.Session
import com.openmausbot.companion.core.chat
import com.openmausbot.companion.core.chatSummaries
import com.openmausbot.companion.core.forTask
import java.util.Locale
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The roster — the port of `ios/App/ChatListView.swift`.
 *
 * Messages-shaped: a header with you on the left and settings on the right, your
 * groups across the top, every bot below with the unread dot in the bot's own
 * colour at the left edge, and a bar floating at the bottom. The bar's pill is
 * Updates — only the bots that need you, are working, or have something you have
 * not read — beside round search and new-bot buttons. Everything scrolls under
 * the bar, which is why the list leaves [BAR_CLEARANCE] below its last row.
 *
 * Ordering is not decided here. `chatSummaries` (`:core`) folds pinned → unread →
 * last activity and hides hidden bots; [RosterLayout] decides which of those are
 * rows and which are tiles; the screen renders what it is handed.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RosterScreen(navigator: CompanionNavigator) {
    val environment = LocalCompanion.current
    val session = environment.session
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    val state by session.state.collectAsState()
    val connection by session.connection.collectAsState()
    val connections by session.connections.collectAsState()
    val status by session.status.collectAsState()
    // The same preference the transcript folds by, from the same store: a reader
    // who turned activity off must not still read tool names here.
    val activityDetail by environment.chatPreferences.activityDetail.collectAsState()

    var bar by rememberSaveable(stateSaver = RosterBarSaver) { mutableStateOf(RosterBar()) }
    var hits by remember { mutableStateOf<List<SearchHit>>(emptyList()) }
    var searching by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    var showingUpdates by remember { mutableStateOf(false) }
    var showingNewGroup by remember { mutableStateOf(false) }
    var showingNewSection by remember { mutableStateOf(false) }
    var expandedBots by rememberSaveable(stateSaver = StringSetSaver) { mutableStateOf(emptySet<String>()) }
    var collapsedFolders by rememberSaveable(stateSaver = StringSetSaver) { mutableStateOf(emptySet<String>()) }
    var creatingThreads by remember { mutableStateOf(emptySet<String>()) }
    var managingThreads by remember { mutableStateOf<Chat?>(null) }
    // Which computer this phone is talking to. One stream at a time is the
    // protocol, so the choice is a switch, not a merge.
    var choosingComputer by remember { mutableStateOf(false) }
    // A new bot opens the same profile editor the chat header uses, in creation
    // mode: the bot is only made when that page is saved, so backing out of it
    // leaves the fleet untouched.
    var creatingBotProfile by remember { mutableStateOf(false) }

    val query = bar.query

    // The roster is the stack root, so the app-level Back would leave the app.
    // With the search bar open, the platform gesture closes the search first —
    // the same rule every pushed screen follows.
    BackHandler(enabled = bar.searchOpen) {
        bar = RosterBar()
        hits = emptyList()
    }

    // A different computer is a different fleet: the previous search answer,
    // the previous expansion and the previous query describe bots that are no
    // longer here. Only a *change* clears them — a restored search from process
    // death is still this computer's.
    var lastComputer by remember { mutableStateOf(connection?.id) }
    LaunchedEffect(connection?.id) {
        if (connection?.id != lastComputer) {
            lastComputer = connection?.id
            bar = RosterBar()
            hits = emptyList()
            expandedBots = emptySet()
            collapsedFolders = emptySet()
        }
    }

    // Local filtering is always on; the computer is only asked past two
    // characters and after a quiet moment (§10).
    LaunchedEffect(query) {
        when (val decision = SearchPolicy.decide(query)) {
            SearchPolicy.Decision.Clear -> {
                hits = emptyList()
                searching = false
            }
            is SearchPolicy.Decision.Remote -> {
                searching = true
                delay(SearchPolicy.DEBOUNCE_MILLIS)
                hits = session.search(decision.query)
                searching = false
            }
        }
    }

    // Folding the fleet walks every thread's transcript, so it is keyed on the
    // state and the activity level alone: typing filters the fold instead of
    // repeating it.
    val summaries = remember(state, activityDetail) { state.chatSummaries(activityDetail) }
    // Only a search has rows to filter; the unsearched roster is assembled
    // section by section below.
    val rows = remember(summaries, query, state.queuedThreadIds) {
        rosterThreadRows(summaries, query, state.queuedThreadIds)
    }
    val approvals = remember(state) { state.pendingApprovals }
    val waiting = remember(state, approvals) { RosterLayout.waitingChats(state, approvals) }
    // One pass over the fleet rather than one per row: resolving a face walks the
    // chat's visible transcript.
    val faces = remember(state, summaries) {
        summaries.associate { it.id to MausState.forChat(it.chat, state) }
    }
    // Hoisted out of the list: read inside a lazy item, `state` would make that
    // item's recompose scope the whole fleet.
    val rooms = state.rooms
    val tiles = remember(state) {
        rooms.associate { it.id to RosterLayout.memberBots(state, it) }
    }
    // Read by the bar over the list and by nothing inside it, so the rows never
    // recompose for it. `approvals` is handed over rather than walked again.
    val updates = remember(state, approvals) { state.updates(approvals) }
    // The cross-bot Needs attention section rides above every roster section.
    val attention = remember(state) { state.crossBotAttention() }
    val canCreateSection = remember(state) { SectionRules.selectable(state).isNotEmpty() }

    // The top bar and the bottom bar share this: both open the creation form.
    val createBot: () -> Unit = { creatingBotProfile = true }

    // Grok opens on one assistant; ours is the chief (or the first bot).
    val hero = remember(summaries, query) {
        if (query.isNotEmpty()) {
            null
        } else {
            summaries.firstOrNull {
                (it.chat as? Chat.BotChat)?.bot?.chiefOfStaff == true
            } ?: summaries.firstOrNull { it.chat is Chat.BotChat }
        }
    }
    // The hero is the row above; it must not appear again in a section.
    val listSummariesById = remember(summaries, hero) {
        summaries.filterNot { it.id == hero?.id }.associateBy { it.id }
    }

    val entry: @Composable (ChatSummary, Boolean) -> Unit = { summary, last ->
        Column {
            ChatRow(
                summary = summary,
                face = faces[summary.id] ?: MausState.IDLE,
                waiting = summary.id in waiting,
                status = status,
                last = last,
                onClick = { navigator.open(environment.chatPreferences.restoringThread(summary.chat, connection?.id)) },
            )
            (summary.chat as? Chat.BotChat)?.bot?.let { bot ->
                // Grok's list is one row per assistant. A bot with a single
                // thread had a "话题 1" row under it that said nothing; only
                // show the tree when there is a tree to show.
                if (bot.tasks.orEmpty().size > 1 || bot.id in expandedBots || query.isNotEmpty()) {
                    BotThreadTree(
                    bot = bot,
                    queuedThreadIds = state.queuedThreadIds,
                    query = query,
                    expanded = bot.id in expandedBots,
                    collapsedFolders = collapsedFolders,
                    creating = bot.id in creatingThreads,
                    onToggle = {
                        haptics.play(HapticCue.SELECT)
                        expandedBots = if (bot.id in expandedBots) expandedBots - bot.id else expandedBots + bot.id
                    },
                    onToggleFolder = { key ->
                        haptics.play(HapticCue.SELECT)
                        collapsedFolders = if (key in collapsedFolders) collapsedFolders - key else collapsedFolders + key
                    },
                    onCreate = {
                        // Hoisted across bot sections and search, so moving a row
                        // cannot permit a second creation while the first is pending.
                        if (bot.id !in creatingThreads) {
                            creatingThreads = creatingThreads + bot.id
                            scope.launch {
                                try {
                                    val created = session.createTask(bot, title = null)
                                    if (created != null) {
                                        navigator.open(Chat.BotChat(created))
                                    } else if (session.actionError == null) {
                                        session.actionError = "无法创建会话，请检查连接后重试。"
                                    }
                                } finally {
                                    creatingThreads = creatingThreads - bot.id
                                }
                            }
                        }
                    },
                    onManage = { managingThreads = Chat.BotChat(bot) },
                    onOpen = navigator::open,
                )
                }
            }
        }
    }

    val hazeState = rememberHazeState()
    val listState = rememberLazyListState()
    val density = LocalDensity.current
    var headerHeightPx by remember { mutableIntStateOf(0) }
    var bottomBarHeightPx by remember { mutableIntStateOf(0) }
    val topClearance = with(density) {
        if (headerHeightPx > 0) headerHeightPx.toDp() else 60.dp
    }
    val bottomClearance = with(density) {
        if (bottomBarHeightPx > 0) bottomBarHeightPx.toDp() + 12.dp else BAR_CLEARANCE
    }
    val topScrolled by remember { derivedStateOf { listState.canScrollBackward } }
    val topBandAlpha by animateFloatAsState(
        targetValue = if (topScrolled) 1f else 0f,
        animationSpec = tween(180),
        label = "roster-top-haze",
    )

    CompositionLocalProvider(LocalHazeState provides hazeState) {
    Box(modifier = Modifier.fillMaxSize().background(minisCanvas)) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(minisCanvas)
                .hazeSource(hazeState),
        ) {
            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = {
                    scope.launch {
                        refreshing = true
                        session.refresh()
                        refreshing = false
                    }
                },
                modifier = Modifier.fillMaxSize(),
            ) {
                val nothingToList =
                    if (query.isEmpty()) !RosterLayout.listsAnyBot(summaries) else rows.isEmpty()
                if (nothingToList && hits.isEmpty()) {
                    EmptyState(
                        title = if (query.isEmpty()) "暂无智能体" else "未找到匹配项",
                        description = if (query.isEmpty()) {
                            if (status is Session.Status.Offline) {
                                "还没连上电脑。连上后，智能体会显示在这里。"
                            } else {
                                "在电脑上创建的智能体会显示在这里。"
                            }
                        } else {
                            "没有匹配“$query”的会话。"
                        },
                    )
                }

                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(top = topClearance, bottom = bottomClearance),
                ) {
                    hero?.let { main ->
                        item(key = "hero") {
                            RosterHero(
                                summary = main,
                                status = status,
                                computerName = connection?.name,
                                computerCount = connections.size,
                                onChooseComputer = { choosingComputer = true },
                            ) {
                                navigator.open(
                                    environment.chatPreferences.restoringThread(
                                        main.chat,
                                        connection?.id,
                                    ),
                                )
                            }
                        }
                    }
                    if (RosterLayout.showsGroups(query)) {
                        if (attention.isNotEmpty()) {
                            item(key = "attention-label") {
                                SectionLabel("需要关注", Modifier.padding(top = 2.dp, bottom = 4.dp))
                            }
                            items(attention, key = { "attention-${it.id}" }) { entry ->
                                AttentionRow(entry = entry, onOpen = {
                                    state.bots.firstOrNull { it.id == entry.botId }
                                        ?.let { bot -> Chat.BotChat(bot.forTask(entry.task.threadId) ?: bot) }
                                        ?.let(navigator::open)
                                })
                            }
                        }
                        state.unsectionedChief?.let { chief ->
                            listSummariesById[chief.id]?.let { summary ->
                                item(key = "chief-${chief.id}") {
                                    entry(summary, true)
                                }
                            }
                        }
                        val pinned = state.pinnedBots.mapNotNull { listSummariesById[it.id] }
                        if (pinned.isNotEmpty()) {
                            item(key = "pinned-label") {
                                SectionLabel("已置顶", Modifier.padding(top = 2.dp, bottom = 4.dp))
                            }
                            itemsIndexed(pinned, key = { _, summary -> "pinned-${summary.id}" }) { index, summary ->
                                // Pinned rows are the ones most likely to swap
                                // places when an unread arrives; let them glide.
                                Box(Modifier.animateItem()) {
                                    entry(summary, index == pinned.lastIndex)
                                }
                            }
                        }
                        if (state.unsectionedChannels.isNotEmpty()) {
                            item(key = "channels") {
                                GroupsStrip(
                                    title = "群组",
                                    rooms = state.unsectionedChannels,
                                    members = tiles,
                                    onOpen = { navigator.open(Chat.RoomChat(it)) },
                                )
                            }
                        }
                        if (state.botChats.isNotEmpty()) {
                            item(key = "bot-chats") {
                                GroupsStrip(
                                    title = "智能体会话",
                                    rooms = state.botChats,
                                    members = tiles,
                                    onOpen = { navigator.open(Chat.RoomChat(it)) },
                                )
                            }
                        }
                        val unsectioned = state.unsectionedBots.mapNotNull { listSummariesById[it.id] }
                        if (unsectioned.isNotEmpty()) {
                            // With the hero above, a "智能体" label would just
                            // restate what the large face already says.
                            if (hero == null) {
                                item(key = "bots-label") {
                                    SectionLabel("智能体", Modifier.padding(top = 18.dp, bottom = 4.dp))
                                }
                            }
                            itemsIndexed(unsectioned, key = { _, summary -> "bot-${summary.id}" }) { index, summary ->
                                Box(Modifier.animateItem()) {
                                    entry(summary, index == unsectioned.lastIndex)
                                }
                            }
                        }
                        // Chiefs, then the section's channels, then its bots —
                        // the order of `rosterSections` in `ChatListView.swift`.
                        state.sidebarSections.forEach { section ->
                            item(key = "section-${section.id}") {
                                SectionLabel(section.name, Modifier.padding(top = 18.dp, bottom = 4.dp))
                            }
                            val sectionChiefs = section.chiefs.mapNotNull { listSummariesById[it.id] }
                            val sectionBots = section.bots.mapNotNull { listSummariesById[it.id] }
                            itemsIndexed(
                                sectionChiefs,
                                key = { _, summary -> "section-${section.id}-chief-${summary.id}" },
                            ) { index, summary ->
                                Box(Modifier.animateItem()) {
                                    entry(
                                        summary,
                                        // A divider separates two rows. The strip is
                                        // not a row, and neither is the end of the
                                        // section.
                                        index == sectionChiefs.lastIndex &&
                                            (section.channels.isNotEmpty() || sectionBots.isEmpty()),
                                    )
                                }
                            }
                            if (section.channels.isNotEmpty()) {
                                item(key = "section-${section.id}-channels") {
                                    GroupsStrip(
                                        title = "群组",
                                        rooms = section.channels,
                                        members = tiles,
                                        onOpen = { navigator.open(Chat.RoomChat(it)) },
                                    )
                                }
                            }
                            itemsIndexed(
                                sectionBots,
                                key = { _, summary -> "section-${section.id}-bot-${summary.id}" },
                            ) { index, summary ->
                                Box(Modifier.animateItem()) {
                                    entry(summary, index == sectionBots.lastIndex)
                                }
                            }
                        }
                    }

                    if (query.isNotEmpty() && hits.isNotEmpty()) {
                        item(key = "search-header") {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(top = 10.dp, bottom = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                SectionLabel("消息")
                                Spacer(Modifier.weight(1f))
                                if (searching) {
                                    CircularProgressIndicator(
                                        modifier = Modifier
                                            .padding(end = 20.dp)
                                            .size(14.dp),
                                        strokeWidth = 2.dp,
                                    )
                                }
                            }
                        }
                        items(hits, key = { it.id }) { hit ->
                            SearchHitRow(
                                hit = hit,
                                onClick = {
                                    scope.launch {
                                        // Session.open switches task, sets the
                                        // active branch, loads the `around` page
                                        // and focuses the message — the chat
                                        // screen honours the focus when it opens.
                                        session.open(hit)?.let {
                                            haptics.play(TactileAction.OPEN_SEARCH_RESULT)
                                            navigator.open(it)
                                        }
                                    }
                                },
                            )
                        }
                        item(key = "chats-label") {
                            SectionLabel("会话", Modifier.padding(top = 14.dp, bottom = 4.dp))
                        }
                    }

                    if (query.isNotEmpty()) {
                        itemsIndexed(rows, key = { _, summary -> summary.chat.threadId }) { index, summary ->
                            entry(summary, index == rows.lastIndex)
                        }
                    }
                }
            }
        }

        Box(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth()
                .height(topClearance + 20.dp)
                .progressiveHazeBand(hazeState, fromTop = true, alpha = topBandAlpha),
        )

        Box(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .height(bottomClearance + if (bar.searchOpen) 42.dp else 28.dp)
                .progressiveHazeBand(hazeState, fromTop = false),
        )

        Column(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth()
                .onSizeChanged { headerHeightPx = it.height },
        ) {
            RosterHeader(
                canCreateBot = true,
                onSettings = { navigator.push(Destination.Settings) },
                onCreateBot = createBot,
                onCreateGroup = {
                    haptics.play(TactileAction.START_NEW_GROUP)
                    showingNewGroup = true
                },
                onCreateSection = {
                    haptics.play(TactileAction.START_NEW_SECTION)
                    showingNewSection = true
                },
            )
            StatusBanner()
        }

        RosterBottomBar(
            updates = updates,
            bar = bar,
            onBar = { bar = it },
            onOpenUpdates = {
                haptics.play(TactileAction.OPEN_UPDATES)
                showingUpdates = true
            },
            onOpenSearch = {
                haptics.play(TactileAction.OPEN_SEARCH)
                bar = bar.openSearch()
            },
            onCreateBot = createBot,
            canCreateBot = true,
            onCreateSection = {
                haptics.play(TactileAction.START_NEW_SECTION)
                showingNewSection = true
            },
            canCreateSection = remember(state) { SectionRules.selectable(state).isNotEmpty() },
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .navigationBarsPadding()
                .onSizeChanged { bottomBarHeightPx = it.height },
        )
    }
    }

    if (showingUpdates) {
        UpdatesSheet(
            onOpen = { chat ->
                showingUpdates = false
                navigator.open(chat)
            },
            onDismiss = { showingUpdates = false },
        )
    }

    if (showingNewGroup) {
        NewGroupSheet(
            onCreated = { room ->
                showingNewGroup = false
                navigator.open(Chat.RoomChat(room))
            },
            onDismiss = { showingNewGroup = false },
        )
    }

    if (showingNewSection) {
        NewSectionSheet(onDismiss = { showingNewSection = false })
    }

    if (choosingComputer) {
        ComputerSheet(
            connections = connections,
            activeId = connection?.id,
            onChoose = { id ->
                choosingComputer = false
                if (id != connection?.id) session.switchComputer(id)
            },
            onDismiss = { choosingComputer = false },
        )
    }

    managingThreads?.let { chat ->
        TaskSheet(
            chat = chat,
            onDismiss = { managingThreads = null },
            onSelectTask = { target ->
                managingThreads = null
                session.state.value.chat(target)?.let(navigator::open)
            },
        )
    }

    if (creatingBotProfile) {
        AgentProfileSheet(
            // Null is the creation form: it saves by making the bot, and every
            // other way out of it makes nothing.
            bot = null,
            onDismiss = { creatingBotProfile = false },
            onOpenOverview = { id ->
                creatingBotProfile = false
                navigator.push(Destination.Overview(id))
            },
        )
    }
}

/** Room for the floating bar, so the last row can scroll clear of it. */
private val BAR_CLEARANCE = 96.dp

/** Two flags and a string: enough to survive a rotation with the search still up. */
private val RosterBarSaver = listSaver<RosterBar, Any>(
    save = { listOf(it.searchOpen, it.query) },
    restore = { RosterBar(searchOpen = it[0] as Boolean, query = it[1] as String) },
)

private val StringSetSaver = listSaver<Set<String>, String>(
    save = { it.toList() },
    restore = { it.toSet() },
)

/**
 * The Grok-shaped top bar: one circle on each side, Settings on the left and a
 * new bot on the right. The connection used to be a line of text in the middle;
 * it is now the lamp on the bot portraits, so the middle stays open.
 */
@Composable
private fun RosterHeader(
    canCreateBot: Boolean,
    onSettings: () -> Unit,
    onCreateBot: () -> Unit,
    onCreateGroup: () -> Unit,
    onCreateSection: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TouchTarget(onClick = onSettings, contentDescription = "设置", size = 44.dp) {
            Box(
                modifier = Modifier
                    .size(44.dp)
                    .chromeCapsule(surface = true),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    painter = painterResource(R.drawable.ic_gear_line),
                    contentDescription = null,
                    tint = minisInk,
                    modifier = Modifier.size(21.dp),
                )
            }
        }

        Spacer(Modifier.weight(1f))

        val interaction = remember { MutableInteractionSource() }
        var menuOpen by remember { mutableStateOf(false) }
        Box {
            Box(
                modifier = Modifier
                    .size(44.dp)
                    .pressScale(interaction, pressed = 0.92f)
                    .chromeCapsule(surface = true)
                    .combinedClickable(
                        interactionSource = interaction,
                        indication = LocalIndication.current,
                        enabled = canCreateBot,
                        role = Role.Button,
                        onClickLabel = "新建",
                        onLongClickLabel = if (canCreateBot) "新建分组" else null,
                        onLongClick = if (canCreateBot) onCreateSection else null,
                        onClick = { menuOpen = true },
                    )
                    .semantics(mergeDescendants = true) {
                        contentDescription = "新建"
                    },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    painter = painterResource(R.drawable.ic_plus_line),
                    contentDescription = null,
                    tint = minisInk,
                    modifier = Modifier.size(22.dp),
                )
            }
            NewMenu(
                expanded = menuOpen,
                onDismiss = { menuOpen = false },
                onCreateBot = {
                    menuOpen = false
                    onCreateBot()
                },
                onCreateGroup = {
                    menuOpen = false
                    onCreateGroup()
                },
            )
        }
    }
}

/** What the top-right + offers: an agent, or a room for a few of them. */
@Composable
private fun NewMenu(
    expanded: Boolean,
    onDismiss: () -> Unit,
    onCreateBot: () -> Unit,
    onCreateGroup: () -> Unit,
) {
    if (!expanded) return
    val gap = with(LocalDensity.current) { 52.dp.roundToPx() }
    Popup(
        alignment = Alignment.TopEnd,
        offset = IntOffset(0, gap),
        onDismissRequest = onDismiss,
        properties = PopupProperties(focusable = true),
    ) {
        Column(
            modifier = Modifier
                .width(176.dp)
                .chromeSheet(cornerRadius = 18.dp, elevation = 14.dp)
                .padding(vertical = 4.dp),
        ) {
            NewMenuRow(
                painter = painterResource(R.drawable.ic_sparkles),
                text = "新建智能体",
                onClick = onCreateBot,
            )
            NewMenuRow(
                painter = painterResource(R.drawable.ic_chat_bubbles),
                text = "新建群组",
                onClick = onCreateGroup,
            )
        }
    }
}

@Composable
private fun NewMenuRow(painter: androidx.compose.ui.graphics.painter.Painter, text: String, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick)
            .heightIn(min = 44.dp)
            .padding(horizontal = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painter = painter,
            contentDescription = null,
            tint = minisInk,
            modifier = Modifier.size(18.dp),
        )
        Text(text, fontSize = 14.sp, color = minisInk)
    }
}

/** The one bot the app is about, large, the way Grok opens on its assistant. */
@Composable
private fun RosterHero(
    summary: ChatSummary,
    status: Session.Status,
    computerName: String?,
    computerCount: Int,
    onChooseComputer: () -> Unit,
    onClick: () -> Unit,
) {
    val chief = (summary.chat as? Chat.BotChat)?.bot?.chiefOfStaff == true
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // The portrait and the name are one button. The computer chip below is
        // deliberately outside it: clearing the hero's descendant semantics to
        // get a single label would otherwise hide the chip from TalkBack.
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(role = Role.Button, onClick = onClick)
                // Keep the name in the merged tree; clearing it would leave
                // only the description and break text-based readers/tests.
                .semantics(mergeDescendants = true) {
                    contentDescription = "${summary.chat.name}，打开会话"
                }
                .padding(top = 6.dp, bottom = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
        Box {
            // The one large portrait on the screen, and the only one that
            // breathes: a slow scale and a six-second highlight sweep are
            // enough to say "alive" without turning the list into an aquarium.
            ChatAvatar(
                chat = summary.chat,
                size = 84.dp,
                animated = false,
                // The whole hero is one labelled button; the portrait must not
                // add a second, duplicate focus stop.
                contentDescription = null,
                fallback = AvatarFallback.PRESET,
                motion = AvatarMotion.BREATH,
                // The one face a person actually looks at for a while: it
                // blinks, follows nothing, and after a minute of being ignored
                // it starts to doze.
                drowsy = true,
                // The commander's crown is drawn by the face rig, so it
                // breathes with the head and tips with its gestures instead of
                // sitting on the screen like a sticker.
                crown = chief,
            )
            // The link to the paired computer is a lamp on the portrait now, not
            // a line of text in the header. The rank moved to the head, so the
            // corner is the lamp's alone.
            ConnectionLight(
                status = status,
                size = 18.dp,
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(1.dp),
            )
        }
        Spacer(Modifier.height(7.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = summary.chat.name,
                fontSize = 17.sp,
                fontWeight = FontWeight.Medium,
                // A long name wraps the hero open; the transcript is one tap
                // away if the reader needs the whole of it.
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (summary.chat.unread) {
                Spacer(Modifier.width(6.dp))
                Box(Modifier.size(8.dp).background(minisAccent, CircleShape))
            }
        }
        }
        // Which computer these bots live on, and the way to the other one.
        // Only when there is a choice: a single paired computer needs no chip,
        // and an unpaired phone has nothing to switch to.
        if (computerCount > 1 && computerName != null) {
            Spacer(Modifier.height(6.dp))
            Row(
                modifier = Modifier
                    .chromeCapsule(surface = true)
                    .clickable(role = Role.Button, onClick = onChooseComputer)
                    .clearAndSetSemantics {
                        contentDescription = "切换电脑，当前 $computerName"
                        role = Role.Button
                        semanticsOnClick(label = "切换电脑") {
                            onChooseComputer()
                            true
                        }
                    }
                    .padding(start = 11.dp, end = 7.dp, top = 4.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = computerName,
                    fontSize = 12.sp,
                    color = minisSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Icon(
                    imageVector = Icons.Filled.KeyboardArrowDown,
                    contentDescription = null,
                    tint = minisSecondary,
                    modifier = Modifier.size(16.dp),
                )
            }
        }
    }
}

/**
 * The paired computers, as a list to choose from.
 *
 * One at a time, because that is what the protocol gives: a single event
 * stream, a single roster, a single session token in use. Merging several
 * computers into one list would need a stream per computer and would collide
 * on bot ids the host assigns, so this is a switch.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ComputerSheet(
    connections: List<Connection>,
    activeId: String?,
    onChoose: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = minisCanvas,
        shape = MinisSheetShape,
        scrimColor = Color.Black.copy(alpha = 0.22f),
    ) {
        GlassBackdrop()
        Column(modifier = Modifier.padding(bottom = 24.dp)) {
            Text(
                text = "电脑",
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                color = minisInk,
                modifier = Modifier.padding(start = 20.dp, end = 20.dp, bottom = 8.dp),
            )
            connections.forEachIndexed { index, computer ->
                val active = computer.id == activeId
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable(role = Role.Button) { onChoose(computer.id) }
                        .padding(horizontal = 20.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = computer.name,
                            fontSize = 16.sp,
                            color = minisInk,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            text = computer.host,
                            fontSize = 12.sp,
                            color = minisTertiary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    if (active) {
                        Icon(
                            imageVector = Icons.Filled.Check,
                            contentDescription = "当前电脑",
                            tint = minisAccent,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                }
                if (index < connections.lastIndex) MinisDivider(insetStart = 20.dp)
            }
        }
    }
}

/**
 * The phone's link to the paired computer as one traffic light, worn on a bot
 * portrait: green when the stream is live, amber while reconnecting, red when
 * the computer is unreachable or the pairing is gone.
 */@Composable
private fun ConnectionLight(status: Session.Status, size: Dp, modifier: Modifier = Modifier) {
    // The palette's own lamps, not five literals: these are states the rest of
    // the app already has names for.
    val (lamp, label) = when (status) {
        Session.Status.Live -> MinisTokens.Success to "电脑已连接"
        Session.Status.Connecting -> MinisTokens.Warning to "正在连接电脑"
        is Session.Status.Offline -> MinisTokens.Danger to "电脑离线"
        Session.Status.Unauthorized -> MinisTokens.Danger to "配对已失效"
        Session.Status.OutdatedApp -> MinisTokens.Warning to "应用需更新"
        Session.Status.Unpaired -> minisTertiary to "未配对"
    }
    Box(
        modifier = modifier
            .size(size)
            .background(minisCanvas, CircleShape)
            .padding(2.dp)
            .background(lamp, CircleShape)
            .semantics { contentDescription = label },
    )
}

/** A heading over a stretch of the list. */
@Composable
private fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    MinisSectionHeader(RosterLayout.sectionLabel(text), modifier)
}

/**
 * Every group, across the top. Making one lives behind the header's +, together
 * with making a bot, so the strip carries groups and nothing else.
 */
@Composable
private fun GroupsStrip(
    title: String,
    rooms: List<Room>,
    members: Map<String, List<Bot>>,
    onOpen: (Room) -> Unit,
) {
    Column(
        modifier = Modifier.padding(top = 2.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SectionLabel(title)
        LazyRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = PaddingValues(horizontal = 16.dp),
        ) {
            items(rooms, key = { it.id }) { room ->
                GroupTile(
                    room = room,
                    members = members[room.id].orEmpty(),
                    onClick = { onOpen(room) },
                )
            }
        }
    }
}

/**
 * A room as a round tile: the first two members' mascots stacked, its name
 * beneath.
 */
@Composable
private fun GroupTile(room: Room, members: List<Bot>, onClick: () -> Unit) {
    GroupTileFrame(
        label = room.name,
        labelColor = MaterialTheme.colorScheme.onSurface,
        onClick = onClick,
    ) {
        Box(
            Modifier
                .size(64.dp)
                .background(secondaryTint.copy(alpha = 0.14f), CircleShape),
        )
        members.getOrNull(0)?.let {
            BotAvatar(
                bot = it,
                size = 34.dp,
                state = MausState.HAPPY,
                animated = false,
                modifier = Modifier.offset(x = (-9).dp, y = (-6).dp),
            )
        }
        members.getOrNull(1)?.let {
            Box(
                modifier = Modifier
                    .offset(x = 11.dp, y = 9.dp)
                    .background(MaterialTheme.colorScheme.surface, CircleShape)
                    .padding(2.dp),
            ) {
                BotAvatar(bot = it, size = 30.dp, state = MausState.HAPPY, animated = false)
            }
        }
        if (room.unread) {
            Box(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(3.dp)
                    .size(14.dp)
                    .background(MaterialTheme.colorScheme.surface, CircleShape)
                    .padding(2.dp)
                    .background(BubbleColor.mine, CircleShape),
            )
        }
    }
}

@Composable
private fun GroupTileFrame(
    label: String,
    labelColor: Color,
    onClick: () -> Unit,
    content: @Composable BoxScope.() -> Unit,
) {
    Column(
        modifier = Modifier
            .width(76.dp)
            .clip(RoundedCornerShape(18.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Box(modifier = Modifier.size(64.dp), contentAlignment = Alignment.Center, content = content)
        Text(
            text = label,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            color = labelColor,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun ChatRow(
    summary: ChatSummary,
    face: MausState,
    waiting: Boolean,
    status: Session.Status,
    last: Boolean,
    onClick: () -> Unit,
) {
    val chat = summary.chat
    val now = remember(summary.lastActivity) { System.currentTimeMillis() }
    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(role = Role.Button, onClick = onClick)
                .padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier.padding(vertical = 12.dp),
            ) {
                ChatAvatar(
                    chat = chat,
                    size = 46.dp,
                    animated = false,
                    contentDescription = "${chat.name} 头像",
                    // Rows get only the sweep: a list of discs all breathing in
                    // place would pull the eye away from the names.
                    fallback = AvatarFallback.PRESET,
                    motion = AvatarMotion.SHEEN,
                )
                ConnectionLight(
                    status = status,
                    size = 13.dp,
                    modifier = Modifier.align(Alignment.BottomEnd),
                )
            }
            Spacer(Modifier.width(13.dp))

            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    // The name, crown and role share one flexible group. Giving
                    // the name and the role each their own weight left two
                    // thirds of the row's free space unclaimed, so every
                    // timestamp stopped short of the right edge — and by a
                    // different amount per row. One group takes the space; the
                    // clock is the last thing before the margin.
                    Row(
                        modifier = Modifier.weight(1f),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = chat.name,
                            fontSize = 17.sp,
                            fontWeight = FontWeight.Medium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                        if (chat is Chat.BotChat && chat.bot.chiefOfStaff == true) {
                            Spacer(Modifier.width(4.dp))
                            CrownBadge(size = 14.dp)
                        }
                        // The bot's job, quietly after the name rather than in a chip.
                        if (chat.subtitle.isNotEmpty()) {
                            Spacer(Modifier.width(6.dp))
                            Text(
                                text = chat.subtitle,
                                fontSize = 12.sp,
                                color = minisTertiary,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    Text(
                        text = RelativeStamp.list(
                            summary.lastActivity,
                            now,
                        ),
                        fontSize = 13.sp,
                        color = minisSecondary,
                        maxLines = 1,
                        // 13 sp against a 17 sp name: centring leaves the clock
                        // a couple of dp above the name's baseline.
                        modifier = Modifier.padding(start = 10.dp, top = 2.dp),
                    )
                    if (chat.unread && !chat.busy) {
                        Spacer(Modifier.width(6.dp))
                        Box(Modifier.size(8.dp).background(minisAccent, CircleShape))
                    }
                }

                Row(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // One line for every bot, so the rows keep one rhythm.
                    Text(
                        text = RosterPreviewFormat.display(summary.preview).ifEmpty { " " },
                        fontSize = 15.sp,
                        color = minisSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    if (chat.busy) {
                        Box(Modifier.size(6.dp).background(minisAccent, CircleShape))
                        Text("正在工作", fontSize = 12.sp, color = minisAccent)
                    }
                }

                if (waiting) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(6.dp).background(minisAccent, CircleShape))
                        Spacer(Modifier.width(6.dp))
                        Text(
                            text = "等待你处理",
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Medium,
                            color = minisAccent,
                        )
                    }
                }
            }
        }
    }
}

/**
 * The bar over the bottom of the list: Updates beside search and new bot, or —
 * once search is open — the field beside Cancel.
 *
 * Cancel is what closes it, and it takes the query with it: that is what puts the
 * groups strip back and returns the list to bots only.
 */
@Composable
private fun RosterBottomBar(
    updates: List<ChatUpdate>,
    bar: RosterBar,
    onBar: (RosterBar) -> Unit,
    onOpenUpdates: () -> Unit,
    onOpenSearch: () -> Unit,
    onCreateBot: () -> Unit,
    canCreateBot: Boolean,
    onCreateSection: () -> Unit,
    canCreateSection: Boolean,
    modifier: Modifier = Modifier,
) {
    val focus = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    LaunchedEffect(bar.searchOpen) {
        if (bar.searchOpen) focus.requestFocus() else focusManager.clearFocus()
    }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (bar.searchOpen) {
            Row(
                modifier = Modifier
                    .weight(1f)
                    .chromeCapsule(surface = true)
                    .height(BAR_HEIGHT)
                    .padding(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = Icons.Filled.Search,
                    contentDescription = null,
                    tint = secondaryTint,
                    modifier = Modifier.size(20.dp),
                )
                Box(modifier = Modifier.weight(1f)) {
                    if (bar.query.isEmpty()) {
                        Text("搜索会话", fontSize = 17.sp, color = secondaryTint)
                    }
                    BasicTextField(
                        value = bar.query,
                        onValueChange = { onBar(bar.typed(it)) },
                        singleLine = true,
                        textStyle = LocalTextStyle.current.copy(
                            fontSize = 17.sp,
                            color = MaterialTheme.colorScheme.onSurface,
                        ),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.onSurface),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                        modifier = Modifier
                            .fillMaxWidth()
                            .focusRequester(focus)
                            // The placeholder is a sibling that disappears once
                            // typing starts; name the field itself.
                            .semantics { contentDescription = "搜索会话" },
                    )
                }
                if (bar.query.isNotEmpty()) {
                    TouchTarget(onClick = { onBar(bar.clearQuery()) }, size = 24.dp) {
                        Icon(
                            imageVector = Icons.Filled.Close,
                            contentDescription = "清除搜索",
                            tint = secondaryTint,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
            }

            Box(
                modifier = Modifier
                    .chromeCapsule(surface = true)
                    .clip(CircleShape)
                    .height(BAR_HEIGHT)
                    .clickable(role = Role.Button, onClick = { onBar(bar.cancelSearch()) })
                    .padding(horizontal = 16.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text("取消", fontSize = 17.sp)
            }
        } else {
            Box(
                modifier = Modifier
                    .size(52.dp)
                    .chromeCapsule(surface = true)
                    .clickable(role = Role.Button, onClick = onOpenUpdates)
                    .semantics(mergeDescendants = true) {
                        contentDescription = "动态"
                        stateDescription = if (updates.isNotEmpty()) "有未读更新" else "无未读更新"
                    },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    painter = painterResource(R.drawable.ic_grid),
                    contentDescription = null,
                    tint = minisInk,
                    modifier = Modifier.size(22.dp),
                )
                if (updates.isNotEmpty()) {
                    Box(
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .padding(8.dp)
                            .size(8.dp)
                            .background(minisAccent, CircleShape),
                    )
                }
            }
            Row(
                modifier = Modifier
                    .weight(1f)
                    .height(BAR_HEIGHT)
                    .chromeCapsule(surface = true)
                    .clickable(role = Role.Button, onClick = onOpenSearch)
                    .semantics(mergeDescendants = true) {
                        contentDescription = "搜索会话"
                    }
                    .padding(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = Icons.Filled.Search,
                    contentDescription = null,
                    tint = minisSecondary,
                    modifier = Modifier.size(20.dp),
                )
                Text("搜索", fontSize = 17.sp, color = minisSecondary)
            }
        }
    }
}

private val BAR_HEIGHT = 52.dp

@Composable
private fun SearchHitRow(hit: SearchHit, onClick: () -> Unit) {
    val now = remember(hit.id) { System.currentTimeMillis() }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        // Who said it. Two hits with the same words are otherwise identical.
        Icon(
            // A person for what you said, the Maus mark for what a bot said —
            // iOS makes the same split with person.fill and a speech bubble.
            painter = if (SearchHitRole.isFromUser(hit.role)) {
                rememberVectorPainter(Icons.Filled.Person)
            } else {
                painterResource(R.drawable.ic_dexbot_mark)
            },
            contentDescription = SearchHitRole.contentDescription(hit.role, hit.name),
            tint = secondaryTint,
            modifier = Modifier
                .size(26.dp)
                .background(secondaryTint.copy(alpha = 0.13f), CircleShape)
                .padding(5.dp),
        )

        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(hit.name, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                hit.task?.takeIf { it.isNotEmpty() }?.let {
                    Text(it, fontSize = 12.sp, color = secondaryTint)
                }
                Spacer(Modifier.weight(1f))
                Text(
                    text = RelativeStamp.list(hit.at, now),
                    fontSize = 12.sp,
                    color = secondaryTint,
                )
            }
            Text(
                text = hit.snippet,
                fontSize = 14.sp,
                color = secondaryTint,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** One wording of the connection state, before it becomes a notice card. */
private data class ConnectionNotice(
    val message: String,
    val title: String?,
    val tone: NoticeTone,
)

/**
 * Connection state, shown only when the list needs a word: a reconnect in
 * progress, a revoked pairing, or an app too old to talk to the computer.
 * An ordinary offline blip is left to the automatic retry — the cached roster
 * stays on screen without a card over it.
 */
@Composable
fun StatusBanner() {
    val session = LocalCompanion.current.session
    val status by session.status.collectAsState()
    val snapshotAt by session.rosterSnapshotAt.collectAsState()
    val cachedFor = snapshotAt?.let(::cacheAge)
    val notice: ConnectionNotice? = when (val current = status) {
        Session.Status.Live, Session.Status.Unpaired, is Session.Status.Offline -> null
        Session.Status.Connecting -> ConnectionNotice(
            message = cachedFor?.let { "正在重连，先显示${it}的名单。" } ?: "正在连接电脑…",
            title = null,
            tone = NoticeTone.INFO,
        )
        Session.Status.Unauthorized -> ConnectionNotice(
            message = "此手机已在电脑上取消配对。",
            title = null,
            tone = NoticeTone.ERROR,
        )
        Session.Status.OutdatedApp -> ConnectionNotice(
            message = "电脑已改用加密连接，请更新手机上的 Luna Bot 应用后再连接。",
            title = "需要更新应用",
            tone = NoticeTone.ERROR,
        )
    }
    // The banner appears and leaves by growing its own row, so the list below
    // slides instead of jumping the moment a reconnect starts or ends.
    AnimatedContent(
        targetState = notice,
        transitionSpec = {
            (fadeIn(tween(180)) + slideInVertically(tween(180)) { -it / 3 }) togetherWith
                (fadeOut(tween(120)) + slideOutVertically(tween(120)) { -it / 3 })
        },
        label = "connection",
    ) { value ->
        if (value == null) {
            Spacer(Modifier.height(0.dp))
        } else {
            InlineNotice(
                message = value.message,
                title = value.title,
                tone = value.tone,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 3.dp),
            )
        }
    }
}

/** "刚刚", "5 分钟前" — the phrase that slots straight into "…的名单". */
private fun cacheAge(savedAtMillis: Long): String {
    val minutes = ((System.currentTimeMillis() - savedAtMillis) / 60_000L).coerceAtLeast(0)
    return when {
        minutes < 1 -> "刚刚"
        minutes < 60 -> "$minutes 分钟前"
        minutes < 60 * 24 -> "${minutes / 60} 小时前"
        else -> "${minutes / (60 * 24)} 天前"
    }
}
