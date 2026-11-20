package com.lunabot.companion.core

import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString

/** How much of a bot's working activity the transcript shows. */
enum class ActivityDetail(val wireValue: String, val label: String, val caption: String) {
    FULL("full", "完整", "显示智能体执行的每一步。"),
    REDUCED("reduced", "精简", "将多个步骤折叠为一行，失败步骤始终显示。"),
    HIDDEN("hidden", "隐藏", "不显示活动步骤，仅显示消息。"),
    ;

    companion object {
        fun fromWire(value: String?): ActivityDetail =
            entries.firstOrNull { it.wireValue == value } ?: FULL
    }
}

/** One user-editable chip on the composer's quick-reply row. */
@Serializable
data class QuickReply(
    val id: String = UUID.randomUUID().toString(),
    val title: String,
    val prompt: String,
    val icon: String,
) {
    companion object {
        val DEFAULTS: List<QuickReply> = listOf(
            QuickReply("default.continue", "继续执行", "继续下一步", "next"),
            QuickReply("default.summary", "总结要点", "帮我简短总结一下刚才的结果", "document"),
            QuickReply("default.explain", "展开说明", "再详细解释一下细节和原因", "explain"),
            QuickReply("default.next", "下一步建议", "接下来有什么建议？", "list"),
        )

        val ICON_CHOICES: List<String> = listOf(
            "next", "diff", "tests", "explain", "build", "bug", "document", "terminal",
            "send", "search", "history", "list",
        )

        fun encode(replies: List<QuickReply>): String =
            runCatching { CompanionJson.encodeToString(replies) }.getOrDefault("")

        /**
         * An empty or corrupt store falls back to defaults. An encoded empty list is a deliberate
         * choice and remains empty.
         */
        fun decode(json: String): List<QuickReply> {
            if (json.isEmpty()) return DEFAULTS
            val decoded = runCatching {
                CompanionJson.decodeFromString<List<QuickReply>>(json)
            }.getOrElse { return DEFAULTS }
            val ids = decoded.map { it.id.trim() }
            if (ids.any(String::isEmpty) || ids.toSet().size != ids.size) return DEFAULTS
            return decoded
        }
    }
}

/** A transcript item: one message, consecutive activity, or completed narration. */
sealed interface TranscriptRow {
    val head: Message
    val id: String
    val at: Double get() = head.at
    val endAt: Double
    val role: Message.Role get() = head.role
    val kind: Message.Kind get() = head.kind
    val senderName: String? get() = head.from?.name

    /** Search and pagination anchors can land inside a folded row. */
    fun containsMessage(messageId: String): Boolean = when (this) {
        is Single -> message.id == messageId
        is ActivityRun -> items.any { it.id == messageId }
        is AssistantTurn -> items.any { it.id == messageId }
    }

    data class Single(val message: Message) : TranscriptRow {
        override val head: Message get() = message
        override val id: String get() = message.id
        override val endAt: Double get() = message.at
    }

    data class ActivityRun(val items: List<Message>) : TranscriptRow {
        init {
            require(items.isNotEmpty()) { "An activity run must contain at least one message." }
        }

        override val head: Message get() = items.first()
        override val id: String get() = "run.${head.id}"
        override val endAt: Double get() = items.last().at
        val running: Boolean get() = items.any { it.tool?.ok == null }
    }

    /**
     * A finished turn's tool steps, behind one receipt.
     *
     * The fold used to hold the bot's narration and hide it, which put the bot's
     * own words behind a "已处理" chip. It now holds the steps only: the words
     * are the transcript and stay visible, and what collapses is the work.
     */
    data class AssistantTurn(val turnId: String, val items: List<Message>, val elapsed: Double) : TranscriptRow {
        init {
            require(items.isNotEmpty()) { "A turn fold must contain at least one step." }
        }

        override val head: Message get() = items.first()
        override val id: String get() = "turn.$turnId"
        override val endAt: Double get() = items.last().at

