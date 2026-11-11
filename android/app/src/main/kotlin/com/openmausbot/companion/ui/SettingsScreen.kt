package com.openmausbot.companion.ui

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.core.ActivityDetail
import com.openmausbot.companion.core.Connection
import com.openmausbot.companion.core.Session
import com.openmausbot.companion.storage.ThemeMode
import com.openmausbot.companion.update.AppUpdater
import com.openmausbot.companion.update.UpdateState
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

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
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboard.current
    val haptics = rememberHaptics()

    var editingAddress by remember { mutableStateOf(false) }
    var addressText by remember { mutableStateOf("") }
    var addressError by remember { mutableStateOf<String?>(null) }
    var showingFullAddress by remember { mutableStateOf(false) }
    var addressCopied by remember { mutableStateOf(false) }
    var reconnecting by remember { mutableStateOf(false) }
    var confirmingUnpair by remember { mutableStateOf(false) }
    var pendingComputerRemoval by remember { mutableStateOf<Connection?>(null) }
    var choosingActivity by remember { mutableStateOf(false) }
    var choosingTheme by remember { mutableStateOf(false) }
    var editingQuickReplies by remember { mutableStateOf(false) }

    Column(modifier = Modifier.fillMaxSize()) {
        // A large title, the way iOS settings reads: the page is the title,
        // not a toolbar with a line under it.
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 6.dp, end = 16.dp, top = 8.dp, bottom = 2.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            HeaderBackButton(onBack)
            Text("设置", fontSize = 22.sp, fontWeight = FontWeight.Bold)
        }

        Column(
            modifier = Modifier
                .verticalScroll(rememberScrollState())
                .padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            SettingsSection("电脑") {
                val bound = connection
                if (bound != null) {
                    val address = SettingsPolicy.addressText(bound)
                    SettingsRow("名称", bound.name)
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
                    // The stored address can simply go stale. Editing it here
                    // keeps the pairing and its token (§7).
                    SettingsButton("编辑地址", chevron = true) {
                        addressText = address
                        addressError = null
                        editingAddress = true
                    }
                } else if (onConnect != null) {
                    SettingsButton("连接电脑", onClick = onConnect)
                }
                SettingsRow("连接状态", SettingsPolicy.statusText(status))
                if (bound != null) {
                    SettingsButton("连接另一台电脑", chevron = true) {
                        haptics.play(TactileAction.CONNECT_ANOTHER_COMPUTER)
                        session.beginPairing()
                    }
                }
            }

            val otherComputers = connections.filter { it.id != connection?.id }
            if (otherComputers.isNotEmpty()) {
                SettingsSection("其他电脑") {
                    otherComputers.forEach { computer ->
                        SettingsButton("使用 ${computer.name}") {
                            haptics.play(TactileAction.SWITCH_COMPUTER)
                            session.switchComputer(computer.id)
                        }
                        SettingsButton("移除 ${computer.name}", destructive = true) {
                            pendingComputerRemoval = computer
                        }
                    }
                    Footnote("每台电脑单独配对。同一时间只有选中的电脑处于活动状态。")
                }
            }

            if (connection != null) {
                SettingsSection("故障排除") {
                    Footnote(troubleshootingText(status))
                    SettingsButton(
                        text = "尝试重新连接",
                        enabled = !reconnecting,
                        trailing = {
                            if (reconnecting) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(16.dp),
                                    strokeWidth = 2.dp,
                                )
                            }
                        },
                    ) {
                        scope.launch {
                            reconnecting = true
                            // Waits until the stream leaves connecting (or 10s),
                            // so the spinner means what it appears to mean.
                            session.refresh()
                            reconnecting = false
                        }
                    }
                }
            }

            SettingsSection("通知") {
                SettingsRow(
                    "状态",
                    NotificationPermissionController.statusText(notifications),
                )
                // Granted is a status, not an action: a disabled "notifications
                // are on" row was a dead control that looked broken.
                if (NotificationPermissionController.buttonEnabled(notifications)) {
                    SettingsButton(
                        text = NotificationPermissionController.buttonText(notifications),
                        onClick = environment.notifications::act,
                    )
                }
                Footnote(SettingsPolicy.NOTIFICATIONS_FOOTER)
            }

            SettingsSection("后台连接") {
                val alwaysOnEnabled by environment.alwaysOnEnabled.collectAsState()
                SettingsSwitchRow(
                    text = "保持后台连接",
                    checked = alwaysOnEnabled,
                    onCheckedChange = { environment.onToggleAlwaysOn() },
                )
                Footnote(
                    if (alwaysOnEnabled) {
                        "已保留一条常驻通知，应用完全关闭后仍能收到定时提醒和例程结果。"
                    } else {
                        "仅在应用打开或刚切入后台时收到通知。依赖定时例程时建议开启。"
                    },
                )
            }

            // Chinese OEM ROMs kill background services far more aggressively
            // than AOSP. The app cannot flip those switches itself, so this is
            // a guided shortcut to the exact system pages instead of a support
            // article the reader has to translate.
            SettingsSection("国产手机保活") {
                val context = androidx.compose.ui.platform.LocalContext.current
                SettingsButton("电池优化白名单") {
                    runCatching {
                        context.startActivity(
                            Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    }
                }
                SettingsButton("自启动与后台管理") {
                    runCatching {
                        context.startActivity(
                            Intent(
                                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                Uri.fromParts("package", context.packageName, null),
                            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    }
                }
                SettingsButton("通知与锁屏显示") {
                    runCatching {
                        context.startActivity(
                            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                                .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    }
                }
                Footnote(
                    "一加 / OPPO / realme：设置 → 电池 → 应用电池管理 → OpenMausBot → 允许后台运行。" +
                        "小米：设置 → 应用设置 → 应用管理 → OpenMausBot → 自启动、省电策略 → 无限制。" +
                        "华为：设置 → 应用 → 应用启动管理 → OpenMausBot → 手动管理，三项全部允许。",
                )
            }

            SettingsSection("外观") {
                SettingsButton(
                    text = "主题",
                    trailing = {
                        Text(themeLabel(themeMode), fontSize = 13.sp, color = minisSecondary)
                    },
                    chevron = true,
                ) { choosingTheme = true }
                Footnote("“深色”会同时切换状态栏和手势栏；“跟随系统”随手机的深色模式变化。")
            }

            SettingsSection("聊天") {
                SettingsButton(
                    text = "活动详情",
                    trailing = {
                        Text(activityDetail.label, fontSize = 13.sp, color = minisSecondary)
                    },
                    chevron = true,
                ) { choosingActivity = true }
                SettingsButton("快捷回复", chevron = true) { editingQuickReplies = true }
            }

            // Routine schedules live on the computer this phone is bound to.
            // With no binding there is nothing to schedule against, so the row
            // is absent rather than present and dead.
            if (onOpenRoutines != null || onOpenConnectedApps != null || onOpenVoice != null) {
                SettingsSection("工作区") {
                    onOpenRoutines?.let { openRoutines ->
                        SettingsButton(text = "会话与例程", chevron = true, onClick = openRoutines)
                    }
                    onOpenConnectedApps?.let { openConnectedApps ->
                        SettingsButton(text = "已连接应用", chevron = true, onClick = openConnectedApps)
                    }
                    onOpenVoice?.let { openVoice ->
                        SettingsButton(text = "语音", chevron = true, onClick = openVoice)
                    }
                    Footnote("例程、连接应用与语音设置保存在电脑端；这里管理手机侧的入口。")
                }
            }

            if (connection != null) {
                SettingsSection(null) {
                    SettingsButton(
                        text = if (connections.size > 1) "移除此电脑" else "取消配对此手机",
                        destructive = true,
                    ) { confirmingUnpair = true }
                    Footnote(SettingsPolicy.UNPAIR_FOOTER)
                }
            }

            // The release channel is phone-only: it downloads a build signed
            // with the same key as this install, so pairing and chat data are
            // untouched. Android still asks for its own install confirmation.
            SettingsSection("关于") {
                val updateState by environment.updates.state.collectAsState()
                val busy = updateState is UpdateState.Checking || updateState is UpdateState.Downloading
                SettingsRow("版本", environment.updates.currentVersionName)
                SettingsButton(
                    text = "软件更新",
                    enabled = !busy,
                    trailing = {
                        if (busy) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(16.dp),
                                strokeWidth = 2.dp,
                            )
                        } else {
                            Text(
                                text = updateStatusText(updateState),
                                fontSize = 14.sp,
                                color = if (
                                    updateState is UpdateState.Available ||
                                    updateState is UpdateState.Ready
                                ) {
                                    minisAccent
                                } else {
                                    minisSecondary
                                },
                            )
                        }
                    },
                ) {
                    when (updateState) {
                        is UpdateState.Available -> environment.updates.download()
                        is UpdateState.Ready -> environment.updates.install()
                        else -> environment.updates.check()
                    }
                }
                // Recovery when the in-app path cannot run: the same page in a
                // browser, where the person can download and install by hand.
                if (updateState is UpdateState.Failed) {
                    val context = LocalContext.current
                    SettingsButton("在浏览器中打开发布页", chevron = true) {
                        runCatching {
                            context.startActivity(
                                Intent(Intent.ACTION_VIEW, Uri.parse(AppUpdater.RELEASE_PAGE))
                                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                            )
                        }
                    }
                }
                Footnote(updateFootnote(updateState))
            }

            SettingsSection("不在此处管理") {
                Footnote(SettingsPolicy.NOT_HERE)
            }
        }
    }

    if (editingAddress) {
        AlertDialog(
            onDismissRequest = { editingAddress = false },
            title = { Text("编辑地址") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(SettingsPolicy.EDIT_ADDRESS_MESSAGE, fontSize = 14.sp)
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
                        modifier = Modifier.fillMaxWidth(),
                    )
                    addressError?.let {
                        Text(it, fontSize = 13.sp, color = MaterialTheme.colorScheme.error)
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        // Session re-parses, re-dials and persists; the walk and
                        // promote semantics stay its job. The form only refuses
                        // what it can already tell is not an address.
                        if (session.updateAddress(addressText)) {
                            editingAddress = false
                        } else {
                            addressError = AddressEdit.INVALID
                        }
                    },
                ) { Text("保存") }
            },
            dismissButton = {
                TextButton(onClick = { editingAddress = false }) { Text("取消") }
            },
        )
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
                        SettingsPolicy.UNPAIR_CONFIRM_MESSAGE
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

    if (choosingTheme) {
        AlertDialog(
            onDismissRequest = { choosingTheme = false },
            title = { Text("主题") },
            text = {
                Column {
                    ThemeMode.entries.forEach { mode ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .selectable(
                                    selected = themeMode == mode,
                                    role = Role.RadioButton,
                                ) {
                                    environment.chatPreferences.setThemeMode(mode)
                                    choosingTheme = false
                                }
                                .padding(vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = themeMode == mode, onClick = null)
                            Text(themeLabel(mode), modifier = Modifier.padding(start = 8.dp))
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = {
                TextButton(onClick = { choosingTheme = false }) { Text("取消") }
            },
        )
    }

    if (choosingActivity) {
        AlertDialog(
            onDismissRequest = { choosingActivity = false },
            title = { Text("活动详情") },
            text = {
                // iOS draws a Picker (SettingsView.swift:67-78), which marks the
                // choice already in force; three plain buttons do not.
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    ActivityDetail.entries.forEach { detail ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = MIN_TOUCH_TARGET)
                                .selectable(
                                    selected = detail == activityDetail,
                                    role = Role.RadioButton,
                                    onClick = {
                                        environment.chatPreferences.setActivityDetail(detail)
                                        choosingActivity = false
                                    },
                                )
                                .padding(vertical = 6.dp),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = detail == activityDetail, onClick = null)
                            Column(modifier = Modifier.weight(1f)) {
                                Text(detail.label, textAlign = TextAlign.Start)
                                Text(detail.caption, fontSize = 12.sp, color = secondaryTint)
                            }
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { choosingActivity = false }) { Text("取消") } },
        )
    }

    if (editingQuickReplies) {
        QuickRepliesEditor(
            preferences = environment.chatPreferences,
            onDismiss = { editingQuickReplies = false },
        )
    }
}

