package com.lunabot.companion.core

import java.net.URI
import java.util.Base64
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.descriptors.element
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/** The one JSON configuration used for every sidecar payload. */
val CompanionJson = Json {
    ignoreUnknownKeys = true
}

@Serializable
data class SkillRequestCardData(
    val version: Int,
    val requestId: String,
    val botId: String,
    val threadId: String,
    val stagedId: String,
    val action: String,
    val name: String,
    val gist: String,
    /** Optional so approval cards persisted by older desktop builds still decode. */
    val source: String? = null,
    /** The exact, secret-scrubbed instructions the approval enables. */
    val preview: String? = null,
    val sha256: String? = null,
    val warnings: List<String> = emptyList(),
    val createdAt: Long,
) {
    /**
     * A current client echoes this hash only after it can show the complete proposal. Legacy or
     * malformed cards remain visible but deny-only.
     */
    val reviewedSha256: String?
        get() = sha256?.takeIf { hash ->
            !preview.isNullOrEmpty() && hash.length == 64 && hash.all { character ->
                character in '0'..'9' || character in 'a'..'f' || character in 'A'..'F'
            }
        }
}

@Serializable
data class OptionCard(
    val title: String,
    val subtitle: String,
    val options: List<String>,
    val answered: String? = null,
    val dismissed: Boolean? = null,
    /**
     * The server withdrew the request's options. It is settled without an
     * answer, and a card that ignored this read as pending forever — the
     * Updates dot never cleared and the buttons were gone.
     */
    val expired: Boolean? = null,
    val requestId: String? = null,
    val tool: String? = null,
    val held: String? = null,
    val allowKey: String? = null,
    /**
     * The allow action is destructive: it deletes a bot, data or an account.
     * The desktop has drawn this as a danger action since the field reached the
     * wire (`shared/wire.ts` `OptionCardData.danger`); the phone dropped it, so
     * a delete read exactly like a calendar read.
     */
    val danger: Boolean? = null,
    /** Learned skills require a complete, hash-bound review before approval. */
    val skillRequest: SkillRequestCardData? = null,
    /**
     * The model's own questions and options (Claude's `AskUserQuestion`).
     * Present only on a structured ask; every other card leaves it null.
     */
    val questionRequest: QuestionRequestCardData? = null,
    /**
     * What an answered question was answered WITH. `answered` only records the
     * behavior once the harness settles a live ask, so without this a settled
     * question card would read "answer" instead of the reply.
     */
    val answeredText: String? = null,
    /** The card takes only its fixed choices, never a typed reply of the person's own. */
    val fixedOptions: Boolean? = null,
) {
    val isPending: Boolean get() = requestId != null && answered == null &&
        dismissed != true && expired != true
    val isPermission: Boolean get() = tool != null

    /**
     * A card of choices that is not a live request: an onboarding quiz, an
     * offer to switch engines, a routine or profile question. The desktop
     * answers it by patching the card and posting the choice as an ordinary
     * message (`src/state/store.tsx` answerCard), and hides the row once it is
     * settled or any later user text exists. Live approval cards carry a
     * `requestId` and never take this path.
     */
    val isOpenQuestion: Boolean get() = requestId == null && answered == null && dismissed != true

    /**
     * A structured ask draws its own card: the model posed real questions with
     * real options, and a flat row of buttons cannot say which question a tap
     * answered.
     */
    val questions: List<AskQuestion> get() = questionRequest?.questions.orEmpty()

    fun responseBehavior(choice: String): String = responseBehavior(choice, isPermission)

    fun shouldRememberPermission(choice: String): Boolean =
        isPermission && allowKey != null && choice.trim().equals("Always allow", ignoreCase = true)

    companion object {
        fun responseBehavior(choice: String, isPermission: Boolean): String = when {
            !isPermission -> "answer"
            isRefusal(choice) -> "deny"
            else -> "allow"
        }

        fun isRefusal(choice: String): Boolean = choice.trim().lowercase() in
            setOf("deny", "cancel", "dismiss")
    }
}

@ConsistentCopyVisibility
data class NotificationTarget private constructor(
    val botId: String,
    val threadId: String,
) {
    fun requiresTaskSwitch(activeThreadId: String): Boolean = threadId != activeThreadId

    companion object {
        fun from(botId: String?, threadId: String?): NotificationTarget? {
            if (botId.isNullOrBlank() || threadId.isNullOrBlank()) return null
            return NotificationTarget(botId, threadId)
        }

        fun from(payload: Map<String, String>): NotificationTarget? =
            from(payload["botId"], payload["threadId"])
    }
}

@Serializable
data class ToolActivity(
    val name: String,
    val ok: Boolean? = null,
    val spoken: String? = null,
    val setup: Boolean? = null,
    /**
     * The failed turn's Claude Code CLI is too old for the chosen model.
     * The phone offers to run Claude's updater on the computer, or shows
     * the command to run by hand. Older computers omit it.
     */
    val claudeUpdate: Boolean? = null,
    /**
     * A first reply that has not come yet: the turn's AI has said nothing and
     * this row is the harness's notice about it (`shared/first-reply-rescue.ts`).
     * The row's name is a whole sentence, which is what the phone prints; this
     * payload is what says whether the notice still has something to ask.
     */
    val rescue: FirstReplyRescue? = null,
    /**
     * 仅失败行：停住这一回合的额度限制何时重置，纪元毫秒，引擎原话上报
     * （`shared/failed-turn.ts`）。这个字段在场才提供「到点继续」按钮；
     * 旧版电脑不带它，也就不提供。
     */
    val limitResetsAt: Double? = null,
    /** The call's own words: what it did, what it read, what it wrote back. */
    val summary: String? = null,
    val input: String? = null,
    /** Truncated on the wire when the harness spilled the full result; the
     * thread's `/messages/:mid/tool` route then carries it whole. */
    val output: String? = null,
    /** A failed MCP step, in the reader's language: which server, why, what to do. */
    val problem: String? = null,
    /** Whether the harness captured the full redacted result server-side. */
    val fullResult: Boolean? = null,
)

/**
 * The harness's own record of a turn that heard nothing from its AI for a
 * while. Only the fields the phone acts on are decoded: the desktop's two
 * buttons (switch AI, connect a subscription) are its own, and the phone has
 * neither.
 */
@Serializable
data class FirstReplyRescue(
    val botId: String,
    val threadId: String,
    val turnId: String,
    val requestMessageId: String? = null,
    val instanceId: String,
    val ai: String,
    val groupId: String? = null,
    /** The AI has started answering: the notice has nothing left to say. */
    val settled: Boolean? = null,
    /** The turn ended, or gave way to the next, without an answer: history, not a live wait. */
    val over: Boolean? = null,
) {
    /**
     * Whether the row still belongs on screen. A settled notice said "still
     * waiting" about something that has since arrived, and the desktop drops it
     * from the transcript; the phone used to print it forever because it could
     * not see this payload at all. An over notice is history and stays, with no
     * live anything — which is exactly what a printed sentence is.
     */
    val answered: Boolean get() = settled == true
}

/**
 * A compaction record: from this message on, rebuilds of the thread's
 * context carry [summary] instead of the earlier messages.
 */
@Serializable
data class Compaction(
    val summary: String,
    val tokensBefore: Int,
) {
    val chipText: String
        get() = "上下文已压缩 · 已总结 ${"%,d".format(tokensBefore)} 个 token"
}

/**
 * The thread an activity chip opened — "Opened thread #Title on Scout" — so
 * the phone can go there. Newer computers only; a chip without one is just a
 * receipt.
 */
@Serializable
data class ThreadRef(
    val botId: String,
    val threadId: String,
    val title: String,
)

@Serializable
data class Sender(
    val botId: String,
    val name: String,
    val color: String,
)

@Serializable
data class Reaction(val emoji: String, val by: String)

@Serializable
data class CommChip(
    val groupId: String,
    val withBotId: String,
    val withName: String,
    val withColor: String,
)

/** stream 中的 Live 通话状态；线上 `status` 为 connecting/live/ending/ended。 */
@Serializable
data class LiveCallState(
    val callId: String = "",
    val botId: String = "",
    val threadId: String = "",
    val client: String = "",
    val voice: String = "",
    val startedAt: Double = 0.0,
    val status: String = "",
    val endReason: String? = null,
    val error: String? = null,
)

/**
 * The record a finished Live call leaves (`kind == "call"`).
 *
 * The phone cannot join a call the desktop is running, but the receipt belongs
 * in the transcript: without it a call just disappears from the conversation.
 * Never carries speech, so there is nothing private to redact here.
 */
@Serializable
data class LiveCallRecord(
    val callId: String = "",
    val botId: String = "",
    val client: String = "",
    val startedAt: Double = 0.0,
    val endedAt: Double = 0.0,
    val seconds: Double = 0.0,
    val endReason: String = "",
    val title: String? = null,
)

