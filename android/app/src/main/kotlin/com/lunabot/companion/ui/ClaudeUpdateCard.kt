package com.lunabot.companion.ui

import android.content.ClipData
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.core.ClaudeUpdateResult
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val UPDATE_COMMAND = "claude update"
private const val UPDATE_CLIP_LABEL = "Claude Code update command"

/** Where the card is. Port of `Phase` in `src/components/ClaudeUpdatePrompt.tsx`. */
sealed interface ClaudeUpdatePhase {
    data object Ask : ClaudeUpdatePhase
    data object Updating : ClaudeUpdatePhase
    data class Updated(val version: String) : ClaudeUpdatePhase
    data object Manual : ClaudeUpdatePhase
    data class Failed(val error: String) : ClaudeUpdatePhase
}

/**
 * Offered under a failed turn whose Claude Code is too old for the model.
 * The computer runs Claude Code's own updater for [instanceId] (the harness
 * refuses while another Claude turn is running, in words meant for a
 * person), or the person takes the command and runs it themselves. Either
 * way the failed message is not resent, so every ending says to send it again.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ClaudeUpdateCard(messageId: String, instanceId: String) {
    val session = LocalCompanion.current.session
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboard.current
    var phase by remember(messageId) { mutableStateOf<ClaudeUpdatePhase>(ClaudeUpdatePhase.Ask) }
    var copied by remember(messageId) { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1_200)
            copied = false
        }
    }

    fun update() {
        if (phase == ClaudeUpdatePhase.Updating) return
        phase = ClaudeUpdatePhase.Updating
        scope.launch {
            phase = when (val result = session.updateClaude(instanceId)) {
                is ClaudeUpdateResult.Updated -> ClaudeUpdatePhase.Updated(result.version)
                is ClaudeUpdateResult.Failed -> ClaudeUpdatePhase.Failed(result.message)
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .musePaperCard()
            .padding(18.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        when (val current = phase) {
            ClaudeUpdatePhase.Ask -> {
                Text(
                    "当前模型需要更新版本的 Claude Code，我可以帮你自动更新。",
                    fontSize = 15.sp,
                    lineHeight = 21.sp,
                    color = minisInk,
                )
                MuseCardDivider()
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    MuseSecondaryPillButton(
                        text = "手动更新",
                        onClick = { phase = ClaudeUpdatePhase.Manual },
                        modifier = Modifier.weight(1f),
                    )
                    MusePrimaryPillButton(
                        text = "自动更新",
                        onClick = ::update,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
            ClaudeUpdatePhase.Updating -> Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CircularProgressIndicator(
                    strokeWidth = 1.5.dp,
                    modifier = Modifier.size(14.dp),
                    color = minisSecondary,
                )
                Text(
                    "正在更新 Claude Code… 可能需要一分钟左右。",
                    fontSize = 14.5.sp,
                    color = minisSecondary,
                )
            }
            is ClaudeUpdatePhase.Updated -> Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Check, contentDescription = null, tint = minisSuccess, modifier = Modifier.size(16.dp))
                Text(
                    "Claude 已更新至 ${current.version}，请重新发送你的消息。",
                    fontSize = 14.5.sp,
                    color = minisInk,
                )
            }
            ClaudeUpdatePhase.Manual, is ClaudeUpdatePhase.Failed -> {
                if (current is ClaudeUpdatePhase.Failed) {
                    SelectionContainer {
                        Text(current.error, fontSize = 14.sp, color = minisDanger)
                    }
                }
                Text(
                    "请在电脑终端中运行以下命令，然后重新发送消息：",
                    fontSize = 14.sp,
                    color = minisSecondary,
                )
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(minisSoftCard, RoundedCornerShape(12.dp))
                        .padding(start = 12.dp, end = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    SelectionContainer(modifier = Modifier.weight(1f)) {
                        Text(UPDATE_COMMAND, fontSize = 13.5.sp, fontFamily = FontFamily.Monospace, color = minisInk)
                    }
                    TextButton(
                        onClick = {
                            scope.launch {
                                clipboard.setClipEntry(
                                    ClipEntry(ClipData.newPlainText(UPDATE_CLIP_LABEL, UPDATE_COMMAND)),
                                )
                                copied = true
                            }
                        },
                    ) { Text(if (copied) "已复制" else "复制", fontWeight = FontWeight.Medium, color = minisInk) }
                }
                if (current is ClaudeUpdatePhase.Failed) {
                    MusePrimaryPillButton(
                        text = "重试更新",
                        onClick = ::update,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}
