// Adapted from Mika's DeviceUnlockInput and DeviceAccess (Apache-2.0).
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
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.phoneui.PhoneUiController
import com.lunabot.companion.phoneui.UnlockCredential
import com.lunabot.companion.phoneui.UnlockOutcome
import kotlinx.coroutines.launch

/**
 * The unlock credential and the switch that lets a turn use it.
 *
 * The credential is entered here, encrypted on this phone, and used only by the
 * shell helper that types it into the keyguard: it is never sent to the
 * computer, never a job argument, never logged. The two fields below are the
 * platform editor's own buffer and are emptied as soon as the value is handed
 * over.
 */
@Composable
fun UnlockSettingsSection(
    phoneUi: PhoneUiController,
    modifier: Modifier = Modifier,
) {
    val state by phoneUi.unlockState.collectAsState()
    val scope = rememberCoroutineScope()
    var kind by remember { mutableStateOf(UnlockCredential.KIND_PIN) }
    var first by remember { mutableStateOf("") }
    var second by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            text = "手机解锁",
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            letterSpacing = 0.2.sp,
            color = minisInk.copy(alpha = 0.45f),
            modifier = Modifier
                .padding(horizontal = 4.dp)
                .semantics { heading() },
        )
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(MinisCardShape)
                .background(minisCard),
        ) {
            UnlockSwitchRow(
                title = "允许远程解锁",
                subtitle = if (state.configured) {
                    "关闭后，电脑上的对话不能唤醒或解锁这台手机。"
                } else {
                    "先在下面保存锁屏密码，再打开这个开关。"
                },
                checked = state.remoteUnlockEnabled,
                enabled = state.configured && !busy,
                onCheckedChange = { enabled ->
                    scope.launch {
                        busy = true
                        val ok = phoneUi.setRemoteUnlockEnabled(enabled)
                        busy = false
                        message = if (ok) null else "开关没有保存，请重新保存锁屏密码后再试。"
                    }
                },
            )
            UnlockDivider()
            if (state.configured) {
                UnlockRow(
                    title = "锁屏密码已保存在本机",
                    subtitle = if (state.blocked) {
                        "上次解锁没有完成，已暂停自动解锁。重新保存密码可恢复。"
                    } else {
                        "更换或删除请重新输入一次。"
                    },
                    value = if (state.kind == UnlockCredential.KIND_PIN) "PIN" else "密码",
                )
                UnlockDivider()
                UnlockRow(
                    title = "试一次解锁",
                    subtitle = when {
                        !state.remoteUnlockEnabled -> "打开上面的开关后才能试。"
                        state.blocked -> "上次解锁没有完成，重新保存密码后再试。"
                        else -> "把手机锁屏，再用保存的密码解锁一次。"
                    },
                    enabled = state.remoteUnlockEnabled && !state.blocked && !busy,
                    trailing = {
                        if (busy) {
                            CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                        }
                    },
                    onClick = {
                        scope.launch {
                            busy = true
                            val outcome = phoneUi.unlockNow()
                            busy = false
                            message = when (outcome) {
                                UnlockOutcome.Unlocked, UnlockOutcome.AlreadyUnlocked -> "已解锁。"
                                UnlockOutcome.Disabled -> "远程解锁开关是关的，或还没有保存密码。"
                                UnlockOutcome.Blocked -> "上次解锁没有完成，已暂停自动解锁。重新保存密码后再试。"
                                UnlockOutcome.NoHelper -> "手机界面辅助进程没连上，请先确认状态是「已就绪」。"
                                UnlockOutcome.UnsupportedKeyguard -> "这台手机没有可输入的锁屏密码（只有滑动解锁）。"
                                UnlockOutcome.Failed -> "没有解锁成功：请确认保存的是这台手机的锁屏密码。"
                            }
                        }
                    },
                )
                UnlockDivider()
                UnlockRow(
                    title = "删除凭据",
                    subtitle = "同时关闭远程解锁。",
                    destructive = true,
                    enabled = !busy,
                    onClick = {
                        scope.launch {
                            busy = true
                            phoneUi.clearUnlockCredential()
                            busy = false
                            first = ""
                            second = ""
                            message = "已删除。"
                        }
                    },
                )
            } else {
                UnlockRow(
                    title = "类型",
                    value = if (kind == UnlockCredential.KIND_PIN) "PIN" else "密码",
                    subtitle = "点一下切换。PIN 只能有数字。",
                    onClick = {
                        kind = if (kind == UnlockCredential.KIND_PIN) {
                            UnlockCredential.KIND_PASSWORD
                        } else {
                            UnlockCredential.KIND_PIN
                        }
                        first = ""
                        second = ""
                        message = null
                    },
                )
                UnlockDivider()
                Column(
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    MinisSheetField(
                        value = first,
                        onValueChange = { first = it.take(maxLength(kind)) },
                        placeholder = if (kind == UnlockCredential.KIND_PIN) {
                            "锁屏 PIN（4-16 位数字）"
                        } else {
                            "锁屏密码（4-64 位）"
                        },
                        keyboardOptions = KeyboardOptions(keyboardType = keyboardType(kind)),
                        visualTransformation = PasswordVisualTransformation(),
                        label = "锁屏密码",
                    )
                    MinisSheetField(
                        value = second,
                        onValueChange = { second = it.take(maxLength(kind)) },
                        placeholder = "再输入一次",
                        keyboardOptions = KeyboardOptions(keyboardType = keyboardType(kind)),
                        visualTransformation = PasswordVisualTransformation(),
                        label = "再输入一次锁屏密码",
                        isError = second.isNotEmpty() && second != first,
                    )
                    val valid = remember(first, kind) { validValue(kind, first) }
                    TextButton(
                        enabled = valid && first == second && !busy,
                        onClick = {
                            // The CharArray is the only copy handed over; the
                            // store wipes it before returning.
                            val value = first.toCharArray()
                            scope.launch {
                                busy = true
                                val ok = phoneUi.setUnlockCredential(kind, value)
                                busy = false
                                if (ok) {
                                    first = ""
                                    second = ""
                                    message = "已保存在本机。打开「允许远程解锁」后，电脑上的对话才能使用它。"
                                } else {
                                    message = "保存失败：请确认密码符合格式，且这台手机允许安全存储。"
                                }
                            }
                        },
                    ) { Text("保存到本机") }
                }
            }
            message?.let {
                UnlockDivider()
                Text(
                    text = it,
                    fontSize = 12.sp,
                    lineHeight = 17.sp,
                    color = secondaryTint,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                )
            }
        }
        Text(
            text = "这组密码只保存在这台手机上，锁屏时由本机的辅助进程输入；不会发送给电脑，" +
                "也不会写进对话或运行记录。删除凭据即抹掉。",
            fontSize = 12.sp,
            lineHeight = 17.sp,
            color = secondaryTint,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

private fun validValue(kind: Int, text: String): Boolean {
    val probe = text.toCharArray()
    return try {
        UnlockCredential.valid(kind, probe)
    } finally {
        probe.fill('\u0000')
    }
}

private fun maxLength(kind: Int): Int = if (kind == UnlockCredential.KIND_PIN) {
    UnlockCredential.MAX_PIN_DIGITS
} else {
    UnlockCredential.MAX_PASSWORD_CHARS
}

private fun keyboardType(kind: Int): KeyboardType = if (kind == UnlockCredential.KIND_PIN) {
    KeyboardType.NumberPassword
} else {
    KeyboardType.Password
}

@Composable
private fun UnlockSwitchRow(
    title: String,
    subtitle: String?,
    checked: Boolean,
    enabled: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .toggleable(
                value = checked,
                enabled = enabled,
                role = Role.Switch,
                onValueChange = onCheckedChange,
            )
            .heightIn(min = 58.dp)
            .padding(horizontal = 16.dp, vertical = 9.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        UnlockTexts(title = title, subtitle = subtitle, enabled = enabled, modifier = Modifier.weight(1f))
        Switch(
            checked = checked,
            onCheckedChange = null,
            enabled = enabled,
            modifier = Modifier
                .scale(0.82f)
                .clearAndSetSemantics {},
        )
    }
}

@Composable
private fun UnlockRow(
    title: String,
    subtitle: String? = null,
    value: String? = null,
    destructive: Boolean = false,
    enabled: Boolean = true,
    trailing: (@Composable () -> Unit)? = null,
    onClick: (() -> Unit)? = null,
) {
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
        UnlockTexts(
            title = title,
            subtitle = subtitle,
            enabled = enabled,
            modifier = Modifier.weight(1f),
            titleColor = when {
                !enabled -> minisTertiary
                destructive -> minisDanger
                else -> minisInk
            },
        )
        value?.let { Text(text = it, fontSize = 13.sp, color = secondaryTint) }
        trailing?.invoke()
    }
}

@Composable
private fun UnlockTexts(
    title: String,
    subtitle: String?,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    titleColor: androidx.compose.ui.graphics.Color = if (enabled) minisInk else minisTertiary,
) {
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            text = title,
            fontSize = 15.sp,
            color = titleColor,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        subtitle?.let {
            Text(
                text = it,
                fontSize = 12.sp,
                lineHeight = 16.sp,
                color = secondaryTint,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun UnlockDivider() {
    HorizontalDivider(
        modifier = Modifier.padding(horizontal = 16.dp),
        thickness = 0.5.dp,
        color = minisSeparator,
    )
}
