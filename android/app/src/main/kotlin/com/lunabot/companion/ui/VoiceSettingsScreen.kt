package com.lunabot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.core.ConfigStatus
import com.lunabot.companion.core.VoiceProvider
import kotlinx.coroutines.launch

/** What Settings → Voice says and offers — the decisions of `ios/App/VoiceSettingsView.swift`. */
object VoiceSettingsRules {
    const val HEADER: String = "通话与语音回复"
    const val HEADER_FOOTER: String = "通话使用你在电脑上设置的语音。每个智能体的语音均在其个人资料中选择。"
    const val SYSTEM_NOTE: String = "此电脑正在使用内置系统语音。切换到 ElevenLabs 后即可在此配置密钥。"
    const val KEY_FOOTER: String =
        "密钥将在你的电脑上进行验证和存储，绝不会保存在此手机上。请前往 elevenlabs.io → Settings → API Keys 获取密钥。"
    const val SAVED: String = "密钥已保存，通话功能已就绪。"
    const val REMOVED: String = "密钥已移除。"

    fun statusText(status: ConfigStatus?): String? = status?.let { if (it.isTTSConfigured) "已就绪" else "未设置" }

    fun usesSystemVoices(status: ConfigStatus?): Boolean = status?.voiceProvider == VoiceProvider.SYSTEM

    /** The key section is drawn only under ElevenLabs; the built-in engine has no key to enter. */
    fun showsKeyField(status: ConfigStatus?): Boolean = !usesSystemVoices(status)

    fun saveLabel(status: ConfigStatus?): String = if (status?.isTTSConfigured == true) "替换密钥" else "保存密钥"

    fun canSave(key: String, saving: Boolean): Boolean = !saving && key.isNotBlank()

    fun canRemove(status: ConfigStatus?, saving: Boolean): Boolean = !saving && status?.isTTSConfigured == true
}

/**
 * Voice: the key that lets a bot talk, set from the phone — styled in Muse
 * pure-white gallery canvas + borderless warm-gray grouped cards.
 */
