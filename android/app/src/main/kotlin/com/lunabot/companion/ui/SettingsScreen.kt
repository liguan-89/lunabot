package com.lunabot.companion.ui

import android.Manifest
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.widget.ImageView
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import dev.chrisbanes.haze.hazeSource
import dev.chrisbanes.haze.rememberHazeState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.lunabot.companion.R
import com.lunabot.companion.core.ActivityDetail
import com.lunabot.companion.account.AccountComputer
import com.lunabot.companion.account.CloudAccountUi
import com.lunabot.companion.core.Connection
import com.lunabot.companion.core.Session
import com.lunabot.companion.phoneui.PhoneUiAccessibilityService
import com.lunabot.companion.phoneui.PhoneUiMirror
import com.lunabot.companion.phoneui.PhoneUiPairingInput
import com.lunabot.companion.phoneui.PhoneUiStatus
import com.lunabot.companion.phoneui.SelfCheckReport
import com.lunabot.companion.phoneui.phoneUiProbes
import com.lunabot.companion.phoneui.runSelfCheck
import com.lunabot.companion.phoneui.shell.PhoneUiShellBridge
import com.lunabot.companion.storage.BotAvatarStyle
import com.lunabot.companion.storage.PhonePace
import com.lunabot.companion.storage.ThemeMode
import com.lunabot.companion.storage.VoiceAsrMode
import com.lunabot.companion.update.AppUpdater
import com.lunabot.companion.update.UpdateState
import com.lunabot.companion.wechat.WechatSettingsSection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.pm.PackageInfoCompat
import androidx.core.net.toUri
import java.net.URI

