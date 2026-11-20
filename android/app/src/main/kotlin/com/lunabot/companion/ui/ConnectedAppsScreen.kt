package com.lunabot.companion.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import com.lunabot.companion.core.ConnectedAppsRules
import com.lunabot.companion.core.ConnectorAccount
import com.lunabot.companion.core.ConnectorCard
import com.lunabot.companion.core.ConnectorCatalog
import com.lunabot.companion.core.ConnectorStatus
import com.lunabot.companion.core.ConnectorStatuses
import kotlinx.coroutines.launch

/**
 * The paired-phone inventory for apps connected on the computer.
 *
 * Authorization deliberately leaves the app for the system browser. The
 * desktop owns provider credentials and revocation, and the paired phone only
 * starts an authorization flow and reports the inventory it was given.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConnectedAppsScreen(onBack: () -> Unit) {
    val environment = LocalCompanion.current
    val session = environment.session
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var catalog by remember { mutableStateOf<ConnectorCatalog?>(null) }
    var inventory by remember { mutableStateOf(ConnectedAppsInventory()) }
    // Everything typed, and the dialog holding it, outlive a rotation: this
    // Activity is recreated on one, and the catalog behind them is re-fetched.
    var query by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf(FILTER_ALL) }
    var loading by remember { mutableStateOf(true) }
    // "The catalog came back empty" and "the catalog did not come back" are
    // different answers, and the screen used to show both as "no connected
    // apps on this computer".
    var loadFailed by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    var aliasTarget by rememberSaveable(stateSaver = AliasTargetSaver) {
        mutableStateOf<AliasTarget?>(null)
    }
    var alias by rememberSaveable { mutableStateOf("") }

    suspend fun refresh(showProgress: Boolean = false) {
        if (showProgress) refreshing = true
        try {
            session.loadAllConnectorStatuses()?.let { response ->
                inventory = ConnectedAppsPolicy.accept(inventory, response)
            }
        } finally {
            if (showProgress) refreshing = false
        }
    }

    fun authorize(slug: String, accountAlias: String?) {
        scope.launch {
            val url = session.authorizeConnector(slug, accountAlias) ?: return@launch
            try {
                // The core client accepts only a well-formed HTTPS URL. ACTION_VIEW
                // keeps provider cookies, redirects and account choice in the
                // browser instead of placing them in our process.
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url.toASCIIString())))
            } catch (_: ActivityNotFoundException) {
                session.actionError = "此手机没有可用的浏览器来打开授权页面。"
            } catch (_: SecurityException) {
                session.actionError = "无法打开授权页面，请检查浏览器限制后重试。"
            }
        }
    }

    suspend fun loadCatalog() {
        loading = true
        try {
            val loaded = session.loadConnectorCatalog()
            catalog = loaded
            loadFailed = loaded == null
            if (loaded != null) refresh()
        } finally {
            loading = false
        }
    }

    LaunchedEffect(Unit) { loadCatalog() }

    // Authorization finishes in the browser, so the answer arrives while this
    // screen is away — iOS re-reads on `scenePhase == .active`
    // (`ios/App/ConnectedAppsView.swift:90-92`), without the full-screen
    // spinner its `load` uses. The first resume is this screen's own entry,
    // which the effect above already loaded, so it is skipped rather than
    // asking twice.
    var entered by remember { mutableStateOf(false) }
    LifecycleResumeEffect(Unit) {
        if (entered) scope.launch { refresh() } else entered = true
        onPauseOrDispose {}
    }

    val cards = catalog?.cards.orEmpty()
    val connectedCount = cards.count { card ->
        inventory.statuses?.get(card.slug)?.connected == true
    }
    val pageCanvas = if (minisIsDark()) minisCanvas else Color(0xFFF8F7F4)

    Box(modifier = Modifier.fillMaxSize().background(pageCanvas)) {
        Column(modifier = Modifier.fillMaxSize()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // A pushed screen, so it leaves the way every other pushed
                // screen does: the bordered back circle, not a bare X that
                // read as "discard".
                TouchTarget(onClick = onBack, modifier = Modifier, size = 44.dp, contentDescription = "返回") {
                    Box(
                        modifier = Modifier
                            .size(44.dp)
                            .chromeCapsule(surface = true),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = null,
                            tint = minisInk,
                            modifier = Modifier.size(22.dp),
                        )
                    }
                }
                Text(
                    "连接应用",
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = minisInk,
                )
                Spacer(Modifier.weight(1f))
                // A count, not a button: refresh lives in the pull gesture below,
                // where the roster answers the same question.
                Text(
                    "已连接 $connectedCount 个",
                    modifier = Modifier
                        .clip(CircleShape)
                        .background(minisCard)
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                    fontSize = 14.sp,
                    color = minisInk,
                )
            }

            // The catalog carries no categories — slug, label, blurb, logo,
            // domain are all it has — so the only honest splits are everything
            // and what is connected.
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(start = 16.dp, end = 16.dp, bottom = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                FilterChip(FILTER_ALL, filter == FILTER_ALL) { filter = FILTER_ALL }
                FilterChip(FILTER_CONNECTED, filter == FILTER_CONNECTED) { filter = FILTER_CONNECTED }
            }

            // The same gesture the roster uses for the same question (RosterScreen.kt:167),
            // and iOS's `.refreshable` (ConnectedAppsView.swift:89).
            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = { scope.launch { refresh(showProgress = true) } },
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    if (inventory.credentialStoreUnreadable) {
                        CredentialStoreWarning(hasLastKnownInventory = inventory.statuses != null)
                    }

                    if (ConnectedAppsPolicy.showSetupNotice(catalog, inventory.credentialStoreUnreadable)) {
                        WhiteCard {
                            Text("已连接应用需要先完成配置", fontWeight = FontWeight.SemiBold)
                            Text(
                                "请先在电脑上配置 Composio。服务商凭据绝不会发送至此手机。",
                                color = minisSecondary,
                                fontSize = 13.sp,
                            )
                        }
                    }

                    // The phone is a viewer here: connecting and authorizing
                    // happen on the computer. When the computer withholds the
                    // account inventory, say it once — with the place that can
                    // fix it — instead of repeating "unknown" on every card.
                    if (!loading && !inventory.credentialStoreUnreadable &&
                        inventory.statuses == null && cards.isNotEmpty()
                    ) {
                        WhiteCard {
                            Text("连接与授权在电脑上完成", fontWeight = FontWeight.SemiBold)
                            Text(
                                "手机端显示应用目录和已连接状态。如果这里读不到状态，请在电脑端「设置 → 连接的应用」里连接，然后回到此页下拉刷新。",
                                color = minisSecondary,
                                fontSize = 13.sp,
                            )
                        }
                    }

                    val base = ConnectedAppsPolicy.filterCards(cards, query)
                    val visibleCards = when (filter) {
                        FILTER_CONNECTED -> base.filter { card ->
                            inventory.statuses?.get(card.slug)?.connected == true
                        }
                        else -> base
                    }
                    visibleCards.forEach { card ->
                        ConnectorCardView(
                            card = card,
                            status = inventory.statuses?.get(card.slug),
                            hasAuthoritativeInventory = inventory.statuses != null,
                            configured = catalog?.configured == true,
                            onConnect = { authorize(card.slug, ConnectedAppsRules.firstAccountAlias) },
                            onAddAccount = {
                                alias = ""
                                aliasTarget = AliasTarget(slug = card.slug, label = card.label)
                            },
                            onDisconnect = { account ->
                                scope.launch {
                                    if (session.disconnectConnectorAccount(card.slug, account.id)) {
                                        refresh(showProgress = true)
                                    }
                                }
                            },
                        )
                    }

                    if (!loading && cards.isEmpty() && !loadFailed) {
                        Text("此电脑暂无可用的已连接应用。", color = minisSecondary)
                    }
                    if (!loading && loadFailed) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(9.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("读不到连接应用列表", color = MinisTokens.Danger, fontSize = 15.sp)
                            TouchTarget(onClick = { scope.launch { loadCatalog() } }) {
                                Text("重试", color = minisAccent, fontSize = 15.sp)
                            }
                        }
                    }

                    if (loading) {
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                            CircularProgressIndicator(modifier = Modifier.size(28.dp), strokeWidth = 3.dp)
                        }
                    }
                }
            }

            // The floating search pill: it sits above the gesture bar (the root
            // screen owns the insets) and filters the list locally as it types.
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .navigationBarsPadding()
                    .padding(start = 16.dp, end = 16.dp, bottom = 10.dp),
            ) {
                Row(
                    modifier = Modifier
                        .weight(1f)
                        .height(52.dp)
                        .chromeCapsule(surface = true)
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
                    Box(modifier = Modifier.weight(1f)) {
                        if (query.isEmpty()) {
                            Text("搜索应用和技能", fontSize = 17.sp, color = minisSecondary)
                        }
                        BasicTextField(
                            value = query,
                            onValueChange = { query = it },
                            singleLine = true,
                            textStyle = LocalTextStyle.current.copy(
                                fontSize = 17.sp,
                                color = minisInk,
                            ),
                            cursorBrush = SolidColor(minisInk),
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                            // The placeholder Text above is a sibling and
                            // disappears on the first character.
                            modifier = Modifier
                                .fillMaxWidth()
                                .semantics { contentDescription = "搜索应用和技能" },
                        )
                    }
                    if (query.isNotEmpty()) {
                        TouchTarget(
                            onClick = { query = "" },
                            size = 24.dp,
                            contentDescription = "清除搜索",
                        ) {
                            Icon(
                                imageVector = Icons.Filled.Close,
                                contentDescription = null,
                                tint = minisSecondary,
                                modifier = Modifier.size(20.dp),
                            )
                        }
                    }
                }
            }
        }
    }

    aliasTarget?.let { target ->
        val normalized = ConnectedAppsRules.additionalAccountAlias(alias)
        AlertDialog(
            onDismissRequest = { aliasTarget = null },
            title = { Text("账号别名") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = alias,
                        onValueChange = { alias = it },
                        label = { Text("工作、个人、客户…") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text(
                        "当智能体使用多个 ${target.label} 账号时，别名可以明确区分不同账号。",
                        color = secondaryTint,
                        fontSize = 13.sp,
                    )
                }
            },
            confirmButton = {
                TextButton(
                    enabled = normalized != null,
                    onClick = {
                        aliasTarget = null
                        authorize(target.slug, normalized)
                    },
                ) { Text("继续") }
            },
            dismissButton = { TextButton(onClick = { aliasTarget = null }) { Text("取消") } },
        )
    }
}

private const val FILTER_ALL = "全部"
private const val FILTER_CONNECTED = "已连接"

@Composable
private fun FilterChip(label: String, selected: Boolean, onClick: () -> Unit) {
    // Token colours, not black-on-white: the selected chip sits on the canvas,
    // and a hardcoded black pill disappears into the dark one.
    Row(
        modifier = Modifier
            .height(38.dp)
            .clip(CircleShape)
            .background(if (selected) minisInk else minisCard)
            .then(
                if (selected) {
                    Modifier
                } else {
                    Modifier.border(0.5.dp, minisSeparator.copy(alpha = 0.65f), CircleShape)
                },
            )
            .clickable(onClick = onClick)
            .semantics { contentDescription = label }
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            fontSize = 14.sp,
            fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal,
            color = if (selected) minisPage else minisInk,
            maxLines = 1,
            softWrap = false,
        )
    }
}

/** A white rounded surface on the grey canvas. */
@Composable
private fun WhiteCard(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(minisCard, MinisCardShape)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        content = content,
    )
}

