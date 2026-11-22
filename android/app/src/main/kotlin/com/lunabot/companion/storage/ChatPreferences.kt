package com.lunabot.companion.storage

import android.content.Context
import android.content.SharedPreferences
import com.lunabot.companion.core.Chat
import com.lunabot.companion.core.forTask
import com.lunabot.companion.core.ActivityDetail
import com.lunabot.companion.core.QuickReply
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import androidx.core.content.edit

/** Light, dark, or whatever the phone is set to. */
enum class ThemeMode(val wireValue: String) {
    SYSTEM("system"),
    LIGHT("light"),
    DARK("dark"),
    ;

    companion object {
        fun fromWire(value: String?): ThemeMode =
            entries.firstOrNull { it.wireValue == value } ?: SYSTEM
    }
}

/** Visual character style pack for bot portraits across the app. */
enum class BotAvatarStyle(val wireValue: String) {
    ORB("orb"),
    NEKO("neko"),
    LIQUID("liquid"),
    SYNTH("synth"),
    SPIRIT("spirit"),
    MINIBOT("minibot"),
    BUNNY("bunny"),
    ASTRO("astro"),
    PRISM("prism"),
    BEAR("bear"),
    RETRO("retro"),
    FOX("fox"),
    FROG("frog"),
    OWL("owl"),
    WISP("wisp"),
    CAMERA("camera"),
    CLOUD("cloud"),
    CLASSIC("classic"),
    ;

    companion object {
        fun fromWire(value: String?): BotAvatarStyle =
            entries.firstOrNull { it.wireValue == value } ?: ORB
    }
}

/** Where a voice message's transcript is produced: nowhere, on the phone, or on the computer. */
enum class VoiceAsrMode(val wireValue: String) {
    OFF("off"),
    DEVICE("device"),
    ONLINE("online"),
    ;

    companion object {
        // Online is the default: the device path needs a downloaded model
        // first, and a failed remote transcribe still degrades to audio-only.
        fun fromWire(value: String?): VoiceAsrMode =
            entries.firstOrNull { it.wireValue == value } ?: ONLINE
    }
}

/**
 * How the phone-UI executor paces its actions. [FAST] is the old touch exactly
 * — no extra waits, the whole text in one write; [STANDARD] and [HUMAN] add
 * pauses and segmented typing so automation looks less mechanical.
 */
enum class PhonePace(val wireValue: String) {
    FAST("fast"),
    STANDARD("standard"),
    HUMAN("human"),
    ;

    companion object {
        // Fast, not OperatingPace.DEFAULT: an install that upgrades must keep
        // the touch it had before this setting existed.
        fun fromWire(value: String?): PhonePace =
            entries.firstOrNull { it.wireValue == value } ?: FAST
    }
}

/**
 * Phone-local controls for how a conversation is presented.
 *
 * These are intentionally separate from pairing and from the encrypted token
 * store: they are presentation choices, not capabilities of the paired
 * computer. One instance is placed in [CompanionEnvironment], so Settings and
 * an already-open chat observe the same values immediately.
 */