/**
 * A bot-authored widget (`kind == "widget"`). `root` is the canonical
 * ChatKit-style tree the phone renders and presses like the desktop: a press
 * rides the normal message POST as `widgetAction` and the server re-validates
 * it, so the tree is kept untyped (`JsonObject`) and read through
 * `WidgetTree.kt`. `rev` counts replacements of the tree (a press names the
 * revision it was made on); `settled`/`withdrawn` are terminal states.
 */
@Serializable
data class WidgetCardData(
    val v: Int = 0,
    val root: JsonObject? = null,
    val rev: Int = 0,
    val settled: WidgetSettledRef? = null,
    val withdrawn: JsonObject? = null,
)

@Serializable
data class WidgetSettledRef(
    val label: String = "",
    val tone: String = "",
    /** The field values that went with the press, for the read-only Details view. */
    val values: JsonObject? = null,
    /** The person's own words for a choice they answered with Other. */
    val other: JsonObject? = null,
)

/**
 * A bot page or MCP app (`kind == "app"`). `doc` names the stored document;
 * the phone shows the readable fallback rather than mounting a sandboxed page,
 * because the app's bridge is the desktop's to run.
 */
@Serializable
data class AppCardData(
    val v: Int = 0,
    val source: String = "",
    val title: String = "",
    val doc: String = "",
)

/**
 * A temporary permission the bot proposes for the person to grant or refuse
 * (`server/permission-grants.ts`). The card is the only place a grant starts;
 * `expiresAt` is epoch milliseconds, when the grant would stop covering.
 */
@Serializable
data class GrantProposalData(
    val id: String,
    val text: String,
    val expiresAt: Double,
    /** granted | refused | expired; absent while the person has not answered. */
    val answer: String? = null,
)

/**
 * A setup suggestion the device renders in its own words
 * (`server/host/helper-suggestion.ts`). The only kind so far is `helperKey`;
 * `answer` is `notNow` once the person declined it.
 */
@Serializable
data class SetupSuggestionData(
    val kind: String,
    val answer: String? = null,
)

/** `Message.dataResult` 的形状；字段名与 wire 一致。 */
@Serializable
data class DataResultData(
    val botId: String,
    val cardId: String,
    val title: String,
    val kind: String,
    val sql: String? = null,
)

/** `Message.sender` 的形状（wire 的 ResolvedSender）：名字仅用于归属展示，
 * 服务端明示不得按它放行或拒绝任何事。 */
@Serializable
data class SenderData(
    val name: String,
    val id: String? = null,
)

@Serializable
data class Message(
    val id: String,
    val role: Role,
    val kind: Kind,
    val at: Double,
    val text: String? = null,
    val card: OptionCard? = null,
    val tool: ToolActivity? = null,
    val threadRef: ThreadRef? = null,
    /** `kind == COMPACTION`: the record itself. */
    val compaction: Compaction? = null,
    val parentId: String? = null,
    val from: Sender? = null,
    val reactions: List<Reaction>? = null,
    val comm: CommChip? = null,
    val hasImage: Boolean? = null,
    val png: String? = null,
    val mime: String? = null,
    /** Agent-generated images on text replies, including late message patches. */
    val attachments: List<MessageImageAttachment>? = null,
    /**
     * A user line the engine took INTO the turn that was already running,
     * rather than one that started a turn of its own.
     */
    val steered: Boolean? = null,
    /**
     * The steer-queue entry this user line drained from. It is how a client
     * showing the held message knows which row to retire when the real line
     * finally lands.
     */
    val queueId: String? = null,
    /** Completed provider turns can fold narration without guessing which reply is final. */
    val turnId: String? = null,
    val turnTerminal: Boolean? = null,
    /** `kind == CONNECTOR`: one app the bot needs the person to authorize. */
    val connector: ConnectorCardData? = null,
    /** `kind == SECRET`: one credential the computer is waiting for. */
    val secret: SecretRequestCardData? = null,
    /** `kind == ROUTINE_RUN`: the live status card of a scheduled run. */
    val routineRun: RoutineRunCardData? = null,
    /** `kind == GOAL_RUN`: the terminal receipt of a channel goal. */
    val goalRun: GroupGoalRunCardData? = null,
    /** `kind == SIGNIN`: the bot needs the person to sign in to a site themselves. */
    val signIn: SignInCardData? = null,
    /** `kind == CALL`: the receipt of a finished Live call. */
    val call: LiveCallRecord? = null,
    /** `kind == WIDGET`: a bot-authored card's tree and settled state, if any. */
    val widget: WidgetCardData? = null,
    /** `kind == WIDGET`: the server built this card — its `i18n` keys localise. */
    val serverCard: Boolean? = null,
    /** `kind == APP`: a bot page or MCP app. */
    val app: AppCardData? = null,
    /** A temporary permission proposal the person answers on this card. */
    val grantProposal: GrantProposalData? = null,
    /** The proactive helper-key suggestion; rendered instead of the text bubble. */
    val setupSuggestion: SetupSuggestionData? = null,
    /**
     * A published Data result on a `data_show` activity row: the desktop draws
     * a chip that opens the result in the bot's Data viewer, and so does the
     * phone — the same read-only sheet/page/image routes the whitelist carries.
     */
    val dataResult: DataResultData? = null,
    /** Who sent this user message, when the workspace has more than one
     * person; absent reads as the owner. `id` is an opaque server key. */
    val sender: SenderData? = null,
    /** The message this one flat-replies to, for an inline quote. */
    val replyToId: String? = null,
    /** "api": sent through the HTTP API; "call": spoken on a Live call. */
    val via: String? = null,
    /** An external interface (the Slack worker) relayed this user line. */
    val relayed: Boolean? = null,
) {
    @Serializable(with = MessageKindSerializer::class)
    enum class Kind {
        TEXT,
        OPTIONS,
        ACTIVITY,
        SCREEN,
        CONNECTOR,
        SECRET,
        SIGNIN,
        ROUTINE_RUN,
        GOAL_RUN,
        DIGEST,
        COMPACTION,
        CALL,
        WIDGET,
        APP,
        UNKNOWN,
    }

    @Serializable(with = MessageRoleSerializer::class)
    enum class Role { BOT, USER }
}

/**
 * The bot asked for an app it does not have access to. The card is the same one
 * the desktop shows: it names the toolkit, carries the outcome of the last
 * attempt, and is a door into the browser flow that finishes the authorization.
 */
@Serializable
data class ConnectorCardData(
    val slug: String,
    val label: String,
    val description: String = "",
    /** required | authorizing | connected | failed */
    val status: String = "required",
    val resumeKey: String? = null,
    val alias: String? = null,
    val error: String? = null,
    val dismissed: Boolean? = null,
    val resumed: Boolean? = null,
) {
    val isPending: Boolean get() = dismissed != true && status != "connected" && status != "failed"
}

/** The two ways to close an inline connector request from the phone. */
enum class ConnectorCardAction(val wire: String) {
    /** Carry on once the browser finished the authorization. */
    RESUME("resume"),

    /** Stop asking; the task goes on without the app. */
    DISMISS("dismiss"),
}

/** The same pair for a credential request, whose value only the host can store. */
enum class SecretCardAction(val wire: String) {
    RESUME("resume"),
    DISMISS("dismiss"),
}

/**
 * One credential the computer is waiting for. The value itself never travels
 * through this client: the desktop seals and stores it. The card still has to
 * exist here, because otherwise the transcript loses the whole message.
 */
@Serializable
data class SecretRequestCardData(
    val target: String? = null,
    val label: String? = null,
    val description: String? = null,
    val placeholder: String? = null,
    val helpUrl: String? = null,
    val requestKey: String? = null,
    val phoneOperationId: String? = null,
    val provided: Boolean? = null,
    val dismissed: Boolean? = null,
    /** A newer request for the same credential replaced this one. */
    val superseded: Boolean? = null,
    val resumed: Boolean? = null,
    val error: String? = null,
) {
    val isPending: Boolean get() = provided != true && dismissed != true && superseded != true
}

/** The two answers a sign-in request takes from a phone. */
enum class SignInCardAction(val wire: String) {
    DONE("done"),
    CANCEL("cancel"),
}

/**
 * The bot asked the person to sign in to a site themselves.
 *
 * The password never travels through this client; the person types it into the
 * page the bot works in. The phone carries the request and its two answers so
 * that a card waiting on the computer is not invisible in the transcript.
 */
