package com.lunabot.companion.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
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
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import com.lunabot.companion.R
import com.lunabot.companion.core.Bot
import com.lunabot.companion.core.Chat
import com.lunabot.companion.core.ChatSummary
import com.lunabot.companion.core.Connection
import com.lunabot.companion.core.Room
import com.lunabot.companion.core.SearchHit
import com.lunabot.companion.core.ChatTarget
import com.lunabot.companion.core.Session
import com.lunabot.companion.core.chat
import com.lunabot.companion.core.chatSummaries
import com.lunabot.companion.core.forTask
import com.lunabot.companion.core.target
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
    var activeTab by rememberSaveable { mutableIntStateOf(0) }
    var drawerOpen by remember { mutableStateOf(false) }
    var showingUpdates by remember { mutableStateOf(false) }
    var showingNewGroup by remember { mutableStateOf(false) }
    var showingNewSection by remember { mutableStateOf(false) }
    var expandedBots by rememberSaveable(stateSaver = StringSetSaver) { mutableStateOf(emptySet<String>()) }
    var collapsedFolders by rememberSaveable(stateSaver = StringSetSaver) { mutableStateOf(emptySet<String>()) }
    var collapsedSections by rememberSaveable(stateSaver = StringSetSaver) { mutableStateOf(emptySet<String>()) }
    var creatingThreads by remember { mutableStateOf(emptySet<String>()) }
    var openingSearchHit by remember { mutableStateOf<String?>(null) }
    var managingThreads by remember { mutableStateOf<Chat?>(null) }
    // Which computer this phone is talking to. One stream at a time is the
    // protocol, so the choice is a switch, not a merge.
    var choosingComputer by remember { mutableStateOf(false) }
    // A new bot opens the same profile editor the chat header uses, in creation
    // mode: the bot is only made when that page is saved, so backing out of it
    // leaves the fleet untouched.
    var creatingBotProfile by remember { mutableStateOf(false) }

    val query = bar.query

    BackHandler(enabled = drawerOpen) { drawerOpen = false }
    BackHandler(enabled = !drawerOpen && bar.searchOpen) {
        bar = RosterBar()
        hits = emptyList()
    }
    BackHandler(enabled = !drawerOpen && !bar.searchOpen && activeTab != 0) {
        activeTab = 0
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
            collapsedSections = emptySet()
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
            val bot = (summary.chat as? Chat.BotChat)?.bot
            ChatRow(
                summary = summary,
                face = faces[summary.id] ?: MausState.IDLE,
                waiting = summary.id in waiting,
                status = status,
                last = last,
                onClick = { navigator.open(environment.chatPreferences.restoringThread(summary.chat, connection?.id)) },
                threadToggle = bot?.let { b ->
                    {
                        ThreadToggle(
                            bot = b,
                            expanded = b.id in expandedBots,
                            searching = query.isNotBlank(),
                            queuedThreadIds = state.queuedThreadIds,
                            onToggle = {
                                haptics.play(HapticCue.SELECT)
                                expandedBots = if (b.id in expandedBots) expandedBots - b.id else expandedBots + b.id
                            },
                        )
                    }
                },
            )
            bot?.let { b ->
                // Grok's list is one row per assistant. A bot with a single
                // thread had a "话题 1" row under it that said nothing; only
                // show the tree when there is a tree to show.
                if (b.tasks.orEmpty().size > 1 || b.id in expandedBots || query.isNotEmpty()) {
                    BotThreadTree(
                    bot = b,
                    queuedThreadIds = state.queuedThreadIds,
                    query = query,
                    expanded = b.id in expandedBots,
                    collapsedFolders = collapsedFolders,
                    creating = b.id in creatingThreads,
                    onToggleFolder = { key ->
                        haptics.play(HapticCue.SELECT)
                        collapsedFolders = if (key in collapsedFolders) collapsedFolders - key else collapsedFolders + key
                    },
                    onCreate = {
                        // Hoisted across bot sections and search, so moving a row
                        // cannot permit a second creation while the first is pending.
                        if (b.id !in creatingThreads) {
                            creatingThreads = creatingThreads + b.id
                            scope.launch {
                                try {
                                    val created = session.createTask(b, title = null)
                                    if (created != null) {
                                        navigator.open(Chat.BotChat(created))
                                    } else if (session.actionError == null) {
                                        session.actionError = "无法创建会话，请检查连接后重试。"
                                    }
                                } finally {
                                    creatingThreads = creatingThreads - b.id
                                }
                            }
                        }
                    },
                    onManage = { managingThreads = Chat.BotChat(b) },
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

    val homeCanvas = minisCanvas
    val heroBot = (hero?.chat as? Chat.BotChat)?.bot
    val companionSummaries = remember(summaries, hero) {
        summaries.filter { it.id != hero?.id && it.chat is Chat.BotChat }
    }
    var embeddedHeroTarget by remember(hero?.id, connection?.id) {
        mutableStateOf<ChatTarget?>(null)
    }
    val showLiveHeroChat = activeTab == 0 && !bar.searchOpen && hero != null
    val drawerProgress by animateFloatAsState(
        targetValue = if (drawerOpen) 1f else 0f,
        animationSpec = androidx.compose.animation.core.spring(dampingRatio = 0.88f, stiffness = 420f),
        label = "muse-drawer-push",
    )
    val drawerWidthPx = with(density) { 296.dp.toPx() }
    val pushedCorner = (28f * drawerProgress).dp

    CompositionLocalProvider(LocalHazeState provides hazeState) {
    Box(modifier = Modifier.fillMaxSize().background(homeCanvas)) {
        // Muse-style underlying pure-white drawer layer (revealed as main stage pushes right).
        if (drawerProgress > 0.005f) {
            MuseDrawerContent(
                activeTab = activeTab,
                companions = companionSummaries,
                computerName = connection?.name,
                status = status,
                modifier = Modifier
                    .align(Alignment.CenterStart)
                    .graphicsLayer {
                        translationX = -36.dp.toPx() * (1f - drawerProgress)
                        alpha = (drawerProgress * 1.4f).coerceIn(0f, 1f)
                    },
                onSelectTab = { next ->
                    haptics.play(HapticCue.SELECT)
                    activeTab = next
                    drawerOpen = false
                },
                onOpenCompanion = { summary ->
                    drawerOpen = false
                    navigator.open(
                        environment.chatPreferences.restoringThread(summary.chat, connection?.id),
                    )
                },
                onOpenSettings = {
                    drawerOpen = false
                    navigator.push(Destination.Settings)
                },
                onOpenGeneralMemory = {
                    drawerOpen = false
                    navigator.push(Destination.TeamMemory(""))
                },
                onOpenSearch = {
                    drawerOpen = false
                    activeTab = 1
                    bar = bar.openSearch()
                },
                onCreateBot = {
                    drawerOpen = false
                    createBot()
                },
                onCreateGroup = {
                    drawerOpen = false
                    showingNewGroup = true
                },
                onSwitchComputer = {
                    drawerOpen = false
                    choosingComputer = true
                },
            )
        }

        // Main app stage: physically pushes right with 28dp rounded corners when drawer opens.
        Box(
            modifier = Modifier
                .fillMaxSize()
                .graphicsLayer {
                    translationX = drawerWidthPx * drawerProgress
                }
                .then(
                    if (drawerProgress > 0.01f) {
                        Modifier
                            .shadow(elevation = (18f * drawerProgress).dp, shape = RoundedCornerShape(pushedCorner))
                            .clip(RoundedCornerShape(pushedCorner))
                    } else {
                        Modifier
                    },
                )
                .background(homeCanvas),
        ) {
        Column(modifier = Modifier.fillMaxSize()) {
            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                when {
                    showLiveHeroChat -> {
                        val activeHero = hero!!
                        val restoredChat = remember(activeHero.id, connection?.id) {
                            environment.chatPreferences.restoringThread(activeHero.chat, connection?.id)
                        }
                        val activeTarget = embeddedHeroTarget ?: restoredChat.target
                        ChatScreen(
                            destination = Destination.Chat(activeTarget),
                            onResolved = { embeddedHeroTarget = it },
                            onBack = { activeTab = 1 },
                            onOpenComputer = { navigator.push(Destination.Computer(it)) },
                            onOpenOverview = { navigator.push(Destination.Overview(it)) },
                            retainsDraft = { true },
                            onOpenChat = navigator::open,
                            embedded = true,
                            onOpenDrawer = {
                                haptics.play(HapticCue.SELECT)
                                drawerOpen = true
                            },
                        )
                    }
                    activeTab == 2 -> Box(modifier = Modifier.fillMaxSize().statusBarsPadding()) {
                        TasksRoutinesScreen(
                            onBack = { activeTab = 0 },
                            onOpenChat = navigator::open,
                            embedded = true,
                        )
                    }
                    activeTab == 3 -> MuseLibraryTab(
                        heroChat = hero?.chat,
                        heroName = heroBot?.name ?: "Luna",
                        computerName = connection?.name,
                        status = status,
                        extraTopPadding = (topClearance - 58.dp).coerceAtLeast(0.dp),
                        onOpenComputer = heroBot?.let { bot -> { navigator.push(Destination.Computer(bot.id)) } },
                        onOpenOverview = heroBot?.let { bot -> { navigator.push(Destination.Overview(bot.id)) } },
                        onSwitchComputer = { choosingComputer = true },
                        onOpenSettings = { navigator.push(Destination.Settings) },
                    )
                    else -> Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .background(homeCanvas)
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
                                contentPadding = PaddingValues(
                                    top = topClearance + 4.dp,
                                    bottom = if (bar.searchOpen) 76.dp else 20.dp,
                                ),
                            ) {
                                if (RosterLayout.showsGroups(query)) {
                                    val unsectioned = state.unsectionedBots.mapNotNull { listSummariesById[it.id] }
                                    item(key = "companions-title") {
                                        Text(
                                            text = "协作助手",
                                            fontSize = 25.sp,
                                            fontWeight = FontWeight.Bold,
                                            letterSpacing = (-0.4).sp,
                                            color = minisInk,
                                            modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 6.dp, bottom = 8.dp),
                                        )
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
                                            Text(
                                                text = "已置顶",
                                                fontSize = 15.sp,
                                                fontWeight = FontWeight.SemiBold,
                                                color = minisSecondary,
                                                modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 4.dp),
                                            )
                                        }
                                        itemsIndexed(pinned, key = { _, summary -> "pinned-${summary.id}" }) { index, summary ->
                                            Box(Modifier.animateItem()) {
                                                entry(summary, index == pinned.lastIndex)
                                            }
                                        }
                                    }
                                    if (unsectioned.isNotEmpty()) {
                                        itemsIndexed(unsectioned, key = { _, summary -> "bot-${summary.id}" }) { index, summary ->
                                            Box(Modifier.animateItem()) {
                                                entry(summary, index == unsectioned.lastIndex)
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
                                    if (attention.isNotEmpty()) {
                                        item(key = "attention-label") {
                                            Text(
                                                text = "需要关注",
                                                fontSize = 18.sp,
                                                fontWeight = FontWeight.Bold,
                                                color = minisInk,
                                                modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 22.dp, bottom = 6.dp),
                                            )
                                        }
                                        itemsIndexed(attention, key = { _, itemEntry -> "attn-${itemEntry.botId}-${itemEntry.task.threadId}" }) { index, itemEntry ->
                                            Column(modifier = Modifier.padding(horizontal = 4.dp)) {
                                                AttentionRow(entry = itemEntry, onOpen = {
                                                    state.bots.firstOrNull { it.id == itemEntry.botId }
                                                        ?.let { bot -> Chat.BotChat(bot.forTask(itemEntry.task.threadId) ?: bot) }
                                                        ?.let(navigator::open)
                                                })
                                                if (index < attention.lastIndex) {
                                                    HorizontalDivider(
                                                        modifier = Modifier.padding(start = 36.dp, end = 16.dp),
                                                        thickness = 0.5.dp,
                                                        color = minisSeparator,
                                                    )
                                                }
                                            }
                                        }
                                    }
                                    state.sidebarSections.forEach { section ->
                                        val sectionChiefs = section.chiefs.mapNotNull { listSummariesById[it.id] }
                                        val sectionBots = section.bots.mapNotNull { listSummariesById[it.id] }
                                        val sectionCollapsed = section.id in collapsedSections
                                        val sectionCount = sectionChiefs.size + sectionBots.size + section.channels.size
                                        item(key = "section-${section.id}") {
                                            CollapsibleSectionHeader(
                                                title = section.name,
                                                count = sectionCount,
                                                collapsed = sectionCollapsed,
                                                onToggle = {
                                                    haptics.play(HapticCue.SELECT)
                                                    collapsedSections = if (sectionCollapsed) {
                                                        collapsedSections - section.id
                                                    } else {
                                                        collapsedSections + section.id
                                                    }
                                                },
                                                onOpenMemory = { navigator.push(Destination.TeamMemory(section.name)) },
                                            )
                                        }
                                        if (!sectionCollapsed) {
                                            itemsIndexed(
                                                sectionChiefs,
                                                key = { _, summary -> "section-${section.id}-chief-${summary.id}" },
                                            ) { index, summary ->
                                                Box(Modifier.animateItem()) {
                                                    entry(
                                                        summary,
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
                                            opening = openingSearchHit == hit.id,
                                            onClick = {
                                                if (openingSearchHit != null) return@SearchHitRow
                                                openingSearchHit = hit.id
                                                scope.launch {
                                                    try {
                                                        session.open(hit)?.let {
                                                            haptics.play(TactileAction.OPEN_SEARCH_RESULT)
                                                            navigator.open(it)
                                                        }
                                                    } finally {
                                                        openingSearchHit = null
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

                        if (bar.searchOpen) {
                            Box(
                                modifier = Modifier
                                    .align(Alignment.BottomCenter)
                                    .fillMaxWidth()
                                    .background(homeCanvas),
                            ) {
                                RosterBottomBar(
                                    updates = updates,
                                    bar = bar,
                                    onBar = { bar = it },
                                    heroName = hero?.chat?.name,
                                    onQuickChat = null,
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
                                )
                            }
                        }
                    }
                }

                if (!showLiveHeroChat) {
                    if (activeTab == 1 || bar.searchOpen) {
                        Box(
                            modifier = Modifier
                                .align(Alignment.TopCenter)
                                .fillMaxWidth()
                                .height(topClearance + 16.dp)
                                .progressiveHazeBand(hazeState, fromTop = true, alpha = topBandAlpha),
                        )
                    }
                    Column(
                        modifier = Modifier
                            .align(Alignment.TopCenter)
                            .fillMaxWidth()
                            .onSizeChanged { headerHeightPx = it.height }
                            .statusBarsPadding(),
                    ) {
                        RosterHeader(
                            showRightActions = activeTab == 1 || bar.searchOpen || hero == null,
                            showSettingsButton = activeTab == 3,
                            canCreateBot = true,
                            onOpenDrawer = {
                                haptics.play(HapticCue.SELECT)
                                drawerOpen = true
                            },
                            onOpenSettings = {
                                haptics.play(HapticCue.SELECT)
                                navigator.push(Destination.Settings)
                            },
                            onOpenSearch = {
                                haptics.play(TactileAction.OPEN_SEARCH)
                                activeTab = 1
                                bar = bar.openSearch()
                            },
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
                }
            }

            MuseBottomNavBar(
                activeTab = activeTab,
                onSelect = { next ->
                    haptics.play(HapticCue.SELECT)
                    activeTab = next
                    if (bar.searchOpen) {
                        bar = RosterBar()
                        hits = emptyList()
                    }
                },
            )
        }
        if (drawerProgress > 0.01f) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.14f * drawerProgress))
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        role = Role.Button,
                        onClick = { drawerOpen = false },
                    ),
            )
        }
        }
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
            status = status,
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
private fun AmbientAuroraBackdrop(dark: Boolean, modifier: Modifier = Modifier) {
    Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height
        drawCircle(
            brush = Brush.radialGradient(
                colors = if (dark) {
                    listOf(Color(0x26E8A55C), Color(0x0ED98F4E), Color.Transparent)
                } else {
                    listOf(Color(0x52FBD4B4), Color(0x24F8E2CC), Color.Transparent)
                },
                center = Offset(w * 0.16f, h * 0.10f),
                radius = w * 0.88f,
            ),
            radius = w * 0.88f,
            center = Offset(w * 0.16f, h * 0.10f),
        )
        drawCircle(
            brush = Brush.radialGradient(
                colors = if (dark) {
                    listOf(Color(0x224B7BE5), Color(0x0C3D66C4), Color.Transparent)
                } else {
                    listOf(Color(0x4CC2E0FD), Color(0x20D7EAFC), Color.Transparent)
                },
                center = Offset(w * 0.86f, h * 0.14f),
                radius = w * 0.82f,
            ),
            radius = w * 0.82f,
            center = Offset(w * 0.86f, h * 0.14f),
        )
        drawCircle(
            brush = Brush.radialGradient(
                colors = if (dark) {
                    listOf(Color(0x168C6CE6), Color.Transparent)
                } else {
                    listOf(Color(0x22E7DCFB), Color.Transparent)
                },
                center = Offset(w * 0.52f, h * 0.22f),
                radius = w * 0.62f,
            ),
            radius = w * 0.62f,
            center = Offset(w * 0.52f, h * 0.22f),
        )
    }
}

private fun Modifier.museGlassSurface(
    shape: Shape,
    dark: Boolean,
    alpha: Float = 0.72f,
    elevation: Dp = 3.dp,
): Modifier {
    val fill = if (dark) Color(0xFF1F222A).copy(alpha = alpha) else Color.White.copy(alpha = alpha)
    val rim = if (dark) Color.White.copy(alpha = 0.11f) else Color.White.copy(alpha = 0.88f)
    return this
        .then(
            if (dark || elevation <= 0.dp) {
                Modifier
            } else {
                Modifier.shadow(
                    elevation = elevation,
                    shape = shape,
                    ambientColor = Color(0x0A000000),
                    spotColor = Color(0x10000000),
                )
            },
        )
        .clip(shape)
        .background(fill)
        .border(0.85.dp, rim, shape)
}

@Composable
private fun RosterHeader(
    showRightActions: Boolean,
    showSettingsButton: Boolean = false,
    canCreateBot: Boolean,
    onOpenDrawer: () -> Unit,
    onOpenSettings: () -> Unit = {},
    onOpenSearch: () -> Unit,
    onCreateBot: () -> Unit,
    onCreateGroup: () -> Unit,
    onCreateSection: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 12.dp, end = 12.dp, top = 10.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        MuseDrawerButton(onClick = onOpenDrawer)

        Spacer(Modifier.weight(1f))

        if (showRightActions) {
            Row(
                modifier = Modifier
                    .height(46.dp)
                    .museFloatingPill(CircleShape, elevation = 4.dp)
                    .padding(horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TouchTarget(onClick = onOpenSearch, contentDescription = "搜索会话", size = 40.dp) {
                    Icon(
                        painter = painterResource(R.drawable.ic_search_line),
                        contentDescription = null,
                        tint = minisInk,
                        modifier = Modifier.size(19.dp),
                    )
                }
                val interaction = remember { MutableInteractionSource() }
                var menuOpen by remember { mutableStateOf(false) }
                Box {
                    Box(
                        modifier = Modifier
                            .size(40.dp)
                            .pressScale(interaction, pressed = 0.92f)
                            .clip(CircleShape)
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
                            modifier = Modifier.size(20.dp),
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
        } else if (showSettingsButton) {
            TouchTarget(onClick = onOpenSettings, contentDescription = "设置") {
                Box(
                    modifier = Modifier
                        .size(44.dp)
                        .museFloatingPill(CircleShape, elevation = 4.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        painter = painterResource(R.drawable.ic_gear_line),
                        contentDescription = null,
                        tint = minisInk,
                        modifier = Modifier.size(20.dp),
                    )
                }
            }
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

/** The primary companion stage — serene, compact, and floating over the ambient aurora. */
@Composable
private fun RosterHero(
    summary: ChatSummary,
    status: Session.Status,
    computerName: String?,
    computerCount: Int,
    canvasColor: Color,
    onChooseComputer: () -> Unit,
    onClick: () -> Unit,
) {
    val chief = (summary.chat as? Chat.BotChat)?.bot?.chiefOfStaff == true
    val dark = minisIsDark()
    val showHostPill = computerCount > 1 && computerName != null
    val heroPreview = remember(summary.preview) { RosterPreviewFormat.display(summary.preview) }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 0.dp, bottom = 2.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // Ambient stage around Luna's breathing portrait, name, and quiet preview.
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(role = Role.Button, onClick = onClick)
                .semantics(mergeDescendants = true) {
                    contentDescription = "${summary.chat.name}，打开会话"
                }
                .padding(top = 2.dp, bottom = 7.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            // Muse-style serene centerpiece: avatar cleanly above a borderless soft
            // white name pill so round mascots never get their chin masked.
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                ChatAvatar(
                    chat = summary.chat,
                    size = 76.dp,
                    state = if (summary.chat.busy) MausState.WORKING else MausState.IDLE,
                    animated = false,
                    contentDescription = null,
                    fallback = AvatarFallback.PRESET,
                    motion = AvatarMotion.BREATH,
                    mood = if (summary.chat.busy) FaceMood.WORKING else FaceMood.IDLE,
                    drowsy = true,
                    crown = chief,
                    breakout = summary.chat.busy,
                )
                Row(
                    modifier = Modifier
                        .shadow(
                            elevation = if (dark) 0.dp else 3.dp,
                            shape = CircleShape,
                            ambientColor = Color(0x0D000000),
                            spotColor = Color(0x12000000),
                        )
                        .clip(CircleShape)
                        .background(minisCard)
                        .padding(horizontal = 14.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (!showHostPill) {
                        val dotColor = when (status) {
                            Session.Status.Live -> MinisTokens.Success
                            Session.Status.Connecting -> MinisTokens.Warning
                            is Session.Status.Offline, Session.Status.Unauthorized -> MinisTokens.Danger
                            else -> minisTertiary
                        }
                        Box(Modifier.size(7.dp).background(dotColor, CircleShape))
                    }
                    Text(
                        text = summary.chat.name,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Light,
                        letterSpacing = 0.4.sp,
                        color = minisInk,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (summary.chat.unread) {
                        Box(Modifier.size(7.dp).background(minisAccent, CircleShape))
                    }
                }
            }
            Spacer(Modifier.height(6.dp))
            Text(
                text = heroPreview.ifEmpty { "轻点头像，直接和 ${summary.chat.name} 聊两句" },
                fontSize = 13.sp,
                color = minisSecondary,
                textAlign = TextAlign.Center,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(horizontal = 32.dp),
            )
        }

        // Frosted glass host status pill (IP stays tucked inside the switcher sheet).
        if (showHostPill) {
            val statusText = when (status) {
                Session.Status.Live -> "已连接"
                Session.Status.Connecting -> "连接中"
                else -> "离线"
            }
            val statusColor = when (status) {
                Session.Status.Live -> MinisTokens.Success
                Session.Status.Connecting -> MinisTokens.Warning
                else -> minisTertiary
            }
            Row(
                modifier = Modifier
                    .museGlassSurface(CircleShape, dark = dark, alpha = 0.72f, elevation = 2.dp)
                    .clickable(role = Role.Button, onClick = onChooseComputer)
                    .clearAndSetSemantics {
                        contentDescription = "切换电脑，当前 $computerName，$statusText"
                        role = Role.Button
                        semanticsOnClick(label = "切换电脑") {
                            onChooseComputer()
                            true
                        }
                    }
                    .padding(start = 11.dp, end = 8.dp, top = 4.dp, bottom = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(5.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(6.dp).background(statusColor, CircleShape))
                Text(
                    text = "$computerName · $statusText",
                    fontSize = 12.sp,
                    color = minisSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Icon(
                    imageVector = Icons.Filled.KeyboardArrowDown,
                    contentDescription = null,
                    tint = minisSecondary,
                    modifier = Modifier.size(15.dp),
                )
            }
        }
    }
}

private data class SpaceCardSpec(
    val key: String,
    val title: String,
    val subtitle: String,
    val icon: Int,
    val lightStart: Color,
    val lightEnd: Color,
    val darkStart: Color,
    val darkEnd: Color,
    val lightTint: Color,
    val darkTint: Color,
    val lightBadgeBg: Color,
    val darkBadgeBg: Color,
    val onClick: () -> Unit,
)

@Composable
private fun LivingSpacesStrip(
    heroName: String,
    computerName: String?,
    onOpenComputer: (() -> Unit)?,
    onOpenRoutines: () -> Unit,
    onConnectedApps: () -> Unit,
    onOverview: (() -> Unit)?,
) {
    val dark = minisIsDark()
    val cards = buildList {
        if (onOpenComputer != null) {
            add(
                SpaceCardSpec(
                    key = "space-computer",
                    title = "实时桌面",
                    subtitle = computerName ?: "查看电脑画面",
                    icon = R.drawable.ic_display_line,
                    lightStart = Color(0xCCFFFFFF),
                    lightEnd = Color(0xBFEAF3FF),
                    darkStart = Color(0xCC1E2634),
                    darkEnd = Color(0xCC171E2A),
                    lightTint = Color(0xFF2B6CB0),
                    darkTint = Color(0xFF7BB3FF),
                    lightBadgeBg = Color(0x1F2B6CB0),
                    darkBadgeBg = Color(0x267BB3FF),
                    onClick = onOpenComputer,
                ),
            )
        }
        add(
            SpaceCardSpec(
                key = "space-routines",
                title = "定时巡检",
                subtitle = "自动任务与日程",
                icon = R.drawable.ic_schedule,
                lightStart = Color(0xCCFFFFFF),
                lightEnd = Color(0xBFFFF3E2),
                darkStart = Color(0xCC2A2318),
                darkEnd = Color(0xCC201B14),
                lightTint = Color(0xFFB7791F),
                darkTint = Color(0xFFF0BE66),
                lightBadgeBg = Color(0x22D69E2E),
                darkBadgeBg = Color(0x26F0BE66),
                onClick = onOpenRoutines,
            ),
        )
        add(
            SpaceCardSpec(
                key = "space-apps",
                title = "连接应用",
                subtitle = "工具授权与生态",
                icon = R.drawable.ic_hub,
                lightStart = Color(0xCCFFFFFF),
                lightEnd = Color(0xBFE8F7EE),
                darkStart = Color(0xCC172620),
                darkEnd = Color(0xCC131F1A),
                lightTint = Color(0xFF2F855A),
                darkTint = Color(0xFF68D391),
                lightBadgeBg = Color(0x1F2F855A),
                darkBadgeBg = Color(0x2668D391),
                onClick = onConnectedApps,
            ),
        )
        if (onOverview != null) {
            add(
                SpaceCardSpec(
                    key = "space-overview",
                    title = "$heroName 总览",
                    subtitle = "记忆与能力面板",
                    icon = R.drawable.ic_sparkles,
                    lightStart = Color(0xCCFFFFFF),
                    lightEnd = Color(0xBFF2ECFF),
                    darkStart = Color(0xCC231D30),
                    darkEnd = Color(0xCC1A1624),
                    lightTint = Color(0xFF6B46C1),
                    darkTint = Color(0xFFB794F4),
                    lightBadgeBg = Color(0x1F6B46C1),
                    darkBadgeBg = Color(0x26B794F4),
                    onClick = onOverview,
                ),
            )
        }
    }
    if (cards.isEmpty()) return
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 12.dp),
    ) {
        Text(
            text = "空间",
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            color = minisSecondary,
            modifier = Modifier.padding(start = 22.dp, bottom = 8.dp),
        )
        LazyRow(
            contentPadding = PaddingValues(horizontal = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(cards, key = { it.key }) { card ->
                val shape = RoundedCornerShape(22.dp)
                val gradient = Brush.linearGradient(
                    colors = if (dark) listOf(card.darkStart, card.darkEnd) else listOf(card.lightStart, card.lightEnd),
                )
                val rimColor = if (dark) Color.White.copy(alpha = 0.11f) else Color.White.copy(alpha = 0.90f)
                val iconTint = if (dark) card.darkTint else card.lightTint
                val iconBadgeBg = if (dark) card.darkBadgeBg else card.lightBadgeBg
                Box(
                    modifier = Modifier
                        .width(144.dp)
                        .height(88.dp)
                        .then(
                            if (dark) Modifier else Modifier.shadow(
                                elevation = 3.dp,
                                shape = shape,
                                ambientColor = Color(0x0A000000),
                                spotColor = Color(0x10000000),
                            ),
                        )
                        .clip(shape)
                        .background(gradient)
                        .border(0.85.dp, rimColor, shape)
                        .clickable(role = Role.Button, onClick = card.onClick)
                        .padding(horizontal = 13.dp, vertical = 12.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .size(28.dp)
                            .background(iconBadgeBg, CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            painter = painterResource(card.icon),
                            contentDescription = null,
                            tint = iconTint,
                            modifier = Modifier.size(15.dp),
                        )
                    }
                    Column(
                        modifier = Modifier.align(Alignment.BottomStart),
                        verticalArrangement = Arrangement.spacedBy(1.dp),
                    ) {
                        Text(
                            text = card.title,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = minisInk,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            text = card.subtitle,
                            fontSize = 11.5.sp,
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
    status: Session.Status,
    onChoose: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = minisCanvas,
        shape = MinisSheetShape,
        scrimColor = MinisSheetScrim,
        dragHandle = { MuseSheetDragHandle() },
    ) {
        GlassBackdrop()
        Column(
            modifier = Modifier
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding()
                .padding(bottom = 24.dp),
        ) {
            Text(
                text = "电脑",
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                color = minisInk,
                modifier = Modifier.padding(start = 20.dp, end = 20.dp, bottom = 8.dp),
            )
            connections.forEachIndexed { index, computer ->
                val active = computer.id == activeId
                val dotColor = if (active) {
                    when (status) {
                        Session.Status.Live -> MinisTokens.Success
                        Session.Status.Connecting -> MinisTokens.Warning
                        else -> MinisTokens.Danger
                    }
                } else {
                    minisTertiary.copy(alpha = 0.45f)
                }
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable(role = Role.Button) { onChoose(computer.id) }
                        .padding(horizontal = 20.dp, vertical = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(8.dp).background(dotColor, CircleShape))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = computer.name,
                            fontSize = 16.sp,
                            fontWeight = if (active) FontWeight.Medium else FontWeight.Normal,
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
                if (index < connections.lastIndex) MinisDivider(insetStart = 40.dp)
            }
        }
    }
}

/**
 * The phone's link to the paired computer as one traffic light, worn on a bot
 * portrait: green when the stream is live, amber while reconnecting, red when
 * the computer is unreachable or the pairing is gone.
 */@Composable
private fun ConnectionLight(
    status: Session.Status,
    size: Dp,
    modifier: Modifier = Modifier,
    ringColor: Color = minisCanvas,
) {
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
            .background(ringColor, CircleShape)
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

/** Collapsible heading for a sidebar section in the roster list. */
@Composable
private fun CollapsibleSectionHeader(
    title: String,
    count: Int,
    collapsed: Boolean,
    onToggle: () -> Unit,
    onOpenMemory: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(44.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            modifier = Modifier
                .weight(1f)
                .fillMaxHeight()
                .clickable(role = Role.Button, onClick = onToggle)
                .semantics(mergeDescendants = true) {
                    contentDescription = "$title 分组"
                    stateDescription = if (collapsed) "已折叠，$count 项" else "已展开"
                }
                .padding(start = 20.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Icon(
                imageVector = if (collapsed) Icons.AutoMirrored.Filled.KeyboardArrowRight else Icons.Filled.KeyboardArrowDown,
                contentDescription = null,
                tint = minisSecondary,
                modifier = Modifier.size(15.dp),
            )
            Text(
                text = RosterLayout.sectionLabel(title),
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                letterSpacing = 0.2.sp,
                color = minisSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (collapsed && count > 0) {
                Text(
                    text = "$count",
                    fontSize = 12.sp,
                    color = minisTertiary,
                )
            }
        }
        TouchTarget(onClick = onOpenMemory, contentDescription = "$title 团队记忆") {
            Text(
                text = "记忆",
                fontSize = 12.sp,
                color = minisAccent,
            )
        }
        Spacer(Modifier.width(12.dp))
    }
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
    threadToggle: (@Composable () -> Unit)? = null,
) {
    val chat = summary.chat
    val now = remember(summary.lastActivity) { System.currentTimeMillis() }
    val hasUnread = chat.unread && !chat.busy
    val formattedPreview = remember(summary.preview) { RosterPreviewFormat.display(summary.preview) }
    val isErrorPreview = formattedPreview.startsWith("错误 ") || formattedPreview.startsWith("请求出错")
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(18.dp))
                .clickable(role = Role.Button, onClick = onClick)
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier.padding(vertical = 7.dp),
            ) {
                ChatAvatar(
                    chat = chat,
                    size = 46.dp,
                    state = if (chat.busy) MausState.WORKING else face,
                    animated = false,
                    contentDescription = "${chat.name} 头像",
                    // Rows get only the sweep: a list of discs all breathing in
                    // place would pull the eye away from the names.
                    fallback = AvatarFallback.PRESET,
                    motion = AvatarMotion.SHEEN,
                    mood = if (chat.busy) FaceMood.WORKING else FaceMood.IDLE,
                    breakout = chat.busy,
                )
                when {
                    chat.busy -> Box(
                        modifier = Modifier
                            .align(Alignment.BottomEnd)
                            .size(13.dp)
                            .background(minisCanvas, CircleShape)
                            .padding(2.dp)
                            .background(minisAccent, CircleShape),
                    )
                    hasUnread -> Box(
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .size(13.dp)
                            .background(minisCanvas, CircleShape)
                            .padding(2.dp)
                            .background(minisAccent, CircleShape),
                    )
                }
            }
            Spacer(Modifier.width(13.dp))

            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(vertical = 7.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    // The name, crown and role share one flexible group. When a
                    // subtitle is present, let the subtitle absorb overflow first
                    // so the bot's own name stays legible beside topic pills.
                    Row(
                        modifier = Modifier.weight(1f),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = chat.name,
                            fontSize = 17.sp,
                            fontWeight = if (hasUnread) FontWeight.Medium else FontWeight.Normal,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = if (chat.subtitle.isEmpty()) Modifier.weight(1f, fill = false) else Modifier,
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
                                modifier = Modifier.weight(1f, fill = false),
                            )
                        }
                    }
                    if (threadToggle != null) {
                        threadToggle()
                    }
                    Text(
                        text = RelativeStamp.list(
                            summary.lastActivity,
                            now,
                        ),
                        fontSize = 13.sp,
                        fontWeight = if (hasUnread) FontWeight.Medium else FontWeight.Normal,
                        color = if (hasUnread) minisAccent else minisSecondary,
                        maxLines = 1,
                        // 13 sp against a 17 sp name: centring leaves the clock
                        // a couple of dp above the name's baseline.
                        modifier = Modifier.padding(start = 10.dp, top = 2.dp),
                    )
                }

                Row(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // One line for every bot, so the rows keep one rhythm.
                    Text(
                        text = formattedPreview.ifEmpty { " " },
                        fontSize = 14.sp,
                        color = when {
                            isErrorPreview -> minisDanger.copy(alpha = 0.86f)
                            hasUnread -> minisInk.copy(alpha = 0.86f)
                            else -> minisSecondary
                        },
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
 * The bar over the bottom of the list: Updates beside quick chat, or —
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
    heroName: String?,
    onQuickChat: (() -> Unit)?,
    onOpenUpdates: () -> Unit,
    onOpenSearch: () -> Unit,
    onCreateBot: () -> Unit,
    canCreateBot: Boolean,
    onCreateSection: () -> Unit,
    canCreateSection: Boolean,
    modifier: Modifier = Modifier,
) {
    val dark = minisIsDark()
    val focus = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    LaunchedEffect(bar.searchOpen) {
        if (bar.searchOpen) focus.requestFocus() else focusManager.clearFocus()
    }

    val pillFill = if (dark) minisCard else Color(0xFFEFEFED)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (bar.searchOpen) {
            Row(
                modifier = Modifier
                    .weight(1f)
                    .clip(CircleShape)
                    .background(pillFill)
                    .height(48.dp)
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
                        Text("搜索会话", fontSize = 16.sp, color = secondaryTint)
                    }
                    BasicTextField(
                        value = bar.query,
                        onValueChange = { onBar(bar.typed(it)) },
                        singleLine = true,
                        textStyle = LocalTextStyle.current.copy(
                            fontSize = 16.sp,
                            color = MaterialTheme.colorScheme.onSurface,
                        ),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.onSurface),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                        modifier = Modifier
                            .fillMaxWidth()
                            .focusRequester(focus)
                            .semantics { contentDescription = "搜索会话" },
                    )
                }
                if (bar.query.isNotEmpty()) {
                    TouchTarget(onClick = { onBar(bar.clearQuery()) }, size = 24.dp) {
                        Icon(
                            imageVector = Icons.Filled.Close,
                            contentDescription = "清除搜索",
                            tint = secondaryTint,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                }
            }
            Box(
                modifier = Modifier
                    .clip(CircleShape)
                    .background(pillFill)
                    .height(48.dp)
                    .clickable(role = Role.Button, onClick = { onBar(bar.cancelSearch()) })
                    .padding(horizontal = 16.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text("取消", fontSize = 15.sp, color = minisInk)
            }
        } else {
            val quickAction = onQuickChat ?: onOpenSearch
            val quickLabel = if (onQuickChat != null && !heroName.isNullOrBlank()) "向 $heroName 提问" else "搜索"
            Row(
                modifier = Modifier
                    .weight(1f)
                    .height(48.dp)
                    .clip(CircleShape)
                    .background(pillFill)
                    .clickable(role = Role.Button, onClick = quickAction)
                    .semantics(mergeDescendants = true) {
                        contentDescription = if (onQuickChat != null) quickLabel else "搜索会话"
                    }
                    .padding(start = 16.dp, end = 14.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .size(28.dp)
                        .clip(CircleShape)
                        .clickable(role = Role.Button, onClick = onOpenUpdates),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        painter = painterResource(R.drawable.ic_sparkles),
                        contentDescription = "动态",
                        tint = minisInk,
                        modifier = Modifier.size(18.dp),
                    )
                    if (updates.isNotEmpty()) {
                        Box(
                            modifier = Modifier
                                .align(Alignment.TopEnd)
                                .size(6.dp)
                                .background(minisAccent, CircleShape),
                        )
                    }
                }
                Text(
                    text = quickLabel,
                    fontSize = 15.5.sp,
                    color = minisSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Icon(
                    painter = painterResource(R.drawable.ic_mic),
                    contentDescription = null,
                    tint = minisInk,
                    modifier = Modifier.size(20.dp),
                )
            }
        }
    }
}

private val BAR_HEIGHT = 50.dp

@Composable
private fun SearchHitRow(hit: SearchHit, opening: Boolean, onClick: () -> Unit) {
    val now = remember(hit.id) { System.currentTimeMillis() }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = !opening, role = Role.Button, onClick = onClick)
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
                painterResource(R.drawable.ic_lunabot_mark)
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
                if (opening) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(14.dp),
                        strokeWidth = 1.5.dp,
                        color = secondaryTint,
                    )
                    Text("打开中…", fontSize = 12.sp, color = secondaryTint)
                } else {
                    Text(
                        text = RelativeStamp.list(hit.at, now),
                        fontSize = 12.sp,
                        color = secondaryTint,
                    )
                }
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
        Session.Status.Live, Session.Status.Unpaired, Session.Status.Connecting, is Session.Status.Offline -> null
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

private fun shortHostLabel(rawHost: String): String {
    val stripped = rawHost
        .removePrefix("https://")
        .removePrefix("http://")
        .substringBefore('/')
    val hostOnly = stripped.substringBefore(':')
    return when {
        hostOnly.endsWith(".e2e.invalid") -> hostOnly.removeSuffix(".e2e.invalid").take(8)
        hostOnly.length > 18 -> hostOnly.take(16) + "…"
        else -> stripped.take(20)
    }
}

private data class MuseNavSpec(
    val index: Int,
    val outlineRes: Int,
    val filledRes: Int,
    val label: String,
)

private val MUSE_NAV_TABS = listOf(
    MuseNavSpec(0, R.drawable.ic_muse_chat_outline, R.drawable.ic_muse_chat_filled, "主要聊天"),
    MuseNavSpec(1, R.drawable.ic_muse_bots_outline, R.drawable.ic_muse_bots_filled, "协作助手"),
    MuseNavSpec(2, R.drawable.ic_muse_schedule_outline, R.drawable.ic_muse_schedule_filled, "定时巡检"),
    MuseNavSpec(3, R.drawable.ic_muse_hub_outline, R.drawable.ic_muse_hub_filled, "工作空间"),
)

/** Muse-style minimalist monochrome 4-icon bottom navigation bar (zero text clutter). */
@Composable
private fun MuseBottomNavBar(
    activeTab: Int,
    onSelect: (Int) -> Unit,
) {
    val dark = minisIsDark()
    val inactiveTint = if (dark) minisSecondary.copy(alpha = 0.62f) else Color(0xFF8E8E93)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(minisCanvas)
            .navigationBarsPadding(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp)
                .padding(horizontal = 24.dp),
            horizontalArrangement = Arrangement.SpaceAround,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            MUSE_NAV_TABS.forEach { tab ->
                val selected = activeTab == tab.index
                Box(
                    modifier = Modifier
                        .size(48.dp)
                        .clip(CircleShape)
                        .clickable(role = Role.Button, onClick = { onSelect(tab.index) })
                        .semantics { contentDescription = tab.label },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        painter = painterResource(if (selected) tab.filledRes else tab.outlineRes),
                        contentDescription = null,
                        tint = if (selected) minisInk else inactiveTint,
                        modifier = Modifier.size(23.dp),
                    )
                }
            }
        }
    }
}

/** Muse-style Library Hub with persistent Luna centerpiece + full-width white-bordered 2-segment switcher. */
@Composable
private fun MuseLibraryTab(
    heroChat: Chat?,
    heroName: String,
    computerName: String?,
    status: Session.Status,
    extraTopPadding: Dp = 0.dp,
    onOpenComputer: (() -> Unit)?,
    onOpenOverview: (() -> Unit)?,
    onSwitchComputer: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    var segment by rememberSaveable { mutableIntStateOf(0) }
    val dark = minisIsDark()
    val activePillFill = if (dark) minisGrouped else Color(0xFFF1F1EF)
    val outerBorder = if (dark) Color(0x20FFFFFF) else Color(0xFFE8E8E6)
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(minisCanvas)
            .statusBarsPadding(),
    ) {
        // Persistent Muse centerpiece: 74dp avatar with soft warm-linen halo
        // so light/white bots stand out crisply on the pure-white canvas.
        val studioHalo = remember(dark) {
            Brush.radialGradient(
                0.00f to if (dark) Color(0x22FFFFFF) else Color(0x66D9CEC2),
                0.56f to if (dark) Color(0x0EFFFFFF) else Color(0x30E4DDD4),
                1.00f to Color.Transparent,
            )
        }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 6.dp + extraTopPadding, bottom = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            if (heroChat != null) {
                Box(
                    modifier = Modifier
                        .size(84.dp)
                        .background(studioHalo, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    ChatAvatar(
                        chat = heroChat,
                        size = 74.dp,
                        animated = false,
                        fallback = AvatarFallback.PRESET,
                        motion = AvatarMotion.SHEEN,
                    )
                }
            }
            Row(
                modifier = Modifier
                    .museFloatingPill(CircleShape, elevation = 5.dp)
                    .padding(horizontal = 15.dp, vertical = 4.5.dp),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = heroName,
                    fontSize = 15.5.sp,
                    fontWeight = FontWeight.Light,
                    letterSpacing = 0.4.sp,
                    color = minisInk,
                )
                Spacer(Modifier.width(4.dp))
                CrownBadge(size = 11.5.dp)
            }
        }
        // Muse-style full-width white-bordered capsule with soft-gray active inner pill.
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .height(50.dp)
                .clip(CircleShape)
                .background(minisCard)
                .border(0.85.dp, outerBorder, CircleShape)
                .padding(4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            listOf("连接应用", "实时桌面").forEachIndexed { idx, label ->
                val selected = segment == idx
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxHeight()
                        .clip(CircleShape)
                        .background(if (selected) activePillFill else Color.Transparent)
                        .clickable(role = Role.Button) { segment = idx },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = label,
                        fontSize = 15.sp,
                        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                        color = if (selected) minisInk else minisSecondary,
                    )
                }
            }
        }
        Spacer(Modifier.height(10.dp))
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            if (segment == 0) {
                ConnectedAppsScreen(onBack = {}, embedded = true)
            } else {
                MuseDesktopTab(
                    heroName = heroName,
                    computerName = computerName,
                    status = status,
                    onOpenComputer = onOpenComputer,
                    onOpenOverview = onOpenOverview,
                    onSwitchComputer = onSwitchComputer,
                    onOpenSettings = onOpenSettings,
                )
            }
        }
    }
}

/** Clean Muse editorial tab for live desktop access and agent overview. */
@Composable
private fun MuseDesktopTab(
    heroName: String,
    computerName: String?,
    status: Session.Status,
    onOpenComputer: (() -> Unit)?,
    onOpenOverview: (() -> Unit)?,
    onSwitchComputer: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val statusText = when (status) {
        Session.Status.Live -> "在线"
        Session.Status.Connecting -> "连接中"
        else -> "离线"
    }
    val dotColor = when (status) {
        Session.Status.Live -> MinisTokens.Success
        Session.Status.Connecting -> MinisTokens.Warning
        else -> MinisTokens.Danger
    }
    val cardFill = minisSoftCard
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(minisCanvas)
            .verticalScroll(rememberScrollState())
            .padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(22.dp))
                .background(cardFill)
                .clickable(enabled = onOpenComputer != null, role = Role.Button) { onOpenComputer?.invoke() }
                .padding(horizontal = 16.dp, vertical = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(44.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(minisCard),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    painter = painterResource(R.drawable.ic_display_line),
                    contentDescription = null,
                    tint = minisInk,
                    modifier = Modifier.size(21.dp),
                )
            }
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(
                    text = computerName ?: "已配对电脑",
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = minisInk,
                )
                Row(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(7.dp).background(dotColor, CircleShape))
                    Text(text = "$statusText · 点击查看实时画面", fontSize = 13.sp, color = minisSecondary)
                }
            }
            Icon(
                imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = minisTertiary,
                modifier = Modifier.size(20.dp),
            )
        }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(22.dp))
                .background(cardFill),
        ) {
            if (onOpenOverview != null) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable(role = Role.Button, onClick = onOpenOverview)
                        .padding(horizontal = 16.dp, vertical = 15.dp),
                    horizontalArrangement = Arrangement.spacedBy(13.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        modifier = Modifier
                            .size(36.dp)
                            .clip(RoundedCornerShape(11.dp))
                            .background(minisCard),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(painterResource(R.drawable.ic_muse_bots_outline), null, tint = minisInk, modifier = Modifier.size(19.dp))
                    }
                    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("$heroName 记忆与总览", fontSize = 15.5.sp, fontWeight = FontWeight.Medium, color = minisInk)
                        Text("查看助手能力、记忆与运行状态", fontSize = 12.5.sp, color = minisSecondary)
                    }
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = minisTertiary, modifier = Modifier.size(20.dp))
                }
                HorizontalDivider(
                    modifier = Modifier.padding(start = 65.dp, end = 16.dp),
                    thickness = 0.5.dp,
                    color = minisSeparator.copy(alpha = 0.25f),
                )
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(role = Role.Button, onClick = onSwitchComputer)
                    .padding(horizontal = 16.dp, vertical = 15.dp),
                horizontalArrangement = Arrangement.spacedBy(13.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .size(36.dp)
                        .clip(RoundedCornerShape(11.dp))
                        .background(minisCard),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(painterResource(R.drawable.ic_display_line), null, tint = minisInk, modifier = Modifier.size(19.dp))
                }
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text("切换连接的电脑", fontSize = 15.5.sp, fontWeight = FontWeight.Medium, color = minisInk)
                    Text(computerName ?: "管理已配对设备", fontSize = 12.5.sp, color = minisSecondary)
                }
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = minisTertiary, modifier = Modifier.size(20.dp))
            }
            HorizontalDivider(
                modifier = Modifier.padding(start = 65.dp, end = 16.dp),
                thickness = 0.5.dp,
                color = minisSeparator.copy(alpha = 0.25f),
            )
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(role = Role.Button, onClick = onOpenSettings)
                    .padding(horizontal = 16.dp, vertical = 15.dp),
                horizontalArrangement = Arrangement.spacedBy(13.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .size(36.dp)
                        .clip(RoundedCornerShape(11.dp))
                        .background(minisCard),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(painterResource(R.drawable.ic_gear_line), null, tint = minisInk, modifier = Modifier.size(19.dp))
                }
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text("应用设置", fontSize = 15.5.sp, fontWeight = FontWeight.Medium, color = minisInk)
                    Text("连接、通知、外观与手机工具", fontSize = 12.5.sp, color = minisSecondary)
                }
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = minisTertiary, modifier = Modifier.size(20.dp))
            }
        }
    }
}

