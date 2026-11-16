package com.openmausbot.companion.storage

import android.content.Context
import android.content.SharedPreferences
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.forTask
import com.openmausbot.companion.core.ActivityDetail
import com.openmausbot.companion.core.QuickReply
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
        const val NAME = "dexbot.chat-preferences"
        const val FILE = "$NAME.xml"
        private const val ACTIVITY_DETAIL = "companion.prefs.activityDetail"
        private const val QUICK_REPLIES = "companion.prefs.quickReplies"
        private const val THEME_MODE = "companion.prefs.themeMode"
        private const val VOICE_ASR_MODE = "companion.prefs.voiceAsr"
        private const val PHONE_CALENDAR = "companion.prefs.phone.calendar"
        private const val PHONE_CONTACTS = "companion.prefs.phone.contacts"
        private const val PHONE_REMINDERS = "companion.prefs.phone.reminders"
        private const val PHONE_LOCATION = "companion.prefs.phone.location"
        private const val PHONE_MESSAGES = "companion.prefs.phone.messages"
        private const val PHONE_UI = "companion.prefs.phone.ui"
        private const val PHONE_PACE = "companion.prefs.phone.pace"
        private const val PHONE_FILES = "companion.prefs.phone.files"
        private const val PHONE_FILES_TREE = "companion.prefs.phone.filesTree"
        private const val PHONE_NOTICES = "companion.prefs.phone.notices"
        private const val PHONE_NOTIFY_RELAY = "companion.prefs.phone.notifyRelay"
        private const val PHONE_INSTALL_ID = "companion.prefs.phone.installId"

        private fun threadKey(connectionId: String, botId: String): String =
            "thread.last-opened.${connectionId.length}:$connectionId$botId"

        private fun destinationKey(connectionId: String): String =
            "share.last-destination.$connectionId"
    }
}