@Serializable
data class SignInCardData(
    /** The page to sign in at, an http(s) address. */
    val url: String = "",
    /** Its host — the card's headline. */
    val site: String = "",
    /** The bot's own words: why it needs the sign-in. */
    val reason: String? = null,
    /** Where the login has to happen: browser | vm | cloud | local | host. */
    val place: String? = null,
    val done: Boolean? = null,
    val cancelled: Boolean? = null,
    /** A newer request for the same site replaced this card. */
    val superseded: Boolean? = null,
    /** Answered by saving a login the computer fills for the bot. */
    val savedLogin: String? = null,
    val resumed: Boolean? = null,
    val error: String? = null,
    /** Stop ended the turn this card paused. */
    val stopped: Boolean? = null,
    /** The person answered in the conversation instead of pressing a button. */
    val answeredInChat: Boolean? = null,
) {
    val isPending: Boolean
        get() = done != true && cancelled != true && superseded != true &&
            stopped != true && answeredInChat != true
}

/** The status card a scheduled run keeps updating in place. */
@Serializable
data class RoutineRunCardData(
    val runId: String,
    val routineId: String? = null,
    val routineName: String = "",
    val scheduledFor: Double? = null,
    /** queued | running | waiting | completed | failed | cancelled | missed */
    val status: String = "queued",
    /** Present while a queued run is held because its target is busy. */
    val deferredAt: Double? = null,
    val goalStatus: String? = null,
    val executionThreadId: String? = null,
    val summary: String? = null,
    val error: String? = null,
) {
    val isTerminal: Boolean get() = status in TERMINAL

    companion object {
        private val TERMINAL = setOf("completed", "failed", "cancelled", "missed")
    }
}

/** The receipt a channel's bounded goal leaves behind when it settles. */
@Serializable
data class GroupGoalRunCardData(
    val runId: String,
    val goal: String,
    val status: String,
    val coordinatorBotId: String? = null,
    val coordinatorName: String? = null,
    val turnCount: Int = 0,
    val maxTurns: Int = 0,
    val detail: String? = null,
    val startedAt: Double? = null,
    val finishedAt: Double? = null,
)

object MessageKindSerializer : KSerializer<Message.Kind> {
    override val descriptor = PrimitiveSerialDescriptor("Message.Kind", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): Message.Kind = when (decoder.decodeString()) {
        "text" -> Message.Kind.TEXT
        "options" -> Message.Kind.OPTIONS
        "activity" -> Message.Kind.ACTIVITY
        "screen" -> Message.Kind.SCREEN
        "connector" -> Message.Kind.CONNECTOR
        "secret" -> Message.Kind.SECRET
        "signin" -> Message.Kind.SIGNIN
        "routine.run" -> Message.Kind.ROUTINE_RUN
        "goal.run" -> Message.Kind.GOAL_RUN
        "digest" -> Message.Kind.DIGEST
        "compaction" -> Message.Kind.COMPACTION
        "call" -> Message.Kind.CALL
        "widget" -> Message.Kind.WIDGET
        "app" -> Message.Kind.APP
        else -> Message.Kind.UNKNOWN
    }

    override fun serialize(encoder: Encoder, value: Message.Kind) {
        // Wire names are not always the enum's lowercase: two of the four card
        // kinds are dotted, and a client that echoes a message back must not
        // invent `routine_run` for a harness that only reads `routine.run`.
        encoder.encodeString(
            when (value) {
                Message.Kind.ROUTINE_RUN -> "routine.run"
                Message.Kind.GOAL_RUN -> "goal.run"
                else -> value.name.lowercase()
            },
        )
    }
}

object MessageRoleSerializer : KSerializer<Message.Role> {
    override val descriptor = PrimitiveSerialDescriptor("Message.Role", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): Message.Role = when (decoder.decodeString()) {
        "user" -> Message.Role.USER
        else -> Message.Role.BOT
    }

    override fun serialize(encoder: Encoder, value: Message.Role) {
        encoder.encodeString(value.name.lowercase())
    }
}

@Serializable
data class ModelSelection(
    val instanceId: String,
    val model: String,
    /**
     * Optional reasoning effort passed through to engines that support it.
     * Older computers omit this field, which means the engine default — and a
     * null here is *omitted* on the wire, never sent as `null`, so an old
     * server's validator does not see a field it does not know.
     */
    val effort: String? = null,
)

/**
 * The bot that opened a thread, on itself or on a teammate. Absent — which is
 * every thread from an older computer — means the person opened it.
 */
@Serializable
data class ThreadOpener(
    val botId: String,
    val name: String,
    val delegationId: String? = null,
    val at: Double,
)

/**
 * The bot that closed a thread with close_thread, once its result was read.
 * Absent means the thread is open; the computer clears it the moment a new
 * turn starts there, so a reopened thread simply loses the stamp.
 */
@Serializable
data class ThreadCloser(
    val botId: String,
    val name: String,
    val at: Double,
)

/** A folder within one bot, in the order saved on the computer. */
@Serializable
data class BotProject(val id: String, val name: String, val emoji: String? = null)

@Serializable
data class BotTask(
    val threadId: String,
    val title: String,
    val createdAt: Double,
    val modelSelection: ModelSelection? = null,
    val activity: String? = null,
    val busy: Boolean? = null,
    /** This thread's own turn is done and a dispatched teammate has not
     * settled yet (#1223): a wait, never work. Newer harnesses only. */
    // The wire has always spelled this `waitingForTeammates`; the old name is
    // kept on the property because every call site reads it, and the mismatch
    // meant the flag never arrived.
    @SerialName("waitingForTeammates")
    val waitingOnTeammate: Boolean? = null,
    val unread: Boolean? = null,
    val approvalMode: String? = null,
    val autoApprove: Boolean? = null,
    val alwaysAllow: List<String>? = null,
    val projectId: String? = null,
    val openedBy: ThreadOpener? = null,
    val closedBy: ThreadCloser? = null,
    /** The person put this thread away. Present means archived — a stamp of
     * 0 is still archived, because the task API accepts any epoch number. */
    val archivedAt: Double? = null,
    /** Bot-only internal execution. Keep it addressable, but out of thread pickers. */
    val routineRunId: String? = null,
    /** The person pinned this thread above the update-ordered list. */
    val pinned: Boolean? = null,
    /** Newest message time. Absent on older computers; the list uses createdAt. */
    val updatedAt: Double? = null,
    /**
     * Asleep until: 0 is the "until new activity" sentinel and never ticks,
     * while a future epoch-milliseconds timestamp sleeps only until it
     * passes. The server drops expired snoozes from snapshots; the phone
     * still checks the clock, because a live stream never refreshes one.
     */
    val snoozedUntil: Double? = null,
)

/** The time the thread list sorts and stamps by. */
val BotTask.listStamp: Double
    get() = updatedAt ?: createdAt

/** The thread list's quiet second line, worded as the desktop words it. */
val BotTask.openedByLabel: String?
    get() = openedBy?.let { "由 ${it.name} 开启" }

/** A bot closed this thread and nothing has happened there since. */
val BotTask.isClosed: Boolean
    get() = closedBy != null

/** Archived is the presence of the stamp, not its value: archivedAt 0 counts. */
val BotTask.isArchived: Boolean
    get() = archivedAt != null

/**
 * Snoozed means asleep right now: 0 is the "until new activity" sentinel and
 * sleeps until woken, while a timestamp sleeps only until it passes
 * (`isSnoozed` in `SidebarThreadRow.tsx`).
 */
fun BotTask.isSnoozed(now: Long = System.currentTimeMillis()): Boolean =
    snoozedUntil != null && (snoozedUntil == 0.0 || snoozedUntil > now)

/**
 * The one line under a title: who closed it once a bot has, "Archived" while
 * it stays filed away, "Snoozed" while it sleeps, otherwise who opened it,
 * otherwise nothing. Closed wins because it is the newer fact; archived and
 * snoozed win over the opener because they explain why the row sits where
 * it does.
 */
fun BotTask.bylineLabel(now: Long = System.currentTimeMillis()): String? =
    when {
        closedBy != null -> "由 ${closedBy.name} 关闭"
        isArchived -> "已归档"
        isSnoozed(now) -> "已延后"
        else -> openedByLabel
    }

@Serializable
data class Bot(
    val id: String,
    val threadId: String,
    val name: String,
    val title: String,
    val description: String,
    val notifications: Boolean,
    val color: String,
    val unread: Boolean,
    val modelSelection: ModelSelection,
    val createdAt: Double,
    val avatarUrl: String? = null,
    val avatarCrop: AvatarCrop? = null,
    val avatarStates: Map<String, String>? = null,
    val busy: Boolean? = null,
    val activity: String? = null,
    /** A dispatched teammate has not settled; the bot waits, it does not work. */
    @SerialName("waitingForTeammates")
    val waitingOnTeammate: Boolean? = null,
    val pinned: Boolean? = null,
    val hidden: Boolean? = null,
    /** Desktop sidebar section. Missing or blank means the built-in Bots area. */
    val section: String? = null,
    val chiefOfStaff: Boolean? = null,
    /** ask, auto, full, or custom; null when paired to an older harness. */
    val approvalMode: String? = null,
    val autoApprove: Boolean? = null,
    val alwaysAllow: List<String>? = null,
    val computer: String? = null,
    val cloudBackend: String? = null,
    val speakReplies: Boolean? = null,
    val voice: String? = null,
    val mascotExpression: String? = null,
    /**
     * Which body from the mascot body catalog this bot wears. Absent (an older
     * harness included) means the shipped `cursor` silhouette.
     */
    val mascotBody: String? = null,
    val tasks: List<BotTask>? = null,
    val messages: List<Message>? = null,
    val activeLeafId: String? = null,
    val hasMore: Boolean? = null,
    val projects: List<BotProject>? = null,
)

