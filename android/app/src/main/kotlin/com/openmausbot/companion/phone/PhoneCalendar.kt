package com.openmausbot.companion.phone

import android.Manifest
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CalendarContract
import androidx.core.content.ContextCompat
import com.openmausbot.companion.core.CalendarAccess
import com.openmausbot.companion.core.PhoneCalendarRules
import com.openmausbot.companion.core.PhoneTool
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

/** What the executor answers: a result object, or the sentence and code the phone sends back. */
internal sealed interface PhoneToolOutcome {
    data class Success(val result: JsonObject) : PhoneToolOutcome
    data class Failure(val error: String, val code: String? = null) : PhoneToolOutcome
}

/**
 * The calendar app, as bots see it.
 *
 * This is the only capability the Android build registers (`PHONE_*` calendar
 * tools). Every read goes through `CalendarContract.Instances`, so recurring
 * events arrive expanded, and every write goes through `Events`; nothing here
 * talks to a network — the caller ships the JSON to the paired computer and
 * nowhere else.
 */
internal class PhoneCalendar(
    private val context: Context,
    private val zone: ZoneId = ZoneId.systemDefault(),
) {
    private val resolver get() = context.contentResolver

    fun access(): CalendarAccess {
        val read = ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR) ==
            PackageManager.PERMISSION_GRANTED
        val write = ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_CALENDAR) ==
            PackageManager.PERMISSION_GRANTED
        return when {
            read && write -> CalendarAccess.READ_WRITE
            read -> CalendarAccess.READ
            else -> CalendarAccess.NONE
        }
    }

    fun execute(tool: PhoneTool, arguments: JsonObject): PhoneToolOutcome {
        val access = access()
        if (!access.canRead) {
            return PhoneToolOutcome.Failure("这台手机还没有允许读取日历。", "denied")
        }
        if (tool.writes && !access.canWrite) {
            return PhoneToolOutcome.Failure("这台手机只允许读取日历，不能修改。", "denied")
        }
        return runCatching {
            when (tool) {
                PhoneTool.LIST_EVENTS -> listEvents(arguments)
                PhoneTool.GET_EVENT -> getEvent(arguments)
                PhoneTool.FIND_FREE_TIME -> findFreeTime(arguments)
                PhoneTool.CREATE_EVENT -> createEvent(arguments)
                PhoneTool.UPDATE_EVENT -> updateEvent(arguments)
                PhoneTool.DELETE_EVENT -> deleteEvent(arguments)
                // The runner dispatches by capability; this is the compiler's
                // reminder that the enum now holds other apps' tools too.
                else -> PhoneToolOutcome.Failure("这个工具不属于日历。", "unsupported")
            }
        }.getOrElse { error ->
            // A provider that throws is a device problem, not the bot's fault;
            // the message still has to be one a person could act on.
            PhoneToolOutcome.Failure(error.message?.takeIf { it.isNotBlank() } ?: "读取日历失败。", "denied")
        }
    }

    // MARK: - Reads

    private fun listEvents(arguments: JsonObject): PhoneToolOutcome {
        val (from, to) = PhoneCalendarRules.parseWindow(
            arguments.string("from"),
            arguments.string("to"),
        ) ?: return invalidWindow()
        val calendar = arguments.string("calendar")

        var count = 0
        val events = buildJsonArray {
            queryInstances(from, to, calendar) { cursor ->
                while (cursor.moveToNext() && count < MAX_EVENTS) {
                    add(instanceJson(cursor))
                    count++
                }
            }
        }
        return PhoneToolOutcome.Success(
            buildJsonObject {
                put("events", events)
                if (count >= MAX_EVENTS) put("truncated", true)
            },
        )
    }

    private fun getEvent(arguments: JsonObject): PhoneToolOutcome {
        val id = arguments.string("id") ?: return missing("id")
        val event = queryEvent(id) ?: return notFound()
        return PhoneToolOutcome.Success(buildJsonObject { put("event", event) })
    }

    private fun findFreeTime(arguments: JsonObject): PhoneToolOutcome {
        val (from, to) = PhoneCalendarRules.parseWindow(
            arguments.string("from"),
            arguments.string("to"),
        ) ?: return invalidWindow()
        val minutes = arguments.int("minutes") ?: return missing("minutes")
        if (minutes !in 5..1440) {
            return PhoneToolOutcome.Failure("minutes 需要在 5 到 1440 之间。", "unsupported")
        }
        val busy = mutableListOf<Pair<Long, Long>>()
        queryInstances(from, to, arguments.string("calendar")) { cursor ->
            while (cursor.moveToNext()) {
                val start = cursor.getLong(cursor.getColumnIndexOrThrow(CalendarContract.Instances.BEGIN))
                val end = cursor.getLong(cursor.getColumnIndexOrThrow(CalendarContract.Instances.END))
                busy += start to end
            }
        }
        val gaps = PhoneCalendarRules.gaps(busy, from, to, minutes)
        return PhoneToolOutcome.Success(
            buildJsonObject {
                put("gaps", buildJsonArray {
                    gaps.forEach { (start, end) ->
                        add(buildJsonObject {
                            put("start", PhoneCalendarRules.formatInstant(start, zone))
                            put("end", PhoneCalendarRules.formatInstant(end, zone))
                        })
                    }
                })
            },
        )
    }

    // MARK: - Writes

    private fun createEvent(arguments: JsonObject): PhoneToolOutcome {
        val title = arguments.string("title") ?: return missing("title")
        val start = PhoneCalendarRules.parseInstant(arguments.string("start")) ?: return invalidTime("start")
        val end = PhoneCalendarRules.parseInstant(arguments.string("end")) ?: return invalidTime("end")
        val allDay = arguments.bool("allDay") == true
        if (end <= start) return PhoneToolOutcome.Failure("结束时间必须晚于开始时间。", "unsupported")
        val calendarId = writableCalendarId()
            ?: return PhoneToolOutcome.Failure("这台手机上还没有可写入的日历。", "denied")

        val values = ContentValues().apply {
            put(CalendarContract.Events.CALENDAR_ID, calendarId)
            put(CalendarContract.Events.TITLE, title)
            if (allDay) {
                put(CalendarContract.Events.DTSTART, allDayMillis(start))
                put(CalendarContract.Events.DTEND, allDayMillis(end))
            } else {
                put(CalendarContract.Events.DTSTART, start)
                put(CalendarContract.Events.DTEND, end)
            }
            put(CalendarContract.Events.ALL_DAY, if (allDay) 1 else 0)
            put(CalendarContract.Events.EVENT_TIMEZONE, if (allDay) "UTC" else zone.id)
            arguments.string("location")?.let { put(CalendarContract.Events.EVENT_LOCATION, it) }
            arguments.string("notes")?.let { put(CalendarContract.Events.DESCRIPTION, it) }
        }
        val inserted = resolver.insert(CalendarContract.Events.CONTENT_URI, values) ?: return notFound()
        val id = ContentUris.parseId(inserted).toString()
        val created = queryEvent(id) ?: return notFound()
        return PhoneToolOutcome.Success(buildJsonObject { put("event", created) })
    }

    private fun updateEvent(arguments: JsonObject): PhoneToolOutcome {
        val id = arguments.string("id") ?: return missing("id")
        queryEvent(id) ?: return notFound()
        val values = ContentValues()
        arguments.string("title")?.let { values.put(CalendarContract.Events.TITLE, it) }
        arguments.string("location")?.let { values.put(CalendarContract.Events.EVENT_LOCATION, it) }
        arguments.string("notes")?.let { values.put(CalendarContract.Events.DESCRIPTION, it) }
        val allDay = arguments.bool("allDay")
        val start = arguments.string("start")?.let {
            PhoneCalendarRules.parseInstant(it) ?: return invalidTime("start")
        }
        val end = arguments.string("end")?.let {
            PhoneCalendarRules.parseInstant(it) ?: return invalidTime("end")
        }
        if (start != null && end != null && end <= start) {
            return PhoneToolOutcome.Failure("结束时间必须晚于开始时间。", "unsupported")
        }
        val effectiveAllDay = allDay ?: (arguments.string("start") == null && arguments.string("end") == null)
        if (allDay != null) values.put(CalendarContract.Events.ALL_DAY, if (allDay) 1 else 0)
        start?.let {
            values.put(
                CalendarContract.Events.DTSTART,
                if (effectiveAllDay) allDayMillis(it) else it,
            )
        }
        end?.let {
            values.put(
                CalendarContract.Events.DTEND,
                if (effectiveAllDay) allDayMillis(it) else it,
            )
        }
        if (values.size() == 0) {
            return PhoneToolOutcome.Success(buildJsonObject { put("event", queryEvent(id)!!) })
        }
        val uri = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id.toLong())
        val changed = resolver.update(uri, values, null, null)
        if (changed <= 0) return notFound()
        val updated = queryEvent(id) ?: return notFound()
        return PhoneToolOutcome.Success(buildJsonObject { put("event", updated) })
    }

    private fun deleteEvent(arguments: JsonObject): PhoneToolOutcome {
        val id = arguments.string("id") ?: return missing("id")
        val uri = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id.toLong())
        val removed = resolver.delete(uri, null, null)
        if (removed <= 0) return notFound()
        return PhoneToolOutcome.Success(buildJsonObject { put("deleted", true) })
    }

    // MARK: - Provider access

    private fun queryInstances(
        from: Long,
        to: Long,
        calendar: String?,
        consume: (android.database.Cursor) -> Unit,
    ) {
        val uri = CalendarContract.Instances.CONTENT_URI.buildUpon()
            .appendPath(from.toString())
            .appendPath(to.toString())
            .build()
        val projection = arrayOf(
            CalendarContract.Instances.EVENT_ID,
            CalendarContract.Instances.TITLE,
            CalendarContract.Instances.BEGIN,
            CalendarContract.Instances.END,
            CalendarContract.Instances.ALL_DAY,
            CalendarContract.Instances.CALENDAR_DISPLAY_NAME,
            CalendarContract.Instances.EVENT_LOCATION,
            CalendarContract.Instances.DESCRIPTION,
        )
        val selection = calendar?.let { "${CalendarContract.Instances.CALENDAR_DISPLAY_NAME} = ?" }
        val args = calendar?.let { arrayOf(it) }
        resolver.query(
            uri,
            projection,
            selection,
            args,
            "${CalendarContract.Instances.BEGIN} ASC",
        )?.use(consume)
    }

    private fun queryEvent(id: String): JsonObject? {
        val uri = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id.toLongOrNull() ?: return null)
        resolver.query(
            uri,
            arrayOf(
                CalendarContract.Events._ID,
                CalendarContract.Events.TITLE,
                CalendarContract.Events.DTSTART,
                CalendarContract.Events.DTEND,
                CalendarContract.Events.ALL_DAY,
                CalendarContract.Events.EVENT_LOCATION,
                CalendarContract.Events.DESCRIPTION,
                CalendarContract.Events.CALENDAR_DISPLAY_NAME,
            ),
            null,
            null,
            null,
        )?.use { cursor ->
            if (!cursor.moveToFirst()) return null
            return eventJson(cursor)
        }
        return null
    }

    private fun writableCalendarId(): Long? {
        resolver.query(
            CalendarContract.Calendars.CONTENT_URI,
            arrayOf(CalendarContract.Calendars._ID),
            "${CalendarContract.Calendars.VISIBLE} = 1 AND " +
                "${CalendarContract.Calendars.SYNC_EVENTS} = 1",
            null,
            "${CalendarContract.Calendars.IS_PRIMARY} DESC",
        )?.use { cursor ->
            if (!cursor.moveToFirst()) return null
            return cursor.getLong(0)
        }
        return null
    }

    // MARK: - JSON

    private fun instanceJson(cursor: android.database.Cursor): JsonObject = buildJsonObject {
        val begin = cursor.getLong(cursor.getColumnIndexOrThrow(CalendarContract.Instances.BEGIN))
        val end = cursor.getLong(cursor.getColumnIndexOrThrow(CalendarContract.Instances.END))
        val allDay = cursor.getInt(cursor.getColumnIndexOrThrow(CalendarContract.Instances.ALL_DAY)) == 1
        put("id", cursor.getLong(cursor.getColumnIndexOrThrow(CalendarContract.Instances.EVENT_ID)).toString())
        put("title", cursor.getStringOrNull(CalendarContract.Instances.TITLE).orEmpty())
        put("start", PhoneCalendarRules.formatInstant(begin, zone))
        put("end", PhoneCalendarRules.formatInstant(end, zone))
        put("allDay", allDay)
        cursor.getStringOrNull(CalendarContract.Instances.CALENDAR_DISPLAY_NAME)?.let { put("calendar", it) }
        cursor.getStringOrNull(CalendarContract.Instances.EVENT_LOCATION)?.let { put("location", it) }
    }

    private fun eventJson(cursor: android.database.Cursor): JsonObject = buildJsonObject {
        val begin = cursor.getLong(cursor.getColumnIndexOrThrow(CalendarContract.Events.DTSTART))
        val end = cursor.getLong(cursor.getColumnIndexOrThrow(CalendarContract.Events.DTEND))
        put("id", cursor.getLong(cursor.getColumnIndexOrThrow(CalendarContract.Events._ID)).toString())
        put("title", cursor.getStringOrNull(CalendarContract.Events.TITLE).orEmpty())
        put("start", PhoneCalendarRules.formatInstant(begin, zone))
        put("end", PhoneCalendarRules.formatInstant(end, zone))
        put("allDay", cursor.getInt(cursor.getColumnIndexOrThrow(CalendarContract.Events.ALL_DAY)) == 1)
        cursor.getStringOrNull(CalendarContract.Events.EVENT_LOCATION)?.let { put("location", it) }
        cursor.getStringOrNull(CalendarContract.Events.DESCRIPTION)?.let { put("notes", it) }
        cursor.getStringOrNull(CalendarContract.Events.CALENDAR_DISPLAY_NAME)?.let { put("calendar", it) }
    }

    private fun android.database.Cursor.getStringOrNull(column: String): String? {
        val index = getColumnIndexOrThrow(column)
        return if (isNull(index)) null else getString(index)
    }

    // MARK: - Failures

    private fun invalidWindow() = PhoneToolOutcome.Failure(
        "需要一个带时区偏移的开始和结束时间，例如 2026-10-24T12:00:00+08:00，且结束要晚于开始。",
        "unsupported",
    )

    private fun invalidTime(field: String) = PhoneToolOutcome.Failure(
        "$field 需要一个带时区偏移的时间，例如 2026-10-24T12:00:00+08:00。",
        "unsupported",
    )

    private fun missing(field: String) = PhoneToolOutcome.Failure("缺少 $field。", "unsupported")

    private fun notFound() = PhoneToolOutcome.Failure("没有找到这个日程。", "not_found")

    /**
     * CalendarContract wants an all-day event's bounds at midnight UTC of the
     * local date; the harness sends an instant with an offset.
     */
    private fun allDayMillis(millis: Long): Long =
        Instant.ofEpochMilli(millis)
            .atZone(zone)
            .toLocalDate()
            .atStartOfDay(ZoneOffset.UTC)
            .toInstant()
            .toEpochMilli()

    private companion object {
        /** One screen of events; a bot asking for a year gets a marker, not a megabyte. */
        const val MAX_EVENTS = 200
    }
}

private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }

private fun JsonObject.bool(key: String): Boolean? =
    (this[key] as? JsonPrimitive)?.booleanOrNull

private fun JsonObject.int(key: String): Int? =
    (this[key] as? JsonPrimitive)?.intOrNull
