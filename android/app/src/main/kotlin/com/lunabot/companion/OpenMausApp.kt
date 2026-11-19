package com.lunabot.companion

import android.app.Application
import androidx.lifecycle.ProcessLifecycleOwner
import com.lunabot.companion.audio.VoicePreviewPlayer
import com.lunabot.companion.audio.VoiceNotePlayer
import com.lunabot.companion.account.CloudAccountApi
import com.lunabot.companion.account.CloudAccountController
import com.lunabot.companion.account.CloudAccountStore
import com.lunabot.companion.avatar.AvatarImageStore
import com.lunabot.companion.core.Session
import com.lunabot.companion.discovery.NsdDiscovery
import com.lunabot.companion.lifecycle.AlwaysOnConnectionService
import com.lunabot.companion.lifecycle.AlwaysOnConnectionState
import com.lunabot.companion.lifecycle.ServiceProcessAnchor
import com.lunabot.companion.lifecycle.SessionLingerController
import com.lunabot.companion.lifecycle.installSessionLinger
import com.lunabot.companion.notifications.LocalNotificationPoster
import com.lunabot.companion.permissions.CompanionPermissions
import com.lunabot.companion.phone.PhoneJobRunner
import com.lunabot.companion.phoneui.PhoneUiController
import com.lunabot.companion.sharing.ShareInbox
import com.lunabot.companion.speech.ModelManager
import com.lunabot.companion.storage.AlwaysOnPreferences
import com.lunabot.companion.storage.ChatPreferences
import com.lunabot.companion.storage.DataStoreConnectionStore
import com.lunabot.companion.storage.FileRosterSnapshotStore
import com.lunabot.companion.storage.OnboardingPreferences
import com.lunabot.companion.storage.KeystoreTokenStore
import com.lunabot.companion.ui.FilePreviews
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Application entry: owns the long-lived [Session] and wires
 * [ProcessLifecycleOwner] the way iOS `scenePhase` drives connect and linger.
 */
class OpenMausApp : Application() {
    private val appJob = SupervisorJob()
    val appScope = CoroutineScope(appJob + Dispatchers.Main.immediate)

    lateinit var session: Session
        private set
    lateinit var notifications: LocalNotificationPoster
        private set
    lateinit var discovery: NsdDiscovery
        private set
    lateinit var permissions: CompanionPermissions
        private set

    /**
     * One instance for the whole process: [Session] writes the first-pair
     * education marker into it as part of committing a pairing, and the root
     * router reads it to decide whether that step is due.
     */
    lateinit var onboarding: OnboardingPreferences
        private set
    lateinit var avatars: AvatarImageStore
        private set
    lateinit var voicePreview: VoicePreviewPlayer
        private set
    lateinit var voiceNotes: VoiceNotePlayer
        private set
    /** The on-device ASR model's files; one root for Settings' download and the sheet's check. */
    lateinit var speechModels: ModelManager
        private set
    lateinit var linger: SessionLingerController
        private set
    lateinit var shareInbox: ShareInbox
        private set
    lateinit var alwaysOn: AlwaysOnPreferences
        private set

    /**
     * One preference store for the process: Settings writes the phone-tools
     * switch here, and the runner observes the same flow. Two instances would
     * each hold their own StateFlow and disagree until a restart.
     */
    lateinit var chatPreferences: ChatPreferences
        private set
    internal lateinit var phoneJobs: PhoneJobRunner
        private set

    /** The wireless-debugging shell controller; process-wide because the helper bridge is. */
    lateinit var phoneUi: PhoneUiController
        private set

    /** The Cloud account this phone signs in with; one account across the desktop and every Cloud. */
    lateinit var cloudAccount: CloudAccountController
        private set

    /**
     * The preference files each rename moved, carried forward once.
     *
     * The list is ordered oldest first and applied in sequence, so an install
     * that still has `openmaus.*` files is renamed to `dexbot.*` and then to
     * `lunabot.*` in the same launch; an install from the middle of the chain
     * only takes the later step. Each step is a no-op when its target already
     * exists, so a file is never clobbered by an older copy.
     */
    private fun migrateLegacyPreferences() {
        val directory = File(applicationInfo.dataDir, "shared_prefs")
        val names = listOf(
            "openmaus.permissions" to "dexbot.permissions",
            "openmaus.onboarding" to "dexbot.onboarding",
            "openmaus.chat-preferences" to "dexbot.chat-preferences",
            "openmaus.always_on" to "dexbot.always_on",
            "dexbot.permissions" to "lunabot.permissions",
            "dexbot.onboarding" to "lunabot.onboarding",
            "dexbot.chat-preferences" to "lunabot.chat-preferences",
            "dexbot.always_on" to "lunabot.always_on",
            "dexbot.phoneui.adb" to "lunabot.phoneui.adb",
            "dex_cloud_account" to "luna_cloud_account",
        )
        for ((legacy, current) in names) {
            val source = File(directory, "$legacy.xml")
            val target = File(directory, "$current.xml")
            if (!target.exists() && source.exists()) source.renameTo(target)
        }
    }