/** Muse-style underlying pure-white drawer layer revealed as main stage pushes right. */
@Composable
private fun MuseDrawerContent(
    activeTab: Int,
    companions: List<ChatSummary>,
    computerName: String?,
    status: Session.Status,
    modifier: Modifier = Modifier,
    onSelectTab: (Int) -> Unit,
    onOpenCompanion: (ChatSummary) -> Unit,
    onOpenSettings: () -> Unit,
    onOpenGeneralMemory: () -> Unit,
    onOpenSearch: () -> Unit,
    onCreateBot: () -> Unit,
    onCreateGroup: () -> Unit,
    onSwitchComputer: () -> Unit,
) {
    val pillFill = if (minisIsDark()) minisGrouped else Color(0xFFF0F0EE)
    Column(
        modifier = modifier
            .width(296.dp)
            .fillMaxHeight()
            .background(minisCanvas)
            .statusBarsPadding()
            .navigationBarsPadding()
            .padding(horizontal = 18.dp, vertical = 16.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "Luna Bot",
                fontSize = 25.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = (-0.4).sp,
                color = minisInk,
                maxLines = 1,
            )
            if (computerName != null) {
                val statusDot = when (status) {
                    Session.Status.Live -> MinisTokens.Success
                    Session.Status.Connecting -> MinisTokens.Warning
                    else -> MinisTokens.Danger
                }
                Box(
                    modifier = Modifier
                        .size(40.dp)
                        .semantics(mergeDescendants = true) {
                            contentDescription = "切换设备，当前 $computerName"
                        },
                ) {
                    Box(
                        modifier = Modifier
                            .matchParentSize()
                            .clip(CircleShape)
                            .background(pillFill)
                            .clickable(role = Role.Button, onClick = onSwitchComputer),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            painter = painterResource(R.drawable.ic_display_line),
                            contentDescription = null,
                            tint = minisInk,
                            modifier = Modifier.size(19.dp),
                        )
                    }
                    Box(
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .padding(top = 1.dp, end = 1.dp)
                            .size(11.dp)
                            .background(minisCanvas, CircleShape)
                            .padding(2.dp)
                            .background(statusDot, CircleShape),
                    )
                }
            }
        }
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState()),
        ) {
            Spacer(Modifier.height(6.dp))
            Text(
                text = "选项卡",
                fontSize = 12.5.sp,
                color = minisSecondary,
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            )
            MUSE_NAV_TABS.forEach { tab ->
                val selected = activeTab == tab.index
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(16.dp))
                        .background(if (selected) pillFill else Color.Transparent)
                        .clickable(role = Role.Button) { onSelectTab(tab.index) }
                        .padding(horizontal = 14.dp, vertical = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        painter = painterResource(if (selected) tab.filledRes else tab.outlineRes),
                        contentDescription = null,
                        tint = minisInk,
                        modifier = Modifier.size(21.dp),
                    )
                    Text(
                        text = tab.label,
                        fontSize = 16.sp,
                        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                        color = minisInk,
                    )
                }
            }
            if (companions.isNotEmpty()) {
                Spacer(Modifier.height(12.dp))
                HorizontalDivider(thickness = 0.5.dp, color = minisSeparator)
                Spacer(Modifier.height(10.dp))
                Text(
                    text = "协作助手",
                    fontSize = 12.5.sp,
                    color = minisSecondary,
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                )
                companions.take(5).forEach { summary ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(14.dp))
                            .clickable(role = Role.Button) { onOpenCompanion(summary) }
                            .padding(horizontal = 10.dp, vertical = 9.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        ChatAvatar(
                            chat = summary.chat,
                            size = 30.dp,
                            animated = false,
                            fallback = AvatarFallback.PRESET,
                            motion = AvatarMotion.SHEEN,
                        )
                        Text(
                            text = summary.chat.name,
                            fontSize = 15.5.sp,
                            fontWeight = FontWeight.Normal,
                            color = minisInk,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        if (summary.chat.unread) {
                            Box(Modifier.size(7.dp).background(minisInk, CircleShape))
                        }
                    }
                }
                if (companions.size > 5) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(14.dp))
                            .clickable(role = Role.Button) { onSelectTab(1) }
                            .padding(horizontal = 12.dp, vertical = 9.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = "查看全部 ${companions.size} 个助手",
                            fontSize = 13.5.sp,
                            fontWeight = FontWeight.Medium,
                            color = minisSecondary,
                            modifier = Modifier.weight(1f),
                        )
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                            contentDescription = null,
                            tint = minisTertiary,
                            modifier = Modifier.size(16.dp),
                        )
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
            HorizontalDivider(thickness = 0.5.dp, color = minisSeparator.copy(alpha = 0.25f))
            Spacer(Modifier.height(10.dp))
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .clickable(role = Role.Button, onClick = onCreateBot)
                    .padding(horizontal = 12.dp, vertical = 11.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(painterResource(R.drawable.ic_plus_line), null, tint = minisInk, modifier = Modifier.size(19.dp))
                Text("新建智能体", fontSize = 15.5.sp, fontWeight = FontWeight.Medium, color = minisInk)
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .clickable(role = Role.Button, onClick = onCreateGroup)
                    .padding(horizontal = 12.dp, vertical = 11.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(painterResource(R.drawable.ic_muse_chat_outline), null, tint = minisInk, modifier = Modifier.size(19.dp))
                Text("新建群组", fontSize = 15.5.sp, fontWeight = FontWeight.Medium, color = minisInk)
            }

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .clickable(role = Role.Button, onClick = onOpenGeneralMemory)
                    .padding(horizontal = 12.dp, vertical = 11.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Star, null, tint = minisInk, modifier = Modifier.size(19.dp))
                Text("通用记忆", fontSize = 15.5.sp, fontWeight = FontWeight.Medium, color = minisInk)
            }

            Spacer(Modifier.height(8.dp))
        }
        Spacer(Modifier.height(10.dp))
        // Muse drawer footer: Settings circle + Search pill + New button
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(46.dp)
                    .clip(CircleShape)
                    .background(pillFill)
                    .clickable(role = Role.Button, onClick = onOpenSettings),
                contentAlignment = Alignment.Center,
            ) {
                Icon(painterResource(R.drawable.ic_gear_line), "设置", tint = minisInk, modifier = Modifier.size(21.dp))
            }
            Row(
                modifier = Modifier
                    .weight(1f)
                    .height(46.dp)
                    .clip(CircleShape)
                    .background(pillFill)
                    .clickable(role = Role.Button, onClick = onOpenSearch)
                    .padding(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(painterResource(R.drawable.ic_search_line), null, tint = minisSecondary, modifier = Modifier.size(19.dp))
                Text("搜索", fontSize = 15.5.sp, color = minisSecondary)
            }
            Box(
                modifier = Modifier
                    .size(46.dp)
                    .clip(CircleShape)
                    .background(pillFill)
                    .clickable(role = Role.Button, onClick = onCreateBot),
                contentAlignment = Alignment.Center,
            ) {
                Icon(painterResource(R.drawable.ic_edit_line), "新建", tint = minisInk, modifier = Modifier.size(19.dp))
            }
        }
    }
}