class ChatPreferences(
    private val prefs: SharedPreferences,
) {
    constructor(context: Context) : this(
        context.applicationContext.getSharedPreferences(NAME, Context.MODE_PRIVATE),
    )

    private val _activityDetail = MutableStateFlow(
        // Minis shows one folded line for a run of tool steps; full step-by-step
        // detail is the developer view, not the default a phone reader wants.
        ActivityDetail.fromWire(
            prefs.getString(ACTIVITY_DETAIL, ActivityDetail.REDUCED.wireValue),
        ),
    )
    val activityDetail: StateFlow<ActivityDetail> = _activityDetail.asStateFlow()

    private val _quickReplies = MutableStateFlow(QuickReply.decode(prefs.getString(QUICK_REPLIES, "").orEmpty()))
    val quickReplies: StateFlow<List<QuickReply>> = _quickReplies.asStateFlow()

    private val _themeMode = MutableStateFlow(
        ThemeMode.fromWire(prefs.getString(THEME_MODE, null)),
    )
    val themeMode: StateFlow<ThemeMode> = _themeMode.asStateFlow()

    private val _avatarStyle = MutableStateFlow(
        BotAvatarStyle.fromWire(prefs.getString(AVATAR_STYLE, null)),
    )
    val avatarStyle: StateFlow<BotAvatarStyle> = _avatarStyle.asStateFlow()

    private val _customLunaAvatarPath = MutableStateFlow(
        prefs.getString(CUSTOM_LUNA_AVATAR_PATH, null)?.takeIf { it.isNotBlank() },
    )
    val customLunaAvatarPath: StateFlow<String?> = _customLunaAvatarPath.asStateFlow()

    private val _voiceAsrMode = MutableStateFlow(
        VoiceAsrMode.fromWire(prefs.getString(VOICE_ASR_MODE, null)),
    )
    val voiceAsrMode: StateFlow<VoiceAsrMode> = _voiceAsrMode.asStateFlow()

    fun setVoiceAsrMode(mode: VoiceAsrMode) {
        if (_voiceAsrMode.value == mode && prefs.contains(VOICE_ASR_MODE)) return
        prefs.edit { putString(VOICE_ASR_MODE, mode.wireValue) }
        _voiceAsrMode.value = mode
    }

    /**
     * Whether bots on the paired computer may read this phone's calendar.
     * Off until the person turns it on and grants the Android permission; the
     * runner registers only while it is on.
     */
    private val _phoneCalendar = MutableStateFlow(prefs.getBoolean(PHONE_CALENDAR, false))
    val phoneCalendar: StateFlow<Boolean> = _phoneCalendar.asStateFlow()

    fun setPhoneCalendar(enabled: Boolean) {
        if (_phoneCalendar.value == enabled && prefs.contains(PHONE_CALENDAR)) return
        prefs.edit { putBoolean(PHONE_CALENDAR, enabled) }
        _phoneCalendar.value = enabled
    }

    /** Whether bots may search and change this phone's contacts; off until allowed. */
    private val _phoneContacts = MutableStateFlow(prefs.getBoolean(PHONE_CONTACTS, false))
    val phoneContacts: StateFlow<Boolean> = _phoneContacts.asStateFlow()

    fun setPhoneContacts(enabled: Boolean) {
        if (_phoneContacts.value == enabled && prefs.contains(PHONE_CONTACTS)) return
        prefs.edit { putBoolean(PHONE_CONTACTS, enabled) }
        _phoneContacts.value = enabled
    }

    /** Whether bots may keep reminders in this app; no OS permission is involved. */
    private val _phoneReminders = MutableStateFlow(prefs.getBoolean(PHONE_REMINDERS, false))
    val phoneReminders: StateFlow<Boolean> = _phoneReminders.asStateFlow()

    fun setPhoneReminders(enabled: Boolean) {
        if (_phoneReminders.value == enabled && prefs.contains(PHONE_REMINDERS)) return
        prefs.edit { putBoolean(PHONE_REMINDERS, enabled) }
        _phoneReminders.value = enabled
    }

    /** Whether bots may ask this phone where it is; off until allowed. */
    private val _phoneLocation = MutableStateFlow(prefs.getBoolean(PHONE_LOCATION, false))
    val phoneLocation: StateFlow<Boolean> = _phoneLocation.asStateFlow()

    fun setPhoneLocation(enabled: Boolean) {
        if (_phoneLocation.value == enabled && prefs.contains(PHONE_LOCATION)) return
        prefs.edit { putBoolean(PHONE_LOCATION, enabled) }
        _phoneLocation.value = enabled
    }

    /**
     * Whether bots may send a message from this phone. One switch for both SMS
     * and WhatsApp: the person grants the address book once, and the Android
     * SMS permission is asked only when the switch is turned on.
     */
    private val _phoneMessages = MutableStateFlow(prefs.getBoolean(PHONE_MESSAGES, false))
    val phoneMessages: StateFlow<Boolean> = _phoneMessages.asStateFlow()

    fun setPhoneMessages(enabled: Boolean) {
        if (_phoneMessages.value == enabled && prefs.contains(PHONE_MESSAGES)) return
        prefs.edit { putBoolean(PHONE_MESSAGES, enabled) }
        _phoneMessages.value = enabled
    }

    private val _phoneUi = MutableStateFlow(prefs.getBoolean(PHONE_UI, false))
    val phoneUi: StateFlow<Boolean> = _phoneUi.asStateFlow()

    @Synchronized
    fun setPhoneUi(enabled: Boolean) {
        if (_phoneUi.value == enabled && prefs.contains(PHONE_UI)) return
        prefs.edit(commit = true) { putBoolean(PHONE_UI, enabled) }
        _phoneUi.value = enabled
    }

    /**
     * How the phone-UI executor paces its actions. Read by the job runner when
     * it builds the executor and observed while it runs, so a change applies
     * to the next task without a restart.
     */
    private val _phonePace = MutableStateFlow(
        PhonePace.fromWire(prefs.getString(PHONE_PACE, PhonePace.FAST.wireValue)),
    )
    val phonePace: StateFlow<PhonePace> = _phonePace.asStateFlow()

    @Synchronized
    fun setPhonePace(pace: PhonePace) {
        if (_phonePace.value == pace && prefs.contains(PHONE_PACE)) return
        prefs.edit(commit = true) { putString(PHONE_PACE, pace.wireValue) }
        _phonePace.value = pace
    }

    /**
     * Whether the app may re-enable wireless debugging after a reboot, so the
     * shell helper can start again without the person walking back to developer
     * options. Opt-in and off by default because it widens the app's own
     * privileges: to write that switch the app must hold
     * WRITE_SECURE_SETTINGS, which lets it write any system setting, not only
     * this one. Turning it off stops future grants; it cannot take back a
     * permission the system already granted — the person can revoke that in
     * system settings.
     */
    private val _phoneRepairWireless = MutableStateFlow(storedBoolean(PHONE_REPAIR_WIRELESS))
    val phoneRepairWireless: StateFlow<Boolean> = _phoneRepairWireless.asStateFlow()

    @Synchronized
    fun setPhoneRepairWireless(enabled: Boolean) {
        if (_phoneRepairWireless.value == enabled && prefs.contains(PHONE_REPAIR_WIRELESS)) return
        // Committed: a reboot is exactly when this value must already be on disk.
        prefs.edit(commit = true) { putBoolean(PHONE_REPAIR_WIRELESS, enabled) }
        _phoneRepairWireless.value = enabled
    }

    /**
     * A boolean as stored, false when the key is absent or holds another type.
     * `getBoolean` throws on a type mismatch, and Settings builds this
     * preference while the screen opens — a stored string must not crash it.
     */
    private fun storedBoolean(key: String): Boolean = try {
        prefs.getBoolean(key, false)
    } catch (_: ClassCastException) {
        false
    }

    /**
     * Whether bots may look through this phone's photos and one folder the
     * person grants. Off until they turn it on; the media permission is asked
     * only then, and the folder grant is a separate deliberate pick.
     */
    private val _phoneFiles = MutableStateFlow(prefs.getBoolean(PHONE_FILES, false))
    val phoneFiles: StateFlow<Boolean> = _phoneFiles.asStateFlow()

    fun setPhoneFiles(enabled: Boolean) {
        if (_phoneFiles.value == enabled && prefs.contains(PHONE_FILES)) return
        prefs.edit { putBoolean(PHONE_FILES, enabled) }
        _phoneFiles.value = enabled
    }

    /** The folder the person granted with the system picker; null while none. */
    private val _phoneFilesTree = MutableStateFlow(prefs.getString(PHONE_FILES_TREE, null))
    val phoneFilesTree: StateFlow<String?> = _phoneFilesTree.asStateFlow()

    fun setPhoneFilesTree(uri: String?) {
        prefs.edit { if (uri == null) remove(PHONE_FILES_TREE) else putString(PHONE_FILES_TREE, uri) }
        _phoneFilesTree.value = uri
    }

    /**
     * Whether bots may list recent notifications. Separate from the SMS relay
     * switch: both ride the same system notification access, but this one is
     * the bot reading every app's notifications, not texts being forwarded.
     */
    private val _phoneNotices = MutableStateFlow(prefs.getBoolean(PHONE_NOTICES, false))
    val phoneNotices: StateFlow<Boolean> = _phoneNotices.asStateFlow()

    fun setPhoneNotices(enabled: Boolean) {
        if (_phoneNotices.value == enabled && prefs.contains(PHONE_NOTICES)) return
        prefs.edit { putBoolean(PHONE_NOTICES, enabled) }
        _phoneNotices.value = enabled
    }

    /**
     * Whether the notification-listener relay may run: RCS/5G messages never
     * fire SMS_RECEIVED, so the messaging app's own notification is the only
     * readable signal. The system grant is asked for separately; this pref is
     * the person's opt-in on top of it.
     */
    private val _phoneNotifyRelay = MutableStateFlow(prefs.getBoolean(PHONE_NOTIFY_RELAY, false))
    val phoneNotifyRelay: StateFlow<Boolean> = _phoneNotifyRelay.asStateFlow()

    fun setPhoneNotifyRelay(enabled: Boolean) {
        if (_phoneNotifyRelay.value == enabled && prefs.contains(PHONE_NOTIFY_RELAY)) return
        prefs.edit { putBoolean(PHONE_NOTIFY_RELAY, enabled) }
        _phoneNotifyRelay.value = enabled
    }

    /**
     * Whether a small read-only window may float over other apps while a task
     * drives the controlled display, so the person can watch from anywhere.
     * Off by default; the switch also needs the system's own overlay grant,
     * which Settings asks for through ACTION_MANAGE_OVERLAY_PERMISSION.
     */
    private val _phoneUiOverlay = MutableStateFlow(storedBoolean(PHONE_UI_OVERLAY))
    val phoneUiOverlay: StateFlow<Boolean> = _phoneUiOverlay.asStateFlow()

    fun setPhoneUiOverlay(enabled: Boolean) {
        if (_phoneUiOverlay.value == enabled && prefs.contains(PHONE_UI_OVERLAY)) return
        prefs.edit { putBoolean(PHONE_UI_OVERLAY, enabled) }
        _phoneUiOverlay.value = enabled
    }

    /**
     * Whether notifications may be pushed to the computer at all. Separate
     * from [phoneNotices] (the bot *reading* them on demand): this is the
     * phone *sending* them on its own, and only for packages in
     * [phoneNoticeApps].
     */
    private val _phoneNoticeShare = MutableStateFlow(prefs.getBoolean(PHONE_NOTICE_SHARE, false))
    val phoneNoticeShare: StateFlow<Boolean> = _phoneNoticeShare.asStateFlow()

    fun setPhoneNoticeShare(enabled: Boolean) {
        if (_phoneNoticeShare.value == enabled && prefs.contains(PHONE_NOTICE_SHARE)) return
        prefs.edit { putBoolean(PHONE_NOTICE_SHARE, enabled) }
        _phoneNoticeShare.value = enabled
    }

    /**
     * The packages whose notifications may be pushed. The whitelist is the
     * consent: nothing outside it leaves the phone, whatever the listener can
     * see.
     */
    private val _phoneNoticeApps = MutableStateFlow(prefs.getStringSet(PHONE_NOTICE_APPS, null) ?: emptySet())
    val phoneNoticeApps: StateFlow<Set<String>> = _phoneNoticeApps.asStateFlow()

    fun setPhoneNoticeApps(packages: Set<String>) {
        if (_phoneNoticeApps.value == packages && prefs.contains(PHONE_NOTICE_APPS)) return
        prefs.edit { putStringSet(PHONE_NOTICE_APPS, packages) }
        _phoneNoticeApps.value = packages
    }

    /**
     * This installation's id for the phone-tools registration. Stable for the
     * life of the install so a re-registration updates the same device record;
     * a fresh pairing changes the key the server stores it under, not this.
     */
    fun phoneInstallId(): String {
        prefs.getString(PHONE_INSTALL_ID, null)?.let { if (it.isNotBlank()) return it }
        val created = java.util.UUID.randomUUID().toString()
        prefs.edit { putString(PHONE_INSTALL_ID, created) }
        return created
    }

    fun setThemeMode(mode: ThemeMode) {
        if (_themeMode.value == mode && prefs.contains(THEME_MODE)) return
        prefs.edit { putString(THEME_MODE, mode.wireValue) }
        _themeMode.value = mode
    }

    fun setAvatarStyle(style: BotAvatarStyle) {
        if (_avatarStyle.value == style && prefs.contains(AVATAR_STYLE)) return
        prefs.edit { putString(AVATAR_STYLE, style.wireValue) }
        _avatarStyle.value = style
    }

    fun setCustomLunaAvatarPath(path: String?) {
        val normalized = path?.takeIf { it.isNotBlank() }
        prefs.edit {
            if (normalized == null) remove(CUSTOM_LUNA_AVATAR_PATH)
            else putString(CUSTOM_LUNA_AVATAR_PATH, normalized)
        }
        _customLunaAvatarPath.value = normalized
    }

    fun setActivityDetail(detail: ActivityDetail) {
        if (_activityDetail.value == detail && prefs.contains(ACTIVITY_DETAIL)) return
        // The value is small and changed only from Settings. Commit makes a
        // selection durable before a process recreation can observe it.
        prefs.edit { putString(ACTIVITY_DETAIL, detail.wireValue) }
        _activityDetail.value = detail
    }

    fun setQuickReplies(replies: List<QuickReply>) {
        // An encoded empty list is meaningful: it hides the chip row. Do not
        // turn it into an absent key, which QuickReply.decode correctly treats
        // as a first-run default.
        val encoded = QuickReply.encode(replies)
        if (_quickReplies.value == replies && prefs.getString(QUICK_REPLIES, null) == encoded) return
        prefs.edit { putString(QUICK_REPLIES, encoded) }
        _quickReplies.value = replies
    }

    fun resetQuickReplies() = setQuickReplies(QuickReply.DEFAULTS)

    fun lastShareDestination(connectionId: String): String? =
        prefs.getString(destinationKey(connectionId), null)?.takeIf(String::isNotBlank)

    fun setLastShareDestination(connectionId: String, destinationId: String) {
        val key = destinationKey(connectionId)
        if (prefs.getString(key, null) == destinationId) return
        prefs.edit { putString(key, destinationId) }
    }

    /** Only a generic roster tap restores this preference; explicit links keep their target. */
    fun restoringThread(chat: Chat, connectionId: String?): Chat {
        if (chat !is Chat.BotChat || connectionId == null) return chat
        val threadId = prefs.getString(threadKey(connectionId, chat.id), null) ?: return chat
        return chat.bot.forTask(threadId)?.let(Chat::BotChat) ?: chat
    }

    fun rememberThread(chat: Chat, connectionId: String?) {
        if (chat !is Chat.BotChat || connectionId == null) return
        val key = threadKey(connectionId, chat.id)
        if (prefs.getString(key, null) != chat.threadId) {
            prefs.edit { putString(key, chat.threadId) }
        }
    }

    companion object {
        const val NAME = "lunabot.chat-preferences"
        const val FILE = "$NAME.xml"
        private const val ACTIVITY_DETAIL = "companion.prefs.activityDetail"
        private const val QUICK_REPLIES = "companion.prefs.quickReplies"
        private const val THEME_MODE = "companion.prefs.themeMode"
        private const val AVATAR_STYLE = "companion.prefs.avatarStyle"
        private const val CUSTOM_LUNA_AVATAR_PATH = "companion.prefs.customLunaAvatarPath"
        private const val VOICE_ASR_MODE = "companion.prefs.voiceAsr"
        private const val PHONE_CALENDAR = "companion.prefs.phone.calendar"
        private const val PHONE_CONTACTS = "companion.prefs.phone.contacts"
        private const val PHONE_REMINDERS = "companion.prefs.phone.reminders"
        private const val PHONE_LOCATION = "companion.prefs.phone.location"
        private const val PHONE_MESSAGES = "companion.prefs.phone.messages"
        private const val PHONE_UI = "companion.prefs.phone.ui"
        private const val PHONE_PACE = "companion.prefs.phone.pace"
        private const val PHONE_REPAIR_WIRELESS = "companion.prefs.phone.repair.wireless"
        private const val PHONE_FILES = "companion.prefs.phone.files"
        private const val PHONE_FILES_TREE = "companion.prefs.phone.filesTree"
        private const val PHONE_NOTICES = "companion.prefs.phone.notices"
        private const val PHONE_UI_OVERLAY = "companion.prefs.phone.uiOverlay"
        private const val PHONE_NOTIFY_RELAY = "companion.prefs.phone.notifyRelay"
        private const val PHONE_NOTICE_SHARE = "companion.prefs.phone.noticeShare"
        private const val PHONE_NOTICE_APPS = "companion.prefs.phone.noticeApps"
        private const val PHONE_INSTALL_ID = "companion.prefs.phone.installId"

        private fun threadKey(connectionId: String, botId: String): String =
            "thread.last-opened.${connectionId.length}:$connectionId$botId"

        private fun destinationKey(connectionId: String): String =
            "share.last-destination.$connectionId"
    }
}
