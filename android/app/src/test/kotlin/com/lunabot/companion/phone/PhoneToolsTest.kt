package com.lunabot.companion.phone

import android.Manifest
import android.app.Application
import android.content.Context
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
}
