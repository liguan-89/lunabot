package com.lunabot.companion.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.R
import com.lunabot.companion.core.SharedAttachmentKind
import com.lunabot.companion.core.SharedAttachmentReference
import com.lunabot.companion.core.SharedMessageComposer
import com.lunabot.companion.sharing.LocalShareAttachment
import com.lunabot.companion.sharing.ShareInbox
import com.lunabot.companion.sharing.ShareItemLoader
import com.lunabot.companion.sharing.SharePayload
import com.lunabot.companion.sharing.SharePreparedDelivery
import com.lunabot.companion.sharing.ShareSheetPhase
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

/**
 * The Android surface of `ios/ShareExtension/ShareRootView.swift`.
 *
 * The trampoline has already copied shared bytes into app-private storage.
 * This screen chooses the computer and conversation, uploads those copies
 * with stable ids, and sends one composed message.
 */
@Composable
fun ShareSheet(
    pending: ShareInbox.PendingShare,
    onDismiss: () -> Unit,
) {
    // One composition tree per generation: a send from A cannot clean B's files,
    // and preview/instruction reset when a newer share arrives.
    key(pending.generation) {
        ShareSheetContent(pending = pending, onDismiss = onDismiss)
    }
}

@Composable
private fun ShareSheetContent(
    pending: ShareInbox.PendingShare,
    onDismiss: () -> Unit,
) {
    val environment = LocalCompanion.current
    val session = environment.session
    val connections by session.connections.collectAsState()
    val active by session.connection.collectAsState()
    val scope = rememberCoroutineScope()
    val sheet = remember(pending.generation) { environment.shareInbox.sessionFor(pending.generation) }

    var phase by remember { mutableStateOf(sheet.phase) }
    var computers by remember { mutableStateOf(sheet.computers) }
    var destinations by remember { mutableStateOf(sheet.destinations) }
    var selectedComputerId by remember { mutableStateOf(sheet.selectedComputerId) }
    var selectedDestinationId by remember { mutableStateOf(sheet.selectedDestinationId) }
    var rememberedDestinationId by remember { mutableStateOf(sheet.rememberedDestinationId) }
    var instruction by remember { mutableStateOf(sheet.instruction) }
    var errorMessage by remember { mutableStateOf(sheet.errorMessage) }
    var preview by remember { mutableStateOf(sheet.preview) }
    var items by remember { mutableStateOf(sheet.items) }
    var pendingDelivery by remember { mutableStateOf(sheet.pendingDelivery) }
    var sendJob by remember { mutableStateOf<Job?>(null) }
    var choosingComputer by remember { mutableStateOf(false) }
    var choosingDestination by remember { mutableStateOf(false) }

    SideEffect {
        sheet.phase = phase
        sheet.computers = computers
        sheet.destinations = destinations
        sheet.selectedComputerId = selectedComputerId
        sheet.selectedDestinationId = selectedDestinationId
        sheet.rememberedDestinationId = rememberedDestinationId
        sheet.instruction = instruction
        sheet.errorMessage = errorMessage
        sheet.preview = preview
        sheet.items = items
        sheet.pendingDelivery = pendingDelivery
    }

    val selectedComputer = computers.firstOrNull { it.id == selectedComputerId }
    val selectedDestination = destinations.firstOrNull { it.id == selectedDestinationId }
    val ready = phase == ShareSheetPhase.READY
    val canEdit = ready && pendingDelivery == null
    val canSend = SharePolicy.canSend(ready, preview, selectedDestination, instruction)
    val canCancel = phase != ShareSheetPhase.SENT
    val imageWarning = SharePolicy.imageCompatibilityMessage(preview, selectedDestination)
    val instructionWarning = SharePolicy.instructionValidationMessage(instruction)

    fun fail(error: Throwable, preservePrepared: Boolean) {
        if (!preservePrepared) pendingDelivery = null
        errorMessage = SharePolicy.friendlyMessage(error, selectedComputer?.name)
        phase = ShareSheetPhase.FAILED
    }

    suspend fun connect(connectionId: String) {
        val connection = connections.firstOrNull { it.id == connectionId }
            ?: session.connection.value
            ?: throw ShareLoadException(SharePolicy.notPaired())
        computers = SharePolicy.computers(
            connections.ifEmpty { listOf(connection) },
            connection,
        )
        selectedComputerId = connection.id
        destinations = emptyList()
        selectedDestinationId = null
        val fleet = session.withPairedShareClient(connection.id) { client -> client.fleet(1) }
        val imageIds = if (preview.imageCount > 0) {
            try {
                session.withPairedShareClient(connection.id) { it.imageCapableInstanceIds() }
            } catch (error: Throwable) {
                if (SharePolicy.isImageSupportUnavailable(error)) {
                    throw ShareLoadException(SharePolicy.imageSupportUnavailable())
                }
                throw error
            }
        } else {
            emptySet()
        }
        val next = SharePolicy.destinations(fleet, imageIds)
        if (next.isEmpty()) throw ShareLoadException(SharePolicy.noDestinations())
        destinations = next
        val remembered = environment.chatPreferences.lastShareDestination(connection.id)
        rememberedDestinationId = remembered
        selectedDestinationId = SharePolicy.rememberedSelection(next, remembered)
        computers = SharePolicy.computers(
            connections.ifEmpty { listOf(connection) },
            session.connection.value?.takeIf { it.id == connection.id } ?: connection,
        )
    }

    suspend fun load() {
        phase = ShareSheetPhase.LOADING
        errorMessage = null
        destinations = emptyList()
        selectedDestinationId = null
        pendingDelivery = null
        instruction = ""
        preview = SharePolicy.SharePreview()
        items = null
        when (val payload = pending.payload) {
            is SharePayload.Failed -> throw ShareLoadException(payload.message)
            is SharePayload.Ready -> {
                items = payload.items
                preview = ShareItemLoader.preview(payload.items)
                val selected = active ?: throw ShareLoadException(SharePolicy.notPaired())
                connect(selected.id)
            }
        }
        phase = ShareSheetPhase.READY
    }

    LaunchedEffect(pending.generation) {
        if (sheet.bootstrapped) {
            // Recreation mid-send lost the Job; keep the prepared delivery for Retry.
            if (phase == ShareSheetPhase.SENDING) {
                phase = ShareSheetPhase.FAILED
                if (errorMessage == null) errorMessage = SharePolicy.generic()
            }
            return@LaunchedEffect
        }
        try {
            load()
            sheet.bootstrapped = true
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            sheet.bootstrapped = true
            fail(error, preservePrepared = false)
        }
    }

    fun cancel() {
        if (!canCancel) return
        sendJob?.cancel()
        sendJob = null
        pendingDelivery = null
        val owned = items
        items = null
        ShareItemLoader.cleanUp(owned)
        onDismiss()
    }

    fun send() {
        if (sendJob != null || !canSend) return
        val ownedItems = items
        sendJob = scope.launch {
            val destination = selectedDestination ?: return@launch
            val computerId = selectedComputerId ?: return@launch
            if (imageWarning != null) {
                errorMessage = imageWarning
                sendJob = null
                return@launch
            }
            if (instructionWarning != null) {
                errorMessage = instructionWarning
                sendJob = null
                return@launch
            }
            phase = ShareSheetPhase.SENDING
            errorMessage = null
            try {
                withTimeout(90_000) {
                    val uploaded = mutableListOf<SharedAttachmentReference>()
                    if (ownedItems != null) {
                        for (attachment in ownedItems.attachments) {
                            val data = withContext(Dispatchers.IO) { attachment.file.readBytes() }
                            when (attachment.kind) {
                                LocalShareAttachment.Kind.IMAGE -> {
                                    val path = session.withPairedShareClient(computerId) { client ->
                                        client.uploadImage(data, attachment.mime, attachment.id)
                                    }
                                    uploaded += SharedAttachmentReference(
                                        path,
                                        SharedAttachmentKind.IMAGE,
                                        attachment.name,
                                    )
                                }
                                LocalShareAttachment.Kind.FILE -> {
                                    val uploadedFile = session.withPairedShareClient(computerId) { client ->
                                        client.uploadFile(data, attachment.name, attachment.mime, attachment.id)
                                    }
                                    uploaded += SharedAttachmentReference(
                                        uploadedFile.path,
                                        SharedAttachmentKind.FILE,
                                        uploadedFile.name,
                                    )
                                }
                            }
                        }
                    }
                    val message = SharedMessageComposer.compose(
                        instruction = instruction,
                        text = ownedItems?.text.orEmpty(),
                        urls = ownedItems?.urls.orEmpty(),
                        attachments = uploaded,
                    )
                    if (message.isEmpty()) throw ShareLoadException(SharePolicy.nothingSupported())
                    val delivery = SharePreparedDelivery(
                        text = message,
                        destination = destination,
                        sendId = pendingDelivery?.sendId ?: UUID.randomUUID().toString(),
                    )
                    pendingDelivery = delivery
                    session.withPairedShareClient(computerId) { client ->
                        client.send(delivery.text, delivery.destination.destination, delivery.sendId)
                    }
                }
                selectedComputerId?.let { id ->
                    selectedDestinationId?.let { environment.chatPreferences.setLastShareDestination(id, it) }
                }
                ShareItemLoader.cleanUp(ownedItems)
                if (items === ownedItems) items = null
                pendingDelivery = null
                phase = ShareSheetPhase.SENT
                delay(450)
                onDismiss()
            } catch (error: TimeoutCancellationException) {
                val preserve = pendingDelivery != null
                if (preserve) {
                    ShareItemLoader.cleanUp(ownedItems)
                    if (items === ownedItems) items = null
                }
                fail(ShareLoadException(SharePolicy.sendTimedOut()), preservePrepared = preserve)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                val preserve = pendingDelivery != null && SharePolicy.shouldPreservePreparedDelivery(error)
                if (preserve) {
                    ShareItemLoader.cleanUp(ownedItems)
                    if (items === ownedItems) items = null
                }
                fail(error, preservePrepared = preserve)
            } finally {
                sendJob = null
            }
        }
    }

    fun retry() {
        if (sendJob != null) return
        sendJob = scope.launch {
            errorMessage = null
            val delivery = pendingDelivery
            val computerId = selectedComputerId
            try {
                if (delivery != null && computerId != null) {
                    phase = ShareSheetPhase.SENDING
                    session.withPairedShareClient(computerId) { client ->
                        client.send(delivery.text, delivery.destination.destination, delivery.sendId)
                    }
                    computerId.let { id ->
                        selectedDestinationId?.let { environment.chatPreferences.setLastShareDestination(id, it) }
                    }
                    pendingDelivery = null
                    phase = ShareSheetPhase.SENT
                    delay(450)
                    onDismiss()
                } else if (items != null && computerId != null) {
                    phase = ShareSheetPhase.LOADING
                    connect(computerId)
                    phase = ShareSheetPhase.READY
                } else {
                    load()
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                fail(error, preservePrepared = pendingDelivery != null && SharePolicy.shouldPreservePreparedDelivery(error))
            } finally {
                sendJob = null
            }
        }
    }

    BackHandler(enabled = canCancel) { cancel() }

    val dark = minisIsDark()
    val softCardFill = if (dark) minisGrouped else Color(0xFFF5F5F3)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(minisCanvas)
            .statusBarsPadding()
            .navigationBarsPadding()
            .imePadding(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 14.dp, end = 16.dp, top = 10.dp, bottom = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(44.dp)
                    .museFloatingPill(CircleShape, elevation = 4.dp)
                    .clickable(enabled = canCancel, role = Role.Button) { cancel() }
                    .semantics { contentDescription = "返回" },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = null,
                    tint = minisInk,
                    modifier = Modifier.size(20.dp),
                )
            }
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    text = "发送到 Luna Bot",
                    fontSize = 18.sp,
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = (-0.2).sp,
                    color = minisInk,
                )
                Text(headerSubtitle(phase), color = minisSecondary, fontSize = 13.sp)
            }
            if (phase == ShareSheetPhase.SENDING || phase == ShareSheetPhase.LOADING) {
                CircularProgressIndicator(
                    modifier = Modifier.size(20.dp),
                    strokeWidth = 2.dp,
                    color = minisInk,
                )
            }
        }

        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            if (!preview.isEmpty) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(22.dp))
                        .background(softCardFill)
                        .padding(horizontal = 18.dp, vertical = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        text = "分享内容",
                        fontSize = 12.5.sp,
                        fontWeight = FontWeight.Medium,
                        color = minisSecondary,
                    )
                    SharePolicy.previewChip(preview).forEach { label ->
                        Text(
                            text = label,
                            fontSize = 15.5.sp,
                            fontWeight = FontWeight.Medium,
                            color = minisInk,
                        )
                    }
                    if (preview.ignoredCount > 0) {
                        Text(
                            SharePolicy.ignoredCaption(preview.ignoredCount),
                            color = minisWarning,
                            fontSize = 13.sp,
                        )
                    }
                }
            }

            if (computers.isNotEmpty() || destinations.isNotEmpty()) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(22.dp))
                        .background(softCardFill),
                ) {
                    if (computers.isNotEmpty()) {
                        val computerClickable = (phase == ShareSheetPhase.READY || phase == ShareSheetPhase.FAILED) && computers.size > 1
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable(enabled = computerClickable, role = Role.Button) {
                                    choosingComputer = true
                                }
                                .padding(horizontal = 18.dp, vertical = 15.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                Text("电脑", fontSize = 12.5.sp, fontWeight = FontWeight.Medium, color = minisSecondary)
                                Text(
                                    text = selectedComputer?.name ?: "选择电脑",
                                    fontSize = 15.5.sp,
                                    fontWeight = FontWeight.SemiBold,
                                    color = minisInk,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                selectedComputer?.routeLabel?.let {
                                    Text(it, color = minisSecondary, fontSize = 13.sp)
                                }
                            }
                            if (computerClickable) {
                                Icon(
                                    imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                                    contentDescription = null,
                                    tint = minisTertiary,
                                    modifier = Modifier.size(20.dp),
                                )
                            }
                        }
                    }

                    if (computers.isNotEmpty() && destinations.isNotEmpty()) {
                        HorizontalDivider(
                            modifier = Modifier.padding(horizontal = 18.dp),
                            thickness = 0.5.dp,
                            color = minisSeparator.copy(alpha = 0.25f),
                        )
                    }

                    if (destinations.isNotEmpty()) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable(enabled = canEdit, role = Role.Button) {
                                    choosingDestination = true
                                }
                                .padding(horizontal = 18.dp, vertical = 15.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                Text("发送到", fontSize = 12.5.sp, fontWeight = FontWeight.Medium, color = minisSecondary)
                                Row(
                                    horizontalArrangement = Arrangement.spacedBy(7.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(
                                        text = selectedDestination?.name ?: "选择智能体或频道",
                                        fontSize = 15.5.sp,
                                        fontWeight = FontWeight.SemiBold,
                                        color = minisInk,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.weight(1f, fill = false),
                                    )
                                    if (selectedDestinationId != null && selectedDestinationId == rememberedDestinationId) {
                                        Box(
                                            modifier = Modifier
                                                .clip(CircleShape)
                                                .background(if (dark) minisCard else Color(0xFFEAEAE8))
                                                .padding(horizontal = 7.dp, vertical = 2.dp),
                                        ) {
                                            Text(
                                                text = "上次使用",
                                                fontSize = 11.sp,
                                                fontWeight = FontWeight.Medium,
                                                color = minisSecondary,
                                            )
                                        }
                                    }
                                }
                                selectedDestination?.subtitle?.let {
                                    Text(it, color = minisSecondary, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                            }
                            Icon(
                                imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                                contentDescription = null,
                                tint = minisTertiary,
                                modifier = Modifier.size(20.dp),
                            )
                        }
                    }
                }
            }

            if (phase == ShareSheetPhase.READY || phase == ShareSheetPhase.SENDING) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        text = "附加说明（可选）",
                        fontSize = 12.5.sp,
                        fontWeight = FontWeight.Medium,
                        color = minisSecondary,
                        modifier = Modifier.padding(horizontal = 6.dp),
                    )
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 84.dp)
                            .clip(RoundedCornerShape(18.dp))
                            .background(softCardFill)
                            .padding(horizontal = 16.dp, vertical = 14.dp),
                    ) {
                        if (instruction.isEmpty()) {
                            Text(
                                text = "例如：总结这段内容并列出下一步计划",
                                fontSize = 15.sp,
                                color = minisTertiary,
                            )
                        }
                        BasicTextField(
                            value = instruction,
                            onValueChange = {
                                instruction = it
                                pendingDelivery = null
                            },
                            enabled = canEdit,
                            textStyle = LocalTextStyle.current.copy(
                                fontSize = 15.sp,
                                color = minisInk,
                                lineHeight = 22.sp,
                            ),
                            cursorBrush = SolidColor(minisInk),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }

            errorMessage?.let {
                Text(
                    text = it,
                    color = Color(0xFFC85A4A),
                    fontSize = 13.5.sp,
                    modifier = Modifier.padding(horizontal = 6.dp),
                )
            }
            if (imageWarning != null && imageWarning != errorMessage) {
                Text(
                    text = imageWarning,
                    color = minisWarning,
                    fontSize = 13.5.sp,
                    modifier = Modifier.padding(horizontal = 6.dp),
                )
            }
            if (instructionWarning != null && instructionWarning != errorMessage) {
                Text(
                    text = instructionWarning,
                    color = minisWarning,
                    fontSize = 13.5.sp,
                    modifier = Modifier.padding(horizontal = 6.dp),
                )
            }

            if (phase == ShareSheetPhase.LOADING && preview.isEmpty) {
                Row(
                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = minisInk)
                    Text("正在读取分享内容", fontSize = 14.sp, color = minisSecondary)
                }
            }
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (phase == ShareSheetPhase.FAILED) {
                Box(
                    modifier = Modifier
                        .height(48.dp)
                        .clip(CircleShape)
                        .background(softCardFill)
                        .clickable(role = Role.Button, onClick = ::retry)
                        .padding(horizontal = 20.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = if (pendingDelivery != null) "重试发送" else "重试",
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Medium,
                        color = minisInk,
                    )
                }
            }
            Row(
                modifier = Modifier
                    .height(48.dp)
                    .clip(CircleShape)
                    .background(if (canSend) minisInk else softCardFill)
                    .clickable(enabled = canSend, role = Role.Button, onClick = ::send)
                    .padding(horizontal = 24.dp),
                horizontalArrangement = Arrangement.spacedBy(7.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    painter = painterResource(R.drawable.ic_send_up),
                    contentDescription = null,
                    tint = if (canSend) minisCanvas else minisTertiary,
                    modifier = Modifier.size(17.dp),
                )
                Text(
                    text = "发送",
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = if (canSend) minisCanvas else minisTertiary,
                )
            }
        }
    }

    if (choosingComputer) {
        AlertDialog(
            onDismissRequest = { choosingComputer = false },
            title = { Text("电脑") },
            text = {
                Column {
                    computers.forEach { computer ->
                        TextButton(
                            onClick = {
                                choosingComputer = false
                                if (computer.id == selectedComputerId) return@TextButton
                                scope.launch {
                                    phase = ShareSheetPhase.LOADING
                                    pendingDelivery = null
                                    try {
                                        connect(computer.id)
                                        phase = ShareSheetPhase.READY
                                    } catch (error: CancellationException) {
                                        throw error
                                    } catch (error: Throwable) {
                                        fail(error, preservePrepared = false)
                                    }
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Column(modifier = Modifier.fillMaxWidth()) {
                                Text(computer.name)
                                Text(computer.routeLabel, fontSize = 12.sp, color = secondaryTint)
                            }
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { choosingComputer = false }) { Text("取消") } },
        )
    }

    if (choosingDestination) {
        AlertDialog(
            onDismissRequest = { choosingDestination = false },
            title = { Text("发送到") },
            text = {
                Column {
                    destinations.forEach { destination ->
                        TextButton(
                            onClick = {
                                selectedDestinationId = destination.id
                                pendingDelivery = null
                                choosingDestination = false
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Column(modifier = Modifier.fillMaxWidth()) {
                                Text(destination.name)
                                Text(destination.subtitle, fontSize = 12.sp, color = secondaryTint)
                            }
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { choosingDestination = false }) { Text("取消") } },
        )
    }
}

private fun headerSubtitle(phase: ShareSheetPhase): String = when (phase) {
    ShareSheetPhase.LOADING -> "正在准备分享内容…"
    ShareSheetPhase.READY -> "选择发送位置"
    ShareSheetPhase.SENDING -> "正在安全发送…"
    ShareSheetPhase.SENT -> "已发送"
    ShareSheetPhase.FAILED -> "需要你处理"
}