    override fun onCreate() {
        super.onCreate()
        migrateLegacyPreferences()
        shareInbox = ShareInbox()
        ShareInbox.cleanStale(cacheDir)
        // Launch stays non-blocking. The preview store awaits the shared
        // completion barrier on its own IO coroutine before writing anything.
        FilePreviews.startStaleCleanup(this, appScope)
        notifications = LocalNotificationPoster(this) { botId ->
            session.state.value.bot(botId)?.let { session.avatarData(it) }
        }
        discovery = NsdDiscovery(this)
        permissions = CompanionPermissions(this)
        onboarding = OnboardingPreferences(this)
        session = Session(
            scope = appScope,
            connectionStore = DataStoreConnectionStore(this),
            tokenStore = KeystoreTokenStore(this),
            onboardingStore = onboarding,
            deviceNameProvider = {
                // User-visible device name; Settings.Global.DEVICE_NAME on API 25+.
                android.provider.Settings.Global.getString(contentResolver, "device_name")
                    ?.takeIf { it.isNotBlank() }
                    ?: android.os.Build.MODEL
            },
            notificationSink = notifications,
            // The offline roster cache: a launch that cannot reach the
            // computer still shows the last fleet, stamped with how old it is.
            // Files-dir, not cache-dir: Android may wipe cacheDir under storage
            // pressure, and this cache is the difference between a roster and
            // an empty sidebar — small, bounded, and excluded from backup.
            rosterSnapshotStore = FileRosterSnapshotStore(File(filesDir, FileRosterSnapshotStore.DIRECTORY)),
        )
        avatars = AvatarImageStore(fetch = session::avatarData)
        voicePreview = VoicePreviewPlayer(this)
        voiceNotes = VoiceNotePlayer(this)
        speechModels = ModelManager(this)

        // iOS resets the avatar cache inside signOut. Observe Unpaired here so
        // the platform cache cannot outlive the pairing that minted its URLs.
        appScope.launch {
            session.status
                .map { it is Session.Status.Unpaired }
                .distinctUntilChanged()
                .collect { unpaired ->
                    if (unpaired) avatars.clearBlocking()
                }
        }

        // Foreground reconnects; background lingers. Cutting the stream at
        // onStop would drop a turn that completes seconds after Home — the
        // notification is produced by this stream and nothing else.
        // `session.linger()` on iOS (`ios/App/CompanionApp.swift:26`).
        linger = installSessionLinger(
            lifecycle = ProcessLifecycleOwner.get().lifecycle,
            session = session,
            scope = appScope,
            anchor = ServiceProcessAnchor(this),
            alwaysOn = { AlwaysOnConnectionState.active },
        )

        alwaysOn = AlwaysOnPreferences(this)

        // Phone apps as bot tools: off until Settings turns calendar access on.
        // The runner registers, long-polls, and answers one job at a time for
        // as long as that switch is on.
        chatPreferences = ChatPreferences(this)
        // Built before the phone-tools runner: the runner observes this
        // controller's status for its phoneUi capability registration.
        phoneUi = PhoneUiController(this, appScope, chatPreferences, permissions)
        val versionName = runCatching {
            packageManager.getPackageInfo(packageName, 0).versionName
        }.getOrNull().orEmpty()
        cloudAccount = CloudAccountController(
            api = CloudAccountApi(),
            store = CloudAccountStore(this),
            scope = appScope,
            deviceName = (android.provider.Settings.Global.getString(contentResolver, "device_name"))
                ?.takeIf { it.isNotBlank() }
                ?: android.os.Build.MODEL,
            appVersion = versionName,
        )
        cloudAccount.start()
        phoneJobs = PhoneJobRunner(
            context = this,
            session = session,
            preferences = chatPreferences,
            appVersion = versionName,
            scope = appScope,
            phoneUi = phoneUi,
        )
        phoneJobs.start()
        // Covers the case where the process was relaunched (not booted) while
        // the setting was on — e.g. the OS killed the whole app under memory
        // pressure and the user (or a notification tap) reopened it. A device
        // reboot is covered separately by AlwaysOnBootReceiver, which can run
        // before anything ever constructs this Application's Activity.
        if (alwaysOn.enabled.value) {
            AlwaysOnConnectionService.start(this)
        }
    }
}
