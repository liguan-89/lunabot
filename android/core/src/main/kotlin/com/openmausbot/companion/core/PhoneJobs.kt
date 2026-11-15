package com.openmausbot.companion.core

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/**
 * The transport for "phone apps as bot tools": a paired phone registers the
 * apps it allows, long-polls for jobs, leases one, and answers it.
 *
 * The computer side is `server/routes/phones.ts` and `server/phones/jobs.ts`.
 * The shapes here are the wire, not a policy: which tools this build can
 * actually run is [PhoneToolCatalog] plus the executor in the app module.
 */
@Serializable
data class PhoneRegistration(
    val installId: String,
    val name: String,
    // Required, not defaulted: the JSON encoder omits values equal to a
    // default, and the server requires this field on the wire.
    val platform: String,
    val appVersion: String,
    val timeZone: String,
    /**
     * Capability → the OS grant the phone holds ("full", "limited", …).
     * Presence means the app is allowed; the value is what the phone's own
     * permission state can honestly claim.
     */
    val capabilities: Map<String, String> = emptyMap(),
)

@Serializable
data class PhoneRegistrationResponse(val phone: JsonObject? = null)

/** `GET /api/phones/self`: null when this phone has never registered. */
@Serializable
data class PhoneSelfResponse(val phone: JsonObject? = null)

@Serializable
data class PhoneJob(
    val id: String,
    val tool: String,
    /** Tool arguments exactly as the harness sent them; the executor reads them. */
    val arguments: JsonObject = JsonObject(emptyMap()),
    val expiresAt: Long? = null,
)

@Serializable
data class PhoneJobPoll(val job: PhoneJob? = null)

@Serializable
data class PhoneLease(val active: Boolean = false)

/**
 * What the phone pushes through `POST /api/phones/self/events`: one inbound
 * text. `sendId` lets the server dedupe the re-broadcasts Android may make
 * for the same message; on Android it is `<from>:<PDU timestamp millis>`.
 */
@Serializable
data class PhoneSmsEvent(
    // Required on the wire (a discriminated union): the encoder would drop a
    // field equal to its default, so it is pinned on.
    @EncodeDefault val kind: String = "sms",
    val sendId: String,
    val from: String,
    val text: String,
)

/**
 * What this build knows how to answer. The list is the calendar subset on
 * purpose: a name here is a tool the Android executor implements, and anything
 * else is answered `unsupported` rather than guessed at.
 */
enum class PhoneTool(
    val wire: String,
    val capability: String,
    val writes: Boolean,
) {
    LIST_EVENTS("PHONE_LIST_EVENTS", "calendar", false),
    GET_EVENT("PHONE_GET_EVENT", "calendar", false),
    FIND_FREE_TIME("PHONE_FIND_FREE_TIME", "calendar", false),
    CREATE_EVENT("PHONE_CREATE_EVENT", "calendar", true),
    UPDATE_EVENT("PHONE_UPDATE_EVENT", "calendar", true),
    DELETE_EVENT("PHONE_DELETE_EVENT", "calendar", true),
    SEARCH_CONTACTS("PHONE_SEARCH_CONTACTS", "contacts", false),
    GET_CONTACT("PHONE_GET_CONTACT", "contacts", false),
    CREATE_CONTACT("PHONE_CREATE_CONTACT", "contacts", true),
    UPDATE_CONTACT("PHONE_UPDATE_CONTACT", "contacts", true),
    LIST_REMINDERS("PHONE_LIST_REMINDERS", "reminders", false),
    CREATE_REMINDER("PHONE_CREATE_REMINDER", "reminders", true),
    UPDATE_REMINDER("PHONE_UPDATE_REMINDER", "reminders", true),
    COMPLETE_REMINDER("PHONE_COMPLETE_REMINDER", "reminders", true),
    DELETE_REMINDER("PHONE_DELETE_REMINDER", "reminders", true),
    GET_LOCATION("PHONE_GET_LOCATION", "location", false),
    SEND_MESSAGE("PHONE_SEND_MESSAGE", "messages", true),
    SEND_WHATSAPP("PHONE_SEND_WHATSAPP", "messages", true),
    // A channel reply the phone sends itself; the server only ever pins `to`
    // to a number that wrote in, unlike the compose-sheet tools above.
    REPLY_SMS("PHONE_REPLY_SMS", "messages", true),
    UI_OBSERVE("PHONE_UI_OBSERVE", "phoneUi", false),
    UI_LAUNCH("PHONE_UI_LAUNCH", "phoneUi", true),
    UI_TAP("PHONE_UI_TAP", "phoneUi", true),
    UI_TYPE("PHONE_UI_TYPE", "phoneUi", true),
    UI_SCROLL("PHONE_UI_SCROLL", "phoneUi", true),
    UI_BACK("PHONE_UI_BACK", "phoneUi", true),
    ;

    companion object {
        private val byWire = entries.associateBy(PhoneTool::wire)

        fun fromWire(value: String): PhoneTool? = byWire[value]
    }
}

