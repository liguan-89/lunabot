package com.openmausbot.companion.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PhoneJobsTest {

    @Test
    fun `the registration only claims the apps this build can serve`() {
        assertEquals(setOf("calendar", "contacts", "reminders"), PhoneToolCatalog.supportedCapabilities)
        assertEquals(
            emptyMap(),
            PhoneToolCatalog.capabilities(CalendarAccess.NONE),
        )
        assertEquals(
            mapOf("calendar" to "limited"),
            PhoneToolCatalog.capabilities(CalendarAccess.READ),
        )
        assertEquals(
            mapOf("calendar" to "full"),
            PhoneToolCatalog.capabilities(CalendarAccess.READ_WRITE),
        )
        assertEquals(
            mapOf("calendar" to "full", "contacts" to "limited"),
            PhoneToolCatalog.capabilities(CalendarAccess.READ_WRITE, ContactsAccess.READ),
        )
        assertEquals(
            mapOf("contacts" to "full", "reminders" to "full"),
            PhoneToolCatalog.capabilities(CalendarAccess.NONE, ContactsAccess.READ_WRITE, reminders = true),
        )
    }

    @Test
    fun `an unsupported tool still knows its capability`() {
        // The executor uses this to answer `unsupported` with a sentence about
        // the app rather than "unknown tool".
        assertEquals("reminders", PhoneToolCatalog.capabilityOf("PHONE_CREATE_REMINDER"))
        assertEquals("messages", PhoneToolCatalog.capabilityOf("PHONE_SEND_MESSAGE"))
        assertEquals("contacts", PhoneToolCatalog.capabilityOf("PHONE_SEARCH_CONTACTS"))
        assertNull(PhoneToolCatalog.capabilityOf("PHONE_FUTURE_THING"))
    }

    @Test
    fun `only the calendar, contacts and reminders tools are implemented`() {
        assertEquals(15, PhoneTool.entries.size)
        assertTrue(PhoneTool.entries.all { it.capability in setOf("calendar", "contacts", "reminders") })
        assertEquals(PhoneTool.CREATE_EVENT, PhoneTool.fromWire("PHONE_CREATE_EVENT"))
        assertEquals(PhoneTool.UPDATE_CONTACT, PhoneTool.fromWire("PHONE_UPDATE_CONTACT"))
        assertEquals(PhoneTool.COMPLETE_REMINDER, PhoneTool.fromWire("PHONE_COMPLETE_REMINDER"))
        assertNull(PhoneTool.fromWire("PHONE_SEND_MESSAGE"))
    }

    @Test
    fun `the reminder filter separates the two buckets and honours a due range`() {
        val day = 24 * 60 * 60 * 1000L
        // Completed is its own list, not an extra flag on the open one.
        assertTrue(PhoneReminderRules.matches(day, null, null, completed = false, wantCompleted = false))
        assertFalse(PhoneReminderRules.matches(day, null, null, completed = true, wantCompleted = false))
        assertTrue(PhoneReminderRules.matches(day, null, null, completed = true, wantCompleted = true))

        // A range only matches reminders that have a due time inside it.
        assertTrue(
            PhoneReminderRules.matches(2 * day, day, 3 * day, completed = false, wantCompleted = null),
        )
        assertFalse(
            PhoneReminderRules.matches(4 * day, day, 3 * day, completed = false, wantCompleted = null),
        )
        assertFalse(
            PhoneReminderRules.matches(null, day, 3 * day, completed = false, wantCompleted = null),
        )
        // With no range at all, an undated reminder is still on the list.
        assertTrue(
            PhoneReminderRules.matches(null, null, null, completed = false, wantCompleted = null),
        )
    }

    @Test
    fun `times need an offset, not a guess about the phone's zone`() {
        val instant = PhoneCalendarRules.parseInstant("2026-10-24T12:00:00+05:30")
        assertEquals(1792823400000L, instant)
        assertNull(PhoneCalendarRules.parseInstant("2026-10-24T12:00:00"))
        assertNull(PhoneCalendarRules.parseInstant("tomorrow"))
        assertNull(PhoneCalendarRules.parseInstant(null))
        assertNull(PhoneCalendarRules.parseInstant("x".repeat(65)))
    }

    @Test
    fun `a window has to move forward and fit in a year`() {
        val from = "2026-10-24T00:00:00+05:30"
        val to = "2026-10-25T00:00:00+05:30"
        assertEquals(24 * 60 * 60 * 1000L, PhoneCalendarRules.parseWindow(from, to)!!.let { it.second - it.first })
        assertNull(PhoneCalendarRules.parseWindow(to, from), "backwards is refused")
        assertNull(PhoneCalendarRules.parseWindow(from, from), "an empty window is refused")
        assertNull(
            PhoneCalendarRules.parseWindow("2026-01-01T00:00:00Z", "2027-06-01T00:00:00Z"),
            "more than a year is refused",
        )
    }

    @Test
    fun `gaps merge overlaps and drop the ones too short`() {
        val hour = 60 * 60 * 1000L
        val from = 10 * hour
        val to = 20 * hour
        val busy = listOf(
            12 * hour to 13 * hour,
            12 * hour + 30 * 60 * 1000 to 14 * hour, // overlaps the first
            16 * hour to 17 * hour,
            1 * hour to 2 * hour, // before the window
        )

        assertEquals(
            listOf(
                10 * hour to 12 * hour, // two hours at the start
                14 * hour to 16 * hour,
                17 * hour to 20 * hour,
            ),
            PhoneCalendarRules.gaps(busy, from, to, minutes = 60),
        )

        // A three-hour floor leaves only the three-hour gap.
        assertEquals(
            listOf(17 * hour to 20 * hour),
            PhoneCalendarRules.gaps(busy, from, to, minutes = 121),
        )
        assertTrue(PhoneCalendarRules.gaps(emptyList(), from, to, 1).isNotEmpty())
    }

    @Test
    fun `event fields carry only what arrived, with allDay as a boolean`() {
        val fields = PhoneCalendarRules.eventFields(
            JsonObject(
                mapOf(
                    "title" to JsonPrimitive("Lunch"),
                    "allDay" to JsonPrimitive(false),
                    "attendees" to JsonPrimitive("ignored"),
                ),
            ),
        )
        assertEquals(mapOf("title" to "Lunch", "allDay" to false), fields)
    }
}
