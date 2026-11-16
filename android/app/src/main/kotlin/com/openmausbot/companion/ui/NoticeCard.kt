package com.openmausbot.companion.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.core.Session
import kotlinx.coroutines.delay

/**
 * The one notice shape, in two sizes — this file replaces the last of the
 * stock UI the app still showed: a Material `AlertDialog` ("出错了" + 确定)
 * and a system `Toast`, neither of which speaks Liquid Gloss.
 *
 * A bottom notice instead of a modal, because the action that failed happened
 * on the screen the person is still looking at: a dialog both covers it and
 * demands a tap before anything else can happen, while the failure itself
 * almost never blocks whatever they were doing. The notice states, waits, and
 * gets out of the way.
 */

/** How loudly a notice speaks. The three hues [MinisDesign] allows itself. */
enum class NoticeTone { INFO, WARNING, ERROR }

/**
 * An inline glass card that carries one message — the attachment-error row's
 * tone at card weight, for anywhere a failure or a heads-up belongs in the
 * flow of a screen rather than over it.
 *
 * The card is [minisGloss] filled with the tone's wash, so in dark mode it
 * reads as a tinted glass panel rather than a grey block. Pass [title] for
 * failures that carry a name ("出错了"), [actionLabel]/[onAction] for the one
 * action that fixes the problem (e.g. 重试), and [onDismiss] to hang an ✕
 * off the trailing edge.
 */
internal object NoticeMessageFormat {
    private val NO_ROUTE = Regex("""(?i)\bno route:\s*(?:[A-Z]+\s+)?\S+""")
    private val BARE_URL = Regex("""https?://\S+""")
    private val NETWORK_FAILURE = Regex(
        """(?i)(?:\.e2e\.invalid\b|unable to resolve host|unknownhostexception|failed to connect|connection refused|connectexception|sockettimeoutexception|timed out|\btimeout\b|network is unreachable|software caused connection abort)""",
    )

    fun humanize(raw: String): String {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return ""
        if (NO_ROUTE.containsMatchIn(trimmed)) {
            return "当前连接的电脑暂不支持此功能，请检查连接或更新电脑端应用。"
        }
        if (NETWORK_FAILURE.containsMatchIn(trimmed)) {
            return "无法连接到电脑，请确认电脑在线并保持远程访问开启。"
        }
        val stripped = BARE_URL.replace(trimmed, "").replace(Regex("""\s{2,}"""), " ").trim(' ', ':', '：', '-', '—')
        return stripped.ifEmpty { trimmed }
    }
}

@Composable
fun InlineNotice(
    message: String,
    modifier: Modifier = Modifier,
    title: String? = null,
    tone: NoticeTone = NoticeTone.WARNING,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
    onDismiss: (() -> Unit)? = null,
    floating: Boolean = false,
) {
    val tint = tone.tint()
    val dark = minisIsDark()
    val basePlate = if (dark) Color(0xF21C1C20) else Color(0xF7FFFFFF)
    val fill = if (floating) tone.floatingWash(dark).compositeOver(basePlate) else tone.wash()
    val rim = if (floating) tint.copy(alpha = if (dark) 0.34f else 0.24f) else minisSeparator
    val cleanMessage = remember(message) { NoticeMessageFormat.humanize(message) }
    Row(
        modifier = modifier
            .minisGloss(
                shape = MinisCardShape,
                fill = fill,
                sheen = minisGlassSheen,
                rim = rim,
                elevation = if (floating) 12.dp else 0.dp,
            )
            // The ✕ keeps its 48 dp target inside [ChromeButton]; this padding
            // only positions the visuals inside the glass.
            .padding(start = 14.dp, end = 6.dp, top = 10.dp, bottom = 10.dp)
            .semantics(mergeDescendants = true) { },
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(NOTICE_ICON_DISC)
                .background(tint.copy(alpha = NOTICE_DISC_WASH), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = when (tone) {
                    NoticeTone.INFO -> Icons.Filled.Info
                    NoticeTone.WARNING, NoticeTone.ERROR -> Icons.Filled.Warning
                },
                contentDescription = null,
                tint = tint,
                modifier = Modifier.size(16.dp),
            )
        }

        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            if (title != null) {
                Text(
                    text = title,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = minisInk,
                )
            }
            Text(text = cleanMessage, fontSize = 13.sp, lineHeight = 18.sp, color = minisInk)
        }

        if (actionLabel != null) {
            Text(
                text = actionLabel,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                color = tint,
                modifier = Modifier
                    .clip(CircleShape)
                    .background(tint.copy(alpha = NOTICE_ACTION_WASH), CircleShape)
                    .clickable(
                        enabled = onAction != null,
                        role = Role.Button,
                        onClick = { onAction?.invoke() },
                    )
                    .padding(horizontal = 12.dp, vertical = 6.dp),
            )
        }

        if (onDismiss != null) {
            ChromeButton(
                icon = Icons.Filled.Close,
                contentDescription = "关闭",
                onClick = onDismiss,
                size = 32.dp,
                glyph = 16.dp,
                tint = minisSecondary,
            )
        }
    }
}

