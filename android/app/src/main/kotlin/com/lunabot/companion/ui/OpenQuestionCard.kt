package com.lunabot.companion.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.core.Chat
import com.lunabot.companion.core.Message
import kotlinx.coroutines.launch

/**
 * A card of choices that is not a live request — an onboarding quiz, an
 * engine-switch offer, a routine or profile question. It carries no
 * `requestId`, so the approval channel cannot answer it: the desktop patches
 * the card and posts the choice as an ordinary message, and this card does
 * the same through [com.lunabot.companion.core.Session.answerOpenQuestion].
 *
 * The row is ephemeral by design on every client: once answered, dismissed,
 * or followed by any later user text, the transcript filter in
 * [OpenQuestionVisibility] drops it, so this composable only ever exists in
 * the open state. In a room it renders read-only — the desktop refuses the
 * answer path there too.
 */
@Composable
internal fun OpenQuestionCard(chat: Chat, message: Message, haptics: Haptics) {
    val card = message.card ?: return
    val session = LocalCompanion.current.session
    val scope = rememberCoroutineScope()
    var answering by remember(message.id) { mutableStateOf(false) }
    var custom by remember(message.id) { mutableStateOf("") }
    val botChat = chat as? Chat.BotChat
    val interactive = botChat != null && !answering

    fun answer(choice: String) {
        val text = choice.trim()
        if (!interactive || text.isEmpty()) return
        haptics.play(TactileAction.CHOOSE_APPROVAL)
        answering = true
        scope.launch {
            session.answerOpenQuestion(botChat!!, message.id, text)
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
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = card.title,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                color = minisInk,
                modifier = Modifier.weight(1f),
            )
            if (botChat != null) {
                Icon(
                    imageVector = Icons.Filled.Close,
                    contentDescription = "跳过",
                    tint = minisTertiary,
                    modifier = Modifier
                        .size(20.dp)
                        .clickable(enabled = !answering, role = Role.Button) {
                            answering = true
                            scope.launch {
                                session.dismissOpenQuestion(botChat, message.id)
                                answering = false
                            }
                        },
                )
            }
        }

        if (card.subtitle.isNotBlank()) {
            ExpandableText(
                text = card.subtitle,
                style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, color = minisSecondary),
                showMore = "显示完整内容",
            )
        }

        if (card.options.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                card.options.forEach { option ->
                    MuseSecondaryPillButton(
                        text = option,
                        onClick = { answer(option) },
                        enabled = interactive,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }

        // The desktop offers a typed reply unless the card pins its choices or
        // belongs to a tool (`!card.answered && !card.tool && !card.fixedOptions`).
        if (botChat != null && card.fixedOptions != true && card.tool == null) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                MinisSheetField(
                    value = custom,
                    onValueChange = { custom = it },
                    placeholder = if (card.options.isEmpty()) "输入你的回答" else "其他回答…",
                    enabled = interactive,
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { answer(custom) }),
                    modifier = Modifier.weight(1f),
                )
                MusePrimaryPillButton(
                    text = "发送",
                    onClick = { answer(custom) },
                    enabled = interactive && custom.isNotBlank(),
                )
            }
        }
    }
}

/** What ChatScreen's transcript filter shares with a test. */
internal object OpenQuestionVisibility {
    /**
     * The desktop's `shouldHideOnboardingCard`: a non-request card row
     * disappears once it is answered or dismissed, or once any later user
     * text exists — the person typed instead of tapping, which is an answer
     * too. Live request cards (`requestId`) never hide this way; their own
     * settled rendering takes over.
     */
    fun hiddenIds(messages: List<Message>): Set<String> {
        val hidden = mutableSetOf<String>()
        var laterUserText = false
        for (message in messages.asReversed()) {
            val card = message.card
            if (message.kind == Message.Kind.OPTIONS && card != null && card.requestId == null &&
                (card.answered != null || card.dismissed == true || laterUserText)
            ) {
                hidden += message.id
            }
            if (message.role == Message.Role.USER && message.kind == Message.Kind.TEXT) {
                laterUserText = true
            }
        }
        return hidden
    }
}
