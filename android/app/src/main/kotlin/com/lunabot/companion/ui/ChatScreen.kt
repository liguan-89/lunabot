package com.lunabot.companion.ui

import android.view.KeyCharacterMap
import androidx.activity.compose.BackHandler
import androidx.compose.material.icons.filled.Warning
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyItemScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import dev.chrisbanes.haze.hazeSource
import dev.chrisbanes.haze.rememberHazeState
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick as semanticsOnClick
import androidx.compose.ui.semantics.onLongClick as semanticsOnLongClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.lunabot.companion.R
import com.lunabot.companion.core.AttachmentPolicy
import com.lunabot.companion.core.Chat
import com.lunabot.companion.core.ChatTarget
import com.lunabot.companion.core.LocalMessageLink
import com.lunabot.companion.core.PendingMessageAttachment
import com.lunabot.companion.core.QueuedSend
import com.lunabot.companion.core.SearchHit
import com.lunabot.companion.core.CompanionState
import com.lunabot.companion.core.Dictation
import com.lunabot.companion.core.DisplayedMessageAttachment
import com.lunabot.companion.core.DownloadedFile
import com.lunabot.companion.core.Message
import com.lunabot.companion.core.QuickReply
import com.lunabot.companion.core.ThreadRef
import com.lunabot.companion.core.TranscriptRow
import com.lunabot.companion.core.target
import com.lunabot.companion.core.transcriptRows
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * One conversation: the transcript, the approval cards, and the composer — the
 * port of `ios/App/ChatView.swift`.
 *
 * The transcript is whatever the harness folded — settled text, tool chips,
 * option cards, screenshots. This renders those and nothing else; it does not
 * re-derive anything from provider events, because the server already did that
 * and having two folds is how two clients start disagreeing.
 *
 * The chrome floats: back and the bot's computer on a strip that fades into the
 * transcript, the bot's face and name over it, and the composer below. Everything
 * else scrolls underneath, which is what makes the conversation the screen.
 */
@Composable
fun ChatScreen(
    destination: Destination.Conversation,
    onResolved: (ChatTarget) -> Unit,
    onBack: () -> Unit,
    onOpenComputer: (String) -> Unit,
    onOpenOverview: (String) -> Unit,
    /**
     * True while this conversation is still on the navigator stack (including
     * under Computer). Used on dispose to keep the in-memory draft across a
     * push and drop it after a pop that removed the chat.
     */
    retainsDraft: (chatId: String) -> Boolean = { false },
    /** An "Opened thread" chip pointing at another bot pushes that chat. */
    onOpenChat: (Chat) -> Unit = {},
    /** True when hosted inside the root Muse 4-tab shell as Tab 0. */
    embedded: Boolean = false,
    /** When non-null, replaces the top-left Back button with Muse's `=` drawer button. */
    onOpenDrawer: (() -> Unit)? = null,
) {
    val session = LocalCompanion.current.session
    val state by session.state.collectAsState()

    // A notification tap at a cold start arrives before the fleet is hydrated,
    // and so does a navigation stack restored after the process was killed: wait
    // for it rather than concluding the chat is gone and bouncing back to the
    // roster, which would make the tap open nothing.
    val resolution = remember(state, destination) {
        ThreadResolution.resolve(state, destination)
    }
    when (resolution) {
        ThreadResolution.Result.Waiting -> OpeningThread(onBack = onBack, embedded = embedded, onOpenDrawer = onOpenDrawer)
        ThreadResolution.Result.Gone -> LaunchedEffect(destination) { if (!embedded) onBack() }
        // The live chat record, so busy/unread stay current as frames land.
        is ThreadResolution.Result.Open -> {
            // Resolve the owner without changing the task named by the destination.
            val resolved = (destination as? Destination.Thread)?.let { resolution.chat.target }
            LaunchedEffect(resolved) { if (resolved != null) onResolved(resolved) }
            LoadedChat(
                chat = resolution.chat,
                state = state,
                onBack = onBack,
                onOpenComputer = onOpenComputer,
                onOpenOverview = onOpenOverview,
                retainsDraft = retainsDraft,
                onSelectTask = onResolved,
                onOpenChat = onOpenChat,
                embedded = embedded,
                onOpenDrawer = onOpenDrawer,
            )
        }
    }
}

/** The transcript is on its way. Leaving is still possible while it is. */
@Composable
private fun OpeningThread(
    onBack: () -> Unit,
    embedded: Boolean = false,
    onOpenDrawer: (() -> Unit)? = null,
) {
    Column(modifier = Modifier.fillMaxSize().background(minisCanvas)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .padding(horizontal = 12.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (onOpenDrawer != null) {
                MuseDrawerButton(onClick = onOpenDrawer)
            } else {
                BackPill(unreadElsewhere = 0, onBack = onBack)
            }
        }
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
        }
    }
}