/**
 * The in-app home for `session.actionError` — everything that used to surface
 * as an AlertDialog or a Toast.
 *
 * Renders a floating [InlineNotice] at the bottom centre of whatever screen is
 * up, with a close button that clears the flow and an eight-second auto-clear
 * so an ignored notice answers itself. Keyed on the message: a second error
 * restarts the clock instead of inheriting the first one's remaining time, and
 * the card retargets its text in place. It draws no scrim and steals no taps —
 * the failed action happened on the screen behind it, and the person may still
 * be mid-gesture there.
 */
@Composable
fun ActionNoticeHost(session: Session) {
    val message by session.actionErrorFlow.collectAsState()

    // Hold the last non-null text through the exit animation: clearing the flow
    // and finishing the fade-out are not the same instant, and the card would
    // flash empty between them otherwise.
    val displayed = remember { mutableStateOf("") }
    SideEffect { message?.let { displayed.value = it } }

    LaunchedEffect(message) {
        if (message != null) {
            delay(NOTICE_LINGER_MS)
            session.actionError = null
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        AnimatedVisibility(
            visible = message != null,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .navigationBarsPadding()
                .padding(start = 16.dp, end = 16.dp, bottom = 24.dp),
            enter = slideInVertically(tween(240)) { it / 2 } + fadeIn(tween(240)),
            exit = slideOutVertically(tween(160)) { it / 2 } + fadeOut(tween(160)),
        ) {
            InlineNotice(
                message = displayed.value,
                title = "出错了",
                tone = NoticeTone.ERROR,
                modifier = Modifier.widthIn(max = 560.dp),
                onDismiss = { session.actionError = null },
                floating = true,
            )
        }
    }
}

/**
 * The tone's ink — the one saturated colour this card shows. Everything else
 * (title, body) stays at full ink contrast, the way the sheen in
 * [minisGloss] keeps text legible over glass.
 */
@Composable
private fun NoticeTone.tint(): Color = when (this) {
    NoticeTone.INFO -> minisAccent
    NoticeTone.WARNING -> minisWarning
    NoticeTone.ERROR -> minisDanger
}

@Composable
private fun NoticeTone.floatingWash(dark: Boolean): Color = when (this) {
    NoticeTone.INFO -> minisAccent.copy(alpha = if (dark) 0.22f else 0.09f)
    NoticeTone.WARNING -> minisWarning.copy(alpha = if (dark) 0.22f else 0.10f)
    NoticeTone.ERROR -> minisDanger.copy(alpha = if (dark) 0.22f else 0.09f)
}

/**
 * The tone's glass fill. Warning ships its own two-alpha wash
 * ([MinisTokens.WarningWashLight]/[MinisTokens.WarningWashDark]); danger and
 * accent derive theirs the same way, because one alpha cannot serve both
 * themes — a tint over white turns to mud over black.
 */
@Composable
private fun NoticeTone.wash(): Color = when (this) {
    NoticeTone.INFO -> minisAccent.copy(alpha = if (minisIsDark()) 0.16f else 0.10f)
    NoticeTone.WARNING -> minisWarningWash
    NoticeTone.ERROR -> minisDanger.copy(alpha = if (minisIsDark()) 0.16f else 0.10f)
}

private val NOTICE_ICON_DISC = 24.dp

/** The disc behind the glyph, faint enough to stay a halo rather than a badge. */
private const val NOTICE_DISC_WASH = 0.18f

private const val NOTICE_ACTION_WASH = 0.14f

/** Eight seconds of reading, then the notice answers itself. */
private const val NOTICE_LINGER_MS = 8_000L
