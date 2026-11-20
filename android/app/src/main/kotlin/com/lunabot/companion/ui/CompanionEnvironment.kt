package com.lunabot.companion.ui

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import com.lunabot.companion.audio.VoicePreviewPlayer
import com.lunabot.companion.audio.VoiceNotePlayer
import com.lunabot.companion.account.CloudAccountController
import com.lunabot.companion.avatar.AvatarImageStore
import com.lunabot.companion.core.ExportedTranscript
import com.lunabot.companion.core.Session
import com.lunabot.companion.dictation.SpeechDictation
import java.net.URI
import com.lunabot.companion.discovery.CompanionDiscovery
import com.lunabot.companion.permissions.CompanionPermissions
import com.lunabot.companion.phoneui.PhoneUiController
import com.lunabot.companion.sharing.ShareInbox
import com.lunabot.companion.speech.ModelManager
import com.lunabot.companion.storage.OnboardingPreferences
import com.lunabot.companion.storage.ChatPreferences
import com.lunabot.companion.update.AppUpdater
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Camera access, as the scanner needs to reason about it. */
enum class CameraAccess { UNKNOWN, GRANTED, DENIED }

/**
 * Camera permission is asked for at the moment the user opens the scanner and
 * never before — the app is usable without a camera (Bonjour list, typed
 * address), so a launch-time prompt would be asking for something most sessions
 * never use.
 */
class CameraPermissionController(
    private val isGranted: () -> Boolean,
    private val request: () -> Unit,
) {
    private val _access = MutableStateFlow(if (isGranted()) CameraAccess.GRANTED else CameraAccess.UNKNOWN)
    val access: StateFlow<CameraAccess> = _access.asStateFlow()

    /** Ask once; the OS shows the sheet only while the answer is still unknown. */
    fun ensure() {
        if (isGranted()) {
            _access.value = CameraAccess.GRANTED
            return
        }
        request()
    }

    fun onResult(granted: Boolean) {
        _access.value = if (granted) CameraAccess.GRANTED else CameraAccess.DENIED
    }

    /** Recover immediately when the user returns from Settings having granted it. */
    fun refresh() {
        if (isGranted()) _access.value = CameraAccess.GRANTED
    }
}

/**
 * Microphone permission for composer dictation. Asked only from the mic button,
 * through [PermissionRequests] so the asked-flag has a single owner. Callers
 * pass a result callback; a stop that races the system sheet is discarded by
 * [SpeechDictation]'s generation guard, not by dropping this callback.
 */
class MicPermissionController(
    private val isGranted: () -> Boolean,
    private val request: () -> Unit,
) {
    private var pending: ((Boolean) -> Unit)? = null

    fun ensure(onResult: (Boolean) -> Unit) {
        if (isGranted()) {
            onResult(true)
            return
        }
        pending = onResult
        request()
    }

    fun onResult(granted: Boolean) {
        val callback = pending
        pending = null
        callback?.invoke(granted)
    }

    fun refresh() {
        // No published state — SpeechDictation re-checks grant on each start.
        if (isGranted()) {
            val callback = pending
            pending = null
            callback?.invoke(true)
        }
    }
}

/**
 * The SwiftUI `@EnvironmentObject` analogue: the long-lived objects every screen
 * reaches for, provided once at the top of the composition.
 */
@Immutable
class CompanionEnvironment(
    val session: Session,
    val permissions: CompanionPermissions,
    val discovery: CompanionDiscovery,
    /**
     * The three durable first-run markers. The same instance [Session] writes
     * the pending marker into when a pairing commits, so the root router reads
     * what the commit wrote without a second copy of the truth.
     */
    val onboarding: OnboardingPreferences,
    /** Phone-local transcript and composer presentation choices. */
    val chatPreferences: ChatPreferences,
    /** The Cloud account this phone signs in with, and the Cloud desktops it can open. */
    val cloudAccount: CloudAccountController,
    val camera: CameraPermissionController,
    val mic: MicPermissionController,
    val notifications: NotificationPermissionController,
    /** Bounded in-memory avatar bytes/bitmaps; cleared on sign-out. */
    val avatars: AvatarImageStore,
    /** One-at-a-time TTS preview; bind to the profile screen lifecycle. */
    val voicePreview: VoicePreviewPlayer,
    /** One-at-a-time transcript voice notes; app-scoped, pauses in place. */
    val voiceNotes: VoiceNotePlayer,
    /** On-device ASR model files: Settings downloads, the voice sheet reads readiness. */
    val speechModels: ModelManager,
    /** Composer dictation; bind to the chat screen lifecycle. */
    val dictation: SpeechDictation,
    /**
     * Volatile composer drafts keyed by [com.lunabot.companion.core.Chat.id].
     * Survives Computer navigation without entering saved state.
     */
    val chatDrafts: ChatDraftHolder,
    /** Fires the activity's `RequestMultiplePermissions` launcher. */
    val requestPermissions: (Array<String>) -> Unit,
    /** Opens the OS app-settings page, for a permission the user denied. */
    val openAppSettings: () -> Unit,
    /** Hands an exported transcript to the share sheet; null on success. */
    val shareTranscript: (ExportedTranscript, ShareFormat) -> String?,
    /** Opens a freshly minted cloud-desktop URL in Custom Tabs; null on success. */
    val openCloudDesktop: (URI) -> String?,
    /** Inbound share copied off the sending app's Intent. */
    val shareInbox: ShareInbox,
    /** Whether [com.lunabot.companion.lifecycle.AlwaysOnConnectionService] is enabled. */
    val alwaysOnEnabled: StateFlow<Boolean>,
    /** Flips the always-on setting and starts/stops the service to match. */
    val onToggleAlwaysOn: () -> Unit,
    /** Wireless-debugging phone UI: opt-in switch, pairing, helper lifecycle. */
    val phoneUi: PhoneUiController,
    /** The public release channel: check, download, hand to the installer. */
    val updates: AppUpdater,
    /**
     * Process-lived work that must outlast a screen: releasing a Local VM lease
     * when its viewer is disposed cannot use the composition's scope, which is
     * cancelled at that exact moment.
     */
    val appScope: kotlinx.coroutines.CoroutineScope,
)

val LocalCompanion = staticCompositionLocalOf<CompanionEnvironment> {
    error("CompanionEnvironment was not provided")
}