@Composable
private fun LoadedChat(
    chat: Chat,
    state: CompanionState,
    onBack: () -> Unit,
    onOpenComputer: (String) -> Unit,
    onOpenOverview: (String) -> Unit,
    retainsDraft: (chatId: String) -> Boolean,
    onSelectTask: (ChatTarget) -> Unit,
    onOpenChat: (Chat) -> Unit,
    embedded: Boolean = false,
    onOpenDrawer: (() -> Unit)? = null,
) {
    // This screen's selected task, independent of the desktop's selection.
    val threadId = chat.threadId
    val chatId = chat.id
    val draftKey = chat.threadId
    val environment = LocalCompanion.current
    val session = environment.session
    val dictation = environment.dictation
    val chatDrafts = environment.chatDrafts
    val haptics = rememberHaptics()
    val scope = rememberCoroutineScope()
    var threadOpenJob by remember { mutableStateOf<Job?>(null) }
    DisposableEffect(threadId) {
        onDispose { threadOpenJob?.cancel() }
    }
    val lifecycleOwner = LocalLifecycleOwner.current
    // Words this computer is holding until the running turn settles.
    val queuedSends = state.pendingQueued[threadId].orEmpty()
    val steeringInstanceIds by session.steeringInstanceIds.collectAsState()
    // Whether this bot's engine can take a message INTO the running turn.
    // Unknown reads as false, which is the promise that is always safe to
    // make: the message will be sent, just not necessarily right now.
    val steerTarget = (chat as? Chat.BotChat)?.bot
    val engineCanSteer = steerTarget?.modelSelection?.instanceId
        ?.let { it in steeringInstanceIds }
        ?: false
    // A Steer is in flight. Cleared when the queue drains or the turn ends,
    // whichever the engine gets to first — and after twenty seconds even if
    // neither frame ever arrives, because a control that spins for ever is
    // worse than one that admits it does not know.
    var steering by remember(threadId) { mutableStateOf(false) }
    LaunchedEffect(queuedSends.size, chat.busy) {
        if (queuedSends.isEmpty() || !chat.busy) steering = false
    }
    LaunchedEffect(steering) {
        if (steering) {
            delay(20_000)
            steering = false
        }
    }
    val steerNow: (() -> Unit)? = steerTarget?.let { target ->
        {
            haptics.play(HapticCue.SELECT)
            dictation.stop()
            steering = true
            scope.launch { session.interrupt(target) }
        }
    }
    var showingTasks by remember { mutableStateOf(false) }
    var creatingThread by remember(chatId) { mutableStateOf(false) }
    // Saveable: the profile form is a form, and a rotation must not throw away
    // what was typed into it — the sheet has to come back for that to matter.
    var showingProfile by rememberSaveable { mutableStateOf(false) }
    // Search is a full-screen overlay rather than an inline filter: the
    // transcript is paged, so results need room to scroll and the query must
    // survive a rotation.
    var searching by rememberSaveable { mutableStateOf(false) }
    var searchQuery by rememberSaveable { mutableStateOf("") }
    var showingPlus by remember(threadId) { mutableStateOf(false) }
    // 短按与按住说话是同一次按下的两种结局：卡片随手指落下即开并开始录音，
    // 提前松手（< 400ms）留在卡片上继续录、由卡内按钮发送；按住超时则
    // 松手即发送、卡片随之消失。
    var voiceCardOpen by remember(threadId) { mutableStateOf(false) }
    var voiceHold by remember(threadId) { mutableStateOf(false) }
    // The bot on the line. Not saveable: a call does not survive a rotation's
    // teardown of the audio session any better than a phone call would.
    var showingCall by remember { mutableStateOf(false) }
    // Real-time when the computer's Live provider speaks the socket relay;
    // the half-duplex dictation call stays the fallback for every other case.
    var liveCall by remember { mutableStateOf(false) }
    val focusManager = LocalFocusManager.current
    val context = LocalContext.current
    val uriHandler = LocalUriHandler.current
    val openCall: () -> Unit = {
        dictation.stop()
        focusManager.clearFocus()
        scope.launch {
            // Once a socket call proved viable it stays the pick: re-probing
            // /api/config on every tap could silently downgrade to the other
            // call UI on a transient miss.
            if (!liveCall) liveCall = session.liveCallRelayReady()
            showingCall = true
        }
    }

    val attachmentDraft = remember(draftKey, chatDrafts) {
        chatDrafts.register(chatId, draftKey)
        chatDrafts.attachments(draftKey)
    }
    val attachments = attachmentDraft.items
    var preparingAttachments by attachmentDraft.preparing
    var sendingMessage by attachmentDraft.sending
    var attachmentError by attachmentDraft.error
    // A notification can change owners while the system picker is open.
    // Its result still belongs to the draft that launched it.
    var pickerDraft by remember { mutableStateOf(attachmentDraft) }
    // A bot-linked file on its way from the computer, and where it landed.
    var openingFileName by remember(threadId) { mutableStateOf<String?>(null) }
    var fileOpenError by remember(threadId) { mutableStateOf<String?>(null) }
    var filePreview by remember(threadId) { mutableStateOf<FilePreviewItem?>(null) }
    var fileDownloadJob by remember(threadId) { mutableStateOf<Job?>(null) }
    val filePreviews = remember(context) { FilePreviews(context) }
    DisposableEffect(filePreviews) {
        onDispose {
            fileDownloadJob?.cancel()
            filePreviews.clear()
        }
    }
    DisposableEffect(filePreviews, threadId) {
        onDispose {
            // LoadedChat follows the bot when its task changes. Invalidate the
            // old request and its published preview as one lifecycle step; a
            // late completion can no longer write into the next task's UI.
            filePreviews.invalidateCurrent()
            fileDownloadJob?.cancel()
        }
    }
    val canAddAttachment = AttachmentImportRules.canAdd(attachments.size, preparingAttachments, sendingMessage)

    suspend fun importInto(target: ChatDraftHolder.Attachments, count: Int, read: suspend (Int, Int) -> PendingMessageAttachment) {
        if (target.preparing.value || target.sending.value) return
        val existing = target.items.toList()
        if (count > AttachmentPolicy.MAXIMUM_ITEMS - existing.size) {
            target.error.value = AttachmentImportRules.TOO_MANY
            return
        }
        target.preparing.value = true
        target.error.value = null
        try {
            val imported = mutableListOf<PendingMessageAttachment>()
            for (index in 0 until count) {
                val remaining = AttachmentImportRules.remainingBytes(existing + imported)
                val candidate = withContext(Dispatchers.IO) { read(index, remaining) }
                AttachmentPolicy.validate(existing + imported + candidate)
                imported += candidate
            }
            target.items += imported
            haptics.play(HapticCue.SELECT)
        } catch (error: Exception) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            target.error.value = error.message ?: "无法添加该附件。"
        } finally {
            target.preparing.value = false
        }
    }

    val pickPhotos = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(AttachmentPolicy.MAXIMUM_ITEMS),
    ) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        val target = pickerDraft
        scope.launch {
            importInto(target, uris.size) { index, remaining ->
                AttachmentImport.readPhoto(context.contentResolver, uris[index], index, uris.size, remaining)
            }
        }
    }
    val pickFiles = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        val target = pickerDraft
        scope.launch {
            importInto(target, uris.size) { index, remaining ->
                AttachmentImport.readDocument(context.contentResolver, uris[index], remaining)
            }
        }
    }

    /** Every computer-local attachment takes the authenticated message-file route. */
    fun openFile(
        path: String,
        message: Message,
        prepared: DownloadedFile? = null,
        preferredName: String? = null,
        cacheResult: Boolean = false,
    ) {
        val requestGeneration = filePreviews.beginRequest()
        val requestedThreadId = threadId
        fileDownloadJob?.cancel()
        fileOpenError = null
        openingFileName = preferredName ?: prepared?.filename ?: FilePreviewRules.nameForOpening(path)
        fileDownloadJob = scope.launch {
            val fetched = prepared ?: session.downloadFile(
                requestedThreadId,
                message.id,
                path,
                cacheResult = cacheResult,
            )
            if (!filePreviews.isCurrent(requestGeneration)) return@launch
            openingFileName = null
            if (fetched == null) {
                fileOpenError = session.actionError ?: "无法打开该文件，请重试。"
                session.actionError = null
                return@launch
            }
            val item = try {
                // The tag's display name labels the card only. Materialising
                // and sharing must use the canonical Content-Disposition name
                // returned by the scoped download route.
                withContext(Dispatchers.IO) { filePreviews.store(fetched, requestGeneration) }
            } catch (error: kotlinx.coroutines.CancellationException) {
                throw error
            } catch (_: Throwable) {
                if (!filePreviews.isCurrent(requestGeneration)) return@launch
                fileOpenError = "已下载的文件无法预览。"
                return@launch
            } ?: return@launch
            if (!filePreviews.isCurrent(requestGeneration)) return@launch
            filePreview = item
        }
    }

    // A tapped link in a bot reply: the web goes to the system, a desktop path
    // comes back through the computer, anything else is refused out loud.
    fun openLink(url: String, message: Message) {
        when (val target = LocalMessageLink.resolve(url)) {
            is LocalMessageLink.Web -> runCatching { uriHandler.openUri(target.url) }
                .onFailure { fileOpenError = "此手机无法打开该链接。" }
            is LocalMessageLink.DesktopFile -> openFile(target.path, message)
            null -> fileOpenError = "无法安全地打开此链接。"
        }
    }

    fun openAttachment(
        attachment: DisplayedMessageAttachment,
        message: Message,
        downloaded: DownloadedFile?,
    ) = openFile(
        attachment.path,
        message,
        downloaded,
        preferredName = attachment.name,
        cacheResult = true,
    )

    // A chip that opened a thread on this bot switches this screen in place,
    // the way a thread row does; one that opened a thread on a teammate pushes
    // that chat.
    fun openThread(ref: ThreadRef) {
        threadOpenJob?.cancel()
        threadOpenJob = scope.launch {
            val bot = session.openThread(ref) ?: return@launch
            if (bot.id == chatId) onSelectTask(ChatTarget.Bot(bot.id, bot.threadId)) else onOpenChat(Chat.BotChat(bot))
        }
    }
    val focusedMessageId by session.focusedMessageId.collectAsState()

    val dictationListening by dictation.isListening.collectAsState()
    val dictationStarting by dictation.isStarting.collectAsState()
    val dictationError by dictation.error.collectAsState()
    val dictationLocked = dictationListening || dictationStarting

    val rawTranscript = remember(state, threadId) { state.visibleTranscript(threadId) }
    val activityDetail by environment.chatPreferences.activityDetail.collectAsState()
    val quickReplies by environment.chatPreferences.quickReplies.collectAsState()
    // The source transcript stays intact for approvals, mascot state and
    // pagination. Only the rendered rows fold activity according to the local
    // preference, so changing the choice never mutates server state.
    val transcript = remember(rawTranscript, activityDetail) {
        transcriptRows(collapseRepeatedReceipts(rawTranscript), activityDetail)
    }
    var expandedTurns by remember(threadId) { mutableStateOf(emptySet<String>()) }
    var revealedTurnMessageId by remember(threadId) { mutableStateOf<String?>(null) }
    val lastTranscriptId = rawTranscript.lastOrNull()?.id
    var dismissedQuickChipsForId by remember(threadId) { mutableStateOf<String?>(null) }
    val predictiveChips = remember(quickReplies, rawTranscript) {
        contextualQuickReplies(rawTranscript, quickReplies)
    }
    val streaming = state.streaming[threadId]
    val reasoning = state.reasoning[threadId]
    // Stream, then reasoning, then the bare fact of being busy — the order in
    // `ChatView.swift`, and the reason it is a rule rather than three `if`s here.
    // `sendingMessage` is the gap between the tap and the harness's own busy
    // flag: without it the row stayed empty for the length of the POST, which
    // is exactly the moment a person expects to see the bot start.
    val tail = LiveTail.of(
        streaming = streaming,
        reasoning = reasoning,
        busy = chat.busy || sendingMessage,
        detail = activityDetail,
    )
    val liveText = streaming?.takeIf { tail == TranscriptTail.STREAM }
    val liveReasoning = reasoning?.takeIf { tail == TranscriptTail.REASONING }
    val hasMore = state.hasMore[threadId] == true
    // What stops the predictive chips from covering the one question on screen
    // that only a person can answer.
    val pendingApproval = remember(rawTranscript) {
        ComposerAccessories.hasPendingApproval(rawTranscript)
    }

    // One live composer per thread, including when an upload finishes after
    // switching away and back. Only typed text enters saved instance state;
    // dictation and attachments remain memory-only. Back clears this owner's
    // drafts, while a Computer push retains them.
    val heldOnEntry = remember(draftKey, chatDrafts) { chatDrafts.get(draftKey) }
    // Hoist the saver: building it inline in rememberSaveable reallocates the
    // Saver + both lambdas on every LoadedChat recomposition (partials included).
    val composerSaver = remember(draftKey, chatDrafts) {
        ChatComposerDraft.saver(draftKey, chatDrafts)
    }
    val composer = rememberSaveable(draftKey, chatDrafts, saver = composerSaver) {
        chatDrafts.composer(
            draftKey,
            initialSaveable = heldOnEntry?.typedSnapshot.orEmpty(),
        )
    }
    val draft = composer.text
    // The command HUD opens from the button *or* from a draft that starts with a
    // slash — and typing anything else closes it again. iOS drives that from
    // `onChange(of: draft)`, which fires however the draft moved, so the rule
    // lives in the one funnel every draft change goes through rather than in the
    // text field's callback alone.
    //
    // Seeded from the restored draft rather than from `false`: coming back from
    // Computer, or from a process death, is a mount and not an edit, so nothing
    // would ever re-apply the rule to a `/dif` that is already in the field.
    // Closing the HUD by hand still sticks — the seed runs once per mount, and
    // `remember` does not re-run it.
    var hudOpen by remember(draftKey, chatDrafts) {
        mutableStateOf(SlashCommands.openOnEntry(composer.text))
    }
    // One scroll position per conversation, and one that survives rotation:
    // a shared state carried the previous task's offset into a brand-new
    // topic, and a fresh topic could open anywhere but its first line.
    val listState = rememberSaveable(threadId, saver = LazyListState.Saver) { LazyListState() }
    // Captured once: the two jump paths run inside effects, where
    // LocalDensity.current cannot be read.
    val density = LocalDensity.current
    val hazeState = rememberHazeState()
    val topInset = WindowInsets.safeDrawing
        .only(WindowInsetsSides.Top)
        .asPaddingValues()
        .calculateTopPadding()
    var headerHeightPx by remember { mutableIntStateOf(0) }
    var composerHeightPx by remember { mutableIntStateOf(0) }
    val headerClearance = with(density) {
        if (headerHeightPx > 0) headerHeightPx.toDp() + 14.dp else HEADER_CLEARANCE
    } + topInset
    val bottomClearance = with(density) {
        if (composerHeightPx > 0) composerHeightPx.toDp() + BOTTOM_CONTENT_GAP else BOTTOM_CHROME_HEIGHT + 8.dp
    }
    // Whether new content keeps the transcript pinned to the newest row. True
    // until the reader scrolls up: a bot that streams while someone is reading
    // history must not drag them back down on every token. Sending, jumping to a
    // search hit and the "back to latest" button set it explicitly.
    val stickToBottom = remember(threadId) { mutableStateOf(true) }
    LaunchedEffect(listState, threadId) {
        snapshotFlow { listState.isScrollInProgress to listState.isAtBottom() }
            .collect { (scrolling, atBottom) ->
                if (scrolling) stickToBottom.value = atBottom
            }
    }
    val canScrollDown by remember { derivedStateOf { listState.canScrollForward } }

    fun publishFrom(composerDraft: ChatComposerDraft) {
        hudOpen = SlashCommands.opensOnDraft(composerDraft.text)
    }

    // Bind dictation to this chat's lifecycle: leaving the screen (including
    // pushing Computer) and process background both stop capture.
    DisposableEffect(lifecycleOwner, threadId) {
        dictation.bind(lifecycleOwner)
        onDispose { dictation.unbind(lifecycleOwner) }
    }

    // Drop the in-memory entry when the chat leaves the stack (roster pop or
    // stack rewrite). Keep it when Computer is pushed on top.
    DisposableEffect(chatId) {
        onDispose {
            if (!retainsDraft(chatId)) {
                chatDrafts.clearOwner(chatId)
            }
        }
    }

    // Always join against the text frozen at capture start. A newer partial
    // then replaces the older partial instead of duplicating it. Skip the
    // first emission: StateFlow replays a sticky transcript from a prior
    // session, and applying that on open would clobber this chat's draft.
    // Merged text stays in the volatile draft / holder — never in the
    // saveable typed snapshot.
    LaunchedEffect(threadId, dictation, showingCall) {
        if (showingCall) return@LaunchedEffect
        var first = true
        dictation.transcript.collect { next ->
            if (first) {
                first = false
                return@collect
            }
            // A call shares this recognizer: what it hears belongs to the
            // call's transcript, never to the half-typed draft behind it.
            if (showingCall) return@collect
            val merged = Dictation.draft(base = dictation.base, transcript = next)
            composer.onDictation(merged)
            publishFrom(composer)
        }
    }
    LaunchedEffect(dictationListening) {
        if (dictationListening) focusManager.clearFocus()
    }
    // Stop when computer / tasks / profile / plus open — matching ChatView.swift.
    LaunchedEffect(showingPlus) { if (showingPlus) dictation.stop() }
    LaunchedEffect(voiceCardOpen) { if (voiceCardOpen) dictation.stop() }
    LaunchedEffect(showingTasks) { if (showingTasks) dictation.stop() }
    LaunchedEffect(showingProfile) { if (showingProfile) dictation.stop() }
    LaunchedEffect(showingCall) { if (showingCall) dictation.stop() }

    val connection by session.connection.collectAsState()
    LaunchedEffect(chatId, threadId, connection?.id) {
        environment.chatPreferences.rememberThread(chat, connection?.id)
    }

    // Opening a chat is what marks it read, exactly as on the desktop — and a
    // message can arrive while it is already on screen, so this keys on the bit
    // rather than running once.
    LaunchedEffect(threadId, chat.unread) {
        if (chat.unread) session.markRead(chat)
    }
    // A non-resumable reconnect replaces the fleet snapshot and invalidates
    // history for nonactive threads. The open chat's ID has not changed, but
    // it must fetch its page again instead of waiting for the user to reopen it.
    LaunchedEffect(threadId, state.hasLoadedPage(threadId)) {
        session.loadThreadIfNeeded(threadId)
    }

    val composerAccessory = ComposerAccessories.accessory(
        hudOpen = hudOpen,
        draft = draft,
        busy = chat.busy,
        pendingApproval = pendingApproval,
        hasQuickReplies = predictiveChips.isNotEmpty(),
        hasAttachments = attachments.isNotEmpty(),
    )
    val showQuickChips = composerAccessory == ComposerAccessory.CHIPS &&
        predictiveChips.isNotEmpty() &&
        !showingPlus &&
        dismissedQuickChipsForId != lastTranscriptId
    val headerCount = if (hasMore) 1 else 0
    // One slot at the bottom, whichever of the three is in it — iOS gives all of
    // them the same `.id(Self.liveBubbleId)` for the same reason: they replace
    // one another, they do not stack.
    val liveCount = if (tail == TranscriptTail.NONE) 0 else 1
    val quickChipsCount = if (showQuickChips) 1 else 0
    val itemCount = headerCount + transcript.size + liveCount + quickChipsCount

    // A conversation grows from the bottom: opening a chat starts on the newest
    // message rather than the oldest.
    var settled by remember(threadId) { mutableStateOf(false) }
    LaunchedEffect(threadId, itemCount, state.hasLoadedPage(threadId)) {
        if (settled || itemCount == 0) return@LaunchedEffect
        // A restored chat composes a placeholder row while its page is still in
        // flight. Settling on that would mark the chat "positioned" at item zero
        // of a list that is about to become a hundred rows — and the reader would
        // land in the middle of history instead of the newest message. Wait for
        // the page the placeholder is standing in for.
        if (!state.hasLoadedPage(threadId)) return@LaunchedEffect
        listState.scrollToItem(itemCount - 1)
        settled = true
    }
    LaunchedEffect(threadId, transcript.lastOrNull()?.id) {
        if (!settled || itemCount == 0) return@LaunchedEffect
        if (stickToBottom.value) listState.animateScrollToItem(itemCount - 1)
    }
    // Follow the live row: its arrival, its change of kind, and the text inside
    // it. Keyed on length rather than the string so this fires once per delta
    // batch, and without animation — animating every token turns a smooth stream
    // into a stutter. [tail] is a key of its own because the working row appears
    // with no text at all, and a row nobody scrolls to is a row nobody is told
    // about. Only while the reader is at the bottom; otherwise the new-activity
    // dot on the "back to latest" button is the whole notification.
    LaunchedEffect(threadId, tail, liveText?.length ?: 0) {
        if (liveCount == 0 || itemCount == 0) return@LaunchedEffect
        if (stickToBottom.value) listState.scrollToItem(itemCount - 1)
    }
    // The composer changes height under the list — the quick-reply chips appear
    // when a turn settles, the keyboard comes and goes — and its measured height
    // is the list's bottom padding. A reader parked at the newest row used to
    // keep the padding it had when it parked, so the new, taller chrome covered
    // the last lines of the answer that had just arrived (the screenshot this
    // fixes showed row 16 of 20 under the chips). Re-anchor when the chrome
    // grows, not when it shrinks: a chip row leaving is no reason to move
    // someone who has scrolled up.
    val chromeHeight = remember(threadId) { mutableStateOf(bottomClearance) }
    LaunchedEffect(threadId, bottomClearance) {
        val grew = bottomClearance > chromeHeight.value
        chromeHeight.value = bottomClearance
        if (!grew || !settled || itemCount == 0) return@LaunchedEffect
        if (stickToBottom.value) listState.scrollToItem(itemCount - 1)
    }
    // A search hit lands on its message.
    LaunchedEffect(focusedMessageId, transcript.size) {
        val target = focusedMessageId ?: return@LaunchedEffect
        val index = transcript.indexOfFirst { row ->
            row.id == target || row.containsMessage(target)
        }
        if (index < 0) return@LaunchedEffect
        // A jump to history parks the reader there; the live row must not pull
        // them off the message they asked to see.
        stickToBottom.value = index == transcript.lastIndex
        val turn = transcript[index] as? TranscriptRow.AssistantTurn
        if (turn != null) expandedTurns = expandedTurns + turn.turnId
        // The header floats over the list, so an item at offset 0 sits *behind*
        // it. A negative offset leaves the hit in the clear below the glass.
        val header = with(density) { headerClearance.roundToPx() }
        listState.scrollToItem(headerCount + index, -header)
        if (turn != null) {
            // The fold can span several screens. Its child brings the actual
            // search hit into view before retiring the pending focus.
            revealedTurnMessageId = target
        } else {
            session.consumeFocus(target)
        }
        settled = true
    }

    // The voice card's finish: transcript or audio, same send path the sheet
    // used, and the card closes itself through the same state the gesture set.
    fun sendVoice(clip: VoiceClip, transcript: String) {
        voiceCardOpen = false
        voiceHold = false
        // A recognized clip sends as text only: the wav would just
        // cost the bot a transcription pass it no longer needs.
        val voice = if (transcript.isEmpty()) listOf(
            PendingMessageAttachment(
                data = clip.data,
                name = clip.name,
                mime = "audio/wav",
                kind = PendingMessageAttachment.Kind.FILE,
            )
        ) else emptyList()
        scope.launch {
            sendingMessage = true
            attachmentError = null
            val sent = try {
                session.send(transcript, voice, chat)
            } finally {
                sendingMessage = false
            }
            if (!sent) {
                attachmentError = session.actionError ?: "无法发送语音消息，请重试。"
                session.actionError = null
            } else {
                stickToBottom.value = true
                haptics.play(HapticCue.SEND)
            }
        }
    }

    val voiceCapture = remember(threadId) {
        VoiceCapture(
            context = context,
            environment = environment,
            scope = scope,
            haptics = haptics,
            onResult = { clip, transcript -> sendVoice(clip, transcript) },
        )
    }

    // A microphone left open by a process switch is worse than a lost take.
    DisposableEffect(voiceCapture, lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) voiceCapture.cancel()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            voiceCapture.release()
        }
    }

    val cancelVoicePx = with(density) { 72.dp.toPx() }
    fun openVoiceCard(hold: Boolean) {
        dictation.stop()
        focusManager.clearFocus()
        voiceCardOpen = true
        voiceHold = hold
        voiceCapture.warmUp()
        voiceCapture.begin()
    }
    val voiceGesture = Modifier
        .pointerInput(threadId) {
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false)
                down.consume()
                openVoiceCard(hold = true)
                var cancel = false
                var released = false
                var releasedAt = 0L
                while (true) {
                    val event = awaitPointerEvent()
                    val change = event.changes.firstOrNull { it.id == down.id } ?: break
                    if (!change.pressed) {
                        released = true
                        releasedAt = change.uptimeMillis
                        break
                    }
                    change.consume()
                    val next = down.position.y - change.position.y > cancelVoicePx
                    if (next != cancel) {
                        cancel = next
                        voiceCapture.cancelling = next
                        haptics.play(HapticCue.SELECT)
                    }
                }
                when {
                    // The system taking the pointer (an incoming call, a back
                    // gesture) must not leave the microphone open behind a
                    // card nobody is holding.
                    !released -> {
                        voiceCapture.cancel()
                        voiceCardOpen = false
                        voiceHold = false
                    }
                    // Released inside the long-press window: a tap. The card
                    // keeps recording; its own buttons finish the message.
                    releasedAt - down.uptimeMillis < HOLD_TO_TALK_MS -> {
                        voiceHold = false
                    }
                    // Held out: release means send (or cancel, slid up). A
                    // permission sheet still on screen instead hands the card
                    // to tap mode so the retry stays reachable.
                    voiceCapture.recording -> {
                        voiceCapture.finish(cancel = cancel)
                        voiceCardOpen = false
                        voiceHold = false
                    }
                    else -> voiceHold = false
                }
            }
        }
        .semantics {
            contentDescription = "语音输入"
            role = Role.Button
            // TalkBack cannot hold-and-release; its click is the tap flow.
            semanticsOnClick(label = "发送语音消息") {
                openVoiceCard(hold = false)
                true
            }
        }

    val bot = (chat as? Chat.BotChat)?.bot
    // The computer is bot-only; a non-DM room exposes task navigation when the
    // paired desktop supplied a task list. Both answers are constants.
    val commands = SlashCommands.forChat(chat)
    // One handler for the one door. The name pill stopped being the second when
    // it became the way into a bot's profile, so the + now carries every action
    // there is — including both export formats.
    val onAction: (ChatActionId) -> Unit = { action ->
        when (action) {
            ChatActionId.PHOTOS -> {
                pickerDraft = attachmentDraft
                pickPhotos.launch(
                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                )
            }
            ChatActionId.FILES -> {
                pickerDraft = attachmentDraft
                pickFiles.launch(
                (AttachmentPolicy.IMAGE_MIME_TYPES + AttachmentPolicy.DOCUMENT_MIME_TYPES).toTypedArray(),
                )
            }
            ChatActionId.VOICE -> openVoiceCard(hold = false)
            ChatActionId.NEW_TASK -> if (!creatingThread && TaskRules.canCreate(chat)) {
                creatingThread = true
                scope.launch {
                    try {
                        val created = when (chat) {
                            is Chat.BotChat -> session.createTask(chat.bot, null)?.let(Chat::BotChat)
                            is Chat.RoomChat -> if (chat.supportsTasks) session.createTask(chat.room, null)
                                ?.let(Chat::RoomChat) else null
                        }
                        if (created == null) {
                            attachmentError = session.actionError ?: "无法创建此对话，请重试。"
                            session.actionError = null
                        } else onSelectTask(created.target)
                    } finally {
                        creatingThread = false
                    }
                }
            }
            ChatActionId.TASKS -> showingTasks = true
            ChatActionId.WATCH_COMPUTER -> {
                // iOS stops on showingComputer; Android leaves ChatScreen when
                // Computer is pushed, but stop here too so capture ends before
                // the navigation frame, not only on dispose.
                dictation.stop()
                if (bot != null) onOpenComputer(bot.id)
            }
            ChatActionId.SETTINGS -> if (bot != null) showingProfile = true
            ChatActionId.SHARE_MARKDOWN -> share(scope, environment, threadId, ShareFormat.MARKDOWN)
            ChatActionId.SHARE_JSON -> share(scope, environment, threadId, ShareFormat.JSON)
            ChatActionId.INTERRUPT -> scope.launch { session.interrupt(chat) }
        }
        Unit
    }

    // A slash command that navigates clears the draft the way emptying the
    // field does — including its provenance, so a spoken word cannot outlive it.
    fun clearDraft() {
        composer.onTypedChange("")
        publishFrom(composer)
    }

    /**
     * Quote a message into the composer as a Markdown blockquote. Only an
     * excerpt travels: quoting a wall of tool output into a draft would make
     * the reply about the quote instead of the answer.
     */
    fun quote(message: Message) {
        val body = message.text?.trim().orEmpty()
        if (body.isEmpty()) return
        // Blank lines inside a quote read as four bare ">" in the composer, so
        // the excerpt is the first few *spoken* lines, not the first few lines.
        val lines = body.lines().map(String::trim).filter(String::isNotEmpty)
        if (lines.isEmpty()) return
        val excerpt = lines.take(QUOTE_MAX_LINES)
            .joinToString("\n") { "> $it" }
            .let { if (lines.size > QUOTE_MAX_LINES) "$it\n> …" else it }
        val existing = composer.text
        composer.onTypedChange(if (existing.isEmpty()) "$excerpt\n\n" else "$excerpt\n\n$existing")
        publishFrom(composer)
    }

    /**
     * The port of iOS `submit(_ explicitText:)`. A command or a chip sends its
     * own prompt and still clears the composer, exactly as the Swift does: the
     * `/dif` you had half-typed is what you were asking for, and leaving it
     * behind would send it again on the next tap of the send button.
     */
    fun submit(explicitText: String? = null) {
        // Cancels an in-flight permission prompt before it can open the
        // microphone after the message has already been sent.
        dictation.stop()
        // Your own message is the one arrival that always wins: wherever the
        // reader was, the answer will be below it.
        stickToBottom.value = true
        val text = (explicitText ?: draft).trim()
        // With attachments waiting, the message is the attachments plus
        // whatever was typed; the draft is cleared only once they are sent.
        if (attachments.isNotEmpty()) {
            if (preparingAttachments || sendingMessage) return
            val outgoing = attachments.toList()
            val draftAtSend = draft
            sendingMessage = true
            attachmentError = null
            showingPlus = false
            scope.launch {
                val sent = try {
                    session.send(text, outgoing, chat)
                } finally {
                    sendingMessage = false
                }
                if (!sent) {
                    attachmentError = session.actionError ?: "无法发送此消息，请重试。"
                    session.actionError = null
                    return@launch
                }
                // Compare with what was in the field at tap time, so a newer
                // edit made while uploading survives the clear.
                if (composer.text == draftAtSend) {
                    composer.onSend()
                    publishFrom(composer)
                }
                if (attachments.map { it.id } == outgoing.map { it.id }) attachments.clear()
                haptics.play(HapticCue.SEND)
            }
            return
        }
        if (text.isEmpty()) return
        composer.onSend()
        // Clearing the draft closes the HUD through the rule above, which is
        // how iOS's `showCommandHUD = false` on submit happens as well.
        publishFrom(composer)
        // Where iOS plays `SoundEffects.playSent()` and a medium impact. The
        // motor only: the sound there is an Apple system id with no counterpart
        // here, and the keyboard already owns that job on this platform.
        haptics.play(HapticCue.SEND)
        // Deliberately not disabled while the bot is busy: the harness answers
        // 409 and Session surfaces "The bot is busy — stop it first." That is a
        // clearer answer than a dead button.
        scope.launch {
            if (session.send(text, chat)) return@launch
            // The draft was already cleared on the tap; a failed send hands the
            // words back rather than dropping them behind a vanishing notice.
            if (composer.text.isBlank()) {
                composer.onTypedChange(text)
                publishFrom(composer)
            }
            attachmentError = session.actionError ?: "无法发送此消息，请重试。"
            session.actionError = null
        }
    }

    fun selectCommand(command: SlashCommand) {
        // Null for a command that sends: `submit` below plays the send cue, and
        // two effects back to back on one gesture are one muddled buzz.
        CompanionHaptics.forCommand(command.effect)?.let { haptics.play(it) }
        when (val effect = command.effect) {
            SlashEffect.OpenComputer -> {
                // Stop before clearing, not after: a partial still in flight
                // would land on the draft this just emptied. iOS stops on
                // `showingComputer`; Android leaves ChatScreen when Computer is
                // pushed, so stop here too — before the navigation frame, not
                // only on dispose.
                dictation.stop()
                clearDraft()
                if (bot != null) onOpenComputer(bot.id)
            }

            SlashEffect.OpenTasks -> {
                dictation.stop()
                clearDraft()
                showingTasks = true
            }

            is SlashEffect.Send -> submit(effect.prompt)
        }
        hudOpen = false
    }

    /**
     * Closing takes back the `/` that opened the HUD and nothing else. Routed
     * around [publishFrom] when the draft did not change, because re-applying
     * the open rule to an unchanged `/dif` would reopen what was just closed.
     */
    fun closeHud() {
        val next = SlashCommands.draftAfterClose(draft)
        if (next != draft) {
            composer.onTypedChange(next)
            publishFrom(composer)
        }
        hudOpen = false
    }

    // Clear draft while still composed so rememberSaveable does not resurrect
    // it after a roster pop. Computer push never takes this path.
    fun leaveToRoster() {
        composer.onLeaveToRoster()
        publishFrom(composer)
        onBack()
    }

    BackHandler(enabled = showingPlus) { showingPlus = false }
    // Back dismisses an open panel before it leaves the screen — the platform's
    // own gesture, applied to the HUD the way it already was to the + sheet.
    BackHandler(enabled = !showingPlus && hudOpen) { closeHud() }
    // Search is a level of its own: Back closed the whole chat and wiped the
    // draft, so searching for an old message cost you what you were writing.
    BackHandler(enabled = searching) { searching = false }
    BackHandler(enabled = !embedded && !showingPlus && !hudOpen && !searching) { leaveToRoster() }

    CompositionLocalProvider(LocalHazeState provides hazeState) {
    Box(modifier = Modifier.fillMaxSize().background(minisCanvas)) {
        Column(modifier = Modifier.fillMaxSize()) {
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .pointerInput(Unit) {
                        detectTapGestures { focusManager.clearFocus() }
                    },
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(minisCanvas)
                        .hazeSource(hazeState),
                ) {
                LazyColumn(
                    state = listState,
                    modifier = Modifier
                        .align(Alignment.TopCenter)
                        .widthIn(max = CHAT_CONTENT_MAX_WIDTH)
                        .fillMaxSize(),
                    contentPadding = PaddingValues(
                        start = 16.dp,
                        end = 16.dp,
                        top = headerClearance,
                        bottom = bottomClearance,
                    ),
                    // Spacing is per row, not uniform: a run of one person's
                    // lines sits 4dp apart and the gap between turns is 9dp,
                    // which is what makes three short lines read as one block
                    // rather than three cards. Grok's own rhythm, from the
                    // design's `.row.tight`.
                ) {
                    if (hasMore) {
                        item(key = LOAD_EARLIER_KEY) {
                            TextButton(
                                onClick = {
                                    // Keep the reader where they were: after older
                                    // messages are prepended, sit back on the one
                                    // that used to be at the top.
                                    val anchor = transcript.firstOrNull()?.id
                                    scope.launch {
                                        session.loadOlder(threadId)
                                        if (anchor == null) return@launch
                                        val fresh = session.state.value
                                        val freshRows = transcriptRows(
                                            fresh.visibleTranscript(threadId),
                                            activityDetail,
                                        )
                                        val index = freshRows.indexOfFirst { row ->
                                            row.id == anchor || row.containsMessage(anchor)
                                        }
                                        if (index < 0) return@launch
                                        // The "load earlier" row is item 0 for as
                                        // long as there is still more to fetch.
                                        val offset = if (fresh.hasMore[threadId] == true) 1 else 0
                                        listState.scrollToItem(index + offset)
                                    }
                                },
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text("加载更早的消息", fontSize = 13.sp, color = secondaryTint)
                            }
                        }
                    }

                    // A brand-new thread is a full-screen invitation to ask,
                    // not a blank sheet where the transcript will be.
                    if (transcript.isEmpty() && liveCount == 0 && state.hasLoadedPage(threadId)) {
                        item(key = EMPTY_STATE_KEY) {
                            Column(
                                modifier = Modifier.fillParentMaxSize(),
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
                            ) {
                                ChatAvatar(chat = chat, size = 72.dp, animated = false)
                                Text(
                                    text = "还没有消息",
                                    fontSize = 17.sp,
                                    fontWeight = FontWeight.SemiBold,
                                    color = minisInk,
                                )
                                Text(
                                    text = "向 ${chat.name} 提问，开始这段对话",
                                    fontSize = 14.sp,
                                    color = minisSecondary,
                                    textAlign = TextAlign.Center,
                                )
                            }
                        }
                    }

                    itemsIndexedKeyed(transcript) { index, message ->
                        // The gap above a row belongs to that row, so a run can
                        // sit tighter than the space between turns without the
                        // list having to know which rows are which.
                        val startsRun = TranscriptLayout.startsRowRun(transcript, index)
                        Column(
                            // New rows fade in and rows that move (a fold
                            // opening, an unread section reordering) glide
                            // rather than jump. Placement only — content
                            // changes inside a row never animate.
                            modifier = Modifier
                                .animateItem()
                                // The list's own top padding already spaces the
                                // very first item; every later row carries its
                                // own gap. "Load earlier" counts as the item
                                // above when it is shown.
                                .padding(
                                    top = when {
                                        index > 0 -> if (startsRun) TURN_GAP else RUN_GAP
                                        hasMore -> TURN_GAP
                                        else -> 0.dp
                                    },
                                ),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            // A gap in time is worth marking; a timestamp on every
                            // message is just noise.
                            if (TranscriptLayout.startsNewDay(transcript, index)) {
                                Text(
                                    text = RelativeStamp.separator(
                                        message.at,
                                        System.currentTimeMillis(),
                                    ),
                                    fontSize = 13.sp,
                                    color = minisSecondary,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(top = 6.dp),
                                    textAlign = TextAlign.Center,
                                )
                            }
                            when (message) {
                                is TranscriptRow.Single -> MessageRow(
                                    chat = chat,
                                    message = message.message,
                                    // The two ends of a run of bubbles from the
                                    // same author: the corners that touch a
                                    // neighbour tuck in, the rest stay round.
                                    startsRun = TranscriptLayout.startsRowRun(transcript, index),
                                    endsRun = TranscriptLayout.endsRowRun(transcript, index),
                                    openLink = ::openLink,
                                    openAttachment = ::openAttachment,
                                    openThread = ::openThread,
                                    // A screenshot is the door to the same
                                    // computer, live: rooms have no single bot
                                    // to open, so they keep the inert still.
                                    openComputer = if (bot != null) {
                                        { onOpenComputer(bot.id) }
                                    } else {
                                        null
                                    },
                                    onQuote = ::quote,
                                )
                                is TranscriptRow.ActivityRun -> ActivityRunChip(message.items, ::openThread)
                                is TranscriptRow.AssistantTurn -> AssistantTurnChip(
                                    turn = message,
                                    chat = chat,
                                    expanded = message.turnId in expandedTurns,
                                    revealMessageId = revealedTurnMessageId,
                                    onRevealed = { target ->
                                        session.consumeFocus(target)
                                        if (revealedTurnMessageId == target) revealedTurnMessageId = null
                                    },
                                    onToggle = {
                                        expandedTurns = if (message.turnId in expandedTurns) expandedTurns - message.turnId
                                            else expandedTurns + message.turnId
                                    },
                                    openLink = ::openLink,
                                    openAttachment = ::openAttachment,
                                    openThread = ::openThread,
                                    openComputer = if (bot != null) {
                                        { onOpenComputer(bot.id) }
                                    } else {
                                        null
                                    },
                                    onQuote = ::quote,
                                )
                            }
                        }
                    }

                    if (liveCount == 1) {
                        item(key = LIVE_BUBBLE_KEY) {
                            // The working row arrives with a fade instead of
                            // popping into existence under the last message.
                            // It is its own turn, so it takes the turn gap.
                            Box(
                                modifier = Modifier
                                    .animateItem()
                                    .padding(top = TURN_GAP),
                            ) {
                                if (tail == TranscriptTail.WORKING) {
                                    WorkingBubble(
                                        chat = chat,
                                        // The last line of the reasoning, when
                                        // the detail setting has folded the
                                        // chamber away: the wait still says
                                        // what the bot is thinking about.
                                        whisper = reasoning
                                            ?.takeIf { it.isNotBlank() }
                                            ?.lineSequence()
                                            ?.lastOrNull { it.isNotBlank() },
                                    )
                                } else {
                                    StreamingBubble(
                                        text = liveText,
                                        reasoning = liveReasoning,
                                    )
                                }
                            }
                        }
                    }

                    if (showQuickChips) {
                        item(key = QUICK_REPLIES_KEY) {
                            PredictiveChipsRow(
                                chips = predictiveChips,
                                onSelect = { submit(it.prompt) },
                                onDismiss = { dismissedQuickChipsForId = lastTranscriptId },
                                modifier = Modifier
                                    .animateItem()
                                    .padding(top = 12.dp),
                            )
                        }
                    }
                }
                }

                val topScrolled by remember { derivedStateOf { listState.canScrollBackward } }
                val topBandAlpha by animateFloatAsState(
                    targetValue = if (topScrolled) 1f else 0.94f,
                    animationSpec = tween(180),
                    label = "chat-top-haze",
                )
                // Muse-style crystal-clear pure-white top fade (zero murky blur smear)
                // so bubbles stay razor-sharp and dissolve cleanly only near the status bar.
                Box(
                    modifier = Modifier
                        .align(Alignment.TopCenter)
                        .fillMaxWidth()
                        .height(topInset + 56.dp)
                        .background(
                            Brush.verticalGradient(
                                0.00f to minisCanvas.copy(alpha = 0.96f * topBandAlpha),
                                0.38f to minisCanvas.copy(alpha = 0.78f * topBandAlpha),
                                0.72f to minisCanvas.copy(alpha = 0.30f * topBandAlpha),
                                1.00f to Color.Transparent,
                            ),
                        ),
                )
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .fillMaxWidth()
                        .height(bottomClearance + 14.dp)
                        .background(
                            Brush.verticalGradient(
                                0.00f to Color.Transparent,
                                0.42f to minisCanvas.copy(alpha = 0.82f),
                                1.00f to minisCanvas,
                            ),
                        ),
                )

                androidx.compose.animation.AnimatedVisibility(
                    visible = canScrollDown && itemCount > 0,
                    enter = fadeIn(tween(150)) + scaleIn(
                        animationSpec = spring(dampingRatio = 0.55f, stiffness = 500f),
                        initialScale = 0.5f,
                    ),
                    exit = fadeOut(tween(120)) + scaleOut(targetScale = 0.8f, animationSpec = tween(120)),
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(end = 16.dp, bottom = bottomClearance + 6.dp),
                ) {
                    ScrollToLatestButton(
                        live = tail != TranscriptTail.NONE,
                        onClick = {
                            haptics.play(HapticCue.SELECT)
                            stickToBottom.value = true
                            scope.launch { listState.animateScrollToItem(itemCount - 1) }
                        },
                    )
                }

                ChatHeader(
                    chat = chat,
                    tail = tail,
                    listening = voiceCardOpen || dictationListening,
                    unreadElsewhere = remember(state, chat) {
                        (state.unreadCount - if (chat.unread) 1 else 0).coerceAtLeast(0)
                    },
                    onBack = { leaveToRoster() },
                    onOpenDrawer = onOpenDrawer,
                    onSearch = { searching = true },
                    onOpenThreads = {
                        dictation.stop()
                        focusManager.clearFocus()
                        showingTasks = true
                    },
                    onWatchComputer = {
                        dictation.stop()
                        if (bot != null) onOpenComputer(bot.id)
                    },
                    onCall = openCall,
                    // A bot's face and its name pill are both the door to its
                    // profile; a room has no profile, so its pill opens the same
                    // sheet the + does.
                    onOpenProfile = {
                        if (bot != null) {
                            showingProfile = true
                        } else {
                            dictation.stop()
                            focusManager.clearFocus()
                            showingPlus = true
                        }
                    },
                    modifier = Modifier
                        .align(Alignment.TopCenter)
                        .widthIn(max = CHAT_CONTENT_MAX_WIDTH)
                        .statusBarsPadding()
                        .onSizeChanged { headerHeightPx = it.height },
                )

                Composer(
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .widthIn(max = CHAT_CONTENT_MAX_WIDTH)
                        .then(if (embedded) Modifier else Modifier.navigationBarsPadding())
                        .onSizeChanged { composerHeightPx = it.height },
                name = chat.name,
                draft = draft,
                accessory = if (composerAccessory == ComposerAccessory.HUD) ComposerAccessory.HUD else ComposerAccessory.NONE,
                commands = commands,
                chips = predictiveChips,
                plusOpen = showingPlus,
                dictationListening = dictationListening,
                dictationLocked = dictationLocked,
                dictationError = dictationError,
                attachments = attachments,
                sending = sendingMessage,
                preparing = preparingAttachments,
                busy = chat.busy,
                engineCanSteer = engineCanSteer,
                queuedSends = queuedSends,
                steering = steering,
                onSteer = steerNow,
                onCancelQueued = { queued ->
                    scope.launch { session.cancelQueued(queued, chat) }
                },
                onEditQueued = { queued ->
                    // The computer drops it from the queue first; only a
                    // confirmed removal hands the words back, so a send that
                    // already joined the turn is never resent. The composer is
                    // this conversation's cached draft, so a thread switch
                    // mid-request still lands the words in the right place.
                    val target = composer
                    scope.launch {
                        if (session.cancelQueued(queued, chat)) {
                            target.onTypedChange(queued.editDraft(keeping = target.text))
                            publishFrom(target)
                        }
                    }
                },
                openingFileName = openingFileName,
                attachmentError = fileOpenError ?: attachmentError,
                onRemoveAttachment = { attachment ->
                    if (!preparingAttachments && !sendingMessage) {
                        attachments.removeAll { it.id == attachment.id }
                        attachmentError = null
                    }
                },
                onDismissError = {
                    fileOpenError = null
                    attachmentError = null
                },
                onTogglePlus = {
                    // iOS drops the composer's focus before the sheet rises; a
                    // keyboard under it would leave the sheet nowhere to go.
                    dictation.stop()
                    if (!showingPlus) focusManager.clearFocus()
                    showingPlus = !showingPlus
                },
                onDraftChange = { next ->
                    if (dictationLocked) return@Composer
                    composer.onTypedChange(next)
                    publishFrom(composer)
                },
                voiceButton = voiceGesture,
                onSend = { submit() },
                showCall = chat is Chat.BotChat,
                onCall = openCall,
                onToggleHud = {
                    dictation.stop()
                    haptics.play(HapticCue.SELECT)
                    hudOpen = !hudOpen
                },
                // The button, not the back gesture — `closeHud` is also what the
                // BackHandler calls, and Android already gives back its own feel.
                onCloseHud = {
                    haptics.play(HapticCue.SELECT)
                    closeHud()
                },
                onSelectCommand = { selectCommand(it) },
                // A chip is the whole message, sent on the tap.
                onSelectChip = { submit(it.prompt) },
            )
            }
        }

        PlusSheet(
            open = showingPlus,
            bottomClearance = bottomClearance,
            actions = remember(chat, pendingApproval, canAddAttachment) {
                ChatActions.sheet(chat, hasPendingApproval = pendingApproval, canAddAttachment = canAddAttachment)
            },
            onDismiss = { showingPlus = false },
            onAction = {
                showingPlus = false
                onAction(it)
            },
        )
    }
    }

    if (searching) {
        ChatSearchOverlay(
            chat = chat,
            transcript = transcript,
            query = searchQuery,
            onQueryChange = { searchQuery = it },
            onClose = {
                searching = false
                searchQuery = ""
            },
            onOpenMessage = { message ->
                searching = false
                searchQuery = ""
                val index = transcript.indexOfFirst { row ->
                    row is TranscriptRow.Single && row.message.id == message.id
                }
                if (index >= 0) {
                    stickToBottom.value = index == transcript.lastIndex
                    scope.launch {
                        val offset = if (hasMore) 1 else 0
                        val header = with(density) { headerClearance.roundToPx() }
                        listState.animateScrollToItem(
                            (index + offset).coerceAtLeast(0),
                            -header,
                        )
                    }
                }
            },
            onOpenHit = { hit ->
                searching = false
                searchQuery = ""
                // The hit may be older than the loaded page: the session loads
                // around it and parks the transcript on the focused message.
                scope.launch { session.open(hit) }
            },
            onSearch = { session.search(it) },
        )
    }

    if (voiceCardOpen) {
        VoiceCard(
            capture = voiceCapture,
            hold = voiceHold,
            onClose = {
                voiceCapture.cancel()
                voiceCardOpen = false
                voiceHold = false
            },
        )
    }

    if (showingTasks) {
        if (chat.supportsTasks) TaskSheet(chat = chat, onDismiss = { showingTasks = false }, onSelectTask = onSelectTask, onDeletedCurrent = onBack)
    }

    if (showingProfile && bot != null) {
        AgentProfileSheet(
            bot = bot,
            onDismiss = { showingProfile = false },
            onOpenOverview = {
                onOpenOverview(it)
                showingProfile = false
            },
        )
    }

    filePreview?.let { item ->
        FilePreviewSheet(
            item = item,
            onDismiss = {
                filePreview = null
                scope.launch(Dispatchers.IO) { filePreviews.dismiss(item) }
            },
            onShare = { filePreviews.share(item) },
            onOpen = { filePreviews.openWithSystem(item) },
        )
    }

    if (showingCall && bot != null) {
        if (liveCall) {
            LiveCallScreen(
                bot = bot,
                bottomClearance = bottomClearance,
                onDismiss = { showingCall = false },
            )
        } else {
            CallScreen(
                bot = bot,
                bottomClearance = bottomClearance,
                onDismiss = { showingCall = false },
            )
        }
    }
}

