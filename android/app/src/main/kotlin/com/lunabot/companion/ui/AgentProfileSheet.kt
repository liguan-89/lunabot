package com.lunabot.companion.ui

import android.annotation.SuppressLint
import android.content.Context
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
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
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
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
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
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
import com.lunabot.companion.R
import com.lunabot.companion.avatar.AvatarImagePicker
import com.lunabot.companion.avatar.AvatarImageRules
import com.lunabot.companion.avatar.PreparedAvatar
import com.lunabot.companion.core.AvatarCrop
import com.lunabot.companion.core.Bot
import com.lunabot.companion.core.forTask
import com.lunabot.companion.core.BotProfilePatch
import com.lunabot.companion.core.ConfigStatus
import com.lunabot.companion.core.Instance
import com.lunabot.companion.core.ModelSelection
import com.lunabot.companion.core.Session
import com.lunabot.companion.core.Voice
import com.lunabot.companion.core.VoiceProvider
import com.lunabot.companion.storage.BotAvatarStyle
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
    var videoPrompt by rememberSaveable { mutableStateOf("") }
    var selectedDynamicState by rememberSaveable { mutableStateOf(DynamicAvatarStates.IDLE) }
    var selectedVideoStyle by rememberSaveable { mutableStateOf(AvatarVideoStyle.AUTO.wire) }
    var videoGenProgress by remember { mutableStateOf<String?>(null) }
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
    var selectedPresetKey by remember(record?.id) { mutableStateOf<String?>(null) }
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
                // Apply pending or modified model selection in the same Save pass
                // so users never lose model edits when tapping top-right Save.
                val modelToApply = pendingModel ?: modelDraft.takeIf {
                    ModelRules.canApply(
                        loaded = modelsLoaded,
                        botBusy = updated.forTask(opened?.threadId ?: updated.threadId)?.busy,
                        instance = selectedInstance,
                        draft = modelDraft,
                        saved = savedModel,
                    )
                }
                modelToApply?.let { selection ->
                    val modelTarget = updated.forTask(opened?.threadId ?: updated.threadId) ?: updated
                    val applied = session.updateModel(selection, modelTarget)
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

    // The pill reads unsaved changes off both profile fields and model edits.
    val profileDirty = form != baseline
    val modelDirty = !creating && currentTask != null && ModelRules.canApply(
        loaded = modelsLoaded,
        botBusy = currentTask.busy,
        instance = selectedInstance,
        draft = modelDraft,
        saved = savedModel,
    )
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
        val scrollState = rememberScrollState()
        val topScrolled by remember { derivedStateOf { scrollState.canScrollBackward } }
        val topBandAlpha by animateFloatAsState(
            targetValue = if (topScrolled) 1f else 0f,
            animationSpec = tween(180),
            label = "profile-top-haze",
        )
        val topInset = WindowInsets.safeDrawing
            .only(WindowInsetsSides.Top)
            .asPaddingValues()
            .calculateTopPadding()
        val bottomInset = WindowInsets.safeDrawing
            .only(WindowInsetsSides.Bottom)
            .asPaddingValues()
            .calculateBottomPadding()
        Box(modifier = Modifier.fillMaxSize().background(minisCanvas)) {
            val view = LocalView.current
            val dark = minisIsDark()
            val chipRecess = if (dark) Color(0xFF2C2C2E) else Color(0xFFE8E8E5)
            SideEffect {
                val window = (view.parent as? DialogWindowProvider)?.window ?: return@SideEffect
                WindowCompat.getInsetsController(window, view).apply {
                    isAppearanceLightStatusBars = !dark
                    isAppearanceLightNavigationBars = !dark
                }
            }
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(scrollState)
                    .navigationBarsPadding()
                    .padding(horizontal = MinisPagePadding)
                    .padding(top = topInset + 64.dp, bottom = 48.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                saveError?.let { message ->
                    InlineNotice(
                        message = message,
                        tone = NoticeTone.ERROR,
                        modifier = Modifier.fillMaxWidth(),
                        onDismiss = { saveError = null },
                    )
                }

                // 1. 顶部头像预览与统一的头像配置区（预设 / 裁剪 / 相册 / AI 生成）
                Column(
                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .clickable(
                                interactionSource = remember { MutableInteractionSource() },
                                indication = null,
                                enabled = !busy,
                                role = Role.Button,
                            ) { libraryOpen = !libraryOpen },
                    ) {
                        val waiting = pendingPreset
                        if (waiting != null) {
                            PresetBotAvatar(
                                color = waiting.key,
                                bodyId = form.mascotBody,
                                size = 104.dp,
                                contentDescription = "${current.name} 头像",
                            )
                        } else {
                            BotAvatar(
                                bot = current.copy(avatarCrop = form.crop, mascotBody = form.mascotBody),
                                size = 104.dp,
                                state = MausState.HAPPY,
                                fallback = AvatarFallback.PRESET,
                                contentDescription = "${current.name} 头像",
                            )
                        }
                    }
                    Text(
                        text = if (libraryOpen) "收起头像选项" else "更换头像",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium,
                        color = minisSecondary,
                        modifier = Modifier
                            .clip(CircleShape)
                            .background(chipRecess)
                            .clickable(enabled = !busy, role = Role.Button) { libraryOpen = !libraryOpen }
                            .padding(horizontal = 14.dp, vertical = 6.dp),
                    )
                }

                AnimatedVisibility(visible = libraryOpen) {
                    val hasCustomImage = current.avatarUrl != null || pendingUpload != null
                    ProfileGroup(
                        footer = if (creating) "头像会在保存时上传到电脑。" else "支持 PNG、JPG、GIF、WebP，最大 10 MB",
                    ) {
                        ProfileCard {
                            if (hasCustomImage || form.crop != AvatarCrop.MASCOT) {
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(horizontal = 14.dp, vertical = 10.dp)
                                        .background(chipRecess, RoundedCornerShape(12.dp))
                                        .padding(3.dp),
                                    horizontalArrangement = Arrangement.spacedBy(3.dp),
                                ) {
                                    AvatarCrop.entries.forEach { option ->
                                        val active = form.crop == option
                                        Box(
                                            modifier = Modifier
                                                .weight(1f)
                                                .heightIn(min = 34.dp)
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
                                ProfileCardDivider()
                            }
                            val activePresetKey = pendingPreset?.key
                                ?: selectedPresetKey
                                ?: if (current.avatarUrl == null) PresetAvatars.forColor(current.color).key else null
                            val previewColor = activePresetKey ?: PresetAvatars.forColor(current.color).key
                            val fallbackStyle = LocalBotAvatarStyle.current
                            val activeStyle = BotAvatarStyle.entries.firstOrNull {
                                it.wireValue.equals(form.mascotBody, ignoreCase = true)
                            } ?: fallbackStyle
                            Text(
                                text = "形象风格",
                                fontSize = 12.sp,
                                color = minisSecondary,
                                modifier = Modifier.padding(start = 16.dp, top = 12.dp),
                            )
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .horizontalScroll(rememberScrollState())
                                    .padding(horizontal = 14.dp, vertical = 8.dp),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                BotAvatarStyle.entries.forEach { style ->
                                    val isSelected = activeStyle == style
                                    Column(
                                        modifier = Modifier
                                            .clip(RoundedCornerShape(14.dp))
                                            .then(
                                                if (isSelected) {
                                                    Modifier
                                                        .background(minisCard, RoundedCornerShape(14.dp))
                                                        .border(1.5.dp, minisAccent, RoundedCornerShape(14.dp))
                                                } else {
                                                    Modifier
                                                },
                                            )
                                            .clickable(enabled = !busy, role = Role.RadioButton) {
                                                form = form.copy(mascotBody = style.wireValue)
                                            }
                                            .padding(horizontal = 8.dp, vertical = 6.dp)
                                            .semantics { contentDescription = "切换为${profileBotStyleLabel(style)}形象" },
                                        horizontalAlignment = Alignment.CenterHorizontally,
                                        verticalArrangement = Arrangement.spacedBy(4.dp),
                                    ) {
                                        PresetBotAvatar(
                                            color = previewColor,
                                            bodyId = style.wireValue,
                                            size = 40.dp,
                                            contentDescription = null,
                                        )
                                        Text(
                                            text = profileBotStyleLabel(style),
                                            fontSize = 11.sp,
                                            fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal,
                                            color = if (isSelected) minisInk else minisSecondary,
                                            maxLines = 1,
                                        )
                                    }
                                }
                            }
                            ProfileCardDivider()
                            Text(
                                text = "配色",
                                fontSize = 12.sp,
                                color = minisSecondary,
                                modifier = Modifier.padding(start = 16.dp, top = 10.dp),
                            )
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .horizontalScroll(rememberScrollState())
                                    .padding(horizontal = 14.dp, vertical = 8.dp),
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                PresetAvatars.all.forEach { preset ->
                                    val isSelected = activePresetKey == preset.key
                                    Box(
                                        modifier = Modifier
                                            .size(50.dp)
                                            .clip(RoundedCornerShape(14.dp))
                                            .then(
                                                if (isSelected) {
                                                    Modifier.border(2.dp, minisAccent, RoundedCornerShape(14.dp))
                                                } else {
                                                    Modifier
                                                },
                                            )
                                            .clickable(enabled = !busy, role = Role.RadioButton) {
                                                scope.launch {
                                                    busy = true
                                                    try {
                                                        val bytes = presetPngBytes(context, preset)
                                                        val target = created ?: opened
                                                        if (target == null) {
                                                            pendingUpload = bytes to "image/png"
                                                            pendingPreset = preset
                                                            selectedPresetKey = preset.key
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
                                                            selectedPresetKey = preset.key
                                                            form = form.copy(crop = AvatarCrop.CIRCLE)
                                                            baseline = baseline.copy(crop = AvatarCrop.CIRCLE)
                                                        }
                                                    } finally {
                                                        busy = false
                                                    }
                                                }
                                            }
                                            .semantics { contentDescription = "使用${preset.label}头像" },
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        PresetBotAvatar(
                                            color = preset.key,
                                            bodyId = form.mascotBody,
                                            size = 42.dp,
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
                            if (!creating) {
                                ProfileCardDivider()
                                ProfilePlainField(
                                    value = prompt,
                                    onValueChange = { prompt = it },
                                    placeholder = "用一句话描述想要的头像风格…",
                                    label = "画面风格描述",
                                    singleLine = false,
                                    minLines = 1,
                                    maxLines = 4,
                                )
                                ProfileCardDivider()
                                ProfileActionRow(
                                    text = "在电脑上生成头像",
                                    painter = R.drawable.ic_sparkles,
                                    enabled = ProfileRules.canGenerate(busy, config, prompt),
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
                                                val updated = session.updateProfile(
                                                    BotProfilePatch(avatarCrop = intended),
                                                    generated,
                                                )
                                                val crop = if (updated != null) {
                                                    updated.avatarCrop ?: intended
                                                } else {
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
                    }
                }

                // 2. 基本信息（合并名称、头衔与职责描述）
                ProfileGroup(label = "基本信息") {
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
                        ProfileCardDivider()
                        ProfilePlainField(
                            value = form.title,
                            onValueChange = { form = form.copy(title = it) },
                            placeholder = "头衔（可选）",
                            label = "头衔",
                        )
                        ProfileCardDivider()
                        ProfilePlainField(
                            value = form.description,
                            onValueChange = { form = form.copy(description = it) },
                            placeholder = "此智能体的职责描述",
                            label = "职责描述",
                            singleLine = false,
                            minLines = 2,
                            maxLines = 6,
                        )
                    }
                    if (nameHint) {
                        Text(
                            text = "先给智能体起个名字，再点创建。",
                            fontSize = 13.sp,
                            color = MinisTokens.Danger,
                            modifier = Modifier.padding(start = 16.dp),
                        )
                    }
                }

                // 3. 模型配置（已纳入右上角统一保存）
                ProfileGroup(label = "模型", footer = ModelRules.FOOTER) {
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
                                ProfileCardDivider()
                                Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
                                    IconNote(text = note, icon = Icons.Filled.Info)
                                }
                            }
                            ProfileCardDivider()
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
                }

                // 4. 语音通话
                VoiceSection(
                    config = config,
                    switching = switchingEngine,
                    onSwitchEngine = { next ->
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
                                    val data = session.previewVoice(
                                        form.voice,
                                        liveBot() ?: current,
                                    ) ?: return@launch
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
                        ProfileCardDivider()
                        Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
                            IconNote(text = hint, icon = Icons.Filled.Info)
                        }
                    }
                }

                // 5. 动态形象视频
                if (!creating) {
                    val dynamicStates = current.avatarStates.orEmpty()
                    val seedanceReady = config?.seedance?.isReady == true
                    ProfileGroup(
                        label = "动态形象视频",
                        footer = "视频由电脑端生成并自动缓存到手机，对话与通话时按状态自动切换。",
                    ) {
                        ProfileCard {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 16.dp, vertical = 12.dp),
                                horizontalArrangement = Arrangement.spacedBy(14.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                BotAvatar(
                                    bot = current,
                                    size = 72.dp,
                                    fallback = AvatarFallback.PRESET,
                                    avatarStateOverride = selectedDynamicState,
                                    breakout = selectedDynamicState == DynamicAvatarStates.WORKING && dynamicStates.isNotEmpty(),
                                )
                                Column(
                                    modifier = Modifier.weight(1f),
                                    verticalArrangement = Arrangement.spacedBy(4.dp),
                                ) {
                                    Text(
                                        text = if (dynamicStates.isEmpty()) "尚未配置动态视频" else "已配置 ${dynamicStates.size} / 5 个状态",
                                        fontSize = 15.sp,
                                        fontWeight = FontWeight.Medium,
                                        color = minisInk,
                                    )
                                    Text(
                                        text = videoGenProgress ?: if (seedanceReady) {
                                            "使用电脑端 Seedance（720p）生成循环视频"
                                        } else {
                                            "请先在电脑端「设置 → AI → 视频生成」配置 Seedance 密钥"
                                        },
                                        fontSize = 12.5.sp,
                                        color = minisSecondary,
                                    )
                                }
                            }
                            ProfileCardDivider()
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .horizontalScroll(rememberScrollState())
                                    .padding(horizontal = 16.dp, vertical = 10.dp),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                DynamicAvatarStates.ALL.forEach { stateKey ->
                                    val active = selectedDynamicState == stateKey
                                    val hasMedia = !dynamicStates[stateKey].isNullOrBlank()
                                    Box(
                                        modifier = Modifier
                                            .clip(CircleShape)
                                            .background(if (active) minisInk else chipRecess)
                                            .clickable(role = Role.RadioButton) { selectedDynamicState = stateKey }
                                            .padding(horizontal = 12.dp, vertical = 6.dp),
                                    ) {
                                        Text(
                                            text = if (hasMedia) "${DynamicAvatarStates.label(stateKey)} ✓" else DynamicAvatarStates.label(stateKey),
                                            fontSize = 13.sp,
                                            fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                                            color = if (active) minisPage else minisInk,
                                        )
                                    }
                                }
                            }
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .horizontalScroll(rememberScrollState())
                                    .padding(start = 16.dp, end = 16.dp, bottom = 10.dp),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                AvatarVideoStyle.entries.forEach { style ->
                                    val active = selectedVideoStyle == style.wire
                                    Box(
                                        modifier = Modifier
                                            .clip(RoundedCornerShape(10.dp))
                                            .background(if (active) minisAccent.copy(alpha = 0.16f) else chipRecess)
                                            .border(
                                                width = if (active) 1.dp else 0.dp,
                                                color = if (active) minisAccent else Color.Transparent,
                                                shape = RoundedCornerShape(10.dp),
                                            )
                                            .clickable(role = Role.RadioButton) { selectedVideoStyle = style.wire }
                                            .padding(horizontal = 10.dp, vertical = 5.dp),
                                    ) {
                                        Text(
                                            text = style.label,
                                            fontSize = 12.5.sp,
                                            color = if (active) minisAccent else minisSecondary,
                                        )
                                    }
                                }
                            }
                            ProfileCardDivider()
                            ProfilePlainField(
                                value = videoPrompt,
                                onValueChange = { videoPrompt = it },
                                placeholder = "动作或氛围补充描述（可选）",
                                label = "视频动作描述",
                                singleLine = false,
                                minLines = 1,
                                maxLines = 3,
                            )
                            ProfileCardDivider()
                            ProfileActionRow(
                                text = "一键生成核心三态（待机 / 工作中 / 说话）",
                                painter = R.drawable.ic_sparkles,
                                enabled = !busy && seedanceReady,
                                onClick = {
                                    scope.launch {
                                        busy = true
                                        saveError = null
                                        try {
                                            val target = liveBot() ?: return@launch
                                            var latest = target
                                            DynamicAvatarStates.CORE_PACK.forEachIndexed { idx, st ->
                                                videoGenProgress = "正在生成 ${DynamicAvatarStates.label(st)} (${idx + 1}/${DynamicAvatarStates.CORE_PACK.size})…"
                                                val updated = session.generateAvatarState(
                                                    forBot = latest,
                                                    state = st,
                                                    style = selectedVideoStyle,
                                                    prompt = videoPrompt.trim().ifEmpty { null },
                                                )
                                                if (updated == null) {
                                                    saveError = NoticeMessageFormat.humanize(
                                                        session.actionError ?: "生成 ${DynamicAvatarStates.label(st)} 失败，请稍后重试。",
                                                    )
                                                    session.actionError = null
                                                    return@launch
                                                }
                                                latest = updated
                                            }
                                        } finally {
                                            videoGenProgress = null
                                            busy = false
                                        }
                                    }
                                },
                            )
                            ProfileCardDivider()
                            ProfileActionRow(
                                text = "单独生成「${DynamicAvatarStates.label(selectedDynamicState)}」视频",
                                painter = R.drawable.ic_sparkles,
                                enabled = !busy && seedanceReady,
                                onClick = {
                                    scope.launch {
                                        busy = true
                                        saveError = null
                                        videoGenProgress = "正在生成 ${DynamicAvatarStates.label(selectedDynamicState)}…"
                                        try {
                                            val target = liveBot() ?: return@launch
                                            val updated = session.generateAvatarState(
                                                forBot = target,
                                                state = selectedDynamicState,
                                                style = selectedVideoStyle,
                                                prompt = videoPrompt.trim().ifEmpty { null },
                                            )
                                            if (updated == null) {
                                                saveError = NoticeMessageFormat.humanize(
                                                    session.actionError ?: "动态视频生成失败，请稍后重试。",
                                                )
                                                session.actionError = null
                                            }
                                        } finally {
                                            videoGenProgress = null
                                            busy = false
                                        }
                                    }
                                },
                            )
                            if (!dynamicStates[selectedDynamicState].isNullOrBlank()) {
                                ProfileCardDivider()
                                ProfileActionRow(
                                    text = "清除「${DynamicAvatarStates.label(selectedDynamicState)}」视频",
                                    icon = Icons.Filled.Delete,
                                    enabled = !busy,
                                    destructive = true,
                                    onClick = {
                                        scope.launch {
                                            busy = true
                                            try {
                                                val target = liveBot() ?: return@launch
                                                val next = target.avatarStates.orEmpty() - selectedDynamicState
                                                session.updateProfile(
                                                    BotProfilePatch(
                                                        avatarStates = if (next.isEmpty()) BotProfilePatch.AvatarStates.Clear else BotProfilePatch.AvatarStates.Set(next),
                                                    ),
                                                    target,
                                                )
                                            } finally {
                                                busy = false
                                            }
                                        }
                                    },
                                )
                            }
                        }
                    }
                }

                // 6. 上下文与通知
                ProfileGroup(label = "上下文", footer = ProfileRules.COMPACT_FOOTER) {
                    ProfileCard {
                        ProfileActionRow(
                            text = if (compacting) "正在压缩…" else ProfileRules.COMPACT_LABEL,
                            enabled = !busy && !compacting && currentTask != null,
                            onClick = { confirmingCompact = true },
                        )
                    }
                }

                ProfileGroup(label = "通知") {
                    ProfileCard {
                        ProfileSwitchRow(
                            label = "智能体通知",
                            checked = form.notifications,
                            onCheckedChange = { form = form.copy(notifications = it) },
                        )
                    }
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

            val canvasColor = minisCanvas
            Box(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .fillMaxWidth()
                    .height(topInset + 56.dp)
                    .background(
                        Brush.verticalGradient(
                            0.00f to canvasColor.copy(alpha = 0.96f * topBandAlpha),
                            0.42f to canvasColor.copy(alpha = 0.78f * topBandAlpha),
                            0.74f to canvasColor.copy(alpha = 0.30f * topBandAlpha),
                            1.00f to Color.Transparent,
                        ),
                    ),
            )
            Box(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .height(bottomInset + 22.dp)
                    .background(
                        Brush.verticalGradient(
                            0.00f to Color.Transparent,
                            0.55f to canvasColor.copy(alpha = 0.82f),
                            1.00f to canvasColor,
                        ),
                    ),
            )
            Box(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .fillMaxWidth()
                    .statusBarsPadding()
                    .heightIn(min = 56.dp)
                    .padding(horizontal = 12.dp, vertical = 6.dp),
            ) {
                TouchTarget(
                    onClick = onDismiss,
                    modifier = Modifier.align(Alignment.CenterStart),
                    contentDescription = "返回",
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
                    text = if (creating) "新建智能体" else "编辑智能体",
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = minisInk,
                    modifier = Modifier.align(Alignment.Center),
                )
                val hasChanges = profileDirty || modelDirty
                val canCommit = if (creating) {
                    ProfileRules.canSave(form, busy)
                } else {
                    hasChanges && ProfileRules.canSave(form, busy)
                }
                val commitLabel = when {
                    creating -> "创建"
                    hasChanges -> "保存"
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
                                Modifier.museFloatingPill(CircleShape, elevation = 4.dp)
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
                    modifier = Modifier
                        .matchParentSize()
                        .background(minisCanvas.copy(alpha = 0.55f))
                        .clickable(
                            interactionSource = remember { MutableInteractionSource() },
                            indication = null,
                            onClick = {},
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(40.dp), strokeWidth = 3.dp)
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

/** Consistent 8 dp rhythm uniting a section header, card(s), and optional footer. */
@Composable
private fun ProfileGroup(
    label: String? = null,
    footer: String? = null,
    content: @Composable () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        label?.let { ProfileSectionLabel(it) }
        content()
        footer?.let { ProfileFooter(it) }
    }
}

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

/** The 12.5 sp grey explanatory line under a card. */
@Composable
private fun ProfileFooter(text: String) {
    Text(
        text = text,
        modifier = Modifier.padding(horizontal = 16.dp),
        fontSize = 12.5.sp,
        lineHeight = 18.sp,
        color = minisSecondary,
    )
}

/** Soft warm-neutral rounded card on the pure-white Muse gallery canvas. */
@Composable
private fun ProfileCard(content: @Composable () -> Unit) {
    val cardFill = if (minisIsDark()) minisGrouped else Color(0xFFF5F5F3)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(22.dp))
            .background(cardFill),
    ) {
        content()
    }
}

/** Whisper-soft divider inside ProfileCard. */
@Composable
private fun ProfileCardDivider() {
    HorizontalDivider(
        modifier = Modifier.padding(horizontal = 16.dp),
        thickness = 0.5.dp,
        color = minisSeparator.copy(alpha = 0.22f),
    )
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
        val dark = minisIsDark()
        Switch(
            checked = checked,
            onCheckedChange = null,
            enabled = enabled,
            colors = SwitchDefaults.colors(
                checkedThumbColor = minisCanvas,
                checkedTrackColor = minisInk,
                checkedBorderColor = Color.Transparent,
                uncheckedThumbColor = if (dark) Color(0xFFB5B5B8) else Color.White,
                uncheckedTrackColor = if (dark) Color(0xFF3A3A3D) else Color(0xFFDCDCD9),
                uncheckedBorderColor = Color.Transparent,
            ),
            modifier = Modifier.scale(0.80f),
        )
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
            shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
            containerColor = minisCanvas,
            scrimColor = Color.Black.copy(alpha = 0.20f),
        ) {
            GlassBackdrop()
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .navigationBarsPadding()
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
private fun profileBotStyleLabel(style: BotAvatarStyle): String = when (style) {
    BotAvatarStyle.ORB -> "琉璃月灵"
    BotAvatarStyle.NEKO -> "折耳瓷猫"
    BotAvatarStyle.LIQUID -> "极光液滴"
    BotAvatarStyle.SYNTH -> "复古掌机"
    BotAvatarStyle.SPIRIT -> "星月软团"
    BotAvatarStyle.MINIBOT -> "陶瓷微机"
    BotAvatarStyle.BUNNY -> "垂耳瓷兔"
    BotAvatarStyle.ASTRO -> "宇航头盔"
    BotAvatarStyle.PRISM -> "切面晶石"
    BotAvatarStyle.BEAR -> "绒雾小熊"
    BotAvatarStyle.RETRO -> "像素终端"
    BotAvatarStyle.FOX -> "灵耳瓷狐"
    BotAvatarStyle.FROG -> "抹茶瓷蛙"
    BotAvatarStyle.OWL -> "夜羽瓷枭"
    BotAvatarStyle.WISP -> "浮云幽灵"
    BotAvatarStyle.CAMERA -> "徕卡微机"
    BotAvatarStyle.CLOUD -> "软绵云朵"
    BotAvatarStyle.CLASSIC -> "经典极简"
}

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
            it.mascotBody.orEmpty(),
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
            mascotBody = (it.getOrNull(7) as? String)?.ifEmpty { null },
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