@Composable
private fun SettingsSection(title: String?, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        title?.let {
            Text(
                text = it,
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                color = minisSecondary,
                modifier = Modifier.padding(start = 4.dp),
            )
        }
        // The 1 dp gaps between rows are the separators: every row paints the
        // grouped card colour, and the container behind them is the hairline
        // colour. That keeps every line inset and automatic, without a hand-
        // placed divider after each row (and without one under the last).
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(MinisCardShape)
                .background(minisSeparator),
            verticalArrangement = Arrangement.spacedBy(1.dp),
        ) {
            content()
        }
    }
}

@Composable
private fun SettingsRow(label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(minisGrouped)
            .heightIn(min = 44.dp)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, fontSize = 14.sp, color = minisInk)
        Text(
            text = value,
            fontSize = 13.sp,
            textAlign = TextAlign.End,
            color = minisSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .weight(1f)
                .padding(start = 12.dp),
        )
    }
}

/**
 * The address, short enough to read at a glance and long enough to copy — the
 * port of the connection details in `ios/App/SettingsView.swift:346-371`.
 */
@Composable
private fun AddressRow(
    address: String,
    expanded: Boolean,
    copied: Boolean,
    onToggle: () -> Unit,
    onCopy: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(minisGrouped)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("地址", fontSize = 14.sp, color = minisInk)
            Text(
                text = shortenedAddress(address),
                fontSize = 12.sp,
                fontFamily = FontFamily.Monospace,
                color = minisSecondary,
                textAlign = TextAlign.End,
                maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis,
                modifier = Modifier
                    .weight(1f)
                    .padding(start = 12.dp),
            )
        }
        if (expanded) {
            // Selectable, because the reason to show it in full is to take it away.
            SelectionContainer {
                Text(
                    text = address,
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                    color = minisSecondary,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            // 12 sp links on a 44 dp row: the padding used to be the target,
            // which made these the smallest things on the screen.
            Text(
                text = if (expanded) "隐藏完整地址" else "显示完整地址",
                fontSize = 12.sp,
                color = minisAccent,
                modifier = Modifier
                    .heightIn(min = 44.dp)
                    .wrapContentHeight(Alignment.CenterVertically)
                    .clickable(role = Role.Button, onClick = onToggle)
                    .padding(horizontal = 6.dp),
            )
            Text(
                text = if (copied) "已复制" else "复制",
                fontSize = 12.sp,
                color = minisAccent,
                modifier = Modifier
                    .heightIn(min = 44.dp)
                    .wrapContentHeight(Alignment.CenterVertically)
                    .clickable(role = Role.Button, onClick = onCopy)
                    .padding(horizontal = 6.dp),
            )
        }
    }
}