private fun share(
    scope: kotlinx.coroutines.CoroutineScope,
    environment: CompanionEnvironment,
    threadId: String,
    format: ShareFormat,
) {
    scope.launch {
        val session = environment.session
        val exported = session.export(threadId, format.wire) ?: return@launch
        environment.shareTranscript(exported, format)?.let { session.actionError = it }
    }
}

/** A quote is an excerpt, not a transcript: four lines and an ellipsis. */
private const val QUOTE_MAX_LINES = 4

private const val LOAD_EARLIER_KEY = "companion.loadEarlier"
private const val LIVE_BUBBLE_KEY = "companion.live"
private const val QUICK_REPLIES_KEY = "companion.quickReplies"
private const val EMPTY_STATE_KEY = "companion.empty"
private val CHAT_CONTENT_MAX_WIDTH = 840.dp

/**
 * The transcript's vertical rhythm: one gap between turns, a tighter one inside a
 * run of the same person's lines.
 *
 * 16dp between turns and 4dp inside one. The design's `.row.tight` is 4px
 * against 9px, but 9dp was measured with the bot's answers as bare page text;
 * now that both sides are bubbles, a 9dp gap between two filled shapes reads as
 * a stack rather than a break, so the turn gap grew with the change. The gap is
 * carried as the top padding of the row that starts, so the list itself needs no
 * verticalArrangement and the first row keeps the list's own padding.
 */
