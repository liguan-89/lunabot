package com.lunabot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.R
import com.lunabot.companion.core.LimitResetContinueResult
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.launch

/**
 * 被额度限制停住的回合下面的「到点继续」——桌面端 ErrorRow 上那颗 action 按钮
 * （`src/components/EngineUsage.tsx` 的 useLimitResetContinue）的手机版。
 * 点一下在这个会话里建一条一次性自动化，额度重置后从停下的地方接着干；
 * 服务端幂等，重复点安全。
 *
 * 安静消失是它的一个状态而不是意外：旧版电脑没有这条路由、会话被拒、会话
 * 已删除，三者都折成 Unavailable，整行不画。
 */
@Composable
fun LimitResetContinueRow(
    messageId: String,
    botId: String,
    threadId: String,
    resetsAt: Double,
) {
    if (!LimitResetContinueRules.offers(resetsAt, System.currentTimeMillis())) return
    val session = LocalCompanion.current.session
    val scope = rememberCoroutineScope()
    var phase by remember(messageId) { mutableStateOf<LimitResetContinuePhase>(LimitResetContinuePhase.Ask) }

    fun arrange() {
        if (phase != LimitResetContinuePhase.Ask && phase !is LimitResetContinuePhase.Failed) return
        phase = LimitResetContinuePhase.Working
        scope.launch {
            phase = when (val result = session.continueAtLimitReset(botId, threadId)) {
                LimitResetContinueResult.Set -> LimitResetContinuePhase.Set
                LimitResetContinueResult.Unavailable -> LimitResetContinuePhase.Hidden
                is LimitResetContinueResult.Failed -> LimitResetContinuePhase.Failed(result.message)
            }
        }
    }

    when (val current = phase) {
        LimitResetContinuePhase.Hidden -> Unit
        LimitResetContinuePhase.Set -> LimitResetContinuePill(
            text = LimitResetContinueRules.SET_TEXT,
            onClick = null,
            leading = {
                Icon(
                    imageVector = Icons.Filled.Check,
                    contentDescription = null,
                    tint = minisSuccess,
                    modifier = Modifier.size(13.dp),
                )
            },
        )
        LimitResetContinuePhase.Working -> LimitResetContinuePill(
            text = LimitResetContinueRules.WORKING_TEXT,
            onClick = null,
            leading = {
                CircularProgressIndicator(
                    modifier = Modifier.size(12.dp),
                    strokeWidth = 1.5.dp,
                    color = minisSecondary,
                )
            },
        )
        else -> {
            val time = LimitResetContinueRules.resetTimeText(resetsAt, System.currentTimeMillis())
            LimitResetContinuePill(
                text = LimitResetContinueRules.offerText(time),
                onClick = ::arrange,
                leading = {
                    Icon(
                        painter = painterResource(R.drawable.ic_schedule),
                        contentDescription = null,
                        tint = minisInk,
                        modifier = Modifier.size(13.dp),
                    )
                },
            )
            if (current is LimitResetContinuePhase.Failed) {
                Text(
                    text = current.message,
                    fontSize = 12.sp,
                    color = minisDanger,
                    modifier = Modifier.padding(start = 10.dp, top = 4.dp),
                )
            }
        }
    }
}

private sealed interface LimitResetContinuePhase {
    data object Ask : LimitResetContinuePhase
    data object Working : LimitResetContinuePhase
    data object Set : LimitResetContinuePhase
    data object Hidden : LimitResetContinuePhase
    data class Failed(val message: String) : LimitResetContinuePhase
}

/**
 * 视觉与 [TranscriptEventPill] 同族——同一条细边、圆角与内边距——但文字允许
 * 折行：按钮文案是一整句话，单行省略号截断的按钮读不完自己的承诺。
 */
@Composable
private fun LimitResetContinuePill(
    text: String,
    onClick: (() -> Unit)?,
    leading: @Composable () -> Unit,
) {
    val shape = RoundedCornerShape(16.dp)
    Row(
        modifier = Modifier
            .clip(shape)
            .background(minisInk.copy(alpha = 0.03f), shape)
            .border(0.5.dp, minisSeparator.copy(alpha = 0.55f), shape)
            .then(
                if (onClick != null) {
                    Modifier.clickable(role = Role.Button, onClick = onClick)
                } else {
                    Modifier
                },
            )
            .padding(horizontal = 10.dp, vertical = 5.dp)
            .semantics(mergeDescendants = true) { contentDescription = text },
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading()
        Text(
            text = text,
            fontSize = 12.5.sp,
            lineHeight = 17.sp,
            fontWeight = FontWeight.Medium,
            color = minisInk,
        )
    }
}

/** 文案与显示判断，纯函数，离开 Compose 可测。 */
internal object LimitResetContinueRules {
    const val SET_TEXT = "已定，到点自动继续"
    const val WORKING_TEXT = "正在安排…"

    /** 与桌面端 zh 文案同一句（`chat.limit.continueAt`）。 */
    fun offerText(time: String): String = "额度在 $time 重置后可继续"

    /**
     * 按钮只在重置时间还在未来时提供。已经过去的失败行留在记录里是证据，
     * 不再是一件要办的事——桌面端同一判断（`resetsAt <= Date.now()` 即不返回按钮）。
     */
    fun offers(resetsAt: Double, nowMillis: Long): Boolean =
        resetsAt.isFinite() && resetsAt > nowMillis.toDouble()

    /**
     * 按钮里的时间：当天只给钟点（15:40），跨天带上几月几日。中文手机读 24 小时制，
     * 与 [RelativeStamp.time] 同一条理由。
     */
    fun resetTimeText(
        resetsAt: Double,
        nowMillis: Long,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.SIMPLIFIED_CHINESE,
    ): String {
        val clock = RelativeStamp.time(resetsAt, zone, locale)
        val at = ZonedDateTime.ofInstant(Instant.ofEpochMilli(resetsAt.toLong()), zone)
        val now = ZonedDateTime.ofInstant(Instant.ofEpochMilli(nowMillis), zone)
        if (at.toLocalDate() == now.toLocalDate()) return clock
        return "${DateTimeFormatter.ofPattern("M月d日", locale).format(at)} $clock"
    }
}