        /**
         * What the one chip says: how long the turn took and what it is holding.
         *
         * The count is there because this chip is the turn's only fold now — the
         * "已运行 N 个步骤" chip beside it described the same work twice, and a
         * reader who opens this one should know how much is inside before they
         * do.
         */
        val label: String get() {
            val steps = "${items.size} 个步骤"
            if (elapsed < 1_000) return "已处理 · $steps"
            val seconds = (elapsed / 1_000).toLong()
            val duration = if (seconds < 60) "${seconds}秒"
                else "${seconds / 60}分 ${(seconds % 60).toString().padStart(2, '0')}秒"
            return "已处理 $duration · $steps"
        }
    }
}

/**
 * The one line a roster row shows under a chat's name.
 *
 * Folded by the same rule as the transcript, and for the same reason: a reader who has turned
 * activity off has said they do not want to see tool calls, and the roster is where they see the
 * most of them — one per chat, on the screen they spend the most time on. Reading the preview off
 * the raw last message made "Hidden" mean "hidden in one place".
 */
fun rosterPreview(messages: List<Message>, detail: ActivityDetail): String =
    when (val last = transcriptRows(messages, detail).lastOrNull()) {
        null -> ""
        is TranscriptRow.Single -> previewText(last.message)
        is TranscriptRow.ActivityRun ->
            "${if (last.running) "正在运行" else "已运行"} ${last.items.size} 个步骤"
        is TranscriptRow.AssistantTurn -> last.label
    }

/** What a single message reads as in a roster row. */
internal fun previewText(message: Message): String = when (message.kind) {
    Message.Kind.TEXT -> message.webhookContent?.task ?: message.text.orEmpty()
    // a pending card's question is the preview; the roster row already says
    // "waiting on you" beside it
    Message.Kind.OPTIONS -> {
        val card = message.card
        when {
            card == null -> ""
            card.isPending && card.subtitle.isNotEmpty() -> card.subtitle
            else -> card.title
        }
    }
    Message.Kind.ACTIVITY -> message.tool?.name.orEmpty()
    Message.Kind.SCREEN -> "屏幕截图"
    Message.Kind.CONNECTOR -> message.connector?.label.orEmpty()
    Message.Kind.SECRET -> message.secret?.label.orEmpty()
    // The site is the fact a reader needs in one line; the reason is on the card.
    Message.Kind.SIGNIN -> message.signIn?.site
        ?.takeIf { it.isNotBlank() }
        ?.let { "需要登录 $it" }
        ?: message.text.orEmpty()
    Message.Kind.ROUTINE_RUN -> message.routineRun?.routineName.orEmpty()
    Message.Kind.GOAL_RUN -> message.goalRun?.goal.orEmpty()
    Message.Kind.DIGEST -> ""
    Message.Kind.COMPACTION -> message.compaction?.chipText ?: message.text.orEmpty()
    Message.Kind.CALL -> message.call?.title?.takeIf { it.isNotBlank() } ?: "通话记录"
    Message.Kind.WIDGET -> message.text.orEmpty().ifBlank { "小组件" }
    Message.Kind.APP -> message.app?.title?.takeIf { it.isNotBlank() }
        ?: message.text.orEmpty().ifBlank { "应用卡片" }
    Message.Kind.UNKNOWN -> message.text.orEmpty()
}

/**
 * Rows the harness writes about a turn rather than in it: tool chips and, since
 * Phase 0, the digest and compaction receipts. Hidden together, because a reader
 * who turned activity off does not want the summary of exactly those calls either.
 * Port of `isActivityReceipt` in `ChatPreferences.swift`.
 */
fun isActivityReceipt(message: Message): Boolean = when (message.kind) {
    Message.Kind.ACTIVITY, Message.Kind.DIGEST, Message.Kind.COMPACTION -> true
    else -> false
}

/**
 * Fold a transcript to the selected activity detail.
 *
 * In [ActivityDetail.REDUCED] a finished turn's successful tool steps fold into
 * one receipt — the same chip the "已运行 N 个步骤" run uses — so a turn shows one
 * fold rather than one for its words and another for its work. Narration is
 * never folded: what the bot said is the transcript, and a reply behind a chip
 * is a reply the reader has to ask for.
 *
 * Failed steps are never folded in reduced mode; hidden mode intentionally
 * removes all activity, including failures.
 */