/**
 * What little the phone gets to configure — the port of
 * `ios/App/SettingsView.swift`.
 *
 * Almost nothing, on purpose: Phone settings, API keys and pairing all live
 * on the computer, because losing the phone must not mean losing the ability to
 * lock it out (§13). This is a status page with an unpair button.
 *
 * It is also the screen the unpaired home reaches, which is why both actions are
 * optional. `SettingsView(onConnect:)` in `ios/App/SettingsView.swift` does the
 * same thing: someone who answered "Not now" can still get to notifications
 * without first entering the connection flow they just declined, and the parts
 * that need a pairing — routines, unpairing, the address — are simply not there
 * to be pressed.
 */
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    onOpenRoutines: (() -> Unit)? = null,
    onOpenConnectedApps: (() -> Unit)? = null,
    onOpenVoice: (() -> Unit)? = null,
    /** Offered instead of the computer's details when there is no pairing. */
    onConnect: (() -> Unit)? = null,
) {
    val environment = LocalCompanion.current
    val session = environment.session
    val connection by session.connection.collectAsState()
    val connections by session.connections.collectAsState()
    val status by session.status.collectAsState()
    val notifications by environment.notifications.access.collectAsState()
    val activityDetail by environment.chatPreferences.activityDetail.collectAsState()
    val themeMode by environment.chatPreferences.themeMode.collectAsState()
    val avatarStyle by environment.chatPreferences.avatarStyle.collectAsState()
    val voiceAsrMode by environment.chatPreferences.voiceAsrMode.collectAsState()
    val phoneCalendar by environment.chatPreferences.phoneCalendar.collectAsState()
    val phoneContacts by environment.chatPreferences.phoneContacts.collectAsState()
    val phoneReminders by environment.chatPreferences.phoneReminders.collectAsState()
    val phoneLocation by environment.chatPreferences.phoneLocation.collectAsState()
    val phoneMessages by environment.chatPreferences.phoneMessages.collectAsState()
    val phoneNotifyRelay by environment.chatPreferences.phoneNotifyRelay.collectAsState()
    val phoneUiEnabled by environment.chatPreferences.phoneUi.collectAsState()
    val phonePace by environment.chatPreferences.phonePace.collectAsState()
    val phoneRepairWireless by environment.chatPreferences.phoneRepairWireless.collectAsState()
    val phoneFiles by environment.chatPreferences.phoneFiles.collectAsState()
    val phoneFilesTree by environment.chatPreferences.phoneFilesTree.collectAsState()
    val phoneNotices by environment.chatPreferences.phoneNotices.collectAsState()
    val phoneUiOverlay by environment.chatPreferences.phoneUiOverlay.collectAsState()
    val phoneNoticeShare by environment.chatPreferences.phoneNoticeShare.collectAsState()
    val phoneNoticeApps by environment.chatPreferences.phoneNoticeApps.collectAsState()
    val phoneUiStatus by environment.phoneUi.status.collectAsState()
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboard.current
    val haptics = rememberHaptics()
    // The system pages may have changed while the person was out of the app.
    LaunchedEffect(Unit) { environment.phoneUi.refresh() }

    // The switch is the consent: Android asks only after the person turns it
    // on, and a refused dialog leaves the switch off rather than claiming an
    // access the app does not have.
    val calendarPermissions = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { granted ->
        environment.chatPreferences.setPhoneCalendar(
            granted[android.Manifest.permission.READ_CALENDAR] == true,
        )
    }
    val contactsPermissions = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { granted ->
        environment.chatPreferences.setPhoneContacts(
            granted[android.Manifest.permission.READ_CONTACTS] == true,
        )
    }
    // Coarse is enough to register `limited`; asking for fine too lets the
    // person choose "precise" in the system dialog and get `full`.
    val locationPermissions = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { granted ->
        environment.chatPreferences.setPhoneLocation(
            granted[android.Manifest.permission.ACCESS_FINE_LOCATION] == true ||
                granted[android.Manifest.permission.ACCESS_COARSE_LOCATION] == true,
        )
    }
    // SMS relay needs both halves: receiving to push inbound texts up, sending
    // to answer them. Refusing either leaves the switch off like the others.
    val smsPermissions = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { granted ->
        environment.chatPreferences.setPhoneMessages(
            granted[android.Manifest.permission.RECEIVE_SMS] == true &&
                granted[android.Manifest.permission.SEND_SMS] == true,
        )
    }
    val phoneUiNetworkPermissions = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { environment.phoneUi.refresh() }

    // Photos need the media grant on 13+, the storage grant before that; the
    // switch only turns on when the dialog was accepted, like the others.
    val filesContext = LocalContext.current
    val filePermissions = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { granted ->
        val grantedNow = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            granted[android.Manifest.permission.READ_MEDIA_IMAGES] == true
        } else {
            granted[android.Manifest.permission.READ_EXTERNAL_STORAGE] == true
        }
        environment.chatPreferences.setPhoneFiles(grantedNow)
    }
    // One folder, deliberately picked: a persisted tree grant the system enforces
    // on every file open.
    val folderPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocumentTree(),
    ) { uri ->
        if (uri != null) {
            runCatching {
                filesContext.contentResolver.takePersistableUriPermission(
                    uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION,
                )
            }
            environment.chatPreferences.setPhoneFilesTree(uri.toString())
        }
    }
    // The floating watch window needs the system's overlay grant; the page is
    // opened by the switch, and returning with the grant turns the switch on.
    val overlayContext = LocalContext.current
    var overlayGranted by remember { mutableStateOf(Settings.canDrawOverlays(overlayContext)) }
    val overlayPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) {
        overlayGranted = Settings.canDrawOverlays(overlayContext)
        if (overlayGranted) environment.chatPreferences.setPhoneUiOverlay(true)
    }

    var editingAddress by remember { mutableStateOf(false) }
    var addressText by remember { mutableStateOf("") }
    var addressError by remember { mutableStateOf<String?>(null) }
    var showingFullAddress by remember { mutableStateOf(false) }
    var addressCopied by remember { mutableStateOf(false) }
    var reconnecting by remember { mutableStateOf(false) }
    var confirmingUnpair by remember { mutableStateOf(false) }
    var pendingComputerRemoval by remember { mutableStateOf<Connection?>(null) }
    /** The account's own computer row awaiting removal — a different list from [pendingComputerRemoval]. */
    var pendingAccountComputerRemoval by remember { mutableStateOf<AccountComputer?>(null) }
    /** The wait for a computer's approval, held so the same row can cancel it. */
    var pairingComputerJob by remember { mutableStateOf<Job?>(null) }
    var choosingActivity by remember { mutableStateOf(false) }
    var choosingTheme by remember { mutableStateOf(false) }
    var choosingAvatarStyle by remember { mutableStateOf(false) }
    var choosingVoiceAsr by remember { mutableStateOf(false) }
    var choosingPhonePace by remember { mutableStateOf(false) }
    var pickingNoticeApps by remember { mutableStateOf(false) }
    var phoneUiCheckReport by remember { mutableStateOf<SelfCheckReport?>(null) }
    var phoneUiChecking by remember { mutableStateOf(false) }
    var watchingScreen by remember { mutableStateOf(false) }
    var editingQuickReplies by remember { mutableStateOf(false) }
    var pairingPhoneUi by remember { mutableStateOf(false) }
    val phoneToolsStatus by session.phoneToolsStatus.collectAsState()
    val account = environment.cloudAccount
    val accountUi by account.state.collectAsState()
    var signingIn by remember { mutableStateOf(false) }
    var cloudNotice by remember { mutableStateOf<String?>(null) }

    val hazeState = rememberHazeState()
    val scrollState = rememberScrollState()
    val topScrolled by remember { derivedStateOf { scrollState.canScrollBackward } }
    val topBandAlpha by animateFloatAsState(
        targetValue = if (topScrolled) 1f else 0f,
        animationSpec = tween(180),
        label = "settings-top-haze",
    )

    CompositionLocalProvider(LocalHazeState provides hazeState) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(minisCanvas)
            .semantics { paneTitle = "设置" },
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(minisCanvas)
                .hazeSource(hazeState),
        ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(scrollState)
                .navigationBarsPadding()
                .padding(start = 16.dp, end = 16.dp, top = 66.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            val bound = connection
            SettingsSection {
                IdentityRow(
                    title = bound?.name ?: "Luna Bot",
                    subtitle = SettingsPolicy.statusText(status),
                    statusColor = connectionColor(status),
                    // The row is the computer's identity; tapping it opens the
                    // one detail this phone can change about it.
                    onClick = if (bound != null) {
                        {
                            addressText = SettingsPolicy.addressText(bound)
                            addressError = null
                            editingAddress = true
                        }
                    } else {
                        null
                    },
                )
                if (bound != null) {
                    val address = SettingsPolicy.addressText(bound)
                    SettingsDivider()
                    AddressRow(
                        address = address,
                        expanded = showingFullAddress,
                        copied = addressCopied,
                        onToggle = { showingFullAddress = !showingFullAddress },
                        onCopy = {
                            scope.launch {
                                clipboard.setClipEntry(
                                    ClipEntry(ClipData.newPlainText(ADDRESS_CLIP_LABEL, address)),
                                )
                                addressCopied = true
                                delay(COPIED_LABEL_MILLIS)
                                addressCopied = false
                            }
                        },
                    )
                    SettingsDivider()
                    SettingsRow(
                        title = "尝试重新连接",
                        enabled = !reconnecting,
                        trailing = {
                            if (reconnecting) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(16.dp),
                                    strokeWidth = 2.dp,
                                )
                            }
                        },
                        onClick = {
                            scope.launch {
                                reconnecting = true
                                // Waits until the stream leaves connecting (or 10s),
                                // so the spinner means what it appears to mean.
                                session.refresh()
                                reconnecting = false
                            }
                        },
                    )
                    SettingsDivider()
                    SettingsRow(
                        title = "连接另一台电脑",
                        chevron = true,
                        onClick = {
                            haptics.play(TactileAction.CONNECT_ANOTHER_COMPUTER)
                            session.beginPairing()
                        },
                    )
                } else if (onConnect != null) {
                    SettingsDivider()
                    SettingsRow(
                        title = "连接电脑",
                        titleColor = minisAccent,
                        chevron = true,
                        onClick = onConnect,
                    )
                }
            }

            val otherComputers = connections.filter { it.id != connection?.id }
            if (otherComputers.isNotEmpty()) {
                SettingsSection(label = "其他电脑") {
                    otherComputers.forEachIndexed { index, computer ->
                        if (index > 0) SettingsDivider()
                        SettingsRow(
                            title = computer.name,
                            subtitle = SettingsPolicy.addressText(computer),
                            chevron = true,
                            trailing = {
                                TextButton(
                                    onClick = { pendingComputerRemoval = computer },
                                ) {
                                    Text(
                                        text = "移除",
                                        fontSize = 13.sp,
                                        color = minisDanger,
                                    )
                                }
                            },
                            onClick = {
                                haptics.play(TactileAction.SWITCH_COMPUTER)
                                session.switchComputer(computer.id)
                            },
                        )
                    }
                }
            }

            // The one card a person checks to see what their bots may use; it
            // sits directly under the computer as its own top-level feature.
            if (onOpenConnectedApps != null) {
                SettingsSection {
                    SettingsRow(
                        title = "已连接应用",
                        chevron = true,
                        onClick = onOpenConnectedApps,
                    )
                }
            }

            SettingsSection(
                label = "Cloud 账号",
                // Errors and browser results are answers, not explanations;
                // the rest of the account story lives in the desktop app.
                footer = if (accountUi.error == null && accountUi.notice == null && cloudNotice == null) {
                    null
                } else {
                    {
                        accountUi.notice?.let { SettingsFootnote(it) }
                        accountUi.error?.let { SettingsFootnote(it) }
                        cloudNotice?.let { SettingsFootnote(it) }
                    }
                },
            ) {
                when (accountUi.phase) {
                    // A failed first read keeps the phase at LOADING, because the
                    // stored session may still be perfectly good — only the
                    // request lost its race with the network on a cold start.
                    // Without a retry here the section said it was still checking
                    // and nothing but an app restart could recover it.
                    CloudAccountUi.Phase.LOADING -> if (accountUi.error == null) {
                        SettingsRow(
                            title = "状态",
                            value = "正在检查",
                            trailing = {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(16.dp),
                                    strokeWidth = 2.dp,
                                )
                            },
                        )
                    } else {
                        SettingsRow(
                            title = "重试",
                            enabled = !accountUi.busy,
                            onClick = { environment.cloudAccount.refresh() },
                        )
                    }
                    CloudAccountUi.Phase.SIGNED_OUT -> {
                        SettingsRow(
                            title = "登录 Cloud 账号",
                            chevron = true,
                            onClick = {
                                environment.cloudAccount.clearError()
                                signingIn = true
                            },
                        )
                    }
                    CloudAccountUi.Phase.SIGNED_IN -> {
                        SettingsRow(title = "账号", value = accountUi.email ?: "")
                        accountUi.clouds.forEach { cloud ->
                            SettingsDivider()
                            SettingsRow(
                                // With one Cloud the name is noise; with two
                                // it is the only thing telling the status rows
                                // apart.
                                title = if (accountUi.clouds.size > 1) "${cloud.name} 状态" else "云电脑状态",
                                value = cloudStatusText(cloud.status),
                            )
                            SettingsDivider()
                            SettingsRow(
                                title = if (accountUi.busy) "正在配对…" else "配对 ${cloud.name} 到这台手机",
                                chevron = true,
                                enabled = cloud.origin != null && !accountUi.busy,
                                onClick = {
                                    if (cloud.origin == null) return@SettingsRow
                                    scope.launch {
                                        // Mint the one-time code, then hand it to the pairing
                                        // screen. Redeeming it here bypassed that screen's
                                        // attempt transaction — the Cloud saw a session but
                                        // nothing was written down for this phone to restore.
                                        val grant = environment.cloudAccount.pairCloud(cloud)
                                            ?: return@launch
                                        CloudPairingInbox.offer(
                                            CloudPairingRequest(
                                                origin = grant.origin,
                                                code = grant.code,
                                                name = cloud.name,
                                            ),
                                        )
                                        session.beginPairing()
                                    }
                                },
                            )
                            SettingsDivider()
                            SettingsRow(
                                title = "在浏览器中打开 ${cloud.name}",
                                external = true,
                                enabled = cloud.origin != null && !accountUi.busy,
                                onClick = {
                                    val origin = cloud.origin ?: return@SettingsRow
                                    cloudNotice = environment.openCloudDesktop(URI(origin))
                                },
                            )
                        }
                        // The computers this account signed in, next to the
                        // Clouds. Asking one opens a card on that computer; the
                        // link it answers with is redeemed by the pairing screen.
                        //
                        // Only desktops appear: the account lists this phone's
                        // own installation too, and a row that can only ever
                        // fail to connect is worse than no row.
                        val accountComputers = accountUi.computers.filter { it.connectable }
                        if (accountComputers.isNotEmpty()) {
                            SettingsDivider()
                            SettingsRow(title = "我的电脑", value = "${accountComputers.size} 台")
                            accountComputers.forEach { computer ->
                                val waiting = accountUi.pairingComputerId == computer.id
                                SettingsDivider()
                                SettingsRow(
                                    title = if (waiting) "取消连接 ${computer.name}" else "连接 ${computer.name}",
                                    value = when {
                                        waiting -> "等待电脑允许…"
                                        computer.online -> "在线"
                                        else -> "离线"
                                    },
                                    chevron = !waiting,
                                    // A waiting request is the one row that stays
                                    // tappable: the wait can be two minutes, and
                                    // tapping again is how it is called off.
                                    enabled = if (waiting) true else accountUi.pairingComputerId == null && !accountUi.busy,
                                    trailing = {
                                        // Not while this row's request is in
                                        // flight: deleting the installation the
                                        // computer is being asked to approve
                                        // would answer the question with a 404.
                                        TextButton(
                                            enabled = !waiting && !accountUi.busy,
                                            onClick = { pendingAccountComputerRemoval = computer },
                                        ) {
                                            Text("移除", fontSize = 13.sp, color = minisDanger)
                                        }
                                    },
                                    onClick = {
                                        if (waiting) {
                                            pairingComputerJob?.cancel()
                                            return@SettingsRow
                                        }
                                        pairingComputerJob = scope.launch {
                                            val link = environment.cloudAccount.pairComputer(computer) ?: return@launch
                                            ComputerPairingInbox.offer(
                                                ComputerPairingRequest(link = link, name = computer.name),
                                            )
                                            session.beginPairing()
                                        }
                                    },
                                )
                            }
                        }
                        SettingsDivider()
                        SettingsRow(
                            title = if (accountUi.busy) "正在刷新…" else "刷新",
                            enabled = !accountUi.busy,
                            onClick = { environment.cloudAccount.refresh() },
                        )
                        SettingsDivider()
                        SettingsRow(
                            title = "退出账号",
                            destructive = true,
                            onClick = { environment.cloudAccount.signOut() },
                        )
                    }
                }
            }

            val alwaysOnEnabled by environment.alwaysOnEnabled.collectAsState()
            // A granted switch cannot turn itself off; it opens the page that can.
            val actOnNotifications = {
                if (notifications == NotificationAccess.GRANTED) {
                    environment.notifications.openSettingsPage()
                } else {
                    environment.notifications.act()
                }
            }
            SettingsSection {
                SettingsSwitchRow(
                    title = "通知",
                    checked = notifications == NotificationAccess.GRANTED,
                    onCheckedChange = { actOnNotifications() },
                )
                SettingsDivider()
                SettingsSwitchRow(
                    title = "保持后台连接",
                    checked = alwaysOnEnabled,
                    onCheckedChange = { environment.onToggleAlwaysOn() },
                )
            }

            // Chinese OEM ROMs kill background services more aggressively than
            // AOSP. These rows open the exact system pages the app cannot
            // toggle itself.
            SettingsSection(label = "手机保活") {
                val context = androidx.compose.ui.platform.LocalContext.current
                SettingsRow(
                    title = "电池优化白名单",
                    external = true,
                    onClick = {
                        runCatching {
                            context.startActivity(
                                Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                            )
                        }
                    },
                )
                SettingsDivider()
                SettingsRow(
                    title = "自启动与后台管理",
                    external = true,
                    onClick = {
                        runCatching {
                            context.startActivity(
                                Intent(
                                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                    Uri.fromParts("package", context.packageName, null),
                                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                            )
                        }
                    },
                )
                SettingsDivider()
                SettingsRow(
                    title = "通知与锁屏显示",
                    external = true,
                    onClick = {
                        runCatching {
                            context.startActivity(
                                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                                    .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                            )
                        }
                    },
                )
            }

            val phoneToolsContext = LocalContext.current
            val toggleCalendar: (Boolean) -> Unit = { enabled ->
                if (enabled) {
                    calendarPermissions.launch(
                        arrayOf(
                            android.Manifest.permission.READ_CALENDAR,
                            android.Manifest.permission.WRITE_CALENDAR,
                        ),
                    )
                } else {
                    environment.chatPreferences.setPhoneCalendar(false)
                }
            }
            val toggleContacts: (Boolean) -> Unit = { enabled ->
                if (enabled) {
                    contactsPermissions.launch(
                        arrayOf(
                            android.Manifest.permission.READ_CONTACTS,
                            android.Manifest.permission.WRITE_CONTACTS,
                        ),
                    )
                } else {
                    environment.chatPreferences.setPhoneContacts(false)
                }
            }
            val toggleLocation: (Boolean) -> Unit = { enabled ->
                if (enabled) {
                    locationPermissions.launch(
                        arrayOf(
                            android.Manifest.permission.ACCESS_FINE_LOCATION,
                            android.Manifest.permission.ACCESS_COARSE_LOCATION,
                        ),
                    )
                } else {
                    environment.chatPreferences.setPhoneLocation(false)
                }
            }
            val toggleMessages: (Boolean) -> Unit = { enabled ->
                if (enabled) {
                    smsPermissions.launch(
                        arrayOf(
                            android.Manifest.permission.RECEIVE_SMS,
                            android.Manifest.permission.SEND_SMS,
                        ),
                    )
                } else {
                    environment.chatPreferences.setPhoneMessages(false)
                }
            }
            // 5G/RCS texts never reach SMS_RECEIVED; the messaging app's notification is the only
            // readable signal. The system grant lives on its own page — the switch remembers intent.
            val toggleNotifyRelay: (Boolean) -> Unit = { enabled ->
                environment.chatPreferences.setPhoneNotifyRelay(enabled)
                if (enabled && !notificationListenerGranted(phoneToolsContext)) {
                    runCatching {
                        phoneToolsContext.startActivity(
                            android.content.Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
                                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    }
                }
            }
            val toolsFailure = phoneToolsStatus as? Session.PhoneToolsStatus.Failed
            SettingsSection(
                label = "手机工具",
                footer = if (toolsFailure == null) {
                    null
                } else {
                    { SettingsFootnote(NoticeMessageFormat.humanize(toolsFailure.message)) }
                },
            ) {
                SettingsSwitchRow(
                    title = "允许智能体读取日历",
                    checked = phoneCalendar,
                    onCheckedChange = toggleCalendar,
                )
                SettingsDivider()
                SettingsSwitchRow(
                    title = "允许智能体读取联系人",
                    checked = phoneContacts,
                    onCheckedChange = toggleContacts,
                )
                SettingsDivider()
                SettingsSwitchRow(
                    title = "允许智能体创建提醒",
                    checked = phoneReminders,
                    onCheckedChange = { environment.chatPreferences.setPhoneReminders(it) },
                )
                SettingsDivider()
                SettingsSwitchRow(
                    title = "允许智能体获取位置",
                    checked = phoneLocation,
                    onCheckedChange = toggleLocation,
                )
                SettingsDivider()
                SettingsSwitchRow(
                    title = "允许智能体收发短信",
                    checked = phoneMessages,
                    onCheckedChange = toggleMessages,
                )
                if (phoneMessages) {
                    SettingsDivider()
                    SettingsSwitchRow(
                        title = "转发短信通知（5G 消息）",
                        checked = phoneNotifyRelay,
                        onCheckedChange = toggleNotifyRelay,
                    )
                }
                if (phoneCalendar || phoneContacts || phoneReminders || phoneLocation || phoneMessages) {
                    SettingsDivider()
                    SettingsRow(
                        title = "电脑登记",
                        value = when (phoneToolsStatus) {
                            Session.PhoneToolsStatus.Registered -> "已登记"
                            is Session.PhoneToolsStatus.Failed -> "登记失败"
                            Session.PhoneToolsStatus.Idle -> "未登记"
                        },
                    )
                }
            }

            // 微信: its own card in its own file — binding, the QR, and the
            // enable/unbind rows. This screen only places it.
            WechatSettingsSection()

            // 手机界面 (wireless debugging + shell helper): default off, the
            // system pages open only from an explicit tap, and pairing needs
            // the port and code the system pairing dialog shows — nothing is
            // enabled or prompted on the person's behalf.
            val phoneUiContext = LocalContext.current
            SettingsSection(
                label = "手机界面",
                footer = {
                    SettingsFootnote("屏幕文字会发送给该智能体的 AI 用于操作；密码字段会跳过。智能体要截图、识别画面文字、读取剪贴板、最近通知或你允许的文件时才会上传对应内容，写剪贴板与每次点击输入一样需要桌面端权限审批。可随时关闭或取消配对。")
                    if (phoneUiStatus == PhoneUiStatus.Failed) {
                        SettingsFootnote("连接失败，请确认无线调试仍开启，或重新配对。")
                    }
                    (phoneToolsStatus as? Session.PhoneToolsStatus.Failed)?.let { failure ->
                        if (phoneUiStatus == PhoneUiStatus.Ready) {
                            SettingsFootnote(NoticeMessageFormat.humanize(failure.message))
                        }
                    }
                },
            ) {
                SettingsSwitchRow(
                    title = "允许智能体操作手机界面",
                    checked = phoneUiEnabled,
                    onCheckedChange = { enabled ->
                        environment.chatPreferences.setPhoneUi(enabled)
                        if (!enabled) environment.phoneUi.disable()
                    },
                )
                if (phoneUiEnabled) {
                    SettingsDivider()
                    SettingsRow(title = "状态", value = phoneUiStatusLabel(phoneUiStatus))
                    when (phoneUiStatus) {
                        PhoneUiStatus.Disabled, PhoneUiStatus.UnsupportedAndroidVersion -> Unit
                        PhoneUiStatus.NeedsDeveloperOptions -> {
                            SettingsDivider()
                            SettingsRow(
                                title = "打开开发者选项",
                                external = true,
                                onClick = { openDeveloperOptions(phoneUiContext) },
                            )
                        }
                        PhoneUiStatus.NeedsWirelessDebugging -> {
                            SettingsDivider()
                            SettingsRow(
                                title = "打开无线调试",
                                external = true,
                                onClick = { openWirelessDebugging(phoneUiContext) },
                            )
                        }
                        PhoneUiStatus.NeedsLocalNetworkPermission -> {
                            SettingsDivider()
                            SettingsRow(
                                title = "允许附近设备和本地网络",
                                onClick = {
                                    phoneUiNetworkPermissions.launch(environment.phoneUi.localNetworkPermissions())
                                },
                            )
                        }
                        PhoneUiStatus.NeedsAccessibility -> {
                            SettingsDivider()
                            SettingsRow(
                                title = "启用屏幕读取服务",
                                external = true,
                                onClick = { openAccessibilitySettings(phoneUiContext) },
                            )
                        }
                        PhoneUiStatus.NotPaired, PhoneUiStatus.Failed -> {
                            SettingsDivider()
                            SettingsRow(
                                title = "配对设备",
                                chevron = true,
                                onClick = { pairingPhoneUi = true },
                            )
                        }
                        PhoneUiStatus.Paired, PhoneUiStatus.HelperConnecting, PhoneUiStatus.Ready -> {
                            SettingsDivider()
                            SettingsRow(
                                title = "取消配对",
                                destructive = true,
                                onClick = {
                                    pairingPhoneUi = false
                                    environment.phoneUi.forget()
                                },
                            )
                        }
                        PhoneUiStatus.Pairing -> Unit
                    }
                    SettingsDivider()
                    SettingsRow(
                        title = stringResource(R.string.settings_phone_pace),
                        value = phonePaceLabel(phonePace),
                        chevron = true,
                        onClick = { choosingPhonePace = true },
                    )
                    SettingsDivider()
                    // The run has a 90 s budget, so the row shows a spinner and
                    // refuses a second tap while it runs.
                    SettingsRow(
                        title = stringResource(R.string.settings_phone_self_check),
                        subtitle = stringResource(R.string.settings_phone_self_check_caption),
                        enabled = !phoneUiChecking,
                        trailing = {
                            if (phoneUiChecking) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(16.dp),
                                    strokeWidth = 2.dp,
                                )
                            }
                        },
                        onClick = {
                            phoneUiChecking = true
                            phoneUiCheckReport = null
                            scope.launch {
                                // Binder calls and display creation block, so the
                                // whole run stays off the main thread.
                                val report = withContext(Dispatchers.IO) {
                                    runSelfCheck(
                                        phoneUiProbes(
                                            phoneUiContext,
                                            shell = { PhoneUiShellBridge.of(phoneUiContext).shell.value },
                                            accessibility = { PhoneUiAccessibilityService.instance.value },
                                        ),
                                    )
                                }
                                phoneUiCheckReport = report
                                phoneUiChecking = false
                            }
                        },
                    )
                    SettingsDivider()
                    // A live, read-only window into the controlled display:
                    // the sheet below inside the app, and an opt-in floating
                    // view over other apps while a task is driving.
                    SettingsRow(
                        title = "观看受控屏",
                        subtitle = "实时显示智能体正在操作的手机画面",
                        chevron = true,
                        onClick = { watchingScreen = true },
                    )
                    SettingsDivider()
                    SettingsSwitchRow(
                        title = "任务期间悬浮显示受控屏",
                        subtitle = if (overlayGranted) "在其他应用上方显示小窗，只读" else "需要允许在其他应用上层显示",
                        checked = phoneUiOverlay && overlayGranted,
                        onCheckedChange = { enabled ->
                            if (enabled && !overlayGranted) {
                                overlayPermission.launch(
                                    Intent(
                                        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                                        "package:${overlayContext.packageName}".toUri(),
                                    ),
                                )
                            } else {
                                environment.chatPreferences.setPhoneUiOverlay(enabled)
                            }
                        },
                    )
                    SettingsDivider()
                    // Opt-in, and off by default: the grant it needs is
                    // WRITE_SECURE_SETTINGS, which is not limited to the one
                    // switch this feature writes. The screen cannot see whether
                    // the grant landed, so the caption promises only that the
                    // helper will be asked, not that it succeeded.
                    SettingsSwitchRow(
                        title = stringResource(R.string.settings_phone_repair_wireless),
                        subtitle = stringResource(
                            if (phoneRepairWireless) {
                                R.string.settings_phone_repair_wireless_pending
                            } else {
                                R.string.settings_phone_repair_wireless_caption
                            },
                        ),
                        checked = phoneRepairWireless,
                        onCheckedChange = { enabled ->
                            environment.chatPreferences.setPhoneRepairWireless(enabled)
                        },
                    )
                    SettingsDivider()
                    // Files are a separate consent on top of the screen switch:
                    // the media grant plus, optionally, one picked folder.
                    SettingsSwitchRow(
                        title = "允许智能体读取相册与文件夹",
                        checked = phoneFiles,
                        onCheckedChange = { enabled ->
                            if (!enabled) {
                                environment.chatPreferences.setPhoneFiles(false)
                            } else {
                                val permission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                    android.Manifest.permission.READ_MEDIA_IMAGES
                                } else {
                                    android.Manifest.permission.READ_EXTERNAL_STORAGE
                                }
                                val already = ContextCompat.checkSelfPermission(filesContext, permission) ==
                                    android.content.pm.PackageManager.PERMISSION_GRANTED
                                if (already) environment.chatPreferences.setPhoneFiles(true)
                                else filePermissions.launch(arrayOf(permission))
                            }
                        },
                    )
                    if (phoneFiles) {
                        SettingsDivider()
                        SettingsRow(
                            title = "授权一个文件夹",
                            value = phoneFilesTree?.let(::treeLabel) ?: "未授权",
                            chevron = true,
                            onClick = { folderPicker.launch(null) },
                        )
                        if (phoneFilesTree != null) {
                            SettingsDivider()
                            SettingsRow(
                                title = "取消文件夹授权",
                                destructive = true,
                                onClick = {
                                    phoneFilesTree?.let { stored ->
                                        runCatching {
                                            filesContext.contentResolver.releasePersistableUriPermission(
                                                android.net.Uri.parse(stored),
                                                Intent.FLAG_GRANT_READ_URI_PERMISSION,
                                            )
                                        }
                                    }
                                    environment.chatPreferences.setPhoneFilesTree(null)
                                },
                            )
                        }
                    }
                    SettingsDivider()
                    // The same system notification access the SMS relay uses,
                    // but this switch is the bot reading every app's posts.
                    SettingsSwitchRow(
                        title = "允许智能体读取最近通知",
                        checked = phoneNotices,
                        onCheckedChange = { enabled ->
                            environment.chatPreferences.setPhoneNotices(enabled)
                            if (enabled && !notificationListenerGranted(phoneToolsContext)) {
                                runCatching {
                                    phoneToolsContext.startActivity(
                                        Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
                                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                                    )
                                }
                            }
                        },
                    )
                    SettingsDivider()
                    // Sharing is the phone pushing on its own — the consent is
                    // per package, not per notification, so it needs its own
                    // switch plus a whitelist instead of one blanket grant.
                    SettingsSwitchRow(
                        title = "分享通知给智能体",
                        checked = phoneNoticeShare,
                        onCheckedChange = { enabled ->
                            environment.chatPreferences.setPhoneNoticeShare(enabled)
                            if (enabled && !notificationListenerGranted(phoneToolsContext)) {
                                runCatching {
                                    phoneToolsContext.startActivity(
                                        Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
                                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                                    )
                                }
                            }
                            if (enabled && phoneNoticeApps.isEmpty()) pickingNoticeApps = true
                        },
                    )
                    if (phoneNoticeShare) {
                        SettingsDivider()
                        SettingsRow(
                            title = "分享哪些应用的通知",
                            value = if (phoneNoticeApps.isEmpty()) "未选择" else "已选 ${phoneNoticeApps.size} 个",
                            chevron = true,
                            onClick = { pickingNoticeApps = true },
                        )
                        SettingsFootnote("只有勾选应用的通知内容会发送到电脑；验证码等敏感内容会被过滤，其他应用的通知不会离开手机。通知监听需要在系统设置里授权。")
                    }
                    if (phoneUiStatus == PhoneUiStatus.Ready) {
                        SettingsDivider()
                        SettingsRow(
                            title = "电脑登记",
                            value = when (phoneToolsStatus) {
                                Session.PhoneToolsStatus.Registered -> "已登记"
                                is Session.PhoneToolsStatus.Failed -> "登记失败"
                                Session.PhoneToolsStatus.Idle -> "未登记"
                            },
                        )
                    }
                }
            }

            // 手机解锁: the credential stays on this phone, encrypted, and is
            // typed into the keyguard by the shell helper. Off until the person
            // saves one and turns the remote switch on.
            UnlockSettingsSection(phoneUi = environment.phoneUi)

            SettingsSection {
                SettingsRow(
                    title = "外观",
                    value = themeLabel(themeMode),
                    chevron = true,
                    onClick = { choosingTheme = true },
                )
                SettingsDivider()
                SettingsRow(
                    title = "Bot 形象风格",
                    value = avatarStyleLabel(avatarStyle),
                    chevron = true,
                    onClick = { choosingAvatarStyle = true },
                )
                SettingsDivider()
                SettingsRow(
                    title = "活动详情",
                    value = activityDetail.label,
                    chevron = true,
                    onClick = { choosingActivity = true },
                )
                SettingsDivider()
                SettingsRow(
                    title = "快捷回复",
                    chevron = true,
                    onClick = { editingQuickReplies = true },
                )
                SettingsDivider()
                SettingsRow(
                    title = "语音消息转文字",
                    value = voiceAsrLabel(voiceAsrMode),
                    chevron = true,
                    onClick = { choosingVoiceAsr = true },
                )
            }

            // Routine schedules live on the computer this phone is bound to.
            // With no binding there is nothing to schedule against, so the row
            // is absent rather than present and dead.
            if (onOpenRoutines != null || onOpenVoice != null) {
                SettingsSection(label = "工作区") {
                    onOpenRoutines?.let { openRoutines ->
                        SettingsRow(title = "会话与例程", chevron = true, onClick = openRoutines)
                    }
                    if (onOpenRoutines != null && onOpenVoice != null) SettingsDivider()
                    onOpenVoice?.let { openVoice ->
                        SettingsRow(title = "语音", chevron = true, onClick = openVoice)
                    }
                }
            }

            // The release channel is phone-only: it downloads a build signed
            // with the same key as this install, so pairing and chat data are
            // untouched. Android still asks for its own install confirmation.
            val updateState by environment.updates.state.collectAsState()
            val updateBusy = updateState is UpdateState.Checking || updateState is UpdateState.Downloading
            val updateFailure = updateState as? UpdateState.Failed
            SettingsSection(
                // A failed update is the one state that needs a sentence; the
                // rest is already in the row.
                footer = if (updateFailure == null) {
                    null
                } else {
                    { SettingsFootnote(updateFailure.message) }
                },
            ) {
                SettingsRow(
                    title = "软件更新",
                    enabled = !updateBusy,
                    chevron = true,
                    trailing = {
                        if (updateBusy) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(16.dp),
                                strokeWidth = 2.dp,
                            )
                        } else {
                            Text(
                                text = updateStatusText(updateState),
                                fontSize = 13.sp,
                                color = if (
                                    updateState is UpdateState.Available ||
                                    updateState is UpdateState.Ready
                                ) {
                                    minisAccent
                                } else {
                                    secondaryTint
                                },
                            )
                        }
                    },
                    onClick = {
                        when (updateState) {
                            is UpdateState.Available -> environment.updates.download()
                            is UpdateState.Ready -> environment.updates.install()
                            else -> environment.updates.check()
                        }
                    },
                )
                // Recovery when the in-app path cannot run: the same page in a
                // browser, where the person can download and install by hand.
                if (updateState is UpdateState.Failed) {
                    val context = LocalContext.current
                    SettingsDivider()
                    SettingsRow(
                        title = "在浏览器中打开发布页",
                        external = true,
                        onClick = {
                            runCatching {
                                context.startActivity(
                                    Intent(Intent.ACTION_VIEW, AppUpdater.RELEASE_PAGE.toUri())
                                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                                )
                            }
                        },
                    )
                }
            }

            // Last on the page: the action that ends this phone's access is the
            // one thing here that cannot be undone from the phone itself.
            if (connection != null) {
                SettingsSection {
                    SettingsRow(
                        title = if (connections.size > 1) "移除此电脑" else "取消配对此手机",
                        destructive = true,
                        onClick = { confirmingUnpair = true },
                    )
                }
            }

            val versionContext = LocalContext.current
            val brandVersion = remember(versionContext) {
                runCatching {
                    val info = versionContext.packageManager.getPackageInfo(versionContext.packageName, 0)
                    "${info.versionName} (${PackageInfoCompat.getLongVersionCode(info)})"
                }.getOrNull() ?: environment.updates.currentVersionName
            }
            BrandBlock(version = brandVersion)
        }
        }

        val canvasTop = minisCanvas
        val topVeil = remember(canvasTop) {
            Brush.verticalGradient(
                0.0f to canvasTop,
                0.72f to canvasTop.copy(alpha = 0.94f),
                1.0f to canvasTop.copy(alpha = 0f),
            )
        }
        Box(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth()
                .height(66.dp)
                .background(topVeil),
        )
        Box(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            TouchTarget(
                onClick = onBack,
                contentDescription = "关闭设置",
                modifier = Modifier.align(Alignment.CenterStart),
            ) {
                Box(
                    modifier = Modifier
                        .size(44.dp)
                        .museFloatingPill(CircleShape, elevation = 4.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = Icons.Filled.Close,
                        contentDescription = null,
                        tint = minisInk,
                        modifier = Modifier.size(19.dp),
                    )
                }
            }
            Text(
                text = "设置",
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                color = minisInk,
                modifier = Modifier.align(Alignment.Center),
            )
        }
    }
    }

    if (editingAddress) {
        SettingsSheet(
            title = "编辑地址",
            onDismiss = { editingAddress = false },
            actionLabel = "保存",
            onAction = {
                // Session re-parses, re-dials and persists; the walk and
                // promote semantics stay its job. The form only refuses what
                // it can already tell is not an address.
                if (session.updateAddress(addressText)) {
                    editingAddress = false
                } else {
                    addressError = AddressEdit.INVALID
                }
            },
        ) {
            Column(
                modifier = Modifier.padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = addressText,
                    onValueChange = {
                        addressText = it
                        addressError = null
                    },
                    placeholder = { Text("https://mac.example 或 192.168.1.42:8810") },
                    singleLine = true,
                    isError = addressError != null,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics { contentDescription = "电脑地址" },
                )
                addressError?.let {
                    Text(it, fontSize = 13.sp, color = MaterialTheme.colorScheme.error)
                }
            }
        }
    }

    if (confirmingUnpair) {
        AlertDialog(
            onDismissRequest = { confirmingUnpair = false },
            title = { Text(if (connections.size > 1) "移除 ${connection?.name}？" else SettingsPolicy.UNPAIR_CONFIRM_TITLE) },
            text = {
                Text(
                    if (connections.size > 1) {
                        "这仅会从本手机移除已保存的连接。其他已保存的电脑仍可使用。"
                    } else {
                        SettingsPolicy.UNPAIR_FOOTER
                    },
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmingUnpair = false
                        // Local token and connection only. Revoking the device
                        // itself is Settings → Phone on the computer (§6).
                        session.signOut()
                    },
                ) {
                    // With another computer saved this removes one of them; the
                    // phone stays paired, so "Unpair" would be the wrong promise.
                    Text(
                        text = if (connections.size > 1) "移除" else "取消配对",
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmingUnpair = false }) { Text("取消") }
            },
        )
    }

    pendingComputerRemoval?.let { computer ->
        AlertDialog(
            onDismissRequest = { pendingComputerRemoval = null },
            title = { Text("移除 ${computer.name}？") },
            text = { Text("这仅会从本手机移除已保存的连接。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        pendingComputerRemoval = null
                        session.forgetConnection(computer.id)
                    },
                ) { Text("移除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { pendingComputerRemoval = null }) { Text("取消") }
            },
        )
    }

    pendingAccountComputerRemoval?.let { computer ->
        AlertDialog(
            onDismissRequest = { pendingAccountComputerRemoval = null },
            title = { Text("从账号移除 ${computer.name}？") },
            text = {
                Text(
                    "这条记录会从你的 Cloud 账号里删除，所有登录了这个账号的手机都不再看到它。" +
                        "电脑本身不受影响，它下次登录会重新出现。",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        pendingAccountComputerRemoval = null
                        environment.cloudAccount.forgetComputer(computer)
                    },
                ) { Text("移除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { pendingAccountComputerRemoval = null }) { Text("取消") }
            },
        )
    }

    if (choosingTheme) {
        SettingsSheet(title = "主题", onDismiss = { choosingTheme = false }) {
            Column(Modifier.padding(horizontal = 16.dp)) {
                SettingsSection {
                    ThemeMode.entries.forEachIndexed { index, mode ->
                        if (index > 0) SettingsDivider()
                        SettingsRow(
                            title = themeLabel(mode),
                            trailing = {
                                if (themeMode == mode) {
                                    Icon(
                                        imageVector = Icons.Filled.Check,
                                        contentDescription = null,
                                        tint = minisAccent,
                                        modifier = Modifier.size(18.dp),
                                    )
                                }
                            },
                            onClick = {
                                environment.chatPreferences.setThemeMode(mode)
                                choosingTheme = false
                            },
                        )
                    }
                }
            }
        }
    }

    if (choosingAvatarStyle) {
        val customLunaPath by environment.chatPreferences.customLunaAvatarPath.collectAsState()
        val avatarContext = LocalContext.current
        val pickLunaPhoto = rememberLauncherForActivityResult(
            ActivityResultContracts.PickVisualMedia(),
        ) { uri ->
            if (uri == null) return@rememberLauncherForActivityResult
            scope.launch {
                val savedPath = withContext(Dispatchers.IO) {
                    runCatching {
                        val dir = java.io.File(avatarContext.filesDir, "custom_avatars").apply { mkdirs() }
                        dir.listFiles()?.forEach { it.delete() }
                        val outFile = java.io.File(dir, "luna_${System.currentTimeMillis()}.jpg")
                        avatarContext.contentResolver.openInputStream(uri)?.use { input ->
                            outFile.outputStream().use { output -> input.copyTo(output) }
                        }
                        outFile.takeIf { it.exists() && it.length() > 0L }?.absolutePath
                    }.getOrNull()
                }
                if (savedPath != null) {
                    haptics.play(HapticCue.SELECT)
                    environment.chatPreferences.setCustomLunaAvatarPath(savedPath)
                }
            }
        }
        var customPreview by remember(customLunaPath) { mutableStateOf<Bitmap?>(null) }
        LaunchedEffect(customLunaPath) {
            customPreview = if (customLunaPath != null) {
                withContext(Dispatchers.IO) {
                    runCatching { android.graphics.BitmapFactory.decodeFile(customLunaPath) }.getOrNull()
                }
            } else {
                null
            }
        }
        SettingsSheet(title = "Bot 形象风格", onDismiss = { choosingAvatarStyle = false }) {
            Column(
                modifier = Modifier.padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                // Muse-style custom portrait picker for Luna
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(20.dp))
                        .background(minisCard)
                        .border(
                            width = if (customLunaPath != null) 1.5.dp else 0.5.dp,
                            color = if (customLunaPath != null) minisAccent else minisSeparator.copy(alpha = 0.5f),
                            shape = RoundedCornerShape(20.dp),
                        )
                        .clickable(role = Role.Button) {
                            pickLunaPhoto.launch(
                                androidx.activity.result.PickVisualMediaRequest(
                                    ActivityResultContracts.PickVisualMedia.ImageOnly,
                                ),
                            )
                        }
                        .padding(horizontal = 14.dp, vertical = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    val bmp = customPreview
                    if (bmp != null) {
                        androidx.compose.foundation.Image(
                            bitmap = remember(bmp) { bmp.asImageBitmap() },
                            contentDescription = null,
                            contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                            modifier = Modifier.size(50.dp).clip(CircleShape),
                        )
                    } else {
                        BotFace(color = "white", size = 50.dp, life = FaceLife.STILL, style = avatarStyle)
                    }
                    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(
                            text = "自定义 Luna 肖像",
                            fontSize = 15.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = minisInk,
                        )
                        Text(
                            text = if (customLunaPath != null) "已启用相册照片 · 点击更换" else "像 Muse 一样从相册选一张真人/插画照片",
                            fontSize = 12.sp,
                            color = secondaryTint,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    if (customLunaPath != null) {
                        TextButton(
                            onClick = {
                                haptics.play(HapticCue.SELECT)
                                environment.chatPreferences.setCustomLunaAvatarPath(null)
                            },
                        ) {
                            Text("恢复", fontSize = 13.sp, color = minisAccent)
                        }
                    }
                }
                BotAvatarStyle.entries.chunked(2).forEach { pair ->
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        pair.forEach { option ->
                            val selected = option == avatarStyle
                            val cardShape = RoundedCornerShape(20.dp)
                            Column(
                                modifier = Modifier
                                    .weight(1f)
                                    .clip(cardShape)
                                    .background(minisCard)
                                    .border(
                                        width = if (selected) 1.5.dp else 0.5.dp,
                                        color = if (selected) minisAccent else minisSeparator.copy(alpha = 0.5f),
                                        shape = cardShape,
                                    )
                                    .clickable(role = Role.Button) {
                                        haptics.play(HapticCue.SELECT)
                                        environment.chatPreferences.setAvatarStyle(option)
                                    }
                                    .padding(horizontal = 12.dp, vertical = 14.dp),
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Row(
                                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                                    verticalAlignment = Alignment.Bottom,
                                ) {
                                    BotFace(
                                        color = "blue",
                                        size = 22.dp,
                                        life = FaceLife.STILL,
                                        style = option,
                                    )
                                    BotFace(
                                        color = "white",
                                        size = 50.dp,
                                        life = FaceLife.ALIVE,
                                        crown = true,
                                        seed = option.ordinal * 37,
                                        style = option,
                                    )
                                    BotFace(
                                        color = "orange",
                                        size = 22.dp,
                                        life = FaceLife.STILL,
                                        style = option,
                                    )
                                }
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                                ) {
                                    Text(
                                        text = avatarStyleLabel(option),
                                        fontSize = 14.sp,
                                        fontWeight = FontWeight.SemiBold,
                                        color = minisInk,
                                    )
                                    if (selected) {
                                        Icon(
                                            imageVector = Icons.Filled.Check,
                                            contentDescription = null,
                                            tint = minisAccent,
                                            modifier = Modifier.size(15.dp),
                                        )
                                    }
                                }
                                Text(
                                    text = avatarStyleCaption(option),
                                    fontSize = 11.5.sp,
                                    color = secondaryTint,
                                    textAlign = TextAlign.Center,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                }
                SettingsFootnote("切换后会实时应用到主页、聊天页与所有协作助手，并保留呼吸、眨眼等微动效。")
            }
        }
    }

    if (choosingActivity) {
        SettingsSheet(title = "活动详情", onDismiss = { choosingActivity = false }) {
            Column(Modifier.padding(horizontal = 16.dp)) {
                SettingsSection {
                    ActivityDetail.entries.forEachIndexed { index, detail ->
                        if (index > 0) SettingsDivider()
                        SettingsRow(
                            title = detail.label,
                            subtitle = detail.caption,
                            trailing = {
                                if (detail == activityDetail) {
                                    Icon(
                                        imageVector = Icons.Filled.Check,
                                        contentDescription = null,
                                        tint = minisAccent,
                                        modifier = Modifier.size(18.dp),
                                    )
                                }
                            },
                            onClick = {
                                environment.chatPreferences.setActivityDetail(detail)
                                choosingActivity = false
                            },
                        )
                    }
                }
            }
        }
    }

    if (choosingVoiceAsr) {
        val modelProgress by environment.speechModels.progress.collectAsState()
        var modelReady by remember { mutableStateOf(environment.speechModels.isReady()) }
        var modelFailed by remember { mutableStateOf(false) }
        // A finished download flips the flow back to null; re-read the files.
        LaunchedEffect(modelProgress) {
            if (modelProgress == null) modelReady = environment.speechModels.isReady()
        }
        SettingsSheet(title = "语音消息转文字", onDismiss = { choosingVoiceAsr = false }) {
            Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                SettingsSection {
                    VoiceAsrMode.entries.forEachIndexed { index, mode ->
                        if (index > 0) SettingsDivider()
                        SettingsRow(
                            title = voiceAsrLabel(mode),
                            subtitle = voiceAsrCaption(mode),
                            trailing = {
                                if (mode == voiceAsrMode) {
                                    Icon(
                                        imageVector = Icons.Filled.Check,
                                        contentDescription = null,
                                        tint = minisAccent,
                                        modifier = Modifier.size(18.dp),
                                    )
                                }
                            },
                            onClick = { environment.chatPreferences.setVoiceAsrMode(mode) },
                        )
                    }
                }
                if (voiceAsrMode == VoiceAsrMode.DEVICE) {
                    // App scope: leaving the sheet must not cancel the download.
                    SettingsSection(
                        footer = if (modelFailed) {
                            { SettingsFootnote("模型下载失败，请检查网络后重试。") }
                        } else {
                            null
                        },
                    ) {
                        SettingsRow(
                            title = when {
                                modelReady -> "端侧识别模型已就绪"
                                modelProgress != null -> "正在下载模型"
                                else -> "下载端侧识别模型（约 25 MB）"
                            },
                            value = modelProgress?.let { "${(it * 100).toInt()}%" },
                            onClick = if (modelReady || modelProgress != null) {
                                null
                            } else {
                                {
                                    environment.appScope.launch {
                                        modelFailed = !environment.speechModels.ensure()
                                    }
                                }
                            },
                        )
                    }
                }
            }
        }
    }

    if (choosingPhonePace) {
        SettingsSheet(
            title = stringResource(R.string.settings_phone_pace),
            onDismiss = { choosingPhonePace = false },
        ) {
            Column(Modifier.padding(horizontal = 16.dp)) {
                SettingsSection(
                    footer = { SettingsFootnote(stringResource(R.string.settings_phone_pace_footnote)) },
                ) {
                    PhonePace.entries.forEachIndexed { index, pace ->
                        if (index > 0) SettingsDivider()
                        SettingsRow(
                            title = phonePaceLabel(pace),
                            subtitle = phonePaceCaption(pace),
                            trailing = {
                                if (pace == phonePace) {
                                    Icon(
                                        imageVector = Icons.Filled.Check,
                                        contentDescription = null,
                                        tint = minisAccent,
                                        modifier = Modifier.size(18.dp),
                                    )
                                }
                            },
                            onClick = {
                                environment.chatPreferences.setPhonePace(pace)
                                choosingPhonePace = false
                            },
                        )
                    }
                }
            }
        }
    }

    if (watchingScreen) {
        ControlledScreenSheet(onDismiss = { watchingScreen = false })
    }

    if (pickingNoticeApps) {
        // Read once per open: the launcher list is the honest "apps that post"
        // set and re-querying per recomposition is a Binder round-trip each.
        val manager = LocalContext.current.packageManager
        val choices: List<Pair<String, String>> = remember {
            runCatching {
                manager.getInstalledApplications(0)
                    .filter { manager.getLaunchIntentForPackage(it.packageName) != null }
                    .map { manager.getApplicationLabel(it).toString() to it.packageName }
                    .sortedWith(compareBy({ it.first.lowercase() }, { it.second }))
            }.getOrDefault(emptyList())
        }
        SettingsSheet(
            title = "分享哪些应用的通知",
            onDismiss = { pickingNoticeApps = false },
        ) {
            Column(Modifier.padding(horizontal = 16.dp)) {
                SettingsSection(
                    footer = {
                        SettingsFootnote("勾选应用收到的通知内容会发送到电脑；验证码等敏感内容会被过滤。取消勾选即停止该应用的分享。")
                    },
                ) {
                    choices.forEachIndexed { index, (label, pkg) ->
                        if (index > 0) SettingsDivider()
                        SettingsSwitchRow(
                            title = label,
                            checked = pkg in phoneNoticeApps,
                            onCheckedChange = { on ->
                                environment.chatPreferences.setPhoneNoticeApps(
                                    if (on) phoneNoticeApps + pkg else phoneNoticeApps - pkg,
                                )
                            },
                        )
                    }
                }
            }
        }
    }

    phoneUiCheckReport?.let { report ->
        SettingsSheet(
            title = stringResource(R.string.settings_phone_self_check_title),
            onDismiss = { phoneUiCheckReport = null },
        ) {
            Column(Modifier.padding(horizontal = 16.dp)) {
                SettingsSection(
                    footer = {
                        // The row details stay English on purpose: they are the
                        // tokens a developer greps for. Say so, so a Chinese
                        // reader does not take them for an untranslated screen.
                        SettingsFootnote("破折号后是技术细节，方便复制反馈；检查项和结论已译为中文。")
                    },
                ) {
                    SelectionContainer {
                        Column(
                            modifier = Modifier.padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Text(
                                text = selfCheckSummary(report),
                                fontSize = 12.sp,
                                lineHeight = 17.sp,
                                fontFamily = FontFamily.Monospace,
                                color = minisInk,
                            )
                            report.rows.forEach { row ->
                                Text(
                                    text = selfCheckLine(row),
                                    fontSize = 12.sp,
                                    lineHeight = 17.sp,
                                    fontFamily = FontFamily.Monospace,
                                    color = secondaryTint,
                                )
                                selfCheckFix(row)?.let { fix ->
                                    Text(
                                        text = "    → $fix",
                                        fontSize = 12.sp,
                                        lineHeight = 17.sp,
                                        color = secondaryTint,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (editingQuickReplies) {
        QuickRepliesEditor(
            preferences = environment.chatPreferences,
            onDismiss = { editingQuickReplies = false },
        )
    }

    if (pairingPhoneUi) {
        PhoneUiPairingSheet(
            phoneUi = environment.phoneUi,
            status = phoneUiStatus,
            onDismiss = { pairingPhoneUi = false },
        )
    }

    if (signingIn) {
        DexSignInSheet(
            account = environment.cloudAccount,
            ui = accountUi,
            onDismiss = { signingIn = false },
        )
    }
}

private fun cloudStatusText(status: String): String = when (status) {
    "ready" -> "已就绪"
    "setting_up" -> "正在创建"
    "offline" -> "离线"
    "stopped" -> "已睡眠"
    else -> status
}

private fun phoneUiStatusLabel(status: PhoneUiStatus): String = when (status) {
    PhoneUiStatus.Disabled -> "已关闭"
    PhoneUiStatus.UnsupportedAndroidVersion -> "此 Android 版本不支持隔离屏幕操作"
    PhoneUiStatus.NeedsDeveloperOptions -> "需开启开发者选项"
    PhoneUiStatus.NeedsWirelessDebugging -> "需开启无线调试"
    PhoneUiStatus.NeedsLocalNetworkPermission -> "需允许附近设备和本地网络"
    PhoneUiStatus.NeedsAccessibility -> "需启用屏幕读取服务"
    PhoneUiStatus.NotPaired -> "未配对"
    PhoneUiStatus.Pairing -> "正在配对"
    PhoneUiStatus.Paired -> "已配对，等待连接"
    PhoneUiStatus.HelperConnecting -> "正在连接辅助进程"
    PhoneUiStatus.Ready -> "已就绪"
    PhoneUiStatus.Failed -> "连接失败"
}

/** A granted folder's own name, without the provider plumbing in the URI. */
private fun treeLabel(stored: String): String =
    android.net.Uri.decode(stored)
        .substringAfterLast("/tree/")
        .substringAfterLast(':')
        .ifEmpty { "已授权" }

private fun openDeveloperOptions(context: Context) {
    runCatching {
        context.startActivity(
            Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}

private fun openAccessibilitySettings(context: Context) {
    val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { context.startActivity(intent) }
}

/** The wireless-debugging page has no public Settings constant: use its component, with developer options as fallback. */
private fun openWirelessDebugging(context: Context) {
    val page = runCatching {
        Intent()
            .setClassName("com.android.settings", "com.android.settings.Settings\$WirelessDebuggingActivity")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }.getOrNull()
    if (page != null && runCatching { context.startActivity(page) }.isSuccess) return
    openDeveloperOptions(context)
}

/**
 * Enter the port and six-digit code the system pairing dialog shows. No deep
 * link: the person walks to the system page themselves and comes back here.
 */
@Composable
private fun PhoneUiPairingSheet(
    phoneUi: com.lunabot.companion.phoneui.PhoneUiController,
    status: PhoneUiStatus,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val autoPairing by phoneUi.autoPairing.collectAsState()
    val notificationsBlocked = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
        PackageManager.PERMISSION_GRANTED
    var port by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    // The controller moves past Pairing exactly once pairing succeeded; the
    // sheet then closes itself like the sign-in sheet does.
    LaunchedEffect(status) {
        if (status != PhoneUiStatus.Pairing &&
            status != PhoneUiStatus.Failed &&
            status != PhoneUiStatus.NotPaired
        ) {
            onDismiss()
        }
    }
    val ready = PhoneUiPairingInput.parse(port, code) != null && status != PhoneUiStatus.Pairing
    SettingsSheet(
        title = "配对无线调试",
        onDismiss = onDismiss,
        actionLabel = "配对",
        actionEnabled = ready,
        onAction = { phoneUi.pair(port, code) },
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                "在系统「开发者选项 → 无线调试」中开启无线调试，选择「使用配对码配对设备」，" +
                    "把显示的端口和 6 位配对码填到下面。",
                fontSize = 12.sp,
                lineHeight = 17.sp,
                color = secondaryTint,
            )
            Text(
                "小米等系统上，离开系统配对页就会关闭配对端口。打开系统页面后，开启屏幕读取服务时" +
                    " App 会自动读取配对码并配对；也可以展开通知栏里的「配对无线调试」通知手动输入。",
                fontSize = 12.sp,
                lineHeight = 17.sp,
                color = secondaryTint,
            )
            if (autoPairing) {
                Text(
                    "正在自动读取系统配对窗口里的配对码……保持「输入配对码配对设备」对话框打开即可。",
                    fontSize = 12.sp,
                    lineHeight = 17.sp,
                    color = secondaryTint,
                )
            }
            SettingsRow(
                title = "打开系统无线调试页面",
                external = true,
                onClick = {
                    // Both happen before leaving: on MIUI the pairing port closes
                    // as soon as this app is foreground again, and auto-read
                    // must already be watching when the dialog appears.
                    phoneUi.showPairingNotification()
                    phoneUi.beginAutoPairing()
                    openWirelessDebugging(context)
                },
            )
            if (notificationsBlocked) {
                SettingsRow(
                    title = "允许通知（通知栏配对需要）",
                    external = true,
                    onClick = {
                        context.startActivity(
                            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                                .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName),
                        )
                    },
                )
            }
            OutlinedTextField(
                value = port,
                onValueChange = { port = it.filter(Char::isDigit).take(5) },
                singleLine = true,
                label = { Text("配对端口") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = code,
                onValueChange = { code = it.filter(Char::isDigit).take(6) },
                singleLine = true,
                label = { Text("6 位配对码") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth(),
            )
            if (status == PhoneUiStatus.Pairing) {
                SettingsFootnote("正在配对…")
            } else if (status == PhoneUiStatus.Failed) {
                SettingsFootnote("配对失败：配对码每次打开配对窗口都会更换，请重新获取后再试。")
            }
        }
    }
}

/**
 * Email code sign-in as a sheet. It closes itself once the controller reports
 * a session, so the person never has to press "done".
 */
@Composable
private fun DexSignInSheet(
    account: com.lunabot.companion.account.CloudAccountController,
    ui: CloudAccountUi,
    onDismiss: () -> Unit,
) {
    var email by remember { mutableStateOf(ui.codeSentTo.orEmpty()) }
    var code by remember { mutableStateOf("") }
    LaunchedEffect(ui.phase) {
        if (ui.phase == CloudAccountUi.Phase.SIGNED_IN) onDismiss()
    }
    val enteringEmail = ui.codeSentTo == null
    SettingsSheet(
        title = if (enteringEmail) "登录 Cloud 账号" else "输入登录码",
        onDismiss = onDismiss,
        actionLabel = if (enteringEmail) "发送登录码" else "登录",
        actionEnabled = !ui.busy,
        onAction = {
            if (enteringEmail) account.sendCode(email) else account.verify(code)
        },
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (enteringEmail) {
                Text(
                    "用 Cloud 账号的邮箱接收一个 8 位登录码。",
                    fontSize = 12.sp,
                    color = secondaryTint,
                )
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    singleLine = true,
                    label = { Text("邮箱") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                Text(
                    "登录码已发送到 ${ui.codeSentTo}。",
                    fontSize = 12.sp,
                    color = secondaryTint,
                )
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it.filter(Char::isDigit).take(8) },
                    singleLine = true,
                    label = { Text("8 位登录码") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                    modifier = Modifier.fillMaxWidth(),
                )
                TextButton(onClick = { account.sendCode(ui.codeSentTo) }, enabled = !ui.busy) {
                    Text("重新发送", fontSize = 13.sp)
                }
            }
            ui.error?.let { Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.error) }
        }
    }
}

@Composable
private fun SettingsSection(
    label: String? = null,
    footer: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val cardFill = if (minisIsDark()) minisGrouped else Color(0xFFF5F5F3)
    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
        label?.let { SettingsSectionLabel(it) }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(22.dp))
                .background(cardFill),
        ) {
            content()
        }
        footer?.let {
            Column(modifier = Modifier.padding(horizontal = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                it()
            }
        }
    }
}

/** A whisper-soft hairline inside rounded warm-gray cards. */
@Composable
private fun SettingsDivider() {
    HorizontalDivider(
        modifier = Modifier.padding(horizontal = 16.dp),
        thickness = 0.5.dp,
        color = minisSeparator.copy(alpha = 0.22f),
    )
}

/**
 * The one sheet every settings sub-screen uses: a drag handle, a Cancel /
 * title / action bar, and the page's own cards underneath.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsSheet(
    title: String,
    onDismiss: () -> Unit,
    actionLabel: String? = null,
    actionEnabled: Boolean = true,
    onAction: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        containerColor = minisCanvas,
        scrimColor = Color.Black.copy(alpha = 0.20f),
        dragHandle = {
            Box(
                modifier = Modifier
                    .padding(top = 8.dp, bottom = 4.dp)
                    .size(width = 36.dp, height = 4.dp)
                    .clip(CircleShape)
                    .background(minisTertiary),
            )
        },
    ) {
        GlassBackdrop()
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp)) {
                TextButton(
                    onClick = onDismiss,
                    modifier = Modifier.align(Alignment.CenterStart),
                ) {
                    Text("取消")
                }
                Text(
                    text = title,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.align(Alignment.Center),
                )
                if (actionLabel != null && onAction != null) {
                    TextButton(
                        onClick = onAction,
                        enabled = actionEnabled,
                        modifier = Modifier.align(Alignment.CenterEnd),
                    ) {
                        Text(actionLabel)
                    }
                }
            }
            content()
        }
    }
}

@Composable
private fun SettingsSectionLabel(text: String) {
    Text(
        text = text,
        fontSize = 13.sp,
        fontWeight = FontWeight.Medium,
        color = minisSecondary,
        modifier = Modifier.padding(horizontal = 6.dp).semantics { heading() },
    )
}

@Composable
private fun SettingsRow(
    title: String,
    subtitle: String? = null,
    value: String? = null,
    valueColor: Color = secondaryTint,
    titleColor: Color? = null,
    destructive: Boolean = false,
    enabled: Boolean = true,
    chevron: Boolean = false,
    /** A row that leaves the app, drawn with the open-in-new glyph. */
    external: Boolean = false,
    trailing: (@Composable () -> Unit)? = null,
    onClick: (() -> Unit)? = null,
) {
    val tone = when {
        !enabled -> minisTertiary
        destructive -> minisDanger
        titleColor != null -> titleColor
        else -> minisInk
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(
                if (onClick != null) {
                    Modifier.clickable(enabled = enabled, role = Role.Button, onClick = onClick)
                } else {
                    Modifier
                },
            )
            .heightIn(min = if (subtitle == null) 50.dp else 58.dp)
            .padding(horizontal = 16.dp, vertical = if (subtitle == null) 0.dp else 9.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text = title,
                fontSize = 15.sp,
                color = tone,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            subtitle?.let {
                Text(
                    text = it,
                    fontSize = 12.sp,
                    lineHeight = 16.sp,
                    color = secondaryTint,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        value?.let {
            Text(
                text = it,
                fontSize = 13.sp,
                textAlign = TextAlign.End,
                color = valueColor,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 200.dp),
            )
        }
        trailing?.invoke()
        if (external) {
            Icon(
                painter = painterResource(R.drawable.ic_open_in_new_line),
                contentDescription = null,
                tint = minisTertiary,
                modifier = Modifier.size(13.dp),
            )
        } else if (chevron) {
            Icon(
                imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = minisTertiary,
                modifier = Modifier.size(14.dp),
            )
        }
    }
}

/**
 * The identity row at the top: a disc, the name, one state line, and a
 * chevron when the row opens something.
 */
@Composable
private fun IdentityRow(
    title: String,
    subtitle: String,
    statusColor: Color,
    onClick: (() -> Unit)? = null,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(
                if (onClick != null) {
                    Modifier.clickable(
                        role = Role.Button,
                        onClickLabel = "编辑地址",
                        onClick = onClick,
                    )
                } else {
                    Modifier
                },
            )
            .heightIn(min = 64.dp)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
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
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text(
                text = title,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                color = minisInk,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Row(
                horizontalArrangement = Arrangement.spacedBy(5.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .size(6.dp)
                        .clip(CircleShape)
                        .background(statusColor),
                )
                Text(
                    text = subtitle,
                    fontSize = 12.sp,
                    color = secondaryTint,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (onClick != null) {
            Icon(
                imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = minisTertiary,
                modifier = Modifier.size(14.dp),
            )
        }
    }
}

/**
 * The address as a row like any other: title, shortened value, copy, and a
 * chevron that unfolds the full one.
 */
@Composable
private fun AddressRow(
    address: String,
    expanded: Boolean,
    copied: Boolean,
    onToggle: () -> Unit,
    onCopy: () -> Unit,
) {
    Column(Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(
                    role = Role.Button,
                    onClickLabel = if (expanded) "隐藏完整地址" else "显示完整地址",
                    onClick = onToggle,
                )
                .heightIn(min = 50.dp)
                .padding(horizontal = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("地址", fontSize = 15.sp, color = minisInk)
            Text(
                text = shortenedAddress(address),
                fontSize = 13.sp,
                fontFamily = FontFamily.Monospace,
                color = secondaryTint,
                textAlign = TextAlign.End,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Box(
                modifier = Modifier
                    .heightIn(min = 36.dp)
                    .wrapContentHeight(Alignment.CenterVertically)
                    .clip(CircleShape)
                    .background(minisCard)
                    .clickable(role = Role.Button, onClick = onCopy)
                    .padding(horizontal = 10.dp, vertical = 4.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = if (copied) "已复制" else "复制",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    color = minisInk,
                )
            }
            Icon(
                imageVector = if (expanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                contentDescription = null,
                tint = minisTertiary,
                modifier = Modifier.size(14.dp),
            )
        }
        if (expanded) {
            // Selectable, because the reason to show it in full is to take it away.
            SelectionContainer {
                Text(
                    text = wrapAddress(address),
                    fontSize = 12.sp,
                    lineHeight = 17.sp,
                    fontFamily = FontFamily.Monospace,
                    color = secondaryTint,
                    modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp),
                )
            }
        }
    }
}

@Composable
private fun connectionColor(status: Session.Status): Color = when (status) {
    Session.Status.Live -> minisSuccess
    Session.Status.Connecting -> minisWarning
    // Unpaired is not an error, but a 30% dot disappears on a white row.
    Session.Status.Unpaired -> secondaryTint
    Session.Status.Unauthorized, Session.Status.OutdatedApp -> minisDanger
    is Session.Status.Offline -> minisWarning
}

@Composable
private fun SettingsSwitchRow(
    title: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    subtitle: String? = null,
    enabled: Boolean = true,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            // The whole row is the switch: one semantics node, and a tap
            // anywhere changes it once. The switch itself is display-only, so
            // TalkBack does not announce a second control inside the first.
            .toggleable(
                value = checked,
                enabled = enabled,
                role = Role.Switch,
                onValueChange = onCheckedChange,
            )
            .heightIn(min = if (subtitle == null) 50.dp else 58.dp)
            .padding(horizontal = 16.dp, vertical = if (subtitle == null) 0.dp else 9.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text = title,
                fontSize = 15.sp,
                color = if (enabled) minisInk else minisTertiary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            subtitle?.let {
                Text(
                    text = it,
                    fontSize = 12.sp,
                    lineHeight = 16.sp,
                    color = secondaryTint,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        val dark = minisIsDark()
        Switch(
            checked = checked,
            onCheckedChange = null,
            enabled = enabled,
            colors = SwitchDefaults.colors(
                checkedThumbColor = minisCanvas,
                checkedTrackColor = minisInk,
                checkedBorderColor = Color.Transparent,
                uncheckedThumbColor = if (dark) Color(0xFFB5B5B8) else Color.White,
                uncheckedTrackColor = if (dark) Color(0xFF3A3A3D) else Color(0xFFDCDCD9),
                uncheckedBorderColor = Color.Transparent,
            ),
            modifier = Modifier
                .scale(0.80f)
                .clearAndSetSemantics {},
        )
    }
}

@Composable
private fun SettingsFootnote(text: String) {
    Text(
        text = text,
        fontSize = 12.sp,
        lineHeight = 17.sp,
        color = secondaryTint,
        modifier = Modifier.fillMaxWidth(),
    )
}

/** The app's own sign-off at the foot of the sheet: mark, name, version. */
@Composable
private fun BrandBlock(version: String) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 12.dp, bottom = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        LunaBotMark(56.dp)
        Text("Luna Bot", fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = minisInk)
        Text(
            text = version,
            fontSize = 12.sp,
            color = secondaryTint,
        )
    }
}

private fun themeLabel(mode: ThemeMode): String = when (mode) {
    ThemeMode.SYSTEM -> "跟随系统"
    ThemeMode.LIGHT -> "浅色"
    ThemeMode.DARK -> "深色"
}

private fun avatarStyleLabel(style: BotAvatarStyle): String = when (style) {
    BotAvatarStyle.ORB -> "琉璃月灵"
    BotAvatarStyle.NEKO -> "折耳瓷猫"
    BotAvatarStyle.LIQUID -> "极光液滴"
    BotAvatarStyle.SYNTH -> "复古掌机"
    BotAvatarStyle.SPIRIT -> "星月软团"
    BotAvatarStyle.MINIBOT -> "陶瓷微机"
    BotAvatarStyle.CLASSIC -> "经典极简"
}

private fun avatarStyleCaption(style: BotAvatarStyle): String = when (style) {
    BotAvatarStyle.ORB -> "温润琉璃球 · 流金皇冠"
    BotAvatarStyle.NEKO -> "哑光白瓷猫耳 · 微动耳尖"
    BotAvatarStyle.LIQUID -> "半透蛋白石 · 虹彩折射"
    BotAvatarStyle.SYNTH -> "工业小方块 · 点阵表情"
    BotAvatarStyle.SPIRIT -> "软萌小精灵 · 悬浮星月"
    BotAvatarStyle.MINIBOT -> "磨砂微机 · 发光面罩"
    BotAvatarStyle.CLASSIC -> "原始极简圆球"
}

private fun voiceAsrLabel(mode: VoiceAsrMode): String = when (mode) {
    VoiceAsrMode.OFF -> "关闭"
    VoiceAsrMode.DEVICE -> "手机端侧"
    VoiceAsrMode.ONLINE -> "电脑在线"
}

private fun voiceAsrCaption(mode: VoiceAsrMode): String? = when (mode) {
    VoiceAsrMode.OFF -> null
    VoiceAsrMode.DEVICE -> "识别在手机上完成，需先下载模型"
    VoiceAsrMode.ONLINE -> "识别在电脑上完成"
}

@Composable
private fun phonePaceLabel(pace: PhonePace): String = stringResource(
    when (pace) {
        PhonePace.FAST -> R.string.settings_phone_pace_fast
        PhonePace.STANDARD -> R.string.settings_phone_pace_standard
        PhonePace.HUMAN -> R.string.settings_phone_pace_human
    },
)

/** Each level says what it costs; the footnote under the sheet says why anyone would pick a slower one. */
@Composable
private fun phonePaceCaption(pace: PhonePace): String = stringResource(
    when (pace) {
        PhonePace.FAST -> R.string.settings_phone_pace_fast_caption
        PhonePace.STANDARD -> R.string.settings_phone_pace_standard_caption
        PhonePace.HUMAN -> R.string.settings_phone_pace_human_caption
    },
)

/** The right-hand status of the one update row. */
private fun updateStatusText(state: UpdateState): String = when (state) {
    UpdateState.Idle -> "检查"
    UpdateState.Checking -> ""
    is UpdateState.UpToDate -> "已是最新"
    is UpdateState.Available -> "可更新至 ${state.info.versionName}"
    is UpdateState.Downloading -> state.progress?.let { "${(it * 100).toInt()}%" } ?: "下载中"
    is UpdateState.Ready -> "点此安装"
    is UpdateState.Failed -> "重试"
}

private const val ADDRESS_CLIP_LABEL = "Luna Bot 电脑地址"

/** Long enough for "Copied" to be read, short enough not to linger (iOS `:363-367`). */
private const val COPIED_LABEL_MILLIS = 2_000L

/**
 * The explanation under the identity card, which changes with the connection
 * state — the port of `ConnectionSecurityView.troubleshootingText`
 * (`ios/App/SettingsView.swift:445-458`).
 */
internal fun troubleshootingText(status: Session.Status): String = when (status) {
    Session.Status.Live -> "此电脑已连接且响应正常。"
    Session.Status.Connecting -> "Luna Bot 正在自动尝试已保存的连接。"
    Session.Status.Unauthorized -> "此手机已从电脑移除，请重新配对以恢复连接。"
    Session.Status.OutdatedApp -> "电脑已改用加密连接。请更新手机上的 Luna Bot 应用，然后重新打开它。"
    Session.Status.Unpaired -> "此手机尚未与电脑配对。"
    is Session.Status.Offline ->
        // The identity subtitle is one line and ellipsized; a failure that
        // has a next step says it here, where there is room for it.
        listOfNotNull(status.message, status.hint).joinToString("\n")
}

/**
 * The address with its middle taken out, so a long tailnet name still shows the
 * host and the port it ends in — `shortened` in `ios/App/SettingsView.swift:460-464`.
 */
internal fun shortenedAddress(address: String): String {
    if (address.length <= 14) return address
    val leading = minOf(20, maxOf(8, address.length - 8))
    return address.take(leading) + "…" + address.takeLast(6)
}

/**
 * The full address with zero-width break opportunities inside runs the line
 * breaker will not split by itself.
 *
 * ICU finds a break after "/" and around ".", and none inside the 32-character
 * relay label between them. That made the expanded row draw "https://c" on a
 * line of its own and the label overflowing to the next two — three lines that
 * read as a layout accident rather than one address. The invisible breaks cost
 * nothing to look at, and 复制 still copies [address] itself.
 */
internal fun wrapAddress(address: String): String {
    if (address.length <= ADDRESS_WRAP_RUN) return address
    val out = StringBuilder(address.length + address.length / ADDRESS_WRAP_RUN)
    var run = 0
    for (char in address) {
        out.append(char)
        if (char in "/.-:_") {
            run = 0
            continue
        }
        run++
        if (run == ADDRESS_WRAP_RUN) {
            out.append('\u200B')
            run = 0
        }
    }
    return out.toString()
}

/** Long enough to keep a host readable, short enough to fit a phone line. */
private const val ADDRESS_WRAP_RUN = 16

private fun notificationListenerGranted(context: Context): Boolean =
    NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.packageName)

/**
 * The live, read-only view of the controlled display the task executor holds.
 * Frames are pulled from the session's own ImageReader mirror, so watching
 * never touches the display and never extends its idle lifetime; opened while
 * no task is running, the sheet just shows the empty state.
 */
@Composable
private fun ControlledScreenSheet(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val display by PhoneUiMirror.display.collectAsState()
    val helper by PhoneUiShellBridge.of(context).shell.collectAsState()
    val live = display?.takeIf { helper != null }
    SettingsSheet(title = "受控屏", onDismiss = onDismiss) {
        if (live == null) {
            Text(
                text = "现在没有受控屏会话。智能体开始操作手机界面后，这里会显示它的画面。",
                fontSize = 14.sp,
                color = secondaryTint,
                modifier = Modifier.padding(horizontal = 16.dp),
            )
        } else {
            val imageRef = remember { arrayOfNulls<ImageView>(1) }
            LaunchedEffect(live) {
                val target = imageRef[0] ?: return@LaunchedEffect
                var shown: Bitmap? = null
                try {
                    while (isActive) {
                        val frame = withContext(Dispatchers.IO) { live.capture(FRAME_WAIT_MS) }
                        if (frame != null) {
                            target.setImageBitmap(frame)
                            shown?.recycle()
                            shown = frame
                        }
                        delay(FRAME_INTERVAL_MS)
                    }
                } finally {
                    // The ImageView outlives the loop on a session swap: drop
                    // its reference before recycling the frame it drew.
                    target.setImageBitmap(null)
                    shown?.recycle()
                }
            }
            AndroidView(
                factory = { viewContext ->
                    ImageView(viewContext).apply { scaleType = ImageView.ScaleType.FIT_CENTER }
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .aspectRatio(live.width.toFloat() / live.height.toFloat()),
                update = { imageRef[0] = it },
            )
        }
    }
}

private const val FRAME_WAIT_MS = 500L
private const val FRAME_INTERVAL_MS = 330L