/** Project only task-local controls; the original fleet record stays profile-global. */
fun Bot.forTask(requestedThreadId: String): Bot? {
    val task = tasks?.firstOrNull { it.threadId == requestedThreadId }
    if (task == null) return takeIf { threadId == requestedThreadId }
    val selected = threadId == requestedThreadId
    return copy(
        threadId = requestedThreadId,
        modelSelection = task.modelSelection ?: modelSelection,
        busy = task.busy ?: if (selected) busy else false,
        activity = task.activity ?: if (selected) activity else null,
        waitingOnTeammate = task.waitingOnTeammate ?: if (selected) waitingOnTeammate else null,
        unread = task.unread ?: if (selected) unread else false,
        approvalMode = task.approvalMode ?: task.autoApprove?.let { if (it) "auto" else "ask" } ?: approvalMode,
        autoApprove = task.autoApprove ?: autoApprove,
        alwaysAllow = task.alwaysAllow ?: alwaysAllow,
        messages = if (selected) messages else null,
        activeLeafId = if (selected) activeLeafId else null,
        hasMore = if (selected) hasMore else null,
    )
}

@Serializable(with = AvatarCropSerializer::class)
enum class AvatarCrop { MASCOT, CIRCLE, ROUNDED, SQUARE }

object AvatarCropSerializer : KSerializer<AvatarCrop> {
    override val descriptor = PrimitiveSerialDescriptor("AvatarCrop", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): AvatarCrop {
        val raw = decoder.decodeString()
        return AvatarCrop.entries.firstOrNull { it.name.lowercase() == raw }
            ?: AvatarCrop.MASCOT
    }

    override fun serialize(encoder: Encoder, value: AvatarCrop) {
        encoder.encodeString(value.name.lowercase())
    }
}

@Serializable
data class GroupResponder(val kind: String, val botId: String? = null)

@Serializable
data class Room(
    val id: String,
    val threadId: String,
    val name: String,
    val memberIds: List<String>,
    val defaultResponder: GroupResponder,
    val bulletin: String,
    val unread: Boolean,
    val createdAt: Double,
    val dm: Boolean? = null,
    /** Desktop sidebar section. Missing or blank means the built-in Channels area. */
    val section: String? = null,
    val busyBotId: String? = null,
    /** Independent user conversations in this channel. DMs omit this field. */
    val tasks: List<BotTask>? = null,
    val messages: List<Message>? = null,
    val hasMore: Boolean? = null,
)

@Serializable(with = FleetSerializer::class)
data class Fleet(
    val bots: List<Bot>,
    val groups: List<Room>,
    /**
     * Held sends for every bot thread, the same snapshot the bot.queued
     * frames carry. Older computers omit it; a missing or unreadable field
     * reads as absent, never as an empty queue.
     */
    val botQueuedMessages: Map<String, List<QueuedSend>>? = null,
)

object FleetSerializer : KSerializer<Fleet> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Fleet")

    override fun deserialize(decoder: Decoder): Fleet {
        val input = decoder as? JsonDecoder
            ?: throw SerializationException("Fleet can only be decoded from JSON")
        val objectValue = input.decodeJsonElement().jsonObject

        fun <T> lossyArray(name: String, decode: (kotlinx.serialization.json.JsonElement) -> T): List<T> {
            val element = objectValue[name] ?: return emptyList()
            if (element is JsonNull) return emptyList()
            val array = element as? JsonArray
                ?: throw SerializationException("Fleet.$name must be an array")
            return array.mapNotNull { runCatching { decode(it) }.getOrNull() }
        }

        return Fleet(
            bots = lossyArray("bots") { input.json.decodeFromJsonElement(Bot.serializer(), it) },
            groups = lossyArray("groups") { input.json.decodeFromJsonElement(Room.serializer(), it) },
            // One malformed entry must not cost the whole fleet: the roster
            // is worth more than the queue note beside it.
            botQueuedMessages = runCatching {
                objectValue["botQueuedMessages"]?.jsonObject?.mapValues { (_, entries) ->
                    entries.jsonArray.mapNotNull { element ->
                        runCatching { element.jsonObject.queuedSendOrNull() }.getOrNull()
                    }
                }
            }.getOrNull(),
        )
    }

    override fun serialize(encoder: Encoder, value: Fleet) {
        val output = encoder as? JsonEncoder
            ?: throw SerializationException("Fleet can only be encoded as JSON")
        output.encodeJsonElement(buildJsonObject {
            put("bots", JsonArray(value.bots.map { output.json.encodeToJsonElement(Bot.serializer(), it) }))
            put("groups", JsonArray(value.groups.map { output.json.encodeToJsonElement(Room.serializer(), it) }))
            value.botQueuedMessages?.let { queues ->
                put("botQueuedMessages", buildJsonObject {
                    queues.forEach { (threadId, sends) ->
                        put(threadId, JsonArray(sends.map { it.toJsonObject() }))
                    }
                })
            }
        })
    }
}

@Serializable
data class ThreadPage(val messages: List<Message>, val hasMore: Boolean? = null, val activeLeafId: String? = null)

@Serializable
data class SearchHit(
    val threadId: String,
    val messageId: String,
    val at: Double,
    val role: Message.Role,
    val kind: Message.Kind,
    val snippet: String,
    val matchStart: Int,
    val matchLength: Int,
    val botId: String? = null,
    val groupId: String? = null,
    val name: String,
    val task: String? = null,
    val onActivePath: Boolean,
) {
    val id: String get() = "$threadId:$messageId"
}

data class TranscriptExport(val data: ByteArray, val filename: String, val contentType: String)

@Serializable
data class PairedDevice(
    val id: String,
    val name: String,
    val createdAt: Double,
    val lastSeenAt: Double,
)

@Serializable(with = PairResponseSerializer::class)
data class PairResponse(
    val token: String,
    val device: PairedDevice,
    val serverName: String,
    val hosts: List<String>? = null,
    val endpoints: List<CompanionEndpoint>? = null,
)

/**
 * Pairing has already minted the durable token by the time this body arrives. Endpoint metadata
 * is therefore lossy per element: a future kind or malformed advisory route cannot discard the
 * usable token and legacy host fields beside it.
 */
object PairResponseSerializer : KSerializer<PairResponse> {
    override val descriptor: SerialDescriptor = JsonObject.serializer().descriptor

    override fun deserialize(decoder: Decoder): PairResponse {
        val input = decoder as? JsonDecoder
            ?: throw SerializationException("PairResponse must be decoded from JSON")
        val value = input.decodeJsonElement() as? JsonObject
            ?: throw SerializationException("PairResponse must be a JSON object")
        val json = input.json
        val token = json.decodeFromJsonElement<String>(
            value["token"] ?: throw SerializationException("PairResponse.token is required"),
        )
        val device = json.decodeFromJsonElement<PairedDevice>(
            value["device"] ?: throw SerializationException("PairResponse.device is required"),
        )
        val serverName = json.decodeFromJsonElement<String>(
            value["serverName"] ?: throw SerializationException("PairResponse.serverName is required"),
        )
        val hosts = value["hosts"]?.takeUnless { it is JsonNull }?.let {
            json.decodeFromJsonElement<List<String>>(it)
        }
        val endpoints = when (val element = value["endpoints"]) {
            null -> null
            is JsonArray -> element.mapNotNull { candidate ->
                runCatching { json.decodeFromJsonElement<CompanionEndpoint>(candidate) }.getOrNull()
            }
            // The field is advisory and the token already exists. A malformed container is
            // discarded just like malformed entries, but is handled explicitly rather than
            // becoming an empty array through a nullable cast.
            else -> emptyList()
        }
        return PairResponse(token, device, serverName, hosts, endpoints)
    }

    override fun serialize(encoder: Encoder, value: PairResponse) {
        val output = encoder as? JsonEncoder
            ?: throw SerializationException("PairResponse must be encoded as JSON")
        output.encodeJsonElement(buildJsonObject {
            put("token", value.token)
            put("device", output.json.encodeToJsonElement(value.device))
            put("serverName", value.serverName)
            value.hosts?.let { put("hosts", output.json.encodeToJsonElement(it)) }
            value.endpoints?.let { put("endpoints", output.json.encodeToJsonElement(it)) }
        })
    }
}