private val TURN_GAP = 16.dp
private val RUN_GAP = 4.dp

/**
 * Whether the newest row is fully on screen.
 *
 * Four dp of slack: a list resting at the bottom can be a fraction of a pixel
 * short after a fold re-measures, and a chat that considers itself scrolled-up
 * for that would stop following the bot.
 */
private fun LazyListState.isAtBottom(): Boolean {
    val info = layoutInfo
    if (info.totalItemsCount == 0) return true
    val last = info.visibleItemsInfo.lastOrNull() ?: return true
    return last.index >= info.totalItemsCount - 1 &&
        last.offset + last.size <= info.viewportEndOffset + 4
}

/** `itemsIndexed` with the message id as the key — one call site, one helper. */
private fun androidx.compose.foundation.lazy.LazyListScope.itemsIndexedKeyed(
    messages: List<TranscriptRow>,
    content: @Composable LazyItemScope.(Int, TranscriptRow) -> Unit,
) {
    items(
        count = messages.size,
        key = { messages[it].id },
        itemContent = { index -> content(index, messages[index]) },
    )
}

// The strip the top controls sit on, and the air the transcript needs below the
// name pill before its first row.
private val HEADER_BAR = 56.dp
private val HEADER_SCRIM_FADE = 24.dp
private val HEADER_CLEARANCE = 128.dp

