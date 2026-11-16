package com.openmausbot.companion.ui

import android.annotation.SuppressLint
import android.content.Context
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.Image
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.AddCircle
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import dev.chrisbanes.haze.hazeSource
import dev.chrisbanes.haze.rememberHazeState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.openmausbot.companion.R
import com.openmausbot.companion.avatar.AvatarImagePicker
import com.openmausbot.companion.avatar.AvatarImageRules
import com.openmausbot.companion.avatar.PreparedAvatar
import com.openmausbot.companion.core.AvatarCrop
import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.forTask
import com.openmausbot.companion.core.BotProfilePatch
import com.openmausbot.companion.core.ConfigStatus
import com.openmausbot.companion.core.Instance
import com.openmausbot.companion.core.ModelSelection
import com.openmausbot.companion.core.Session
import com.openmausbot.companion.core.Voice
import com.openmausbot.companion.core.VoiceProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The paired-safe subset of bot settings — the port of
 * `ios/App/AgentProfileView.swift`, drawn as the Grok Bot edit page.
 *
 * The model, identity, avatar, notifications and the renderer-neutral voice
 * choice. Shared provider keys stay on the computer: this page sees the model
 * catalog and configured / not configured, and offers no field that could
 * carry a key.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AgentProfileSheet(bot: Bot?, onDismiss: () -> Unit, onOpenOverview: (String) -> Unit) {
    val environment = LocalCompanion.current
    val session = environment.session
    val state by session.state.collectAsState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val player = environment.voicePreview

    // Editing opens on a record; creating opens on nothing. Nothing is sent to
    // the computer until the form is saved, so leaving a half-filled new bot
    // (the back arrow, a system back) leaves the fleet exactly as it was.
    val opened = remember { bot }
    // Once a save has made the bot this page becomes an editor: a retry after a
    // failed profile patch must patch that bot, not make a second one.
    var created by remember { mutableStateOf<Bot?>(null) }
    val record = created ?: opened
    val creating = record == null
    // Drawn before the bot exists; never sent anywhere. The avatar section is
    // closed while creating because an upload needs an id to attach to.
    val placeholder = remember {
        Bot(
            id = "",
            threadId = "",
            name = "",
            title = "",
            description = "",
            notifications = true,
            color = "black",
            unread = false,
            modelSelection = ModelSelection("", "", null),
            createdAt = 0.0,
        )
    }

    var form by rememberSaveable(stateSaver = ProfileFormSaver) {
        mutableStateOf(opened?.let(ProfileForm::of) ?: ProfileForm.blank())
    }
    var baseline by rememberSaveable(stateSaver = ProfileFormSaver) {
        mutableStateOf(opened?.let(ProfileForm::of) ?: ProfileForm.blank())
    }
    // The record as the computer knows it, or the stand-in while creating.
    val live = record?.let { state.bot(it.id) ?: it }
    val current = live ?: placeholder.copy(
        name = form.name,
        title = form.title,
        description = form.description,
    )
    val currentTask = live?.let { it.forTask(opened?.threadId ?: it.threadId) }

    var prompt by rememberSaveable { mutableStateOf("") }
    var voices by remember { mutableStateOf<List<Voice>>(emptyList()) }
    var config by remember { mutableStateOf<ConfigStatus?>(null) }
    var busy by remember { mutableStateOf(false) }
    var switchingEngine by remember { mutableStateOf(false) }
    var compacting by remember { mutableStateOf(false) }
    var confirmingCompact by remember { mutableStateOf(false) }
    // The avatar library expands under the 外观 row; a Dialog has no second
    // screen to push it onto.
    var libraryOpen by rememberSaveable { mutableStateOf(false) }
    // A face chosen before the bot exists. Uploading needs a bot id, and this
    // page deliberately creates nothing until Save — so the choice is held here
    // and uploaded at the moment the bot is made. Without this, picking a face
    // while creating did nothing at all (the picker returned early).
    var pendingPreset by remember { mutableStateOf<PresetAvatar?>(null) }
    var pendingUpload by remember { mutableStateOf<Pair<ByteArray, String>?>(null) }
    // Set when "Done" is pressed on a creation page with nothing to save.
    var nameHint by remember { mutableStateOf(false) }
    // A failed save used to close the page, so the form vanished looking
    // saved. The sentence stays here, in the sheet's own window, where the
    // activity-level notice cannot be seen.
    var saveError by remember { mutableStateOf<String?>(null) }

    // The Model section. The draft survives rotation; the catalog is reloaded.
    var instances by remember { mutableStateOf<List<Instance>>(emptyList()) }
    var modelsLoaded by remember { mutableStateOf(false) }
    var savedModel by remember { mutableStateOf(opened?.modelSelection ?: ModelSelection("", "", null)) }
    var selectedInstanceId by rememberSaveable {
        mutableStateOf(opened?.modelSelection?.instanceId.orEmpty())
    }
    var selectedModelId by rememberSaveable { mutableStateOf(opened?.modelSelection?.model.orEmpty()) }
    // "" is the engine default; the picker has no null row.
    var selectedEffort by rememberSaveable {
        mutableStateOf(opened?.modelSelection?.effort.orEmpty())
    }
    // A model picked before the bot exists: kept here and applied right after
    // the first save, because there is no id to send it to yet.
    var pendingModel by remember { mutableStateOf<ModelSelection?>(null) }
    val selectedInstance = instances.firstOrNull { it.instanceId == selectedInstanceId }
    val modelDraft = ModelSelection(selectedInstanceId, selectedModelId, selectedEffort.ifEmpty { null })

    fun liveBot(): Bot? = record?.let { session.state.value.bot(it.id) ?: it }

    fun showModel(selection: ModelSelection) {
        selectedInstanceId = selection.instanceId
        selectedModelId = selection.model
        selectedEffort = selection.effort.orEmpty()
    }

    /**
     * One save path for the bottom row and "完成".
     *
     * The bottom row alone was a trap: the form is long, and "完成" looked like
     * it committed what had just been typed. It dismissed instead, so a renamed
     * bot came back under its old name and read as "the name cannot be changed".
     */
    fun saveProfile(close: Boolean = false) {
        if (busy) return
        scope.launch {
            busy = true
            saveError = null
            try {
                // Creating is the one place a bot is made: the name must be
                // typed and this button pressed. Nothing before it touches the
                // fleet.
                val target = created ?: liveBot() ?: session.createBot()
                if (target == null) {
                    saveError = NoticeMessageFormat.humanize(
                        session.actionError ?: "无法创建智能体，请检查连接后重试。",
                    )
                    session.actionError = null
                    return@launch
                }
                created = target
                // A face picked before the bot existed is uploaded now, when
                // there is finally an id to attach it to.
                pendingUpload?.let { (bytes, mime) ->
                    val uploaded = session.uploadAvatar(
                        data = bytes,
                        mime = mime,
                        forBot = target,
                        crop = AvatarCrop.CIRCLE,
                    )
                    if (uploaded == null) {
                        // The rest of the form is still worth saving, but the
                        // person asked for that face; say it did not land.
                        saveError = "头像上传失败，其余修改已保留。"
                    }
                    pendingUpload = null
                    pendingPreset = null
                }
                val updated = session.updateProfile(
                    ProfileRules.patch(form, baseline, config),
                    target,
                )
                if (updated == null) {
                    // Closing here made a failed save look like a saved one.
                    if (saveError == null) {
                        saveError = NoticeMessageFormat.humanize(
                            session.actionError ?: "保存失败，请检查连接后重试。",
                        )
                        session.actionError = null
                    }
                    return@launch
                }
                form = ProfileForm.of(updated)
                baseline = ProfileForm.of(updated)
                // A model chosen in the creation form is applied now, when
                // there is finally an id to send it to.
                pendingModel?.let { selection ->
                    val applied = session.updateModel(selection, updated)
                    if (applied != null) {
                        savedModel = applied.modelSelection
                        showModel(applied.modelSelection)
                    }
                    pendingModel = null
                }
                if (close) onDismiss()
            } finally {
                busy = false
            }
        }
    }

    // The pill reads unsaved changes off the same comparison the save uses.
    val profileDirty = form != baseline
    val connectionStatus by session.status.collectAsState()

    LaunchedEffect(Unit) {
        val priorError = session.actionError
        if (connectionStatus is Session.Status.Offline ||
            connectionStatus == Session.Status.Unpaired ||
            connectionStatus == Session.Status.Unauthorized
        ) {
            modelsLoaded = true
            return@LaunchedEffect
        }
        launch {
            val loadedStatus = withTimeoutOrNull(4_500L) { session.configStatus() }
            config = loadedStatus
            form = ProfileRules.applyLoadedConfig(form, loadedStatus)
            if (priorError == null && session.actionError != null) session.actionError = null
        }
        launch {
            voices = withTimeoutOrNull(4_500L) { session.voiceOptions() }.orEmpty()
            if (priorError == null && session.actionError != null) session.actionError = null
        }
        launch {
            instances = withTimeoutOrNull(4_500L) { session.modelInstances() }.orEmpty()
            modelsLoaded = true
            if (priorError == null && session.actionError != null) session.actionError = null
        }
    }

    // One preview at a time, and none that outlives this page.
    DisposableEffect(lifecycleOwner) {
        player.bind(lifecycleOwner)
        onDispose { player.unbind(lifecycleOwner) }
    }
    LaunchedEffect(Unit) {
        player.playbackErrors.collect { session.actionError = it }
    }

    val pickImage = rememberLauncherForActivityResult(
        remember { AvatarImagePicker.contract() },
    ) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            busy = true
            try {
                when (val prepared = AvatarImagePicker.read(context.contentResolver, uri)) {
                    is PreparedAvatar.Rejected -> session.actionError = prepared.message
                    is PreparedAvatar.Ready -> {
                        val intended = AvatarImageRules.intendedUploadCrop(form.crop)
                        // No bot yet: hold the picture and upload it when Save
                        // creates one. Creating a bot here would make "back" a
                        // creation again, which is the thing this page avoids.
                        val target = created ?: opened
                        if (target == null) {
                            pendingUpload = prepared.data to prepared.mime
                            pendingPreset = null
                            form = form.copy(crop = intended)
                            baseline = baseline.copy(crop = intended)
                            return@launch
                        }
                        val updated = session.uploadAvatar(
                            data = prepared.data,
                            mime = prepared.mime,
                            forBot = target,
                            crop = intended,
                        )
                        if (updated != null) {
                            val crop = updated.avatarCrop ?: intended
                            form = form.copy(crop = crop)
                            baseline = baseline.copy(crop = crop)
                        }
                    }
                }
            } finally {
                busy = false
            }
        }
    }

    // The Grok Bot edit page is a page, not a sheet: it covers the screen on
    // the grey canvas so the form reads like Settings. A Dialog owns the whole
    // window, and with `decorFitsSystemWindows = false` it draws under the
    // system bars — so this content pads its own insets.
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        val hazeState = rememberHazeState()
        val scrollState = rememberScrollState()
        val topScrolled by remember { derivedStateOf { scrollState.canScrollBackward } }
        val topBandAlpha by animateFloatAsState(
            targetValue = if (topScrolled) 1f else 0f,
            animationSpec = tween(180),
            label = "profile-top-haze",
        )
        CompositionLocalProvider(LocalHazeState provides hazeState) {
        Box(modifier = Modifier.fillMaxSize().background(minisCanvas).statusBarsPadding()) {
            val view = LocalView.current
            val dark = minisIsDark()
            SideEffect {
                val window = (view.parent as? DialogWindowProvider)?.window ?: return@SideEffect
                WindowCompat.getInsetsController(window, view).apply {
                    isAppearanceLightStatusBars = !dark
                    isAppearanceLightNavigationBars = !dark
                }
            }
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(minisCanvas)
                    .hazeSource(hazeState),
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(scrollState)
                        .navigationBarsPadding()
                        .padding(horizontal = MinisPagePadding)
                        .padding(top = 72.dp, bottom = 36.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    saveError?.let { message ->
                        InlineNotice(
                            message = message,
                            tone = NoticeTone.ERROR,
                            modifier = Modifier.fillMaxWidth(),
                            onDismiss = { saveError = null },
                        )
                    }

                    Column(
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 4.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Box(
                            modifier = Modifier
                                .clip(CircleShape)
                                .clickable(enabled = !busy, role = Role.Button) { libraryOpen = !libraryOpen },
                        ) {
                            val waiting = pendingPreset
                            if (waiting != null) {
                                PresetBotAvatar(
                                    color = waiting.key,
                                    size = 108.dp,
                                    contentDescription = "${current.name} 头像",
                                )
                            } else {
                                BotAvatar(
                                    bot = current,
                                    size = 108.dp,
                                    state = MausState.HAPPY,
                                    fallback = AvatarFallback.PRESET,
                                    contentDescription = "${current.name} 头像",
                                )
                            }
                            TouchTarget(
                                onClick = { if (!busy) libraryOpen = !libraryOpen },
                                modifier = Modifier
                                    .align(Alignment.BottomEnd)
                                    .offset(x = 4.dp, y = 4.dp),
                                contentDescription = "更换头像",
                            ) {
                                Box(
                                    modifier = Modifier
                                        .size(36.dp)
                                        .background(minisCanvas, CircleShape)
                                        .padding(2.dp)
                                        .shadow(4.dp, CircleShape, clip = false)
                                        .background(minisCard, CircleShape)
                                        .border(0.5.dp, minisSeparator, CircleShape),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Icon(
                                        imageVector = Icons.Filled.Edit,
                                        contentDescription = null,
                                        tint = minisInk,
                                        modifier = Modifier.size(15.dp),
                                    )
                                }
                            }
                        }
                        Text(
                            text = if (libraryOpen) "收起头像选项" else "点击更换头像",
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Medium,
                            color = minisAccent,
                            modifier = Modifier
                                .clip(CircleShape)
                                .clickable(enabled = !busy, role = Role.Button) { libraryOpen = !libraryOpen }
                                .padding(horizontal = 12.dp, vertical = 4.dp),
                        )
                    }

                    AnimatedVisibility(visible = libraryOpen) {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            ProfileCard {
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(horizontal = 16.dp, vertical = 12.dp)
                                        .background(minisGrouped, RoundedCornerShape(12.dp))
                                        .padding(3.dp),
                                    horizontalArrangement = Arrangement.spacedBy(3.dp),
                                ) {
                                    AvatarCrop.entries.forEach { option ->
                                        val active = form.crop == option
                                        Box(
                                            modifier = Modifier
                                                .weight(1f)
                                                .heightIn(min = 38.dp)
                                                .clip(RoundedCornerShape(9.dp))
                                                .then(
                                                    if (active) {
                                                        Modifier
                                                            .background(minisCard, RoundedCornerShape(9.dp))
                                                            .border(0.5.dp, minisSeparator, RoundedCornerShape(9.dp))
                                                    } else {
                                                        Modifier
                                                    },
                                                )
                                                .clickable(role = Role.RadioButton) { form = form.copy(crop = option) },
                                            contentAlignment = Alignment.Center,
                                        ) {
                                            Text(
                                                text = ProfileRules.cropLabel(option),
                                                fontSize = 13.sp,
                                                fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                                                color = if (active) minisInk else minisSecondary,
                                            )
                                        }
                                    }
                                }
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(horizontal = 16.dp, vertical = 4.dp)
                                        .horizontalScroll(rememberScrollState()),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    PresetAvatars.all.forEach { preset ->
                                        TouchTarget(
                                            onClick = {
                                                if (!busy) {
                                                    scope.launch {
                                                        busy = true
                                                        try {
                                                            val bytes = presetPngBytes(context, preset)
                                                            val target = created ?: opened
                                                            if (target == null) {
                                                                pendingUpload = bytes to "image/png"
                                                                pendingPreset = preset
                                                                form = form.copy(crop = AvatarCrop.CIRCLE)
                                                                baseline = baseline.copy(crop = AvatarCrop.CIRCLE)
                                                                return@launch
                                                            }
                                                            val updated = session.uploadAvatar(
                                                                data = bytes,
                                                                mime = "image/png",
                                                                forBot = target,
                                                                crop = AvatarCrop.CIRCLE,
                                                            )
                                                            if (updated != null) {
                                                                pendingPreset = null
                                                                form = form.copy(crop = AvatarCrop.CIRCLE)
                                                                baseline = baseline.copy(crop = AvatarCrop.CIRCLE)
                                                            }
                                                        } finally {
                                                            busy = false
                                                        }
                                                    }
                                                }
                                            },
                                            contentDescription = "使用${preset.label}头像",
                                            size = 48.dp,
                                            enabled = !busy,
                                        ) {
                                            PresetBotAvatar(
                                                color = preset.key,
                                                size = 44.dp,
                                                contentDescription = null,
                                            )
                                        }
                                    }
                                }
                                ProfileCardDivider()
                                ProfileActionRow(
                                    text = "从相册上传图片",
                                    icon = Icons.Filled.AddCircle,
                                    enabled = !busy,
                                    onClick = { pickImage.launch(AvatarImagePicker.request()) },
                                )
                                if (current.avatarUrl != null) {
                                    ProfileCardDivider()
                                    ProfileActionRow(
                                        text = "恢复默认头像",
                                        icon = Icons.Filled.Delete,
                                        enabled = !busy,
                                        destructive = true,
                                        onClick = {
                                            scope.launch {
                                                busy = true
                                                try {
                                                    val target = (created ?: opened) ?: return@launch
                                                    val updated = session.updateProfile(
                                                        BotProfilePatch(
                                                            avatarUrl = BotProfilePatch.AvatarURL.Clear,
                                                            avatarCrop = AvatarCrop.MASCOT,
                                                        ),
                                                        target,
                                                    )
                                                    if (updated != null) {
                                                        val crop = updated.avatarCrop ?: AvatarCrop.MASCOT
                                                        form = form.copy(crop = crop)
                                                        baseline = baseline.copy(crop = crop)
                                                    }
                                                } finally {
                                                    busy = false
                                                }
                                            }
                                        },
                                    )
                                }
                            }
                            ProfileFooter(
                                if (creating) "头像会在保存时上传到电脑。" else ProfileRules.AVATAR_FOOTER,
                            )
                        }
                    }

                    ProfileSectionLabel("名称")
                    ProfileCard {
                        ProfilePlainField(
                            value = form.name,
                            onValueChange = {
                                form = form.copy(name = it)
                                if (it.isNotBlank()) nameHint = false
                            },
                            placeholder = "名称",
                            label = "名称",
                            keyboardOptions = KeyboardOptions(
                                capitalization = KeyboardCapitalization.Words,
                            ),
                        )
                    }
                    if (nameHint) {
                        Text(
                            text = "先给智能体起个名字，再点创建。",
                            fontSize = 13.sp,
                            color = MinisTokens.Danger,
                            modifier = Modifier.padding(start = 4.dp, top = 2.dp),
                        )
                    }

                    VoiceSection(
                        config = config,
                        switching = switchingEngine,
                        onSwitchEngine = { next ->
                            // The desktop's Voice engine group: one field of the
                            // ordinary config write, then a fresh voice list,
                            // because every engine names its own voices.
                            if (switchingEngine || config?.voiceProvider == next) return@VoiceSection
                            scope.launch {
                                switchingEngine = true
                                try {
                                    val updated = session.switchVoiceProvider(next)
                                    if (updated != null) {
                                        val (resetForm, resetBaseline) = ProfileRules.afterVoiceProviderSwitch(
                                            form = form,
                                            baseline = baseline,
                                            config = updated,
                                        )
                                        form = resetForm
                                        baseline = resetBaseline
                                        config = updated
                                        // Never render or preview the previous
                                        // provider's identifiers while reloading.
                                        voices = emptyList()
                                        voices = session.voiceOptions()
                                    }
                                } finally {
                                    switchingEngine = false
                                }
                            }
                        },
                    ) {
                        ProfilePickerRow(
                            label = "语音音色",
                            choices = ProfileRules.voiceChoices(config, voices, form.voice),
                            selected = form.voice,
                            onSelect = { form = form.copy(voice = it) },
                        )
                        ProfileCardDivider()
                        ProfileSwitchRow(
                            label = "语音朗读回复",
                            checked = form.speakReplies,
                            enabled = ProfileRules.selectedVoiceCanSpeak(config, form.voice),
                            onCheckedChange = { form = form.copy(speakReplies = it) },
                        )
                        ProfileCardDivider()
                        ProfileActionRow(
                            text = "试听语音",
                            painter = R.drawable.ic_volume_up,
                            enabled = ProfileRules.canPreview(busy, config, form.voice),
                            onClick = {
                                scope.launch {
                                    if (!ProfileRules.selectedVoiceCanSpeak(config, form.voice)) {
                                        session.actionError = ProfileRules.PREVIEW_REFUSED
                                        return@launch
                                    }
                                    busy = true
                                    try {
                                        // Preview only needs the bot's name for
                                        // the sample line, so a draft can hear
                                        // its own voice without being created.
                                        val data = session.previewVoice(
                                            form.voice,
                                            liveBot() ?: current,
                                        ) ?: return@launch
                                        // `rememberCoroutineScope` dispatches on
                                        // main, and starting a preview reaches
                                        // MediaPlayer.prepare(), which blocks
                                        // until the source is decodable. The
                                        // controller serialises every transition
                                        // on its own lock and its callbacks are
                                        // delivered on the main Looper, so it is
                                        // safe to start from a worker; the result
                                        // lands back on main to be reported.
                                        val failure = withContext(Dispatchers.IO) {
                                            player.play(data)
                                        }
                                        failure?.let { session.actionError = it }
                                    } finally {
                                        busy = false
                                    }
                                }
                            },
                        )
                        ProfileRules.pickAVoiceHint(config, form.voice)?.let { hint ->
                            Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
                                IconNote(text = hint, icon = Icons.Filled.Info)
                            }
                        }
                    }

                    ProfileSectionLabel("模型")
                    ProfileCard {
                        val instanceChoices = ModelRules.instanceChoices(instances, savedModel)
                        if (!modelsLoaded) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .heightIn(min = 56.dp)
                                    .padding(horizontal = 16.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    ModelRules.LOADING,
                                    fontSize = 15.sp,
                                    color = minisSecondary,
                                    modifier = Modifier.weight(1f),
                                )
                                CircularProgressIndicator(modifier = Modifier.size(20.dp))
                            }
                        } else if (instanceChoices.isEmpty()) {
                            if (savedModel.model.isNotBlank()) {
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .heightIn(min = 54.dp)
                                        .padding(horizontal = 16.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(
                                        text = "当前模型",
                                        fontSize = 16.sp,
                                        color = minisInk,
                                        modifier = Modifier.weight(1f),
                                    )
                                    Text(
                                        text = savedModel.model,
                                        fontSize = 15.sp,
                                        color = minisSecondary,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                ProfileCardDivider()
                            }
                            Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
                                IconNote(
                                    text = if (connectionStatus == Session.Status.Live) {
                                        ModelRules.NONE_AVAILABLE
                                    } else {
                                        "连接电脑后可切换模型与服务商"
                                    },
                                    icon = Icons.Filled.Info,
                                )
                            }
                        } else {
                            val providerRows = buildList {
                                if (ModelRules.providerMissing(instances, selectedInstanceId)) {
                                    add(
                                        VoiceChoice(
                                            id = selectedInstanceId,
                                            label = ModelRules.CURRENT_PROVIDER_UNAVAILABLE,
                                            detail = null,
                                            enabled = false,
                                        ),
                                    )
                                }
                                instanceChoices.forEach {
                                    add(
                                        VoiceChoice(
                                            id = it.instanceId,
                                            label = ModelRules.instanceLabel(it),
                                            detail = null,
                                            enabled = it.snapshot.isAvailable,
                                        ),
                                    )
                                }
                            }
                            ProfilePickerRow(
                                label = "提供商",
                                choices = providerRows,
                                selected = selectedInstanceId,
                                onSelect = { id ->
                                    val instance = instances.firstOrNull { it.instanceId == id }
                                    if (instance != null) showModel(ModelRules.defaultsFor(instance, savedModel))
                                },
                            )
                            ProfileCardDivider()
                            ProfilePickerRow(
                                label = "模型",
                                choices = ModelRules.modelChoices(selectedInstance, selectedModelId).map {
                                    VoiceChoice(id = it.id, label = it.label, detail = null, enabled = true)
                                },
                                selected = selectedModelId,
                                enabled = selectedInstance?.snapshot?.isAvailable == true,
                                onSelect = { selectedModelId = it },
                            )
                            val effortLevels = ModelRules.effortLevels(selectedInstance)
                            if (effortLevels.isNotEmpty()) {
                                ProfileCardDivider()
                                ProfilePickerRow(
                                    label = "推理强度",
                                    choices = buildList {
                                        add(VoiceChoice(id = "", label = ModelRules.DEFAULT_EFFORT_LABEL, detail = null, enabled = true))
                                        effortLevels.forEach {
                                            add(VoiceChoice(id = it, label = ModelRules.effortLabel(it), detail = null, enabled = true))
                                        }
                                    },
                                    selected = selectedEffort,
                                    onSelect = { selectedEffort = it },
                                )
                            }
                            ModelRules.note(currentTask?.busy, selectedInstance)?.let { note ->
                                Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
                                    IconNote(text = note, icon = Icons.Filled.Info)
                                }
                            }
                            ProfileActionRow(
                                text = if (creating) "记住模型" else "应用模型",
                                icon = Icons.Filled.Check,
                                enabled = !busy && (creating || currentTask != null) && ModelRules.canApply(
                                    loaded = modelsLoaded,
                                    botBusy = currentTask?.busy,
                                    instance = selectedInstance,
                                    draft = modelDraft,
                                    saved = savedModel,
                                ),
                                onClick = {
                                    // While creating there is nothing to patch;
                                    // saveProfile sends this right after the bot
                                    // exists.
                                    if (creating) {
                                        pendingModel = modelDraft
                                        savedModel = modelDraft
                                    } else {
                                        scope.launch {
                                            busy = true
                                            try {
                                                val bot = liveBot() ?: return@launch
                                                val target = bot.forTask(opened?.threadId ?: bot.threadId)
                                                    ?: return@launch
                                                val updated = session.updateModel(modelDraft, target)
                                                if (updated != null) {
                                                    savedModel = updated.modelSelection
                                                    showModel(updated.modelSelection)
                                                }
                                            } finally {
                                                busy = false
                                            }
                                        }
                                    }
                                },
                            )
                        }
                    }
                    ProfileFooter(ModelRules.FOOTER)

                    ProfileSectionLabel("上下文")
                    ProfileCard {
                        ProfileActionRow(
                            text = if (compacting) "正在压缩…" else ProfileRules.COMPACT_LABEL,
                            enabled = !busy && !compacting && currentTask != null,
                            onClick = { confirmingCompact = true },
                        )
                    }
                    ProfileFooter(ProfileRules.COMPACT_FOOTER)

                    ProfileSectionLabel("生成头像")
                    ProfileCard {
                        ProfilePlainField(
                            value = prompt,
                            onValueChange = { prompt = it },
                            placeholder = "画面风格描述",
                            label = "画面风格描述",
                            singleLine = false,
                            minLines = 2,
                            maxLines = 5,
                        )
                        ProfileActionRow(
                            text = "在电脑上生成",
                            painter = R.drawable.ic_sparkles,
                            // Generating attaches the result to a bot, so it
                            // waits until this draft has an id.
                            enabled = !creating && ProfileRules.canGenerate(busy, config, prompt),
                            onClick = {
                                scope.launch {
                                    busy = true
                                    try {
                                        val intended = AvatarImageRules.intendedUploadCrop(form.crop)
                                        val target = (created ?: opened) ?: return@launch
                                        val generated = session.generateAvatar(
                                            ProfileRules.generatePrompt(prompt),
                                            target,
                                        ) ?: return@launch
                                        // Generation picks a safe crop server-side;
                                        // the selector is the user's explicit choice,
                                        // so persist it against the returned
                                        // attachment rather than leaving the two out
                                        // of sync.
                                        val updated = session.updateProfile(
                                            BotProfilePatch(avatarCrop = intended),
                                            generated,
                                        )
                                        val crop = if (updated != null) {
                                            updated.avatarCrop ?: intended
                                        } else {
                                            // Generation itself succeeded: reflect its
                                            // authoritative fallback rather than
                                            // claiming the requested crop was saved.
                                            generated.avatarCrop ?: AvatarCrop.MASCOT
                                        }
                                        form = form.copy(crop = crop)
                                        baseline = baseline.copy(crop = crop)
                                    } finally {
                                        busy = false
                                    }
                                }
                            },
                        )
                    }
                    ProfileFooter(ProfileRules.generateFooter(config))

                    ProfileSectionLabel("身份信息")
                    ProfileCard {
                        ProfilePlainField(
                            value = form.title,
                            onValueChange = { form = form.copy(title = it) },
                            placeholder = "头衔",
                            label = "头衔",
                        )
                        ProfileCardDivider()
                        ProfilePlainField(
                            value = form.description,
                            onValueChange = { form = form.copy(description = it) },
                            placeholder = "此智能体的职责描述",
                            label = "职责描述",
                            singleLine = false,
                            minLines = 3,
                            maxLines = 8,
                        )
                    }

                    ProfileSectionLabel("通知")
                    ProfileCard {
                        ProfileSwitchRow(
                            label = "智能体通知",
                            checked = form.notifications,
                            onCheckedChange = { form = form.copy(notifications = it) },
                        )
                    }

                    if (opened != null) {
                        ProfileCard {
                            ProfileActionRow(
                                text = "此智能体的职责与配置",
                                icon = Icons.Filled.Info,
                                onClick = { onOpenOverview(opened.id) },
                            )
                        }
                    }
                }
            }

            Box(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .fillMaxWidth()
                    .height(94.dp)
                    .progressiveHazeBand(hazeState, fromTop = true, alpha = topBandAlpha),
            )
            Box(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .fillMaxWidth()
                    .heightIn(min = 56.dp)
                    .padding(horizontal = 12.dp, vertical = 4.dp),
            ) {
                TouchTarget(
                    onClick = onDismiss,
                    modifier = Modifier.align(Alignment.CenterStart),
                    contentDescription = "返回",
                ) {
                    Box(
                        modifier = Modifier
                            .size(42.dp)
                            .chromeCapsule(surface = true),
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
                    text = if (creating) "新建智能体" else "编辑智能体",
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = minisInk,
                    modifier = Modifier.align(Alignment.Center),
                )
                val canCommit = if (creating) {
                    ProfileRules.canSave(form, busy)
                } else {
                    profileDirty && ProfileRules.canSave(form, busy)
                }
                val commitLabel = when {
                    creating -> "创建"
                    profileDirty -> "保存"
                    else -> "完成"
                }
                Box(
                    modifier = Modifier
                        .align(Alignment.CenterEnd)
                        .then(
                            if (canCommit) {
                                Modifier
                                    .clip(CircleShape)
                                    .background(minisInk, CircleShape)
                            } else {
                                Modifier.chromeCapsule(surface = true)
                            },
                        )
                        .clickable(role = Role.Button) {
                            if (canCommit) {
                                saveProfile(close = true)
                            } else if (creating) {
                                nameHint = true
                            } else {
                                onDismiss()
                            }
                        }
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                ) {
                    Text(
                        text = commitLabel,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Medium,
                        color = if (canCommit) minisPage else minisSecondary,
                    )
                }
            }

            if (busy) {
                Box(
                    modifier = Modifier.matchParentSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(44.dp))
                }
            }
        }
        }
    }

    if (confirmingCompact) {
        AlertDialog(
            onDismissRequest = { confirmingCompact = false },
            title = { Text(ProfileRules.COMPACT_TITLE) },
            text = { Text(ProfileRules.COMPACT_CONFIRM) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmingCompact = false
                        scope.launch {
                            compacting = true
                            val bot = liveBot()
                            val target = bot?.let { it.forTask(opened?.threadId ?: it.threadId) }
                            if (target != null) session.compact(target)
                            compacting = false
                        }
                    },
                ) {
                    Text(ProfileRules.COMPACT_ACTION)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmingCompact = false }) {
                    Text("取消")
                }
            },
        )
    }
}