/** Non-secret connection snapshot returned by GET /api/companion/endpoints. */
@Serializable(with = CompanionConnectionMetadataSerializer::class)
data class CompanionConnectionMetadata(
    val serverName: String,
    val hosts: List<String>? = null,
    val endpoints: List<CompanionEndpoint>,
    /**
     * Present when the computer offers the encrypted connection. A phone paired
     * before this feature adopts it once from here — trust on first use — and
     * pins it from then on (spec §3).
     */
    val e2e: com.lunabot.companion.core.e2e.E2eDescriptor? = null,
)

/**
 * Refresh metadata also drops malformed individual routes, but unlike PairResponse it is a
 * replacement snapshot. With no usable route the whole response is rejected so callers retain
 * their last known-good connection.
 */
object CompanionConnectionMetadataSerializer : KSerializer<CompanionConnectionMetadata> {
    override val descriptor: SerialDescriptor = JsonObject.serializer().descriptor

    override fun deserialize(decoder: Decoder): CompanionConnectionMetadata {
        val input = decoder as? JsonDecoder
            ?: throw SerializationException("Companion connection metadata must be JSON")
        val value = input.decodeJsonElement() as? JsonObject
            ?: throw SerializationException("Companion connection metadata must be a JSON object")
        val json = input.json
        val serverName = json.decodeFromJsonElement<String>(
            value["serverName"]
                ?: throw SerializationException("Companion connection metadata needs serverName"),
        )
        val hosts = value["hosts"]?.takeUnless { it is JsonNull }?.let {
            json.decodeFromJsonElement<List<String>>(it)
        }
        val decoded = (value["endpoints"] as? JsonArray).orEmpty().mapNotNull { element ->
            runCatching { json.decodeFromJsonElement<CompanionEndpoint>(element) }.getOrNull()
        }
        val endpoints = decoded.withIndex()
            .sortedWith(compareBy<IndexedValue<CompanionEndpoint>> { it.value.priority }.thenBy { it.index })
            .map { it.value }
            .distinctBy { it.url }
            .take(8)
        if (endpoints.isEmpty()) {
            throw SerializationException(
                "Companion endpoint metadata must contain at least one valid route.",
            )
        }
        val e2e = (value["e2e"] as? JsonObject)?.let { element ->
            (com.lunabot.companion.core.e2e.E2eDescriptorParser.parseObject(element)
                as? com.lunabot.companion.core.e2e.DescriptorParse.Ok)?.descriptor
        }
        return CompanionConnectionMetadata(serverName, hosts, endpoints, e2e)
    }

    override fun serialize(encoder: Encoder, value: CompanionConnectionMetadata) {
        val output = encoder as? JsonEncoder
            ?: throw SerializationException("Companion connection metadata must be JSON")
        output.encodeJsonElement(buildJsonObject {
            put("serverName", value.serverName)
            value.hosts?.let { put("hosts", output.json.encodeToJsonElement(it)) }
            put("endpoints", output.json.encodeToJsonElement(value.endpoints))
            value.e2e?.let { descriptor ->
                put("e2e", buildJsonObject {
                    put("v", 1)
                    put("k", descriptor.k)
                    descriptor.h?.let { put("h", it) }
                    if (descriptor.relays.isNotEmpty()) {
                        put("r", buildJsonArray { descriptor.relays.forEach { add(JsonPrimitive(it)) } })
                    }
                    descriptor.routes?.let { put("routes", it) }
                })
            }
        })
    }
}

@Serializable(with = CloudDesktopSessionSerializer::class)
data class CloudDesktopSession(val url: URI)

/** `POST /api/bots/:id/computer/control`: whether the computer is held, and by this lease. */
@Serializable
data class ComputerControl(val held: Boolean = false, val owned: Boolean = false)

/**
 * `POST /api/bots/:id/local-computer/join`: the sidecar rewrites the viewer into
 * a device-scoped relay path, so this is relative to the paired origin (unlike
 * the cloud viewer's absolute HTTPS URL).
 */
@Serializable
data class LocalComputerJoin(val joinUrl: String? = null) {
    /** The WebSocket path a noVNC `websockify` endpoint answers on. */
    val socketPath: String?
        get() {
            val path = joinUrl?.substringBefore('#')?.takeIf { it.startsWith("/") } ?: return null
            return if (path.endsWith("/websockify")) path else "$path/websockify"
        }

    /**
     * The VM's VNC password, when the viewer URL carries one in its fragment:
     * a direct server pairing is told the password out of band, and noVNC
     * reads it from the same query string this parses.
     */
    val password: String?
        get() {
            val fragment = joinUrl?.substringAfter('#', "") ?: return null
            if (fragment.isEmpty()) return null
            return fragment.split('&')
                .firstOrNull { it.startsWith("password=") }
                ?.substringAfter('=')
                ?.let { runCatching { java.net.URLDecoder.decode(it, "UTF-8") }.getOrNull() }
                ?.takeIf { it.isNotEmpty() }
        }
}

object CloudDesktopSessionSerializer : KSerializer<CloudDesktopSession> {
    @Serializable
    private data class Wire(@SerialName("joinUrl") val joinUrl: String)

    override val descriptor: SerialDescriptor = Wire.serializer().descriptor

    override fun deserialize(decoder: Decoder): CloudDesktopSession {
        val raw = Wire.serializer().deserialize(decoder).joinUrl
        val parsed = runCatching { URI(raw) }.getOrNull()
        if (parsed == null || !parsed.scheme.equals("https", ignoreCase = true) || parsed.host.isNullOrEmpty()) {
            throw SerializationException("Cloud desktop URL must be HTTPS with a host")
        }
        return CloudDesktopSession(parsed)
    }

    override fun serialize(encoder: Encoder, value: CloudDesktopSession) {
        Wire.serializer().serialize(encoder, Wire(value.url.toASCIIString()))
    }
}

@Serializable
data class ProviderSnapshot(
    val state: String,
    val reason: String? = null,
    val authenticated: Boolean? = null,
    val version: String? = null,
) {
    val isAvailable: Boolean get() = state == "available"
}

@Serializable
data class ModelOption(val id: String, val label: String)

@Serializable
data class ModelCatalog(
    @SerialName("default") val defaultModel: String,
    val options: List<ModelOption>,
)

@Serializable
data class Instance(
    val instanceId: String,
    val driverKind: String,
    val displayName: String? = null,
    val snapshot: ProviderSnapshot,
    val models: ModelCatalog,
    /** Older computers omit capabilities; omission is intentionally not permission. */
    val capabilities: InstanceCapabilities? = null,
) {
    val id: String get() = instanceId
}

/**
 * The small, phone-safe part of an engine's capabilities. Missing capabilities
 * or effort levels mean the engine offers no reasoning control.
 */
@Serializable
data class InstanceCapabilities(
    val images: Boolean? = null,
    val effortLevels: List<String>? = null,
    /**
     * The engine can take a message into a turn that is already running.
     * Engines without it hold mid-turn sends until the turn settles, which is
     * a different promise and deserves different words in the composer.
     */
    val queueing: Boolean? = null,
)

@Serializable
data class InstanceList(val instances: List<Instance>)

/**
 * A reply split into utterances the computer can voice, and whether it can
 * voice them at all — `POST /api/tts/prepare`.
 */
@Serializable
data class PreparedSpeech(val ready: Boolean, val utterances: List<String>)

/**
 * Which engine actually speaks. `VoiceProvider` in `server/tts/index.ts`;
 * [wire] is the exact string the config write carries, and [fromWire] applies
 * the server's own fallback: a missing field — an older desktop that predates
 * the choice — and a provider this build has never heard of both mean
 * ElevenLabs, keeping an unrecognised engine from being explained with copy
 * written for a different one.
 */
enum class VoiceProvider(val wire: String) {
    ELEVENLABS("elevenlabs"),
    FISH("fish"),
    SYSTEM("system"),
    CHATTERBOX("chatterbox"),
    // 桌面端 `tts.provider` 已超出手机最初支持的四个引擎。缺少这些值时，
    // xAI、Gemini、OpenAI、豆包或千问工作区会被读成 ElevenLabs：标签错误、
    // 缺钥提示错误，选择器也无法说出当前引擎。
    XAI("xai"),
    GEMINI("gemini"),
    OPENAI("openai"),
    VOLC("volc"),
    QWEN("qwen");

    companion object {
        fun fromWire(value: String?): VoiceProvider = entries.firstOrNull { it.wire == value } ?: ELEVENLABS
    }
}

@Serializable
data class ConfigFlag(
    val configured: Boolean,
    val apiKeyConfigured: Boolean? = null,
    val ready: Boolean? = null,
    val voice: String? = null,
    /**
     * The voice engine, absent on desktops older than the built-in provider.
     * Read it through `ConfigStatus.voiceProvider`, which applies the
     * server's own fallback; nothing should compare this string directly.
     */
    val provider: String? = null,
)

@Serializable
data class Profile(val name: String, val email: String)