// The top band spans the header plus a short tail — narrow enough that most
// of the transcript stays untouched.
private val TOP_BAND_HEIGHT = 52.dp

// The floating bottom chrome — quick chips, the composer — occupies this much
// above the window edge; the blur band and the list's clearance both use it.
private val BOTTOM_CHROME_HEIGHT = 104.dp

// The air between the newest row and the composer's top edge. The composer's own
// 6dp top padding is inside its measured height, so this is what a reader sees
// between a bubble's bottom and the quick-reply chips above the field: at 10dp a
// long answer's last line sat close enough to the chips to look tucked under
// them, which is the "贴着快捷卡片" the screenshot showed.
private val BOTTOM_CONTENT_GAP = 22.dp

/**
 * Search over the messages this phone has loaded.
 *
 * Full screen rather than an inline filter: the transcript is paged, results
 * need room to scroll, and closing the overlay returns to the exact row the
 * person picked. Only text rows are searched — activity receipts are noise in a
 * result list — and the query is case-insensitive.
 */
/**
 * One result row, whether it came from the messages already in memory or from
 * the computer's full-text index. Keeping both in one shape is what lets a
 * loaded hit stay instant while the server answers for everything older than
 * the page the phone is holding.
 */
private data class ChatSearchResult(
    val messageId: String,
    val role: Message.Role,
    val at: Double,
    val text: String,
    val message: Message? = null,
    val hit: SearchHit? = null,
)