@Composable
internal fun ChoicePicker(
    label: String,
    choices: List<VoiceChoice>,
    selected: String,
    onSelect: (String) -> Unit,
    enabled: Boolean = true,
) {
    ProfileCard {
        ProfilePickerRow(
            label = label,
            choices = choices,
            selected = selected,
            onSelect = onSelect,
            enabled = enabled,
        )
    }
}

/**
 * The Voice section: its words, and which of them stand in for the picker.
 *
 * Both come from one [ProfileRules.voiceCopy] call, so the branch and the
 * sentence explaining it cannot disagree. This exists as its own composable
 * because the defect it guards lives in the composition rather than in any
 * value a rule returns — the screen once drew a correct sentence in the wrong
 * slot with the whole suite green — and, like `DataTableCard`, the assertion
 * has to be over what is mounted. `VoiceSectionWiringTest` mounts exactly this,
 * so the text order stays label, engine, notice-or-picker, footer.
 *
 * The engine picker rides above the branch: like the desktop's Voice engine
 * group it is drawn in every state, because switching away is how you repair
 * an engine whose credential is missing.
 *
 * The label is the Grok edit page's 语音通话. Its 速度 / 语言 rows have no
 * server field behind them, so this card carries only what the config
 * actually reports.
 */
@Composable
internal fun VoiceSection(
    config: ConfigStatus?,
    switching: Boolean = false,
    onSwitchEngine: (VoiceProvider) -> Unit = {},
    canSpeak: @Composable () -> Unit,
) {
    val copy = ProfileRules.voiceCopy(config)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        ProfileSectionLabel("语音通话")
        ProfileCard {
            ProfilePickerRow(
                label = "语音引擎",
                choices = ProfileRules.providerChoices(),
                selected = (config?.voiceProvider ?: VoiceProvider.ELEVENLABS).wire,
                onSelect = { next -> onSwitchEngine(VoiceProvider.fromWire(next)) },
                enabled = !switching,
            )
            ProfileCardDivider()
            if (copy.unconfiguredNotice != null) {
                Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
                    IconNote(text = copy.unconfiguredNotice, painter = R.drawable.ic_volume_off)
                }
            } else {
                canSpeak()
            }
        }
        ProfileFooter(copy.footer)
    }
}