@Serializable
data class SeedanceConfigFlag(
    val provider: String = "ark",
    val resolution: String = "720p",
    val configured: Boolean = false,
    val ready: Boolean? = null,
    val arkConfigured: Boolean? = null,
    val tk1688Configured: Boolean? = null,
) {
    val isReady: Boolean get() = ready == true || configured
}

@Serializable
data class ConfigStatus(
    val composio: ConfigFlag? = null,
    val box: ConfigFlag? = null,
    val tts: ConfigFlag? = null,
    val imageGen: ConfigFlag? = null,
    val seedance: SeedanceConfigFlag? = null,
    val profile: Profile? = null,
    /** Live-call readiness as the computer reports it (never its key). */
    val live: ConfigFlag? = null,
) {
    /**
     * "This engine can speak", not "a key is on file" — under the built-in
     * provider `providerConfigured` in `server/tts/index.ts` reports whether
     * the computer has usable voices, and no credential exists at all. The
     * flag stays provider-neutral; only the reason behind it changes.
     */
    val isTTSConfigured: Boolean
        get() = tts?.configured == true || tts?.apiKeyConfigured == true

    val hasWorkspaceDefaultVoice: Boolean
        get() = !tts?.voice.isNullOrBlank()

    fun canSpeak(agentVoice: String?): Boolean =
        isTTSConfigured && (!agentVoice.isNullOrBlank() || hasWorkspaceDefaultVoice)

    /**
     * `voiceProvider(cfg)` in `server/tts/index.ts`: only a known, exact wire
     * value selects its engine. Everything else falls back to ElevenLabs
     * through [VoiceProvider.fromWire], which is the server's own rule.
     */
    val voiceProvider: VoiceProvider
        get() = VoiceProvider.fromWire(tts?.provider)

    /**
     * The socket relay (`/api/live/relay`) only carries providers whose
     * realtime transport is a WebSocket; the others call over WebRTC, which
     * this build does not carry.
     */
    val hasSocketLiveCall: Boolean
        get() = live?.configured == true && live?.provider.orEmpty() in LiveRelay.SOCKET_PROVIDERS
}

object ConnectedAppsRules {
    const val MAX_ACCOUNT_ALIAS_LENGTH = 64
    const val MAX_ACCOUNTS_PER_CONNECTOR = 5
    const val PRIMARY_ACCOUNT_LABEL = "主账号"

    val firstAccountAlias: String? = null

    fun additionalAccountAlias(input: String): String? =
        trimmedAlias(input)?.take(MAX_ACCOUNT_ALIAS_LENGTH)

    fun canAddAnotherAccount(accounts: List<ConnectorAccount>): Boolean =
        accounts.size < MAX_ACCOUNTS_PER_CONNECTOR

    internal fun trimmedAlias(input: String?): String? =
        input?.trim { it.isWhitespace() }?.takeIf { it.isNotEmpty() }
}

@Serializable
data class ConnectorCard(
    val slug: String,
    val label: String,
    val blurb: String,
    val logo: String? = null,
    val domain: String? = null,
) {
    val id: String get() = slug
}

@Serializable
data class ConnectorAccount(
    val id: String,
    val alias: String? = null,
    val status: String,
) {
    val displayName: String
        get() = ConnectedAppsRules.trimmedAlias(alias) ?: ConnectedAppsRules.PRIMARY_ACCOUNT_LABEL

    val isActive: Boolean
        get() = status.trim { it.isWhitespace() }.uppercase() == "ACTIVE"
}

@Serializable
data class ConnectorStatus(
    val connected: Boolean,
    val pending: Boolean? = null,
    val status: String? = null,
    val accounts: List<ConnectorAccount>? = null,
)

@Serializable
data class ConnectorCatalog(
    val configured: Boolean,
    val mode: String? = null,
    val source: String? = null,
    val cards: List<ConnectorCard>,
)

@Serializable
data class ConnectorStatuses(
    val configured: Boolean,
    val services: Map<String, ConnectorStatus>,
    /**
     * "ok", "unavailable", or absent on a desktop that predates the field.
     * Read it through `isAuthoritative`; nothing should compare it directly.
     */
    val credentialStore: String? = null,
) {
    /**
     * Whether `services` is an inventory or an admission of ignorance.
     *
     * `server/index.ts` answers an unreadable Composio credential store with
     * an empty map *and* `credentialStore: "unavailable"`, because not being
     * able to read the store means we do not know what is connected — which
     * is not the same as knowing nothing is. An empty map that arrives this
     * way must never be shown as "nothing is connected"; every account may
     * still be live on the computer.
     *
     * Only that exact string withdraws the claim. "ok" is authoritative, and
     * so is a missing field: a desktop old enough not to send it would
     * otherwise have every answer treated as unknowable.
     */
    val isAuthoritative: Boolean
        get() = credentialStore != "unavailable"
}

@Serializable(with = BotProfilePatchSerializer::class)
data class BotProfilePatch(
    val name: String? = null,
    val title: String? = null,
    val description: String? = null,
    val notifications: Boolean? = null,
    val avatarUrl: AvatarURL? = null,
    val avatarCrop: AvatarCrop? = null,
    val avatarStates: AvatarStates? = null,
    val mascotBody: String? = null,
    val voice: String? = null,
    val speakReplies: Boolean? = null,
) {
    sealed interface AvatarURL {
        data class Set(val path: String) : AvatarURL
        data object Clear : AvatarURL
    }

    sealed interface AvatarStates {
        data class Set(val states: Map<String, String>) : AvatarStates
        data object Clear : AvatarStates
    }
}

object BotProfilePatchSerializer : KSerializer<BotProfilePatch> {
    private val fieldNames = setOf(
        "name",
        "title",
        "description",
        "notifications",
        "avatarUrl",
        "avatarCrop",
        "avatarStates",
        "mascotBody",
        "voice",
        "speakReplies",
    )

    override val descriptor = buildClassSerialDescriptor("BotProfilePatch") {
        element<String>("name", isOptional = true)
        element<String>("title", isOptional = true)
        element<String>("description", isOptional = true)
        element<Boolean>("notifications", isOptional = true)
        element<JsonElement>("avatarUrl", isOptional = true)
        element<String>("avatarCrop", isOptional = true)
        element<JsonElement>("avatarStates", isOptional = true)
        element<String>("mascotBody", isOptional = true)
        element<String>("voice", isOptional = true)
        element<Boolean>("speakReplies", isOptional = true)
    }

    override fun serialize(encoder: Encoder, value: BotProfilePatch) {
        val output = encoder as? JsonEncoder
            ?: throw SerializationException("BotProfilePatch can only be encoded as JSON")
        output.encodeJsonElement(buildJsonObject {
            value.name?.let { put("name", it) }
            value.title?.let { put("title", it) }
            value.description?.let { put("description", it) }
            value.notifications?.let { put("notifications", it) }
            when (val avatarUrl = value.avatarUrl) {
                is BotProfilePatch.AvatarURL.Set -> put("avatarUrl", avatarUrl.path)
                BotProfilePatch.AvatarURL.Clear -> put("avatarUrl", JsonNull)
                null -> Unit
            }
            value.avatarCrop?.let { put("avatarCrop", it.name.lowercase()) }
            when (val states = value.avatarStates) {
                is BotProfilePatch.AvatarStates.Set -> put(
                    "avatarStates",
                    buildJsonObject {
                        states.states.forEach { (k, v) -> put(k, v) }
                    },
                )
                BotProfilePatch.AvatarStates.Clear -> put("avatarStates", JsonNull)
                null -> Unit
            }
            value.mascotBody?.let { put("mascotBody", it) }
            value.voice?.let { put("voice", it) }
            value.speakReplies?.let { put("speakReplies", it) }
        })
    }

    override fun deserialize(decoder: Decoder): BotProfilePatch {
        val input = decoder as? JsonDecoder
            ?: throw SerializationException("BotProfilePatch can only be decoded from JSON")
        val value = input.decodeJsonElement().jsonObject
        val unknown = value.keys - fieldNames
        if (unknown.isNotEmpty()) {
            throw SerializationException("Unsupported profile field: ${unknown.first()}")
        }

        fun string(name: String): String? {
            val element = value[name] ?: return null
            if (element is JsonNull) throw SerializationException("$name must be a string")
            val primitive = element as? JsonPrimitive
                ?: throw SerializationException("$name must be a string")
            if (!primitive.isString) throw SerializationException("$name must be a string")
            return primitive.content
        }

        fun boolean(name: String): Boolean? {
            val element = value[name] ?: return null
            val primitive = element as? JsonPrimitive
                ?: throw SerializationException("$name must be true or false")
            return primitive.booleanOrNull
                ?: throw SerializationException("$name must be true or false")
        }

        val avatarUrl = when (val element = value["avatarUrl"]) {
            null -> null
            JsonNull -> BotProfilePatch.AvatarURL.Clear
            else -> BotProfilePatch.AvatarURL.Set(string("avatarUrl")!!)
        }
        val crop = string("avatarCrop")?.let { raw ->
            AvatarCrop.entries.firstOrNull { it.name.lowercase() == raw }
                ?: AvatarCrop.MASCOT
        }
        val avatarStates = when (val element = value["avatarStates"]) {
            null -> null
            JsonNull -> BotProfilePatch.AvatarStates.Clear
            is JsonObject -> BotProfilePatch.AvatarStates.Set(
                element.mapNotNull { (k, v) ->
                    val primitive = v as? JsonPrimitive
                    if (primitive != null && primitive.isString) k to primitive.content else null
                }.toMap(),
            )
            else -> throw SerializationException("avatarStates must be an object or null")
        }
        return BotProfilePatch(
            name = string("name"),
            title = string("title"),
            description = string("description"),
            notifications = boolean("notifications"),
            avatarUrl = avatarUrl,
            avatarCrop = crop,
            avatarStates = avatarStates,
            mascotBody = string("mascotBody"),
            voice = string("voice"),
            speakReplies = boolean("speakReplies"),
        )
    }
}