@Composable
private fun ChatSearchOverlay(
    chat: Chat,
    transcript: List<TranscriptRow>,
    query: String,
    onQueryChange: (String) -> Unit,
    onClose: () -> Unit,
    onOpenMessage: (Message) -> Unit,
    onOpenHit: (SearchHit) -> Unit,
    onSearch: suspend (String) -> List<SearchHit>,
) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    val needle = query.trim()
    val local = remember(transcript, needle) {
        if (needle.isEmpty()) {
            emptyList()
        } else {
            transcript
                .mapNotNull { (it as? TranscriptRow.Single)?.message }
                .filter { it.text?.contains(needle, ignoreCase = true) == true }
                .asReversed()
        }
    }
    // The loaded page answers instantly; the computer's index answers for the
    // rest of the thread. Debounced so a fast typist sends one query, not ten.
    var remote by remember { mutableStateOf(emptyList<SearchHit>()) }
    var remoteQuery by remember { mutableStateOf("") }
    LaunchedEffect(needle) {
        if (needle.length < 2) {
            remote = emptyList()
            remoteQuery = needle
            return@LaunchedEffect
        }
        delay(250)
        remoteQuery = needle
        remote = onSearch(needle).filter { it.threadId == chat.threadId }
    }
    val results = remember(local, remote) {
        val seen = local.mapTo(mutableSetOf()) { it.id }
        buildList {
            local.forEach { message ->
                add(
                    ChatSearchResult(
                        messageId = message.id,
                        role = message.role,
                        at = message.at,
                        text = message.text.orEmpty(),
                        message = message,
                    ),
                )
            }
            remote.forEach { hit ->
                if (seen.add(hit.messageId)) {
                    add(
                        ChatSearchResult(
                            messageId = hit.messageId,
                            role = hit.role,
                            at = hit.at,
                            text = hit.snippet,
                            hit = hit,
                        ),
                    )
                }
            }
        }
    }
    val waiting = needle.length >= 2 && remoteQuery != needle

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(minisCanvas)
            .statusBarsPadding()
            .padding(horizontal = 16.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 8.dp, bottom = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ChromeButton(
                icon = Icons.Filled.Close,
                contentDescription = "关闭搜索",
                onClick = onClose,
                size = 40.dp,
                glyph = 20.dp,
                surface = true,
            )
            Row(
                modifier = Modifier
                    .weight(1f)
                    .chromeCapsule(surface = true)
                    .height(48.dp)
                    .padding(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = Icons.Filled.Search,
                    contentDescription = null,
                    tint = minisSecondary,
                    modifier = Modifier.size(20.dp),
                )
                Box(modifier = Modifier.weight(1f)) {
                    if (query.isEmpty()) {
                        Text("搜索聊天内容", fontSize = 17.sp, color = minisSecondary)
                    }
                    BasicTextField(
                        value = query,
                        onValueChange = onQueryChange,
                        singleLine = true,
                        textStyle = LocalTextStyle.current.copy(fontSize = 17.sp, color = minisInk),
                        cursorBrush = SolidColor(minisInk),
                        modifier = Modifier
                            .fillMaxWidth()
                            .focusRequester(focus)
                            // The placeholder is a sibling Text that disappears
                            // once typing starts; the field needs a name of its
                            // own or TalkBack focuses a bare edit box.
                            .semantics { contentDescription = "搜索聊天内容" },
                    )
                }
            }
        }

        Text(
            text = when {
                needle.isEmpty() -> "输入关键词，搜索整个会话"
                results.isEmpty() && waiting -> "正在搜索…"
                results.isEmpty() -> "没有匹配的消息"
                else -> "${results.size} 条结果"
            },
            fontSize = 12.sp,
            color = minisSecondary,
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 4.dp),
        )

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(bottom = 32.dp),
        ) {
            items(results, key = { it.messageId }) { result ->
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable {
                            result.hit?.let(onOpenHit) ?: result.message?.let(onOpenMessage)
                        }
                        .padding(vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = if (result.role == Message.Role.USER) "你" else chat.name,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = minisAccent,
                        )
                        Text(
                            text = RelativeStamp.updated(result.at),
                            fontSize = 12.sp,
                            color = minisSecondary,
                        )
                    }
                    Text(
                        text = highlighted(
                            result.text,
                            needle,
                            minisAccent.copy(alpha = 0.25f),
                        ),
                        fontSize = 14.sp,
                        color = minisInk,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                MinisDivider()
            }
        }
    }
}

private fun highlighted(text: String, query: String, highlight: Color): AnnotatedString {
    if (query.isEmpty()) return AnnotatedString(text)
    val lower = text.lowercase()
    val needle = query.lowercase()
    return buildAnnotatedString {
        var start = 0
        while (start < text.length) {
            val index = lower.indexOf(needle, start)
            if (index < 0) {
                append(text.substring(start))
                break
            }
            append(text.substring(start, index))
            withStyle(SpanStyle(background = highlight)) {
                append(text.substring(index, index + needle.length))
            }
            start = index + needle.length
        }
    }
}

/**
 * Back on the left with the rest-of-app unread count, the bot's computer on the
 * right, and the bot itself between them over its name.
 *
 * The header paints nothing behind the controls: the transcript reads through
 * the gaps and only the solid pills — back, identity, actions — occlude it.
 */
@Composable
internal fun MuseDrawerButton(
    onClick: () -> Unit,
    unreadElsewhere: Int = 0,
) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TouchTarget(onClick = onClick, contentDescription = "打开侧边栏", size = 48.dp) {
            Box(
                modifier = Modifier
                    .size(46.dp)
                    .museFloatingPill(CircleShape, elevation = 4.dp),
                contentAlignment = Alignment.Center,
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(4.5.dp)) {
                    Box(Modifier.width(14.dp).height(1.9.dp).background(minisInk, CircleShape))
                    Box(Modifier.width(14.dp).height(1.9.dp).background(minisInk, CircleShape))
                }
            }
        }
        if (unreadElsewhere > 0) {
            Text(
                text = "$unreadElsewhere",
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                color = minisAccent,
                modifier = Modifier
                    .museFloatingPill(CircleShape, elevation = 3.dp)
                    .defaultMinSize(minWidth = 22.dp)
                    .padding(horizontal = 8.dp, vertical = 3.dp),
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun ChatHeader(
    chat: Chat,
    tail: TranscriptTail,
    listening: Boolean,
    unreadElsewhere: Int,
    onBack: () -> Unit,
    onOpenDrawer: (() -> Unit)?,
    onSearch: () -> Unit,
    onWatchComputer: () -> Unit,
    onCall: () -> Unit,
    onOpenProfile: () -> Unit,
    onOpenThreads: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth(),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 12.dp, end = 12.dp, top = 6.dp, bottom = 4.dp),
        ) {
            Box(modifier = Modifier.align(Alignment.TopStart).padding(top = 6.dp)) {
                if (onOpenDrawer != null) {
                    MuseDrawerButton(onClick = onOpenDrawer, unreadElsewhere = unreadElsewhere)
                } else {
                    BackPill(unreadElsewhere = unreadElsewhere, onBack = onBack)
                }
            }

            // Muse-style generous floating centerpiece: 74dp avatar with a soft
            // warm-linen studio halo in Light Mode so light/white bots keep crisp
            // sculptural presence on the pure-white gallery canvas.
            val dark = minisIsDark()
            val canvasMask = minisCanvas
            val avatarBackdrop = remember(dark, canvasMask) {
                Brush.radialGradient(
                    0.00f to canvasMask,
                    0.72f to canvasMask.copy(alpha = 0.94f),
                    1.00f to Color.Transparent,
                )
            }
            val studioHalo = remember(dark) {
                Brush.radialGradient(
                    0.00f to if (dark) Color(0x22FFFFFF) else Color(0x66D9CEC2),
                    0.56f to if (dark) Color(0x0EFFFFFF) else Color(0x30E4DDD4),
                    1.00f to Color.Transparent,
                )
            }
            Column(
                modifier = Modifier.align(Alignment.TopCenter),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(84.dp)
                        .background(avatarBackdrop, CircleShape)
                        .background(studioHalo, CircleShape)
                        .clickable(
                            interactionSource = remember { MutableInteractionSource() },
                            indication = null,
                            role = Role.Button,
                            onClick = onOpenProfile,
                        )
                        .semantics { contentDescription = "${chat.name}，打开控制中心" },
                    contentAlignment = Alignment.Center,
                ) {
                    val headerMood = when {
                        listening -> FaceMood.LISTENING
                        tail == TranscriptTail.STREAM -> FaceMood.SPEAKING
                        tail == TranscriptTail.REASONING -> FaceMood.THINKING
                        tail == TranscriptTail.WORKING || chat.busy -> FaceMood.WORKING
                        else -> FaceMood.IDLE
                    }
                    val headerState = when (headerMood) {
                        FaceMood.LISTENING -> MausState.LISTENING
                        FaceMood.WORKING -> MausState.WORKING
                        FaceMood.THINKING -> MausState.THINKING
                        else -> MausState.IDLE
                    }
                    ChatAvatar(
                        chat = chat,
                        size = 74.dp,
                        state = headerState,
                        animated = true,
                        contentDescription = null,
                        fallback = AvatarFallback.PRESET,
                        motion = AvatarMotion.SHEEN,
                        mood = headerMood,
                        breakout = headerMood == FaceMood.WORKING,
                        avatarStateOverride = when (headerMood) {
                            FaceMood.SPEAKING -> DynamicAvatarStates.TALKING
                            FaceMood.LISTENING -> DynamicAvatarStates.LISTENING
                            FaceMood.THINKING -> DynamicAvatarStates.THINKING
                            FaceMood.WORKING -> DynamicAvatarStates.WORKING
                            else -> DynamicAvatarStates.IDLE
                        },
                    )
                }
                Row(
                    modifier = Modifier
                        .museFloatingPill(CircleShape, elevation = 5.dp)
                        .clickable(
                            role = Role.Button,
                            onClick = if (chat.supportsTasks) onOpenThreads else onOpenProfile,
                        )
                        .semantics(mergeDescendants = true) {
                            contentDescription =
                                if (chat.supportsTasks) "${chat.name}，打开话题列表"
                                else "${chat.name}，编辑智能体资料"
                        }
                        .padding(horizontal = 15.dp, vertical = 4.5.dp),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = chat.name,
                        fontSize = 15.5.sp,
                        fontWeight = FontWeight.Light,
                        letterSpacing = 0.4.sp,
                        color = minisInk,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.widthIn(max = 156.dp),
                    )
                    if (chat is Chat.BotChat && chat.bot.chiefOfStaff == true) {
                        Spacer(Modifier.width(4.dp))
                        CrownBadge(size = 11.5.dp)
                    }
                    if (chat.busy) {
                        Spacer(Modifier.width(5.dp))
                        WorkingDotsView(minisAccent)
                    }
                }
            }

            // Muse-style floating right dual-action capsule: 46dp crisp white pill.
            Box(modifier = Modifier.align(Alignment.TopEnd).padding(top = 6.dp)) {
                var actionsOpen by remember { mutableStateOf(false) }
                Row(
                    modifier = Modifier
                        .height(46.dp)
                        .museFloatingPill(CircleShape, elevation = 4.dp)
                        .padding(horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (chat is Chat.BotChat) {
                        TouchTarget(onClick = onCall, size = 42.dp, contentDescription = "语音通话") {
                            Icon(
                                painter = painterResource(R.drawable.ic_call_line),
                                contentDescription = null,
                                tint = minisInk,
                                modifier = Modifier.size(20.dp),
                            )
                        }
                    }
                    TouchTarget(onClick = { actionsOpen = true }, size = 42.dp, contentDescription = "更多操作") {
                        Icon(
                            painter = painterResource(R.drawable.ic_more),
                            contentDescription = null,
                            tint = minisInk,
                            modifier = Modifier.size(19.dp),
                        )
                    }
                }
                ChatOverflowMenu(
                    expanded = actionsOpen,
                    bot = chat as? Chat.BotChat,
                    onDismiss = { actionsOpen = false },
                    onSearch = {
                        actionsOpen = false
                        onSearch()
                    },
                    onCall = {
                        actionsOpen = false
                        onCall()
                    },
                    onWatchComputer = {
                        actionsOpen = false
                        onWatchComputer()
                    },
                    onOpenProfile = {
                        actionsOpen = false
                        onOpenProfile()
                    },
                )
            }
        }
    }
}