/**
 * The edit page's material: white cards on the grey canvas, 56 dp rows, 13 sp
 * grey labels, hairlines between rows. These live beside the older
 * `FormSection`/`ActionRow` family rather than replacing it — the other
 * sheets still draw the old Form look.
 */

/** The 13 sp grey label above a card. */
@Composable
private fun ProfileSectionLabel(text: String) {
    Text(
        text = text,
        modifier = Modifier.padding(start = 16.dp),
        fontSize = 13.sp,
        color = minisSecondary,
    )
}

/** The 13 sp grey explanatory line under a card. */
@Composable
private fun ProfileFooter(text: String) {
    Text(
        text = text,
        modifier = Modifier.padding(horizontal = 16.dp),
        fontSize = 13.sp,
        color = minisSecondary,
    )
}

/** A white card: `minisCard` fill, rounded 16, no border, no glass. */
@Composable
private fun ProfileCard(content: @Composable () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(minisCard, MinisCardShape),
    ) {
        content()
    }
}

/** The thin divider between rows inside a card, inset to the row text. */
@Composable
private fun ProfileCardDivider() {
    MinisDivider(insetStart = 16.dp)
}

/** A `Button` row of a card: 56 dp tall, 17 sp ink, left aligned. */
@Composable
private fun ProfileActionRow(
    text: String,
    enabled: Boolean = true,
    destructive: Boolean = false,
    icon: ImageVector? = null,
    painter: Int? = null,
    onClick: () -> Unit,
) {
    val tint = when {
        !enabled -> minisTertiary
        destructive -> minisDanger
        else -> minisInk
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        when {
            icon != null -> Icon(
                imageVector = icon,
                contentDescription = null,
                tint = tint,
                modifier = Modifier.size(20.dp),
            )
            painter != null -> Icon(
                painter = painterResource(painter),
                contentDescription = null,
                tint = tint,
                modifier = Modifier.size(20.dp),
            )
        }
        Text(text = text, fontSize = 17.sp, color = tint)
    }
}