@Composable
fun VoiceSettingsScreen(onBack: () -> Unit) {
    val session = LocalCompanion.current.session
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf<ConfigStatus?>(null) }
    var loadFailed by remember { mutableStateOf(false) }
    var key by rememberSaveable { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var messageIsError by remember { mutableStateOf(false) }

    suspend fun refresh() {
        val loaded = session.configStatus()
        status = loaded
        loadFailed = loaded == null
    }

    LaunchedEffect(Unit) { refresh() }

    fun run(action: suspend () -> String?, success: String?) {
        scope.launch {
            saving = true
            message = null
            try {
                val error = action()
                if (error != null) {
                    message = error
                    messageIsError = true
                    return@launch
                }
                message = success
                messageIsError = false
                refresh()
            } finally {
                saving = false
            }
        }
    }

    val cardFill = if (minisIsDark()) minisGrouped else Color(0xFFF5F5F3)

    Column(modifier = Modifier.fillMaxSize().background(minisCanvas)) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            TouchTarget(
                onClick = onBack,
                contentDescription = "返回",
                modifier = Modifier.align(Alignment.CenterStart),
            ) {
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
                text = "语音",
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                color = minisInk,
                modifier = Modifier.align(Alignment.Center),
            )
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding()
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                Text(
                    text = VoiceSettingsRules.HEADER,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    color = minisSecondary,
                    modifier = Modifier.padding(horizontal = 6.dp),
                )
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(22.dp))
                        .background(cardFill),
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 54.dp)
                            .padding(horizontal = 16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("状态", fontSize = 15.5.sp, fontWeight = FontWeight.Medium, color = minisInk, modifier = Modifier.weight(1f))
                        val text = VoiceSettingsRules.statusText(status)
                        when {
                            text != null -> Row(
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Box(
                                    modifier = Modifier
                                        .size(7.dp)
                                        .clip(CircleShape)
                                        .background(if (status?.isTTSConfigured == true) minisSuccess else minisTertiary),
                                )
                                Text(
                                    text = text,
                                    fontSize = 14.sp,
                                    color = if (status?.isTTSConfigured == true) minisInk else minisSecondary,
                                )
                            }
                            loadFailed -> Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                Text("暂时无法读取", fontSize = 14.sp, color = minisSecondary)
                                Box(
                                    modifier = Modifier
                                        .clip(CircleShape)
                                        .background(minisCard)
                                        .clickable(role = Role.Button) { scope.launch { refresh() } }
                                        .padding(horizontal = 10.dp, vertical = 4.dp),
                                ) {
                                    Text("重试", fontSize = 12.5.sp, fontWeight = FontWeight.Medium, color = minisInk)
                                }
                            }
                            else -> CircularProgressIndicator(
                                modifier = Modifier.size(16.dp),
                                strokeWidth = 2.dp,
                                color = minisTertiary,
                            )
                        }
                    }
                    if (VoiceSettingsRules.usesSystemVoices(status)) {
                        HorizontalDivider(
                            modifier = Modifier.padding(horizontal = 16.dp),
                            thickness = 0.5.dp,
                            color = minisSeparator.copy(alpha = 0.22f),
                        )
                        Column(
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
                            verticalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            Text(VoiceSettingsRules.SYSTEM_NOTE, fontSize = 13.sp, lineHeight = 18.sp, color = minisSecondary)
                            Box(
                                modifier = Modifier
                                    .clip(CircleShape)
                                    .background(minisInk)
                                    .clickable(enabled = !saving, role = Role.Button) {
                                        run({ session.updateVoiceProvider("elevenlabs") }, success = null)
                                    }
                                    .padding(horizontal = 16.dp, vertical = 9.dp),
                            ) {
                                Text("切换到 ElevenLabs", fontSize = 13.5.sp, fontWeight = FontWeight.Medium, color = minisCanvas)
                            }
                        }
                    }
                }
                Text(
                    text = VoiceSettingsRules.HEADER_FOOTER,
                    fontSize = 12.5.sp,
                    lineHeight = 17.sp,
                    color = minisSecondary,
                    modifier = Modifier.padding(horizontal = 6.dp),
                )
            }

            if (VoiceSettingsRules.showsKeyField(status)) {
                Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                    Text(
                        text = "ElevenLabs",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium,
                        color = minisSecondary,
                        modifier = Modifier.padding(horizontal = 6.dp),
                    )
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(22.dp))
                            .background(cardFill)
                            .padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(14.dp))
                                .background(minisCard)
                                .padding(horizontal = 14.dp, vertical = 13.dp),
                        ) {
                            if (key.isEmpty()) {
                                Text("ElevenLabs API 密钥", fontSize = 15.sp, color = minisTertiary)
                            }
                            BasicTextField(
                                value = key,
                                onValueChange = { key = it },
                                singleLine = true,
                                textStyle = TextStyle(fontSize = 15.sp, color = minisInk),
                                cursorBrush = SolidColor(minisInk),
                                visualTransformation = PasswordVisualTransformation(),
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            val canSave = VoiceSettingsRules.canSave(key, saving)
                            Box(
                                modifier = Modifier
                                    .weight(1f)
                                    .heightIn(min = 44.dp)
                                    .clip(CircleShape)
                                    .background(if (canSave) minisInk else minisCard)
                                    .clickable(enabled = canSave, role = Role.Button) {
                                        val entered = key
                                        run(
                                            {
                                                val error = session.updateVoiceKey(entered)
                                                if (error == null) key = ""
                                                error
                                            },
                                            success = VoiceSettingsRules.SAVED,
                                        )
                                    },
                                contentAlignment = Alignment.Center,
                            ) {
                                if (saving) {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(16.dp),
                                        strokeWidth = 2.dp,
                                        color = if (canSave) minisCanvas else minisTertiary,
                                    )
                                } else {
                                    Text(
                                        text = VoiceSettingsRules.saveLabel(status),
                                        fontSize = 14.5.sp,
                                        fontWeight = FontWeight.Medium,
                                        color = if (canSave) minisCanvas else minisTertiary,
                                    )
                                }
                            }
                            if (VoiceSettingsRules.canRemove(status, saving = false)) {
                                Box(
                                    modifier = Modifier
                                        .heightIn(min = 44.dp)
                                        .clip(CircleShape)
                                        .background(minisCard)
                                        .clickable(enabled = !saving, role = Role.Button) {
                                            run({ session.updateVoiceKey("") }, success = VoiceSettingsRules.REMOVED)
                                        }
                                        .padding(horizontal = 16.dp),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text("移除", fontSize = 14.sp, fontWeight = FontWeight.Medium, color = MinisTokens.Danger)
                                }
                            }
                        }
                        message?.let {
                            Text(
                                text = it,
                                fontSize = 13.sp,
                                color = if (messageIsError) MinisTokens.Danger else minisSuccess,
                            )
                        }
                    }
                    Text(
                        text = VoiceSettingsRules.KEY_FOOTER,
                        fontSize = 12.5.sp,
                        lineHeight = 17.sp,
                        color = minisSecondary,
                        modifier = Modifier.padding(horizontal = 6.dp),
                    )
                }
            } else {
                message?.let {
                    Text(
                        text = it,
                        fontSize = 13.sp,
                        color = MinisTokens.Danger,
                        modifier = Modifier.padding(horizontal = 6.dp),
                    )
                }
            }
            Spacer(Modifier.size(8.dp))
        }
    }
}