@Composable
private fun SettingsButton(
    text: String,
    enabled: Boolean = true,
    destructive: Boolean = false,
    /** Drawn at the end of the row — a value, a spinner, or an install label. */
    trailing: (@Composable () -> Unit)? = null,
    /** True for a row that opens another screen or sheet. */
    chevron: Boolean = false,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(minisGrouped)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .heightIn(min = 44.dp)
            .padding(horizontal = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = text,
            fontSize = 14.sp,
            color = when {
                !enabled -> minisTertiary
                destructive -> MaterialTheme.colorScheme.error
                else -> minisInk
            },
            modifier = Modifier.weight(1f),
        )
        trailing?.invoke()
        if (chevron) {
            Icon(
                imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = minisTertiary,
                modifier = Modifier.size(15.dp),
            )
        }
    }
}

/** A labelled switch, for a setting that is on or off rather than an action. */
@Composable
private fun SettingsSwitchRow(
    text: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(minisGrouped)
            .clickable(role = Role.Switch) { onCheckedChange(!checked) }
            .heightIn(min = 44.dp)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, fontSize = 14.sp, color = minisInk, modifier = Modifier.weight(1f))
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
            // Material's switch is drawn for a taller row; at 44 dp it is the
            // one control that still reads as a slab, so it comes down a notch.
            modifier = Modifier.scale(0.82f),
        )
    }
}