/** A `Toggle` row of a card: the whole 56 dp line switches. */
@Composable
private fun ProfileSwitchRow(
    label: String,
    checked: Boolean,
    enabled: Boolean = true,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .toggleable(
                value = checked,
                enabled = enabled,
                role = Role.Switch,
                onValueChange = onCheckedChange,
            )
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            fontSize = 17.sp,
            color = if (enabled) minisInk else minisTertiary,
            modifier = Modifier.weight(1f),
        )
        Switch(checked = checked, onCheckedChange = null, enabled = enabled)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ProfilePickerRow(
    label: String,
    choices: List<VoiceChoice>,
    selected: String,
    onSelect: (String) -> Unit,
    enabled: Boolean = true,
) {
    var expanded by remember { mutableStateOf(false) }
    val selectedLabel = choices.firstOrNull { it.id == selected }?.label.orEmpty()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clickable(enabled = enabled, role = Role.Button) { expanded = true }
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            fontSize = 17.sp,
            color = if (enabled) minisInk else minisTertiary,
            modifier = Modifier.weight(1f),
        )
        Text(
            text = selectedLabel,
            fontSize = 15.sp,
            color = minisSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.End,
            modifier = Modifier.weight(1f).padding(start = 12.dp),
        )
        Icon(
            imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = minisTertiary,
            modifier = Modifier.padding(start = 8.dp).size(20.dp),
        )
    }
    if (expanded && enabled) {
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = { expanded = false },
            sheetState = sheetState,
            shape = MinisSheetShape,
            containerColor = minisCanvas,
            scrimColor = Color.Black.copy(alpha = 0.22f),
        ) {
            GlassBackdrop()
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(start = 16.dp, end = 16.dp, bottom = 28.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(
                    text = label,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = minisInk,
                    modifier = Modifier.padding(horizontal = 4.dp),
                )
                ProfileCard {
                    choices.forEachIndexed { index, choice ->
                        if (index > 0) ProfileCardDivider()
                        val isSelected = choice.id == selected
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = 52.dp)
                                .clickable(enabled = choice.enabled, role = Role.Button) {
                                    expanded = false
                                    onSelect(choice.id)
                                }
                                .padding(horizontal = 16.dp, vertical = 10.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(
                                modifier = Modifier.weight(1f),
                                verticalArrangement = Arrangement.spacedBy(2.dp),
                            ) {
                                Text(
                                    text = choice.label,
                                    fontSize = 16.sp,
                                    color = if (choice.enabled) minisInk else minisTertiary,
                                )
                                choice.detail?.let { detail ->
                                    Text(
                                        text = detail,
                                        fontSize = 12.sp,
                                        color = secondaryTint,
                                    )
                                }
                            }
                            if (isSelected) {
                                Icon(
                                    imageVector = Icons.Filled.Check,
                                    contentDescription = null,
                                    tint = minisAccent,
                                    modifier = Modifier.size(18.dp),
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
 * A text field drawn straight onto a white card: no outline, a 17 sp ink line
 * of text, the placeholder standing in while it is empty.
 */
@Composable
private fun ProfilePlainField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    /** The field's accessible name; the placeholder is only a hint. */
    label: String,
    modifier: Modifier = Modifier,
    singleLine: Boolean = true,
    minLines: Int = 1,
    maxLines: Int = 1,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 14.dp),
    ) {
        if (value.isEmpty()) {
            Text(text = placeholder, fontSize = 17.sp, color = minisTertiary)
        }
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            textStyle = TextStyle(fontSize = 17.sp, color = minisInk),
            cursorBrush = SolidColor(minisAccent),
            keyboardOptions = keyboardOptions,
            singleLine = singleLine,
            minLines = minLines,
            maxLines = maxLines,
            modifier = Modifier
                .fillMaxWidth()
                .semantics { contentDescription = label },
        )
    }
}

/** A SwiftUI `Form` section, as Material draws one: a quiet heading, a rule, the
 *  rows, and the explanatory line underneath. */
@Composable
internal fun FormSection(
    header: String?,
    footer: String? = null,
    content: @Composable () -> Unit,
) {
    Column(
        modifier = Modifier.padding(horizontal = 20.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        header?.let {
            Text(
                text = it.uppercase(),
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                color = secondaryTint,
                modifier = Modifier.semantics { heading() },
            )
        }
        MinisDivider()
        content()
        footer?.let { Text(text = it, fontSize = 13.sp, color = secondaryTint) }
    }
}

/** A `Button` row of a Form: full width, left aligned, hit at 48 dp. */
@Composable
internal fun ActionRow(
    text: String,
    enabled: Boolean = true,
    destructive: Boolean = false,
    icon: ImageVector? = null,
    painter: Int? = null,
    onClick: () -> Unit,
) {
    val tint = when {
        !enabled -> secondaryTint.copy(alpha = 0.5f)
        destructive -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.primary
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = MIN_TOUCH_TARGET)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        when {
            icon != null -> Icon(
                imageVector = icon,
                contentDescription = null,
                tint = tint,
                modifier = Modifier.size(20.dp),
            )
            painter != null -> Icon(
                painter = painterResource(painter),
                contentDescription = null,
                tint = tint,
                modifier = Modifier.size(20.dp),
            )
        }
        Text(text = text, fontSize = 15.sp, color = tint)
    }
}

/** A `Toggle` row: the whole line switches, and it is 48 dp tall. */
@Composable
internal fun SwitchRow(
    label: String,
    checked: Boolean,
    enabled: Boolean = true,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = MIN_TOUCH_TARGET)
            .toggleable(
                value = checked,
                enabled = enabled,
                role = Role.Switch,
                onValueChange = onCheckedChange,
            ),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            fontSize = 15.sp,
            color = if (enabled) Color.Unspecified else secondaryTint.copy(alpha = 0.5f),
            modifier = Modifier.weight(1f),
        )
        Switch(checked = checked, onCheckedChange = null, enabled = enabled)
    }
}

