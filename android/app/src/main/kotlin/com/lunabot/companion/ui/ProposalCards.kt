package com.lunabot.companion.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.core.Message
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.launch

/**
 * A temporary permission the bot proposed (`server/permission-grants.ts`):
 * the person taps Grant or Refuse, and the card is the only place a grant can
 * start. The desktop twin is `src/components/GrantProposal.tsx`; the wire
 * text already carries the proposal sentence, so the card adds the deadline
 * and the two answers rather than repeating it.
 */
@Composable
internal fun GrantProposalCard(threadId: String, message: Message) {
    val proposal = message.grantProposal ?: return
    val session = LocalCompanion.current.session
    val scope = rememberCoroutineScope()
    var answering by remember(message.id) { mutableStateOf(false) }

    fun answer(granted: Boolean) {
        if (answering) return
        answering = true
        scope.launch {
            session.answerGrant(threadId, message.id, granted)
            answering = false
        }
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .musePaperCard()
            .padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        val until = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT)
            .format(Date(proposal.expiresAt.toLong()))
        Text("临时权限请求", fontSize = 12.5.sp, fontWeight = FontWeight.Medium, color = minisSecondary)
        Text(proposal.text, fontSize = 15.5.sp, fontWeight = FontWeight.Medium, color = minisInk)
        Text("有效期至 $until", fontSize = 12.5.sp, color = minisTertiary)
        when (proposal.answer) {
            null -> Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                MusePrimaryPillButton(
                    text = "允许",
                    onClick = { answer(true) },
                    enabled = !answering,
                    modifier = Modifier.weight(1f),
                )
                MuseSecondaryPillButton(
                    text = "拒绝",
                    onClick = { answer(false) },
                    enabled = !answering,
                    modifier = Modifier.weight(1f),
                )
            }
            "granted" -> Text("已允许，有效期至 $until。", fontSize = 13.sp, color = minisSecondary)
            "refused" -> Text("已拒绝。", fontSize = 13.sp, color = minisSecondary)
            else -> Text("已过期。", fontSize = 13.sp, color = minisSecondary)
        }
    }
}

/**
 * The proactive bot's one suggestion to add a helper-model key. Adding the
 * key stays on the computer — the phone carries no decision-model key
 * settings, by the same trust boundary that keeps every other key off it —
 * but "Not now" is the person's own answer and ends the suggestion here.
 */
@Composable
internal fun HelperSuggestionCard(threadId: String, message: Message) {
    val suggestion = message.setupSuggestion ?: return
    val session = LocalCompanion.current.session
    val scope = rememberCoroutineScope()
    var answering by remember(message.id) { mutableStateOf(false) }
    val declined = suggestion.answer == "notNow"

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .musePaperCard()
            .padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            message.text.orEmpty(),
            fontSize = 15.sp,
            color = minisInk,
        )
        if (declined) {
            Text("已暂不处理。", fontSize = 13.sp, color = minisSecondary)
        } else {
            Text("添加密钥请在电脑端的设置里完成。", fontSize = 12.5.sp, color = minisTertiary)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                MuseSecondaryPillButton(
                    text = "暂不",
                    onClick = {
                        if (answering) return@MuseSecondaryPillButton
                        answering = true
                        scope.launch {
                            session.dismissHelperSuggestion(threadId, message.id)
                            answering = false
                        }
                    },
                    enabled = !answering,
                )
            }
        }
    }
}