@Composable
private fun CredentialStoreWarning(hasLastKnownInventory: Boolean) {
    WhiteCard {
        Text("无法重新检查账号状态", fontWeight = FontWeight.SemiBold, color = minisWarning)
        Text(
            if (hasLastKnownInventory) {
                "当前显示上次连接的状态。您的电脑刚才无法打开凭据存储，因此无法重新核查这些账号。没有任何连接被断开——在电脑上重启 Luna Bot 通常即可恢复。"
            } else {
                "您的电脑无法打开凭据存储，因此无法确认哪些账号已连接。没有任何连接被断开——在电脑上重启 Luna Bot 通常即可恢复。"
            },
            color = minisSecondary,
            fontSize = 13.sp,
        )
    }
}

/**
 * One app, one white row. The state machine underneath is the one the wire
 * gives: an inventory that admits ignorance shows no action at all, a card
 * with no accounts yet offers the connect capsule, and one with accounts
 * lists them and the (ceiling-limited) add-account action.
 */
@Composable
private fun ConnectorCardView(
    card: ConnectorCard,
    status: ConnectorStatus?,
    hasAuthoritativeInventory: Boolean,
    configured: Boolean,
    onConnect: () -> Unit,
    onAddAccount: () -> Unit,
    onDisconnect: (ConnectorAccount) -> Unit,
) {
    val accounts = status?.accounts.orEmpty()
    val connected = status?.connected == true
    val pending = status?.pending == true

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(minisCard, MinisCardShape),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ConnectorIconTile(card)
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    card.label,
                    fontSize = 15.5.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = minisInk,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    card.blurb,
                    color = minisSecondary,
                    fontSize = 13.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            when {
                !hasAuthoritativeInventory -> ConnectorActionCapsule("电脑端管理", enabled = false, onClick = null)
                connected || accounts.isNotEmpty() -> ConnectorActionCapsule("已连接", enabled = false, onClick = null)
                pending -> ConnectorActionCapsule("连接中…", enabled = false, onClick = null)
                else -> ConnectorActionCapsule("连接", enabled = configured, onClick = onConnect)
            }
        }

        when {
            !hasAuthoritativeInventory -> Unit
            accounts.isEmpty() && (connected || pending) -> Text(
                "无法从该服务商获取账号详情。请在完成授权后刷新。",
                modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 12.dp),
                color = minisSecondary,
                fontSize = 13.sp,
            )
            accounts.isNotEmpty() -> Column(
                modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 6.dp),
            ) {
                accounts.forEachIndexed { index, account ->
                    if (index > 0) MinisDivider()
                    ConnectorAccountRow(
                        account = account,
                        onDisconnect = if (hasAuthoritativeInventory) {
                            { onDisconnect(account) }
                        } else {
                            null
                        },
                    )
                }
                // Kept and disabled at the limit, so the limit is legible
                // (`ios/App/ConnectedAppsView.swift:159-163`); hiding the
                // button leaves the ceiling to be guessed at.
                TextButton(
                    onClick = onAddAccount,
                    enabled = ConnectedAppsRules.canAddAnotherAccount(accounts),
                ) {
                    Text("添加其他账号", color = minisAccent, fontSize = 14.sp)
                }
            }
        }
    }
}