@Composable
private fun Footnote(text: String) {
    Text(
        text = text,
        fontSize = 12.sp,
        lineHeight = 16.sp,
        color = minisSecondary,
        modifier = Modifier
            .fillMaxWidth()
            .background(minisGrouped)
            .padding(horizontal = 14.dp, vertical = 10.dp),
    )
}

private fun themeLabel(mode: ThemeMode): String = when (mode) {
    ThemeMode.SYSTEM -> "跟随系统"
    ThemeMode.LIGHT -> "浅色"
    ThemeMode.DARK -> "深色"
}

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

/** The sentence under the update row, which changes with the state. */
private fun updateFootnote(state: UpdateState): String = when (state) {
    is UpdateState.Available -> buildString {
        append("可更新至 ${state.info.versionName}")
        if (state.info.sizeLabel.isNotEmpty()) append("（${state.info.sizeLabel}）")
        state.info.notes?.let { append("：$it") }
    }
    is UpdateState.Downloading ->
        state.progress?.let { "正在下载 ${(it * 100).toInt()}%…" } ?: "正在下载更新…"
    is UpdateState.Ready -> state.hint ?: "下载完成。点上方安装，系统会再确认一次。"
    is UpdateState.Failed -> state.message
    is UpdateState.UpToDate -> "当前已是最新版本。"
    else -> "更新包托管在公开网页；安装时系统会再确认。"
}

private const val ADDRESS_CLIP_LABEL = "OpenMausMobile 电脑地址"

/** Long enough for "Copied" to be read, short enough not to linger (iOS `:363-367`). */
private const val COPIED_LABEL_MILLIS = 2_000L

/**
 * What the Troubleshooting section says before offering to reconnect — the port
 * of `ConnectionSecurityView.troubleshootingText` (`ios/App/SettingsView.swift:445-458`).
 */
internal fun troubleshootingText(status: Session.Status): String = when (status) {
    Session.Status.Live -> "此电脑已连接且响应正常。"
    Session.Status.Connecting -> "OpenMausBot 正在自动尝试已保存的连接。"
    Session.Status.Unauthorized -> "此手机已从电脑移除，请重新配对以恢复连接。"
    Session.Status.OutdatedApp -> "电脑已改用加密连接。请更新手机上的 MausBot 应用，然后重新打开它。"
    Session.Status.Unpaired -> "此手机尚未与电脑配对。"
    is Session.Status.Offline -> status.message
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