fun transcriptRows(messages: List<Message>, detail: ActivityDetail): List<TranscriptRow> {
    // Only a server completion marker makes a turn's steps foldable. Legacy and
    // unfinished turns keep every step visible, matching desktop and iOS.
    val steps = mutableMapOf<String, MutableList<Message>>()
    val startedAt = mutableMapOf<String, Double>()
    var lastUserAt: Double? = null
    val folds = mutableMapOf<String, TranscriptRow.AssistantTurn>()
    val hiddenIds = mutableSetOf<String>()
    if (detail == ActivityDetail.REDUCED) {
        val pendingUnscoped = mutableListOf<Message>()
        var unscopedStartAt: Double? = null
        for (message in messages) {
            if (message.role == Message.Role.USER) {
                lastUserAt = message.at
                pendingUnscoped.clear()
                unscopedStartAt = null
                continue
            }
            if (message.role != Message.Role.BOT) continue
            val turnId = message.turnId?.takeIf { it.isNotEmpty() }
            if (message.turnTerminal == true && turnId != null) {
                val collected = mutableListOf<Message>()
                steps.remove(turnId)?.let { collected.addAll(it) }
                if (pendingUnscoped.isNotEmpty()) {
                    collected.addAll(pendingUnscoped)
                    pendingUnscoped.clear()
                }
                if (collected.isEmpty()) continue
                collected.sortBy { it.at }
                val startAt = listOfNotNull(startedAt.remove(turnId), unscopedStartAt, collected.first().at).minOrNull()
                    ?: collected.first().at
                unscopedStartAt = null
                folds[collected.first().id] = TranscriptRow.AssistantTurn(
                    turnId,
                    collected.toList(),
                    (message.at - startAt).coerceAtLeast(0.0),
                )
                hiddenIds.addAll(collected.map { it.id })
            } else if (isFoldableStep(message)) {
                if (turnId != null) {
                    if (turnId !in steps) startedAt[turnId] = lastUserAt ?: message.at
                    steps.getOrPut(turnId) { mutableListOf() }.add(message)
                } else {
                    if (unscopedStartAt == null) unscopedStartAt = lastUserAt ?: message.at
                    pendingUnscoped.add(message)
                }
            }
        }
    }
    return buildList {
        val run = mutableListOf<Message>()
        fun flush() {
            when (run.size) {
                0 -> Unit
                1 -> add(TranscriptRow.Single(run.single()))
                else -> add(TranscriptRow.ActivityRun(run.toList()))
            }
            run.clear()
        }

        messages.forEach { message ->
            if (message.kind == Message.Kind.DIGEST) return@forEach
            // A first-reply notice the AI has since answered is not history
            // worth a line: it said "no answer yet" about a turn that has one.
            // The desktop drops the same row (`FirstReplyRescueRow`), and this
            // is the phone's half of that rule.
            if (message.tool?.rescue?.answered == true) return@forEach
            val turn = folds[message.id]
            if (turn != null) {
                flush()
                add(turn)
            } else if (message.id in hiddenIds || (detail == ActivityDetail.HIDDEN && isActivityReceipt(message))) {
                // A folded step is drawn by its turn's receipt; Hidden owns the rest.
            } else if (detail != ActivityDetail.REDUCED || message.kind != Message.Kind.ACTIVITY) {
                flush()
                add(TranscriptRow.Single(message))
            } else if (message.tool?.ok == false) {
                flush()
                add(TranscriptRow.Single(message))
            } else {
                run += message
            }
        }
        flush()
    }
}

/**
 * A step a finished turn can fold: one that ran and finished, and that is only a
 * receipt — not a chip that opens a thread, and not a line reporting the
 * harness's own state, which a reader needs to see even when the work around it
 * is folded.
 */
private fun isFoldableStep(message: Message): Boolean {
    if (message.kind != Message.Kind.ACTIVITY) return false
    val tool = message.tool ?: return false
    if (tool.ok != true) return false
    if (message.threadRef != null || message.comm != null) return false
    return STATUS_PREFIXES.none { tool.name.startsWith(it) }
}

private val STATUS_PREFIXES = listOf("notice:", "recovery:", "stopped:", "error:")