/**
 * The app's tile. The catalog carries a `logo` URL, but the app has no image
 * loader to fetch it with, so the honest fallback is the label's initial —
 * the same letter the desktop's favicon resolves to.
 */
@Composable
private fun ConnectorIconTile(card: ConnectorCard) {
    val dark = minisIsDark()
    val idx = (card.slug.hashCode() and 0x7FFFFFFF) % 5
    val (bg, fg) = if (dark) {
        when (idx) {
            0 -> Color(0xFF1C2738) to Color(0xFF8CC4FF)
            1 -> Color(0xFF2B2318) to Color(0xFFF3C47A)
            2 -> Color(0xFF172820) to Color(0xFF7ADBA2)
            3 -> Color(0xFF251E33) to Color(0xFFC5A8FA)
            else -> Color(0xFF2C1E20) to Color(0xFFF7A6A4)
        }
    } else {
        when (idx) {
            0 -> Color(0xFFEAF3FF) to Color(0xFF2B6CB0)
            1 -> Color(0xFFFFF3E2) to Color(0xFFB7791F)
            2 -> Color(0xFFE9F7EF) to Color(0xFF2F855A)
            3 -> Color(0xFFF3EEFF) to Color(0xFF6B46C1)
            else -> Color(0xFFFFEFEF) to Color(0xFFC53030)
        }
    }
    Box(
        modifier = Modifier
            .size(46.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(bg),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = card.label.trim().firstOrNull()?.uppercase() ?: "·",
            fontSize = 18.sp,
            fontWeight = FontWeight.SemiBold,
            color = fg,
        )
    }
}