object PhoneToolCatalog {
    /**
     * Every capability the server may route to a phone. A tool outside
     * [PhoneTool] still has a capability, so the executor can answer
     * `unsupported` with the right sentence instead of "unknown tool".
     */
    private val capabilityByTool: Map<String, String> = mapOf(
        "PHONE_LIST_EVENTS" to "calendar",
        "PHONE_GET_EVENT" to "calendar",
        "PHONE_FIND_FREE_TIME" to "calendar",
        "PHONE_CREATE_EVENT" to "calendar",
        "PHONE_UPDATE_EVENT" to "calendar",
        "PHONE_DELETE_EVENT" to "calendar",
        "PHONE_RESPOND_TO_INVITE" to "calendar",
        "PHONE_LIST_REMINDERS" to "reminders",
        "PHONE_CREATE_REMINDER" to "reminders",
        "PHONE_UPDATE_REMINDER" to "reminders",
        "PHONE_COMPLETE_REMINDER" to "reminders",
        "PHONE_DELETE_REMINDER" to "reminders",
        "PHONE_SEARCH_CONTACTS" to "contacts",
        "PHONE_GET_CONTACT" to "contacts",
        "PHONE_CREATE_CONTACT" to "contacts",
        "PHONE_UPDATE_CONTACT" to "contacts",
        "PHONE_GET_LOCATION" to "location",
        "PHONE_FIND_PLACES_NEARBY" to "location",
        "PHONE_LIST_HOME" to "home",
        "PHONE_SET_ACCESSORY" to "home",
        "PHONE_RUN_SCENE" to "home",
        "PHONE_SEND_MESSAGE" to "messages",
        "PHONE_SEND_WHATSAPP" to "messages",
        "PHONE_REPLY_SMS" to "messages",
        "PHONE_UI_OBSERVE" to "phoneUi",
        "PHONE_UI_LAUNCH" to "phoneUi",
        "PHONE_UI_TAP" to "phoneUi",
        "PHONE_UI_TYPE" to "phoneUi",
        "PHONE_UI_SCROLL" to "phoneUi",
        "PHONE_UI_BACK" to "phoneUi",
    )

    fun capabilityOf(tool: String): String? = capabilityByTool[tool]

    /** The capabilities this build can actually serve. */
    val supportedCapabilities: Set<String> = PhoneTool.entries.mapTo(mutableSetOf(), PhoneTool::capability)

    /**
     * A registration answer for the apps the person allowed on this phone.
     * Grants are the phone's own permission state: `full` only when the app
     * holds both halves, so the computer's "read vs write" choice has
     * something true to stand on.
     */
    fun capabilities(
        calendar: CalendarAccess,
        contacts: ContactsAccess = ContactsAccess.NONE,
        reminders: Boolean = false,
        location: LocationAccess = LocationAccess.NONE,
        messages: Boolean = false,
        phoneUi: Boolean = false,
    ): Map<String, String> = buildMap {
        when (calendar) {
            CalendarAccess.NONE -> Unit
            CalendarAccess.READ -> put("calendar", "limited")
            CalendarAccess.READ_WRITE -> put("calendar", "full")
        }
        when (contacts) {
            ContactsAccess.NONE -> Unit
            ContactsAccess.READ -> put("contacts", "limited")
            ContactsAccess.READ_WRITE -> put("contacts", "full")
        }
        // Reminders are this app's own store, not an OS permission: the
        // Settings switch is the whole grant, so it is always full.
        if (reminders) put("reminders", "full")
        when (location) {
            LocationAccess.NONE -> Unit
            LocationAccess.COARSE -> put("location", "limited")
            LocationAccess.PRECISE -> put("location", "full")
        }
        // Sending is the whole of the messages capability; the SMS permission
        // and the Settings switch are the grant.
        if (messages) put("messages", "full")
        // UI automation is a separate, explicit Settings grant and requires a
        // shell helper paired through Android Wireless debugging.
        if (phoneUi) put("phoneUi", "full")
    }
}

/** What the phone's own location permission state allows. */
enum class LocationAccess {
    NONE,
    COARSE,
    PRECISE,
    ;

    val canRead: Boolean get() = this != NONE
}