@Serializable
data class Voice(
    val id: String,
    val label: String,
    val description: String? = null,
)

@Serializable
data class RoutineSchedule(
    val type: Kind,
    val at: Double? = null,
    val time: String? = null,
    val weekdays: List<Int>? = null,
    val everyMinutes: Int? = null,
    val anchorAt: Long? = null,
) {
    @Serializable(with = RoutineScheduleKindSerializer::class)
    enum class Kind { ONCE, DAILY, INTERVAL, UNKNOWN }

    companion object {
        fun once(atMillis: Double): RoutineSchedule = RoutineSchedule(Kind.ONCE, at = atMillis)

        fun daily(time: String, weekdays: List<Int>): RoutineSchedule =
            RoutineSchedule(Kind.DAILY, time = time, weekdays = weekdays)

        fun interval(everyMinutes: Int, anchorAtMillis: Long): RoutineSchedule =
            RoutineSchedule(
                Kind.INTERVAL,
                everyMinutes = everyMinutes,
                anchorAt = anchorAtMillis,
            )
    }
}

object RoutineScheduleKindSerializer : KSerializer<RoutineSchedule.Kind> {
    override val descriptor = PrimitiveSerialDescriptor("RoutineSchedule.Kind", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): RoutineSchedule.Kind = when (decoder.decodeString()) {
        "once" -> RoutineSchedule.Kind.ONCE
        "daily" -> RoutineSchedule.Kind.DAILY
        "interval" -> RoutineSchedule.Kind.INTERVAL
        else -> RoutineSchedule.Kind.UNKNOWN
    }

    override fun serialize(encoder: Encoder, value: RoutineSchedule.Kind) {
        encoder.encodeString(value.name.lowercase())
    }
}

@Serializable
data class Routine(
    val id: String,
    val name: String,
    val prompt: String,
    val botId: String,
    val runOn: String,
    val enabled: Boolean,
    val schedule: RoutineSchedule,
    /** Legacy calendar/display length retained for older desktop compatibility. */
    val durationMinutes: Int,
    /** Optional execution guard. Missing means the routine has no time limit. */
    val timeoutMinutes: Int? = null,
    val nextRunAt: Double? = null,
    val createdAt: Double,
    val updatedAt: Double,
) {
    val runLocation: RoutineRunLocation
        get() = RoutineRunLocation.entries.firstOrNull { it.wireValue == runOn }
            ?: RoutineRunLocation.MAUS

    fun canToggle(atMillis: Double = System.currentTimeMillis().toDouble()): Boolean = when (schedule.type) {
        RoutineSchedule.Kind.DAILY -> true
        RoutineSchedule.Kind.INTERVAL ->
            (schedule.everyMinutes ?: 0) in 5..1_440 && schedule.anchorAt != null
        RoutineSchedule.Kind.ONCE -> (schedule.at ?: Double.NEGATIVE_INFINITY) > atMillis
        RoutineSchedule.Kind.UNKNOWN -> false
    }
}

@Serializable
data class RoutineRun(
    val id: String,
    val routineId: String,
    val routineName: String,
    val prompt: String? = null,
    /** Legacy calendar/display length snapshot. */
    val durationMinutes: Int? = null,
    /** Optional execution-guard snapshot. */
    val timeoutMinutes: Int? = null,
    val botId: String,
    val runOn: String,
    val scheduledFor: Double,
    val status: String,
    val manual: Boolean,
    val triggerSource: String? = null,
    val threadId: String? = null,
    val startedAt: Double? = null,
    val finishedAt: Double? = null,
    val output: String? = null,
    val error: String? = null,
    val createdAt: Double,
    val seenAt: Double? = null,
)

@Serializable
data class RoutineInput(
    val name: String,
    val prompt: String,
    val botId: String,
    val runOn: String = "maus",
    val enabled: Boolean? = null,
    val schedule: RoutineSchedule,
    /** Still required by older paired desktops; it is not the execution timeout. */
    val durationMinutes: Int = 30,
    /** A value replaces the stored limit; null leaves it unchanged on PATCH. */
    val timeoutMinutes: Int? = null,
    /** Interpreted by CompanionClient as an explicit JSON null. */
    @kotlinx.serialization.Transient val clearTimeout: Boolean = false,
)

@Serializable
enum class RoutineRunLocation(val wireValue: String) {
    @SerialName("maus")
    MAUS("maus"),

    @SerialName("cloud")
    CLOUD("cloud"),
}

data class RoutineRunAvailability(
    val cloudConfigured: Boolean,
    val cloudInstanceAvailable: Boolean,
) {
    constructor(config: ConfigStatus?, instances: List<Instance>) : this(
        cloudConfigured = config?.box?.configured == true,
        cloudInstanceAvailable = instances.any {
            it.driverKind == "boxAgent" && it.snapshot.isAvailable
        },
    )

    val cloudReady: Boolean get() = cloudConfigured && cloudInstanceAvailable

    fun canSelect(location: RoutineRunLocation, preserving: RoutineRunLocation): Boolean =
        location == RoutineRunLocation.MAUS || cloudReady || preserving == RoutineRunLocation.CLOUD
}

@Serializable
data class APIErrorBody(val error: String)

data class ScreenFrame(val png: String, val mime: String) {
    val data: ByteArray?
        get() = try {
            Base64.getDecoder().decode(png)
        } catch (_: IllegalArgumentException) {
            null
        }
}

/**
 * This computer's own screen. [imageWidth]/[imageHeight] are the pixels in [png]; [screenWidth]/[screenHeight] are the
 * logical points an action's x/y must be in, so a tap on the picture is scaled before it is sent.
 */
@Serializable
data class DesktopScreenFrame(
    val png: String,
    val mime: String = "image/png",
    val imageWidth: Int,
    val imageHeight: Int,
    val screenWidth: Int,
    val screenHeight: Int,
) {
    val data: ByteArray?
        get() = try {
            Base64.getDecoder().decode(png)
        } catch (_: IllegalArgumentException) {
            null
        }

    /** A point on the drawn picture, in the screen points the server takes. */
    fun toScreen(x: Float, y: Float): Pair<Float, Float> {
        if (imageWidth <= 0 || imageHeight <= 0) return x to y
        return (x * screenWidth / imageWidth) to (y * screenHeight / imageHeight)
    }
}

@Serializable
data class CreatedBot(val bot: Bot)

@Serializable
data class CreatedRoom(val group: Room)

@Serializable
internal data class SearchResponse(val hits: List<SearchHit>)

@Serializable
internal data class MessageToolOutputResponse(val output: String? = null)

@Serializable
internal data class MessageResponse(val message: Message)

/** `GET /api/team-map` 的应答：bot 两两协作的 DM、排队中与进行中的委派边。
 * 只读观测面——手机端不做任何 team-map 写操作（本来也没有写路由）。 */
@Serializable
data class TeamMapResponse(
    val collaborations: List<TeamMapCollaboration> = emptyList(),
    val queued: List<TeamMapHandoff> = emptyList(),
    val running: List<TeamMapHandoff> = emptyList(),
)

@Serializable
data class TeamMapCollaboration(
    val groupId: String,
    val botIds: List<String>,
    val lastAt: Double = 0.0,
)

@Serializable
data class TeamMapHandoff(
    val sourceBotId: String,
    val targetBotId: String,
    val groupId: String? = null,
    val threadId: String? = null,
)

@Serializable
internal data class EditResponse(val message: Message? = null)

@Serializable
internal data class ActiveBranchResponse(val activeLeafId: String)

@Serializable
internal data class BotResponse(val bot: Bot)

@Serializable
internal data class RoomResponse(val group: Room)

/** The narrow sidebar organizer route returns just the affected bots. */
@Serializable
internal data class SidebarSectionResponse(val section: String, val bots: List<Bot>)