/**
 * The header's overflow as the app's own card: the same surface, hairlines and
 * row weight as Settings, rather than the platform menu with its system
 * typography.
 */
@Composable
private fun ChatOverflowMenu(
    expanded: Boolean,
    bot: Chat.BotChat?,
    onDismiss: () -> Unit,
    onSearch: () -> Unit,
    onCall: () -> Unit,
    onWatchComputer: () -> Unit,
    onOpenProfile: () -> Unit,
) {
    if (!expanded) return
    val gap = with(LocalDensity.current) { 46.dp.roundToPx() }
    Popup(
        alignment = Alignment.TopEnd,
        offset = IntOffset(0, gap),
        onDismissRequest = onDismiss,
        properties = PopupProperties(focusable = true),
    ) {
        ChatMenuCard(modifier = Modifier.width(CHAT_MENU_WIDTH)) {
            ChatMenuRow(
                title = "搜索聊天内容",
                icon = menuIcon(R.drawable.ic_search_line),
                onClick = onSearch,
            )
            if (bot != null) {
                ChatMenuDivider()
                ChatMenuRow(
                    title = "呼叫 ${bot.name}",
                    icon = menuIcon(R.drawable.ic_call_line),
                    onClick = onCall,
                )
                ChatMenuDivider()
                ChatMenuRow(
                    title = "查看 ${bot.name} 的电脑",
                    icon = menuIcon(R.drawable.ic_display_line),
                    onClick = onWatchComputer,
                )
                ChatMenuDivider()
                ChatMenuRow(
                    title = "智能体资料",
                    icon = menuIcon(R.drawable.ic_edit_line),
                    onClick = onOpenProfile,
                )
            }
        }
    }
}

private val CHAT_MENU_WIDTH = 240.dp

@Composable
private fun ChatMenuCard(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = modifier
            .chromeSheet(cornerRadius = 18.dp, elevation = 14.dp)
            .padding(vertical = 4.dp),
        content = content,
    )
}

@Composable
private fun ChatMenuDivider() {
    HorizontalDivider(
        modifier = Modifier.padding(horizontal = 16.dp),
        thickness = 0.5.dp,
        color = minisSeparator,
    )
}

@Composable
private fun ChatMenuRow(
    title: String,
    icon: @Composable (Color) -> Unit,
    onClick: () -> Unit,
    enabled: Boolean = true,
    destructive: Boolean = false,
) {
    val alpha = if (enabled) 1f else 0.45f
    val titleColor = if (destructive) MaterialTheme.colorScheme.error else minisInk
    val iconColor = if (destructive) MaterialTheme.colorScheme.error else secondaryTint
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 50.dp)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        icon(iconColor.copy(alpha = alpha))
        Text(
            text = title,
            fontSize = 15.sp,
            color = titleColor.copy(alpha = alpha),
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

private fun menuIcon(icon: Int): @Composable (Color) -> Unit = { tint ->
    Icon(
        painter = painterResource(icon),
        contentDescription = null,
        tint = tint,
        modifier = Modifier.size(17.dp),
    )
}

private fun actionIcon(id: ChatActionId): @Composable (Color) -> Unit = { tint ->
    ChatActionIcon(id, tint)
}

/**
 * The "back to the newest message" pill.
 *
 * A floating circle rather than a bar: the transcript stays the screen, and the
 * one action floats over its bottom-right corner with a shadow, the way a
 * scroll-to-latest control does in every chat app people already use.
 */
@Composable
private fun ScrollToLatestButton(live: Boolean, onClick: () -> Unit) {
    TouchTarget(onClick = onClick, contentDescription = "回到最新消息") {
        Box(
            modifier = Modifier
                .size(40.dp)
                .chromeCapsule(elevation = 6.dp, surface = true),
            contentAlignment = Alignment.Center,
        ) {
        Icon(
            imageVector = Icons.Filled.KeyboardArrowDown,
            contentDescription = "回到最新消息",
            tint = minisInk,
            modifier = Modifier.size(22.dp),
        )
        if (live) {
            Box(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(top = 8.dp, end = 8.dp)
                    .size(7.dp)
                    .background(minisAccent, CircleShape),
            )
        }
        }
    }
}

/** Leaving, with what is unread everywhere else — a quiet chevron, not a pill. */
@Composable
private fun BackPill(unreadElsewhere: Int, onBack: () -> Unit) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TouchTarget(onClick = onBack, contentDescription = "返回", size = 40.dp) {
            Box(
                modifier = Modifier
                    .size(40.dp)
                    .chromeCapsule(surface = true),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = null,
                    tint = minisInk,
                    modifier = Modifier.size(22.dp),
                )
            }
        }
        if (unreadElsewhere > 0) {
            Text(
                text = "$unreadElsewhere",
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                color = minisAccent,
                modifier = Modifier
                    .chromeCapsule(surface = true)
                    .defaultMinSize(minWidth = 22.dp)
                    .padding(horizontal = 8.dp, vertical = 3.dp),
                textAlign = TextAlign.Center,
            )
        }
    }
}

/**
 * What the composer's + opens: the things you can do here, in one card. Rises
 * above the composer; tapping anywhere else, the back gesture, or the × the +
 * became, puts it away.
 */
@Composable
private fun BoxScope.PlusSheet(
    open: Boolean,
    bottomClearance: androidx.compose.ui.unit.Dp,
    actions: List<ChatAction>,
    onDismiss: () -> Unit,
    onAction: (ChatActionId) -> Unit,
) {
    AnimatedVisibility(
        visible = open,
        enter = fadeIn(tween(PLUS_MILLIS)),
        exit = fadeOut(tween(PLUS_MILLIS)),
        modifier = Modifier.matchParentSize(),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.scrim.copy(alpha = 0.24f))
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    role = Role.Button,
                    onClick = onDismiss,
                )
                .semantics { contentDescription = "关闭" },
        )
    }

    AnimatedVisibility(
        visible = open,
        enter = slideInVertically(tween(PLUS_MILLIS)) { it / 3 } + fadeIn(tween(PLUS_MILLIS)),
        exit = slideOutVertically(tween(PLUS_MILLIS)) { it / 3 } + fadeOut(tween(PLUS_MILLIS)),
        modifier = Modifier
            .align(Alignment.BottomStart)
            .padding(start = 12.dp, end = 32.dp, bottom = bottomClearance.coerceAtLeast(68.dp)),
    ) {
        val mediaIds = remember { setOf(ChatActionId.PHOTOS, ChatActionId.FILES, ChatActionId.VOICE) }
        val mediaActions = remember(actions) { actions.filter { it.id in mediaIds } }
        val listActions = remember(actions) { actions.filterNot { it.id in mediaIds } }
        ChatMenuCard(modifier = Modifier.width(268.dp)) {
            if (mediaActions.isNotEmpty()) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 10.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    mediaActions.forEach { action ->
                        val alpha = if (action.enabled) 1f else 0.42f
                        Column(
                            modifier = Modifier
                                .weight(1f)
                                .clip(RoundedCornerShape(12.dp))
                                .background(secondaryTint.copy(alpha = 0.10f))
                                .clickable(
                                    enabled = action.enabled,
                                    role = Role.Button,
                                    onClick = { onAction(action.id) },
                                )
                                .padding(vertical = 10.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(5.dp),
                        ) {
                            ChatActionIcon(action.id, minisInk.copy(alpha = alpha))
                            Text(
                                text = when (action.id) {
                                    ChatActionId.PHOTOS -> "图库"
                                    ChatActionId.FILES -> "文件"
                                    ChatActionId.VOICE -> "语音"
                                    else -> action.title
                                },
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Medium,
                                color = minisInk.copy(alpha = alpha),
                                maxLines = 1,
                            )
                        }
                    }
                }
                if (listActions.isNotEmpty()) ChatMenuDivider()
            }
            listActions.forEachIndexed { index, action ->
                if (index > 0) ChatMenuDivider()
                ChatMenuRow(
                    title = action.title,
                    icon = actionIcon(action.id),
                    onClick = { onAction(action.id) },
                    enabled = action.enabled,
                    destructive = action.destructive,
                )
            }
        }
    }
}

/** Longer than this is hold-to-talk; shorter is a tap that leaves the card up. */
private const val HOLD_TO_TALK_MS = 400L

private const val PLUS_MILLIS = 280

/** The + becomes an ×. */
private const val PLUS_TURN_DEGREES = 45f

/** A quiet progress line above the field — `ProgressView` plus a caption on iOS. */
@Composable
private fun ComposerStatusLine(text: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 4.dp)
            .semantics(mergeDescendants = true) { },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
        Text(text = text, fontSize = 13.sp, fontWeight = FontWeight.Medium, color = secondaryTint, maxLines = 1)
    }
}

/**
 * The glyph beside an action. Decorative: the row's own text is the label, and
 * TalkBack reading the icon too would say everything twice.
 */
@Composable
private fun ChatActionIcon(id: ChatActionId, tint: Color) {
    val modifier = Modifier.size(17.dp)
    when (id) {
        ChatActionId.PHOTOS ->
            Icon(painterResource(R.drawable.ic_photo), null, tint = tint, modifier = modifier)
        ChatActionId.FILES ->
            Icon(painterResource(R.drawable.ic_attach_file), null, tint = tint, modifier = modifier)
        ChatActionId.VOICE ->
            Icon(painterResource(R.drawable.ic_mic), null, tint = tint, modifier = modifier)
        ChatActionId.NEW_TASK ->
            Icon(painterResource(R.drawable.ic_plus_line), null, tint = tint, modifier = modifier)
        ChatActionId.TASKS ->
            Icon(painterResource(R.drawable.ic_list_line), null, tint = tint, modifier = modifier)
        ChatActionId.WATCH_COMPUTER ->
            Icon(painterResource(R.drawable.ic_display_line), null, tint = tint, modifier = modifier)
        ChatActionId.SETTINGS ->
            Icon(painterResource(R.drawable.ic_gear_line), null, tint = tint, modifier = modifier)
        ChatActionId.SHARE_MARKDOWN, ChatActionId.SHARE_JSON ->
            Icon(painterResource(R.drawable.ic_share_line), null, tint = tint, modifier = modifier)
        ChatActionId.INTERRUPT ->
            Icon(Icons.Filled.Close, null, tint = tint, modifier = modifier)
    }
}

