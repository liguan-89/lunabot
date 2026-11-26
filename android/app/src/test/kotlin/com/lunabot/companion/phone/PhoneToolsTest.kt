package com.lunabot.companion.phone

import android.Manifest
import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.provider.CalendarContract
import com.lunabot.companion.core.CalendarAccess
import com.lunabot.companion.core.ContactsAccess
import com.lunabot.companion.core.PhoneTool
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver

/**
 * The parts of the calendar executor that can be checked without a calendar
 * provider: the permission gate and the JSON the computer parses.
 *
 * The provider queries themselves are device behaviour; validating them means
 * running against a real calendar, which is what the acceptance pass on the
 * phone is for.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PhoneToolsTest {

    private val app: Application = RuntimeEnvironment.getApplication()
    private val context: Context = app
    private val calendar = PhoneCalendar(context)

    private fun arguments(vararg pairs: Pair<String, String>): JsonObject =
        JsonObject(pairs.associate { (key, value) -> key to JsonPrimitive(value) })

    @Test
    fun `without the system grant nothing is read and nothing is claimed`() {
        assertEquals(CalendarAccess.NONE, calendar.access())

        val outcome = calendar.execute(
            PhoneTool.LIST_EVENTS,
            arguments("from" to "2026-10-24T00:00:00+08:00", "to" to "2026-10-25T00:00:00+08:00"),
        )
        val failure = assertIs<PhoneToolOutcome.Failure>(outcome)
        assertEquals("denied", failure.code)
    }

    @Test
    fun `read-only consent refuses writes with the same code, not an empty success`() {
        Shadows.shadowOf(app).grantPermissions(Manifest.permission.READ_CALENDAR)
        assertEquals(CalendarAccess.READ, calendar.access())

        val outcome = calendar.execute(
            PhoneTool.CREATE_EVENT,
            arguments(
                "title" to "Lunch",
                "start" to "2026-10-24T12:00:00+08:00",
                "end" to "2026-10-24T13:00:00+08:00",
            ),
        )
        val failure = assertIs<PhoneToolOutcome.Failure>(outcome)
        assertEquals("denied", failure.code)
        assertEquals("这台手机只允许读取日历，不能修改。", failure.error)
    }

    @Test
    fun `a bad window is refused before the provider is asked`() {
        Shadows.shadowOf(app).grantPermissions(Manifest.permission.READ_CALENDAR)

        val outcome = calendar.execute(
            PhoneTool.LIST_EVENTS,
            arguments("from" to "tomorrow", "to" to "later"),
        )
        val failure = assertIs<PhoneToolOutcome.Failure>(outcome)
        assertEquals("unsupported", failure.code)
    }

    @Test
    fun `contacts obey the same two gates as the calendar`() {
        val contacts = PhoneContacts(context)
        assertEquals(ContactsAccess.NONE, contacts.access())
        val refused = assertIs<PhoneToolOutcome.Failure>(
            contacts.execute(
                PhoneTool.SEARCH_CONTACTS,
                arguments("query" to "ada"),
            ),
        )
        assertEquals("denied", refused.code)

        Shadows.shadowOf(app).grantPermissions(Manifest.permission.READ_CONTACTS)
        assertEquals(ContactsAccess.READ, contacts.access())
        val write = assertIs<PhoneToolOutcome.Failure>(
            contacts.execute(
                PhoneTool.CREATE_CONTACT,
                arguments("givenName" to "Ada"),
            ),
        )
        assertEquals("denied", write.code)
        assertEquals("这台手机只允许读取联系人，不能修改。", write.error)
    }

    @Test
    fun `a channel reply without the SMS grant fails before SmsManager is asked`() {
        val messages = PhoneMessages(context)
        val outcome = messages.execute(
            PhoneTool.REPLY_SMS,
            arguments("to" to "+8613800138000", "text" to "收到"),
        )
        val failure = assertIs<PhoneToolOutcome.Failure>(outcome)
        assertEquals("unsupported", failure.code)
    }

    @Test
    fun `compose-sheet tools still need no grant at all`() {
        val messages = PhoneMessages(context)
        // SEND_MESSAGE opens the composer; with no activity to catch the intent
        // in this fixture the honest answer is still a Failure, never a crash.
        val outcome = messages.execute(
            PhoneTool.SEND_MESSAGE,
            arguments("to" to "+8613800138000", "text" to "hi"),
        )
        assertIs<PhoneToolOutcome>(outcome)
    }

    @Test
    fun `outcomes become the exact JSON the job result takes`() {
        val success = PhoneToolOutcome.Success(buildJsonObject { put("deleted", true) }).toJson()
        assertEquals(true, success.getValue("ok").jsonPrimitive.content.toBoolean())
        val result = success.getValue("result") as JsonObject
        assertEquals(true, result.getValue("deleted").jsonPrimitive.content.toBoolean())

        val failure = PhoneToolOutcome.Failure("没有找到这个日程。", "not_found").toJson()
        assertEquals(false, failure.getValue("ok").jsonPrimitive.content.toBoolean())
        assertEquals("没有找到这个日程。", failure.getValue("error").jsonPrimitive.content)
        assertEquals("not_found", failure.getValue("code").jsonPrimitive.content)

        // A failure with no code still has to be parseable: the union takes an
        // error and an optional code.
        val bare = PhoneToolOutcome.Failure("读取日历失败。").toJson()
        assertEquals(setOf("ok", "error"), bare.keys)
    }

    @Test
    fun `an invite answer is a write behind the same two calendar gates`() {
        val noGrant = calendar.execute(
            PhoneTool.RESPOND_TO_INVITE,
            arguments("id" to "42", "response" to "accept"),
        )
        assertEquals("denied", assertIs<PhoneToolOutcome.Failure>(noGrant).code)

        Shadows.shadowOf(app).grantPermissions(Manifest.permission.READ_CALENDAR)
        val readOnly = calendar.execute(
            PhoneTool.RESPOND_TO_INVITE,
            arguments("id" to "42", "response" to "accept"),
        )
        val failure = assertIs<PhoneToolOutcome.Failure>(readOnly)
        assertEquals("denied", failure.code)
        assertEquals("这台手机只允许读取日历，不能修改。", failure.error)
    }

    @Test
    fun `an invite answer validates its arguments before the provider is asked`() {
        Shadows.shadowOf(app).grantPermissions(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)

        val noId = assertIs<PhoneToolOutcome.Failure>(
            calendar.execute(PhoneTool.RESPOND_TO_INVITE, arguments("response" to "accept")),
        )
        assertEquals("缺少 id。", noId.error)
        assertEquals("unsupported", noId.code)

        val noResponse = assertIs<PhoneToolOutcome.Failure>(
            calendar.execute(PhoneTool.RESPOND_TO_INVITE, arguments("id" to "42")),
        )
        assertEquals("缺少 response。", noResponse.error)

        val badWord = assertIs<PhoneToolOutcome.Failure>(
            calendar.execute(PhoneTool.RESPOND_TO_INVITE, arguments("id" to "42", "response" to "maybe")),
        )
        assertEquals("unsupported", badWord.code)
        assertEquals("response 需要是 accept、decline 或 tentative。", badWord.error)
    }

    @Test
    fun `each answer word writes its own attendee status on the owner's row`() {
        Shadows.shadowOf(app).grantPermissions(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)
        val provider = FakeCalendarProvider().apply {
            events[42] = FakeCalendarProvider.Event(42, "Dentist")
            ownerAccounts[1] = "me@example.com"
            // The owner's row carries the calendar owner account's email, in
            // any case; the guest row next to it must never be written.
            attendees += FakeCalendarProvider.Attendee(7, 42, "Me@Example.com")
            attendees += FakeCalendarProvider.Attendee(8, 42, "guest@example.com")
        }
        ShadowContentResolver.registerProviderInternal(CalendarContract.AUTHORITY, provider)

        val statusByWord = mapOf(
            "accept" to CalendarContract.Attendees.ATTENDEE_STATUS_ACCEPTED,
            "decline" to CalendarContract.Attendees.ATTENDEE_STATUS_DECLINED,
            "tentative" to CalendarContract.Attendees.ATTENDEE_STATUS_TENTATIVE,
        )
        for ((word, status) in statusByWord) {
            provider.writes.clear()
            val outcome = calendar.execute(
                PhoneTool.RESPOND_TO_INVITE,
                arguments("id" to "42", "response" to word),
            )
            val success = assertIs<PhoneToolOutcome.Success>(outcome)
            // The answer is the accepted word alone, the shape the computer's
            // own phone-job tests pin for this tool.
            assertEquals(setOf("response"), success.result.keys)
            assertEquals(word, success.result.getValue("response").jsonPrimitive.content)
            assertEquals(listOf(7L to status), provider.writes)
        }
    }

    @Test
    fun `an invite for an event the phone does not have is not found`() {
        Shadows.shadowOf(app).grantPermissions(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)
        val provider = FakeCalendarProvider()
        ShadowContentResolver.registerProviderInternal(CalendarContract.AUTHORITY, provider)

        val outcome = calendar.execute(
            PhoneTool.RESPOND_TO_INVITE,
            arguments("id" to "42", "response" to "accept"),
        )
        val failure = assertIs<PhoneToolOutcome.Failure>(outcome)
        assertEquals("not_found", failure.code)
        assertEquals("没有找到这个日程。", failure.error)
        assertEquals(emptyList(), provider.writes)
    }

    @Test
    fun `an event without the owner's own attendee row has no invite to answer`() {
        Shadows.shadowOf(app).grantPermissions(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)
        val provider = FakeCalendarProvider().apply {
            events[42] = FakeCalendarProvider.Event(42, "Dentist")
            ownerAccounts[1] = "me@example.com"
            attendees += FakeCalendarProvider.Attendee(8, 42, "guest@example.com")
        }
        ShadowContentResolver.registerProviderInternal(CalendarContract.AUTHORITY, provider)

        val outcome = calendar.execute(
            PhoneTool.RESPOND_TO_INVITE,
            arguments("id" to "42", "response" to "decline"),
        )
        val failure = assertIs<PhoneToolOutcome.Failure>(outcome)
        assertEquals("not_found", failure.code)
        assertEquals("这个日程里没有你的邀请记录。", failure.error)
        assertEquals(emptyList(), provider.writes)
    }

    @Test
    fun `a calendar that silently refuses the write answers denied`() {
        Shadows.shadowOf(app).grantPermissions(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)
        val provider = FakeCalendarProvider().apply {
            events[42] = FakeCalendarProvider.Event(42, "Dentist")
            ownerAccounts[1] = "me@example.com"
            attendees += FakeCalendarProvider.Attendee(7, 42, "me@example.com")
            refuseWrites = true
        }
        ShadowContentResolver.registerProviderInternal(CalendarContract.AUTHORITY, provider)

        val outcome = calendar.execute(
            PhoneTool.RESPOND_TO_INVITE,
            arguments("id" to "42", "response" to "tentative"),
        )
        val failure = assertIs<PhoneToolOutcome.Failure>(outcome)
        assertEquals("denied", failure.code)
    }

    /**
     * The slice of CalendarContract the invite answer talks to: event rows
     * with their calendar, each calendar's owner account, and the attendee
     * rows, with every status write recorded.
     */
    private class FakeCalendarProvider : ContentProvider() {
        data class Event(
            val id: Long,
            val title: String,
            val calendarId: Long = 1,
            val start: Long = 1_792_800_000_000,
            val end: Long = 1_792_803_600_000,
        )

        data class Attendee(val rowId: Long, val eventId: Long, val email: String?)

        val events = mutableMapOf<Long, Event>()
        /** Calendar id → the owner account the owner's attendee row is matched by. */
        val ownerAccounts = mutableMapOf<Long, String>()
        val attendees = mutableListOf<Attendee>()
        var refuseWrites = false
        val writes = mutableListOf<Pair<Long, Int>>()

        override fun onCreate(): Boolean = true

        override fun getType(uri: Uri): String? = null

        override fun query(
            uri: Uri,
            projection: Array<out String>?,
            selection: String?,
            selectionArgs: Array<out String>?,
            sortOrder: String?,
        ): Cursor? {
            val columns = projection ?: return null
            val cursor = MatrixCursor(columns)
            when {
                uri.path.orEmpty().startsWith("/events/") -> {
                    val event = events[uri.lastPathSegment?.toLongOrNull()] ?: return cursor
                    cursor.addRow(columns.map { column -> eventColumn(event, column) })
                }
                uri.path.orEmpty().startsWith("/calendars/") -> {
                    val owner = ownerAccounts[uri.lastPathSegment?.toLongOrNull()]
                    cursor.addRow(columns.map { column ->
                        if (column == CalendarContract.Calendars.OWNER_ACCOUNT) owner else null
                    })
                }
                uri.path == "/attendees" -> {
                    val eventId = selectionArgs?.getOrNull(0)?.toLongOrNull()
                    for (attendee in attendees.filter { it.eventId == eventId }) {
                        cursor.addRow(columns.map { column ->
                            when (column) {
                                CalendarContract.Attendees._ID -> attendee.rowId
                                CalendarContract.Attendees.ATTENDEE_EMAIL -> attendee.email
                                else -> null
                            }
                        })
                    }
                }
                else -> return null
            }
            return cursor
        }

        private fun eventColumn(event: Event, column: String): Any? = when (column) {
            CalendarContract.Events._ID -> event.id
            CalendarContract.Events.TITLE -> event.title
            CalendarContract.Events.CALENDAR_ID -> event.calendarId
            CalendarContract.Events.DTSTART -> event.start
            CalendarContract.Events.DTEND -> event.end
            CalendarContract.Events.ALL_DAY -> 0
            else -> null
        }

        override fun insert(uri: Uri, values: ContentValues?): Uri? = null

        override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

        override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int {
            if (refuseWrites) return 0
            val rowId = uri.lastPathSegment?.toLongOrNull() ?: return 0
            val status = values?.getAsInteger(CalendarContract.Attendees.ATTENDEE_STATUS) ?: return 0
            writes += rowId to status
            return 1
        }
    }
}