@Serializable
internal data class VoiceListResponse(val voices: List<Voice>, val error: String? = null)

@Serializable
internal data class AttachmentResponse(val path: String, val mime: String, val bytes: Int)

@Serializable
internal data class FileUploadResponse(val path: String, val name: String, val mime: String, val bytes: Int)

@Serializable
internal data class GeneratedAvatarResponse(val avatarUrl: String, val bot: Bot)

@Serializable
internal data class GeneratedAvatarStateResponse(val state: String, val url: String, val bot: Bot)

@Serializable
internal data class ClaudeUpdateResponse(val version: String)

@Serializable
data class RoutinesResponse(val routines: List<Routine>, val runs: List<RoutineRun>)

@Serializable
internal data class RoutineResponse(val routine: Routine)

@Serializable
internal data class RoutineRunResponse(val run: RoutineRun)

@Serializable
internal data class ConnectorAuthorizationResponse(val url: String)

@Serializable
data class BotOverviewWho(val name: String, val title: String, val blurb: String, val soulLead: String)

@Serializable
data class BotOverviewRecent(val at: Double, val summary: String)

@Serializable
data class BotOverview(
    val who: BotOverviewWho,
    val does: List<String> = emptyList(),
    val reaches: List<String> = emptyList(),
    val wont: List<String> = emptyList(),
    val recent: List<BotOverviewRecent> = emptyList(),
)

/**
 * One MCP server as `GET /api/bots/:id/mcp-servers` reports it — names and
 * switches only, never the command, arguments or address, which is why that
 * route is open to phones while `/api/mcp/servers` is not.
 *
 * [enabled] is the server's switch in MCP settings; [on] is this bot's. A bot
 * with no `mcpServers` list takes every enabled server.
 */
@Serializable
data class McpServerEntry(
    val name: String,
    val enabled: Boolean = false,
    val on: Boolean = false,
    /** True when the server is explicitly off for this bot. */
    val offFor: Boolean? = null,
)

@Serializable
data class McpServersResponse(val servers: List<McpServerEntry> = emptyList())

/**
 * `GET /api/bots/:id/activity` 的一行：这个智能体用过的一件工具或求过的一次批准
 * （`shared/activity.ts`）。只解码手机要画的字段——`labelKey`/`summaryParams`
 * 是桌面端用自己的语言重述文案用的，手机直接画 `label` 与 `summary` 原文。
 *
 * [at] 是 ISO-8601 字符串；[outcome] 保持字符串不枚举，新结局类型出现在更新的
 * 电脑上时行仍在，只是没有对应的中文徽标词。
 */
@Serializable
data class BotActivityRow(
    val at: String,
    val threadId: String,
    val tool: String,
    val app: String? = null,
    val label: String = "",
    val summary: String? = null,
    val outcome: String = "ran",
)

@Serializable
data class BotActivityResponse(val rows: List<BotActivityRow> = emptyList())

/**
 * `GET /api/notifications` 的一条通知日志（`shared/notification.ts`）：电脑认为
 * 值得打扰人的每一件事，新的在前。[at] 是毫秒时间戳；[kind] 保持字符串不枚举，
 * 新种类出现在更新的电脑上时行仍在，只是归类到「其他」。
 */
@Serializable
data class NotificationLogRow(
    val id: String,
    val at: Long,
    val kind: String,
    val botId: String = "",
    val botName: String = "",
    val threadId: String = "",
    val title: String = "",
    val body: String = "",
    val groupId: String? = null,
    val read: Boolean = false,
)

@Serializable
data class NotificationLogResponse(val notifications: List<NotificationLogRow> = emptyList())

/** `InboxRow.from` / `via` / `workingFor` 的共同形状：谁来的、经谁转手。 */
@Serializable
data class InboxParty(
    val name: String,
    val botId: String? = null,
)

/** 收件箱一行来自哪个会话；手机只用它标注来源，不做跳转。 */
@Serializable
data class InboxOrigin(
    val botId: String = "",
    val threadId: String = "",
    val title: String = "",
    val groupId: String? = null,
)

/**
 * `GET /api/inbox` 的一行（`shared/inbox.ts`）。只解码手机要画的字段——
 * `card`/`secret`/`signIn`/`connector` 是桌面端在此回答卡片用的，手机的回答
 * 在会话里的卡片上做，这里一行也不展开。[kind] 与 [tab] 保持字符串不枚举。
 */
@Serializable
data class InboxRowLine(
    val id: String,
    val kind: String,
    val tab: String,
    val from: InboxParty,
    val text: String = "",
    val at: Long,
    val unread: Boolean = false,
    val via: InboxParty? = null,
    val workingFor: InboxParty? = null,
    val origin: InboxOrigin? = null,
)

@Serializable
data class InboxViewResponse(
    val botId: String? = null,
    val threadId: String? = null,
    val rows: List<InboxRowLine> = emptyList(),
    val anchor: String? = null,
)

@Serializable
data class InboxCountResponse(val count: Int = 0)

/**
 * `/api/team-memory` 的一条共享记忆。kind/status 保持字符串：更新的电脑
 * 增加种类时，手机仍画出原文而不是丢掉整条记忆。
 */
@Serializable
data class TeamMemorySource(
    val botId: String = "",
    val botName: String = "",
    val threadId: String = "",
    val at: Long = 0,
    val quote: String? = null,
)

@Serializable
data class TeamMemoryHistoryEntry(val name: String, val detail: String, val at: Long)

@Serializable
data class TeamMemoryEntry(
    val id: String,
    val kind: String,
    val name: String,
    val detail: String,
    val aliases: List<String> = emptyList(),
    val status: String,
    val source: TeamMemorySource = TeamMemorySource(),
    val updatedAt: Long = 0,
    val revision: String = "",
    val pinned: Boolean? = null,
    val key: String? = null,
    val history: List<TeamMemoryHistoryEntry>? = null,
)

@Serializable
data class TeamMemoryResponse(
    val section: String,
    val label: String,
    val entries: List<TeamMemoryEntry> = emptyList(),
    val loadedIds: List<String> = emptyList(),
)

/** 团队记忆写操作的响应：服务端只回最新的条目与加载选择，不重复分区名。 */
@Serializable
data class TeamMemoryMutationResponse(
    val entries: List<TeamMemoryEntry> = emptyList(),
    val loadedIds: List<String> = emptyList(),
)

/**
 * `GET /api/bots/:id/data` 的只读形状（`shared/data-surface.ts`）：sheet 上的卡片、
 * 加载过的来源与数据库里的表。只读是有意的——跑 SQL、改卡片、导出都不对手机开放。
 */
@Serializable
data class DataColumnEntry(
    val name: String,
    val type: String = "",
)

@Serializable
data class DataTableEntry(
    val name: String,
    val rowCount: Long = 0,
    val columns: List<DataColumnEntry> = emptyList(),
)

/** sheet 上的一张卡片。图表卡的图走 `data/cards/<id>/image` 单取，这里没有图。 */
@Serializable
data class DataCardEntry(
    val id: String,
    val kind: String,
    val title: String = "",
    val rowCount: Long? = null,
    val truncated: Boolean? = null,
    val text: String? = null,
    val status: String = "ready",
)

@Serializable
data class DataSourceEntry(
    val name: String,
    val kind: String = "",
    val rowCount: Long = 0,
)

@Serializable
data class DataSheetEntry(
    val cards: List<DataCardEntry> = emptyList(),
    val sources: List<DataSourceEntry> = emptyList(),
)

@Serializable
data class BotDataResponse(
    val sheet: DataSheetEntry = DataSheetEntry(),
    val tables: List<DataTableEntry> = emptyList(),
)

/**
 * `POST data/page` 的一页行。单元格原样保留 JSON——DuckDB 的 bigint 与 decimal
 * 到站就是字符串，画成文本时一视同仁。
 */
@Serializable
data class DataPageResponse(
    val columns: List<DataColumnEntry> = emptyList(),
    val rows: List<List<kotlinx.serialization.json.JsonElement>> = emptyList(),
    val rowCount: Long = 0,
    val offset: Int = 0,
)

/** Native server sessions returned by POST /api/auth/pair. */
@Serializable
data class ServerPairResponse(
    val token: String,
    val session: ServerSession,
    val environment: ServerEnvironment,
)

@Serializable
data class ServerSession(val id: String, val label: String, val scopes: List<String>)

@Serializable
data class ServerEnvironment(val environmentId: String, val label: String)

/** Unknown attachment kinds remain decodable and are not rendered. */
@Serializable
data class MessageImageAttachment(
    val kind: String,
    val path: String? = null,
    val mime: String? = null,
    /** `kind == "audio"`: the server's duration estimate, used until the player loads metadata. */
    val durationMs: Double? = null,
    /** The server's `attach_file` display name; parked TTS notes omit it. */
    val name: String? = null,
)