/** A round + and a pill with the send button inside it. */
@Composable
private fun Composer(
    modifier: Modifier = Modifier,
    name: String,
    draft: String,
    accessory: ComposerAccessory,
    commands: List<SlashCommand>,
    plusOpen: Boolean,
    dictationListening: Boolean,
    dictationLocked: Boolean,
    dictationError: String?,
    onTogglePlus: () -> Unit,
    onDraftChange: (String) -> Unit,
    /** The microphone's whole gesture: tap opens the card, hold talks. */
    voiceButton: Modifier,
    onSend: () -> Unit,
    /** Grok Bot's black voice circle beside the pill; rooms have no call. */
    showCall: Boolean,
    onCall: () -> Unit,
    onToggleHud: () -> Unit,
    onCloseHud: () -> Unit,
    onSelectCommand: (SlashCommand) -> Unit,
    chips: List<PredictiveChip>,
    onSelectChip: (PredictiveChip) -> Unit,
    attachments: List<PendingMessageAttachment>,
    sending: Boolean,
    preparing: Boolean,
    busy: Boolean,
    engineCanSteer: Boolean,
    queuedSends: List<QueuedSend>,
    steering: Boolean,
    onSteer: (() -> Unit)?,
    onCancelQueued: (QueuedSend) -> Unit,
    onEditQueued: (QueuedSend) -> Unit,
    openingFileName: String?,
    attachmentError: String?,
    onRemoveAttachment: (PendingMessageAttachment) -> Unit,
    onDismissError: () -> Unit,
) {
    val canSend = AttachmentImportRules.canSend(draft, attachments.size, preparing, sending)
    val inFlight = preparing || sending
    // Held as the state rather than unwrapped with `by`: read inside the layer
    // block, the turn is a new frame, not a new composition of the composer.
    val turn = animateFloatAsState(
        targetValue = if (plusOpen) PLUS_TURN_DEGREES else 0f,
        animationSpec = tween(PLUS_MILLIS),
        label = "plus",
    )
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(start = 12.dp, end = 12.dp, top = 6.dp, bottom = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (dictationError != null) {
            Text(
                text = dictationError,
                fontSize = 13.sp,
                color = minisWarning,
                modifier = Modifier.padding(horizontal = 4.dp),
            )
        }
        // What is in flight, in the order iOS stacks them: the send or the
        // import, then a file on its way, then whatever went wrong.
        if (inFlight) {
            ComposerStatusLine(if (preparing) "正在准备附件…" else "正在发送…")
        }
        if (openingFileName != null) {
            ComposerStatusLine("正在打开 $openingFileName…")
        }
        if (attachmentError != null) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(minisWarningWash, RoundedCornerShape(12.dp))
                    .padding(horizontal = 12.dp, vertical = 9.dp)
                    .semantics(mergeDescendants = true) { },
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = Icons.Filled.Warning,
                    contentDescription = null,
                    tint = minisWarning,
                    modifier = Modifier.size(18.dp),
                )
                Text(
                    text = NoticeMessageFormat.humanize(attachmentError),
                    fontSize = 13.sp,
                    modifier = Modifier.weight(1f),
                )
                TouchTarget(
                    onClick = onDismissError,
                    size = 44.dp,
                    contentDescription = "忽略附件错误",
                ) {
                    Text(
                        text = "忽略",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = minisAccent,
                    )
                }
            }
        }
        // Everything the computer is holding, stacked straight above the chat
        // bar in the order it was sent.
        queuedSends.forEach { queued ->
            QueuedSendRow(
                send = queued,
                onSteer = onSteer,
                steering = steering,
                onEdit = { onEditQueued(queued) },
                onCancel = { onCancelQueued(queued) },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (attachments.isNotEmpty()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 2.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                attachments.forEach { attachment ->
                    PendingAttachmentChip(
                        attachment = attachment,
                        enabled = !inFlight,
                        onRemove = { onRemoveAttachment(attachment) },
                    )
                }
            }
        }
        // One or the other, never both: the HUD is what the composer is doing
        // right now, and a row of send-immediately chips under it would be a
        // second thing to tap by accident.
        when (accessory) {
            ComposerAccessory.HUD -> CommandSkillHud(
                commands = commands,
                draft = draft,
                onSelect = onSelectCommand,
                onClose = onCloseHud,
            )

            ComposerAccessory.CHIPS -> PredictiveChipsRow(
                chips = chips,
                onSelect = onSelectChip,
            )

            ComposerAccessory.NONE -> Unit
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.Bottom,
        ) {
                Row(
                modifier = Modifier
                    .weight(1f)
                    .clip(CircleShape)
                    .background(if (minisIsDark()) minisCard else Color(0xFFEBEBE9))
                    .heightIn(min = 50.dp)
                    .padding(start = 6.dp, end = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(2.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                // Plus lives inside the capsule, Minis-style. On a 360dp phone
                // the old layout put a 44dp button outside the field and another
                // 44dp slash button inside it, leaving the placeholder only a
                // few characters of width — it wrapped to two lines.
                TouchTarget(
                    onClick = onTogglePlus,
                    contentDescription = if (plusOpen) "关闭" else "更多",
                ) {
                    Box(
                        modifier = Modifier
                            .size(32.dp)
                            .clip(CircleShape)
                            .then(
                                if (plusOpen) {
                                    Modifier.background(minisInk, CircleShape)
                                } else {
                                    Modifier
                                },
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            imageVector = Icons.Filled.Add,
                            contentDescription = null,
                            tint = if (plusOpen) minisPage else minisInk,
                            modifier = Modifier
                                .size(20.dp)
                                .graphicsLayer { rotationZ = turn.value },
                        )
                    }
                }

                Box(
                    modifier = Modifier
                        .weight(1f)
                        .padding(top = 13.dp, bottom = 13.dp),
                ) {
                    if (draft.isEmpty()) {
                        Text(
                            text = ComposerPromise.placeholder(
                                name = name,
                                busy = busy,
                                engineCanSteer = engineCanSteer,
                                sending = sending,
                                listening = dictationListening,
                            ),
                            fontSize = 16.sp,
                            color = secondaryTint,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    BasicTextField(
                        value = draft,
                        onValueChange = onDraftChange,
                        // Partials rebuild from a frozen base; prevent competing
                        // edits without dimming the text.
                        readOnly = dictationLocked,
                        maxLines = 5,
                        textStyle = LocalTextStyle.current.copy(
                            fontSize = 16.sp,
                            color = MaterialTheme.colorScheme.onSurface,
                        ),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.onSurface),
                        // The software keyboard's Return breaks the line, like
                        // Messages; the arrow button on the bar is the one send.
                        // A hardware Return still sends and Shift+Return breaks
                        // the line. Some soft keyboards deliver their Return as a
                        // key event too, so the rule also asks where it came from.
                        modifier = Modifier
                            .fillMaxWidth()
                            // The promise line above is drawn as a sibling and
                            // vanishes on the first character; name the field.
                            // Merge so the name lands on the editable node
                            // TalkBack focuses, not on a silent child.
                            .semantics(mergeDescendants = true) {
                                contentDescription = "消息输入框"
                            }
                            .onPreviewKeyEvent { event ->
                                val sends = ComposerReturn.sends(
                                    isReturnKey = event.key == Key.Enter || event.key == Key.NumPadEnter,
                                    keyDown = event.type == KeyEventType.KeyDown,
                                    shift = event.isShiftPressed,
                                    fromSoftwareKeyboard =
                                        event.nativeKeyEvent.deviceId == KeyCharacterMap.VIRTUAL_KEYBOARD,
                                )
                                if (sends) onSend()
                                sends
                            },
                    )
                }

                // Grok shows the microphone only while there is nothing to
                // send; the moment the draft has content the same slot becomes
                // the send arrow, so the bar never carries two endings at once.
                // The two are one control changing its mind, so the change is a
                // crossfade with a small scale, not an icon swap between frames.
                AnimatedContent(
                    targetState = canSend,
                    transitionSpec = {
                        (fadeIn(tween(140)) + scaleIn(tween(180), initialScale = 0.72f)) togetherWith
                            (fadeOut(tween(90)) + scaleOut(tween(120), targetScale = 0.72f))
                    },
                    label = "composer-action",
                ) { sending ->
                if (!sending) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // Tap opens the floating voice card and keeps recording until
                    // its send button; holding the mic records and the release
                    // sends — one press, decided by how long it is held.
                    val voiceInteraction = remember { MutableInteractionSource() }
                    Box(
                        modifier = Modifier
                            .size(42.dp)
                            .pressScale(voiceInteraction)
                            .clip(CircleShape)
                            .then(voiceButton),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (dictationListening) {
                            ListeningBars(
                                color = MinisTokens.Danger,
                                modifier = Modifier.size(width = 16.dp, height = 14.dp),
                            )
                        } else {
                            Icon(
                                painter = painterResource(R.drawable.ic_mic),
                                contentDescription = null,
                                tint = minisInk,
                                modifier = Modifier.size(21.dp),
                            )
                        }
                    }
                }
                } else {
                    TouchTarget(
                        onClick = onSend,
                        enabled = canSend,
                        contentDescription = "发送",
                    ) {
                        Box(
                            modifier = Modifier
                                .size(34.dp)
                                .background(minisInk, CircleShape),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                painter = painterResource(R.drawable.ic_send_up),
                                contentDescription = null,
                                tint = minisPage,
                                modifier = Modifier.size(19.dp),
                            )
                        }
                    }
                }
                }
            }
        }
    }
}

/**
 * Consecutive identical receipts — two attempts at the same failing engine call,
 * or the same notice twice — are one line with a count. The source transcript is
 * untouched; this only changes what the list draws.
 */
/**
 * Adapts the factory quick-reply chips to the latest conversation context so
 * phone-control chats don't show coding templates; user-customized replies are
 * preserved verbatim.
 */
internal fun contextualQuickReplies(
    transcript: List<Message>,
    configured: List<QuickReply>,
): List<PredictiveChip> {
    if (configured.isEmpty()) return emptyList()
    if (configured != QuickReply.DEFAULTS) {
        return configured.map { PredictiveChip(title = it.title, prompt = it.prompt, icon = it.icon) }
    }
    val recent = transcript.takeLast(6)
    val blob = recent.joinToString(" ") {
        listOfNotNull(it.text, it.tool?.name).joinToString(" ")
    }.lowercase(Locale.ROOT)
    val isPhoneControl = "phone_ui" in blob || "受控屏幕" in blob || "手机屏幕" in blob || "点击测试" in blob
    val isCoding = "git" in blob || "diff" in blob || "编译" in blob || "报错" in blob || "gradle" in blob || "commit" in blob
    return when {
        isPhoneControl -> listOf(
            PredictiveChip("再测一次", "再执行一次刚才的操作验证一下", "history"),
            PredictiveChip("看下屏幕", "帮我读取一下当前手机屏幕状态", "search"),
            PredictiveChip("继续操作", "继续下一步操作", "next"),
            PredictiveChip("总结结果", "简短总结一下刚才的测试结果", "document"),
        )
        isCoding -> listOf(
            PredictiveChip("查看变更", "展示最新的代码变更", "diff"),
            PredictiveChip("运行测试", "运行相关自动化测试确认没有回归", "tests"),
            PredictiveChip("解释原因", "详细解释一下原因和改动点", "explain"),
            PredictiveChip("下一步？", "接下来我们该做什么？", "next"),
        )
        else -> configured.map { PredictiveChip(title = it.title, prompt = it.prompt, icon = it.icon) }
    }
}

internal fun collapseRepeatedReceipts(messages: List<Message>): List<Message> {
    if (messages.size < 2) return messages
    val out = ArrayList<Message>(messages.size)
    var index = 0
    while (index < messages.size) {
        val message = messages[index]
        val tool = message.tool
        if (message.kind != Message.Kind.ACTIVITY || tool == null) {
            out += message
            index++
            continue
        }
        var count = 1
        while (index + count < messages.size) {
            val next = messages[index + count]
            if (next.kind == Message.Kind.ACTIVITY &&
                next.tool?.name == tool.name &&
                next.tool?.ok == tool.ok
            ) {
                count++
            } else {
                break
            }
        }
        out += if (count > 1) {
            message.copy(tool = tool.copy(name = "${tool.name} ×$count"))
        } else {
            message
        }
        index += count
    }
    return out
}