/** SwiftUI's `Label(_, systemImage:)` in its quiet, informational form. */
@Composable
internal fun IconNote(
    text: String,
    icon: ImageVector? = null,
    painter: Int? = null,
    tint: Color = Color.Unspecified,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val resolved = if (tint == Color.Unspecified) secondaryTint else tint
        when {
            icon != null -> Icon(
                imageVector = icon,
                contentDescription = null,
                tint = resolved,
                modifier = Modifier.size(18.dp),
            )
            painter != null -> Icon(
                painter = painterResource(painter),
                contentDescription = null,
                tint = resolved,
                modifier = Modifier.size(18.dp),
            )
        }
        Text(text = text, fontSize = 13.sp, color = resolved)
    }
}

/** Rotation must not throw away a half-typed profile. */
private val ProfileFormSaver = listSaver<ProfileForm, Any>(
    save = {
        listOf(
            it.name,
            it.title,
            it.description,
            it.notifications,
            it.crop.name,
            it.voice,
            it.speakReplies,
        )
    },
    restore = {
        ProfileForm(
            name = it[0] as String,
            title = it[1] as String,
            description = it[2] as String,
            notifications = it[3] as Boolean,
            crop = AvatarCrop.valueOf(it[4] as String),
            voice = it[5] as String,
            speakReplies = it[6] as Boolean,
        )
    },
)

/**
 * The bytes of one built-in preset PNG.
 *
 * `openRawResource` is normally for `res/raw`, but the preset library ships
 * drawable PNGs and the upload needs the file itself rather than a bitmap
 * re-encoded here. The ids are this app's own constants, so the resource type
 * is known even though the annotation cannot say so.
 */
@SuppressLint("ResourceType")
private fun presetPngBytes(context: Context, preset: PresetAvatar): ByteArray =
    context.resources.openRawResource(preset.res).use { it.readBytes() }