/** The grey capsule action on a row's trailing edge. */
@Composable
private fun ConnectorActionCapsule(label: String, enabled: Boolean, onClick: (() -> Unit)?) {
    Box(
        modifier = Modifier
            .clip(CircleShape)
            .background(minisGrouped)
            .then(
                if (enabled && onClick != null) {
                    Modifier.clickable(onClick = onClick)
                } else {
                    Modifier
                },
            )
            .padding(horizontal = 14.dp, vertical = 7.dp),
    ) {
        Text(
            label,
            fontSize = 14.sp,
            color = if (enabled) minisInk else minisTertiary,
        )
    }
}

@Composable
private fun ConnectorAccountRow(account: ConnectorAccount, onDisconnect: (() -> Unit)?) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(account.displayName, fontSize = 15.sp, color = minisInk)
            Text(ConnectedAppsPolicy.statusLabel(account.status), color = minisSecondary, fontSize = 12.sp)
            SelectionContainer {
                Text(account.id, color = minisTertiary, fontSize = 12.sp)
            }
        }
        Text(if (account.isActive) "已启用" else "待确认", color = minisSecondary, fontSize = 12.sp)
        // Disconnecting used to be the one thing this screen could not do,
        // although the companion allows exactly this route.
        if (onDisconnect != null) {
            TouchTarget(onClick = onDisconnect, contentDescription = "断开 ${account.displayName}") {
                Text("断开", color = MinisTokens.Danger, fontSize = 14.sp)
            }
        }
    }
}