/** What the phone's own contacts permission state allows. */
enum class ContactsAccess {
    NONE,
    READ,
    READ_WRITE,
    ;

    val canRead: Boolean get() = this != NONE
    val canWrite: Boolean get() = this == READ_WRITE
}

/**
 * The reminder list's filter, kept pure because "affects nobody's calendar but
 * shows the right rows" is the kind of rule worth pinning without a device.
 */
object PhoneReminderRules {
    /**
     * [wantCompleted]: true lists only completed reminders; false or null lists
     * only open ones — the app's reminders screen has the same two buckets. A
     * range only matches reminders that have a due time inside it.
     */
    fun matches(
        dueAt: Long?,
        from: Long?,
        to: Long?,
        completed: Boolean,
        wantCompleted: Boolean?,
    ): Boolean {
        if ((wantCompleted == true) != completed) return false
        if (from == null && to == null) return true
        val due = dueAt ?: return false
        if (from != null && due < from) return false
        if (to != null && due > to) return false
        return true
    }
}

/** What the phone's own calendar permission state allows. */
enum class CalendarAccess {
    NONE,
    READ,
    READ_WRITE,
    ;

    val canRead: Boolean get() = this != NONE
    val canWrite: Boolean get() = this == READ_WRITE
}

/**
 * The pure half of the calendar tools: parsing the times the harness sends and
 * finding gaps in a set of busy intervals. Kept here, away from
 * `CalendarContract`, so the branching is testable without a device.
 */
object PhoneCalendarRules {
    /** A year is wider than any question a bot asks and bounds a bad input. */
    private const val MAX_RANGE_MILLIS = 366L * 24 * 60 * 60 * 1000

    /**
     * ISO 8601 with an offset, e.g. `2026-10-24T12:00:00+05:30`. A bare local
     * time is refused rather than guessed at: the phone's zone may not be the
     * computer's.
     */
    fun parseInstant(text: String?): Long? {
        val value = text?.trim().orEmpty()
        if (value.isEmpty() || value.length > 64) return null
        return runCatching {
            java.time.OffsetDateTime.parse(value).toInstant().toEpochMilli()
        }.getOrNull()
    }

    /** `from` before `to`, both parseable, and no wider than a year. */
    fun parseWindow(from: String?, to: String?): Pair<Long, Long>? {
        val start = parseInstant(from) ?: return null
        val end = parseInstant(to) ?: return null
        if (end <= start || end - start > MAX_RANGE_MILLIS) return null
        return start to end
    }

    fun formatInstant(millis: Long, zone: java.time.ZoneId = java.time.ZoneId.systemDefault()): String =
        java.time.Instant.ofEpochMilli(millis)
            .atZone(zone)
            .format(java.time.format.DateTimeFormatter.ISO_OFFSET_DATE_TIME)

    /**
     * Gaps of at least [minutes] between [from] and [to], given busy intervals
     * that may overlap, run past the window, or arrive out of order.
     */
    fun gaps(
        busy: List<Pair<Long, Long>>,
        from: Long,
        to: Long,
        minutes: Int,
    ): List<Pair<Long, Long>> {
        if (to <= from || minutes <= 0) return emptyList()
        val minimum = minutes * 60_000L
        val clamped = busy
            .map { (start, end) -> maxOf(start, from) to minOf(end, to) }
            .filter { (start, end) -> end > start }
            .sortedBy { it.first }

        val merged = mutableListOf<Pair<Long, Long>>()
        for (interval in clamped) {
            val last = merged.lastOrNull()
            if (last != null && interval.first <= last.second) {
                merged[merged.lastIndex] = last.first to maxOf(last.second, interval.second)
            } else {
                merged += interval
            }
        }

        val gaps = mutableListOf<Pair<Long, Long>>()
        var cursor = from
        for ((start, end) in merged) {
            if (start - cursor >= minimum) gaps += cursor to start
            cursor = maxOf(cursor, end)
        }
        if (to - cursor >= minimum) gaps += cursor to to
        return gaps
    }

    /** The event fields a create or update may carry, and which of them arrived. */
    fun eventFields(arguments: kotlinx.serialization.json.JsonObject): Map<String, Any?> =
        listOf("title", "start", "end", "allDay", "location", "notes").mapNotNull { key ->
            arguments[key]?.let { element ->
                val primitive = element as? kotlinx.serialization.json.JsonPrimitive
                val value: Any? = when {
                    primitive == null -> null
                    key == "allDay" -> primitive.booleanOrNull
                    else -> primitive.contentOrNull
                }
                value?.let { key to it }
            }
        }.toMap()
}