/** Pure state transition so an unavailable store can never erase a known inventory. */
data class ConnectedAppsInventory(
    val statuses: Map<String, ConnectorStatus>? = null,
    val credentialStoreUnreadable: Boolean = false,
)

object ConnectedAppsPolicy {
    fun accept(previous: ConnectedAppsInventory, response: ConnectorStatuses): ConnectedAppsInventory =
        if (response.isAuthoritative) {
            ConnectedAppsInventory(statuses = response.services)
        } else {
            previous.copy(credentialStoreUnreadable = true)
        }

    /**
     * The provider's own wire word, made readable —
     * `status.replacingOccurrences(of: "_", with: " ").capitalized` in
     * `ios/App/ConnectedAppsView.swift:144`. Case is fixed, not the phone's
     * locale: these are ASCII protocol words, not prose.
     */
    fun statusLabel(status: String): String =
        status.replace('_', ' ').split(' ').joinToString(" ") { word ->
            word.lowercase().replaceFirstChar(Char::uppercaseChar)
        }

    fun showSetupNotice(catalog: ConnectorCatalog?, credentialStoreUnreadable: Boolean): Boolean =
        catalog?.configured == false && !credentialStoreUnreadable

    fun filterCards(cards: List<ConnectorCard>, query: String): List<ConnectorCard> {
        val needle = query.trim()
        if (needle.isEmpty()) return cards
        return cards.filter { card ->
            card.label.contains(needle, ignoreCase = true) ||
                card.slug.contains(needle, ignoreCase = true) ||
                card.blurb.contains(needle, ignoreCase = true)
        }
    }
}

/** The connector whose "add another account" dialog is open. */
private data class AliasTarget(val slug: String, val label: String)

/**
 * Survives rotation without trusting the catalog: only the two strings the
 * dialog needs are saved, so a refreshed catalog cannot leave a stale object.
 */
private val AliasTargetSaver = listSaver<AliasTarget?, Any>(
    save = { target -> target?.let { listOf(it.slug, it.label) } ?: emptyList() },
    restore = { saved ->
        if (saved.size == 2 && saved[0] is String && saved[1] is String) {
            AliasTarget(saved[0] as String, saved[1] as String)
        } else {
            null
        }
    },
)
