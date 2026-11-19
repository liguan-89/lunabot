package com.lunabot.companion.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PhoneJobsTest {

    @Test
    fun `the registration only claims the apps this build can serve`() {
        assertEquals(
            setOf("calendar", "contacts", "reminders", "location", "messages", "phoneUi", "phoneData"),
            PhoneToolCatalog.supportedCapabilities,
        )
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
        // Coarse location is a limited grant; precise is full. The messages
        // switch reports `full` only once the runner sees both SMS grants —
        // this map is the registration's claim, not the permission check.
        assertEquals(
            mapOf("location" to "limited"),
            PhoneToolCatalog.capabilities(CalendarAccess.NONE, location = LocationAccess.COARSE),
        )
        assertEquals(
            mapOf("location" to "full"),
            PhoneToolCatalog.capabilities(CalendarAccess.NONE, location = LocationAccess.PRECISE),
        )
        assertEquals(
            mapOf("messages" to "full"),
            PhoneToolCatalog.capabilities(CalendarAccess.NONE, messages = true),
        )
    }

    @Test
    fun `an unsupported tool still knows its capability`() {
        // The executor uses this to answer `unsupported` with a sentence about
        // the app rather than "unknown tool".
        assertEquals("reminders", PhoneToolCatalog.capabilityOf("PHONE_CREATE_REMINDER"))
        assertEquals("messages", PhoneToolCatalog.capabilityOf("PHONE_SEND_MESSAGE"))
        assertEquals("messages", PhoneToolCatalog.capabilityOf("PHONE_REPLY_SMS"))
        assertEquals("messages", PhoneToolCatalog.capabilityOf("PHONE_REPLY_WECHAT"))
        assertEquals("contacts", PhoneToolCatalog.capabilityOf("PHONE_SEARCH_CONTACTS"))
        assertNull(PhoneToolCatalog.capabilityOf("PHONE_FUTURE_THING"))
    }

    @Test
    fun `phone UI wire names map to an explicitly opt in capability`() {
        assertEquals("phoneUi", PhoneToolCatalog.capabilityOf("PHONE_UI_OBSERVE"))
        assertEquals("phoneUi", PhoneToolCatalog.capabilityOf("PHONE_UI_LAUNCH"))
        assertEquals("phoneUi", PhoneToolCatalog.capabilityOf("PHONE_UI_TAP"))
        assertEquals("phoneUi", PhoneToolCatalog.capabilityOf("PHONE_UI_TYPE"))
        assertEquals("phoneUi", PhoneToolCatalog.capabilityOf("PHONE_UI_SCROLL"))
        assertEquals("phoneUi", PhoneToolCatalog.capabilityOf("PHONE_UI_BACK"))
        assertEquals(PhoneTool.UI_OBSERVE, PhoneTool.fromWire("PHONE_UI_OBSERVE"))
        assertFalse(PhoneTool.UI_OBSERVE.writes)
        assertTrue(PhoneTool.UI_TAP.writes)
        assertEquals(mapOf("phoneUi" to "full"), PhoneToolCatalog.capabilities(CalendarAccess.NONE, phoneUi = true))
        assertEquals(emptyMap(), PhoneToolCatalog.capabilities(CalendarAccess.NONE, phoneUi = false))
    }

    @Test
    fun `the query and app-list reads are phone UI tools that write nothing`() {
        assertEquals("phoneUi", PhoneToolCatalog.capabilityOf("PHONE_UI_QUERY"))
        assertEquals("phoneUi", PhoneToolCatalog.capabilityOf("PHONE_LIST_APPS"))
        assertEquals(PhoneTool.UI_QUERY, PhoneTool.fromWire("PHONE_UI_QUERY"))
        assertEquals(PhoneTool.LIST_APPS, PhoneTool.fromWire("PHONE_LIST_APPS"))
        // Both only read: the query filters a snapshot, the list reads PackageManager.
        assertFalse(PhoneTool.UI_QUERY.writes)
        assertFalse(PhoneTool.LIST_APPS.writes)
        // Find searches the same way but scrolls to do it, so it is a write on the wire.
        assertEquals("PHONE_UI_FIND", PhoneTool.UI_FIND.wire)
        assertEquals("phoneUi", PhoneTool.UI_FIND.capability)
        assertTrue(PhoneTool.UI_FIND.writes)
        assertEquals(PhoneTool.UI_FIND, PhoneTool.fromWire("PHONE_UI_FIND"))
        assertEquals("phoneUi", PhoneToolCatalog.capabilityOf("PHONE_UI_FIND"))
    }

    @Test
    fun `the run tool is one phone UI write on the wire the server sends`() {
        assertEquals("PHONE_UI_RUN", PhoneTool.UI_RUN.wire)
        assertEquals("phoneUi", PhoneTool.UI_RUN.capability)
        assertTrue(PhoneTool.UI_RUN.writes)
        assertEquals(PhoneTool.UI_RUN, PhoneTool.fromWire("PHONE_UI_RUN"))
        assertEquals("phoneUi", PhoneToolCatalog.capabilityOf("PHONE_UI_RUN"))
        // The command list travels as sent: the executor reads each step's fields itself.
        val arguments = JsonObject(
            mapOf(
                "commands" to kotlinx.serialization.json.JsonArray(
                    listOf(
                        JsonObject(mapOf("op" to JsonPrimitive("tap"), "text" to JsonPrimitive("发送"))),
                        JsonObject(mapOf("op" to JsonPrimitive("type"), "text" to JsonPrimitive("12"), "pressEnter" to JsonPrimitive(true))),
                    ),
                ),
            ),
        )
        val job = PhoneJob(id = "job-1", tool = PhoneTool.UI_RUN.wire, arguments = arguments, expiresAt = 1_760_000_000_000)
        val json = CompanionJson.encodeToJsonElement(PhoneJob.serializer(), job).jsonObject
        assertEquals("PHONE_UI_RUN", json.getValue("tool").jsonPrimitive.content)
        assertEquals(arguments, json.getValue("arguments").jsonObject)
    }

    @Test
    fun `files and notifications are their own capability, apart from the screen`() {
        assertEquals("phoneData", PhoneToolCatalog.capabilityOf("PHONE_FILE_LIST"))
        assertEquals("phoneData", PhoneToolCatalog.capabilityOf("PHONE_FILE_READ"))
        assertEquals("phoneData", PhoneToolCatalog.capabilityOf("PHONE_NOTIF_LIST"))
        assertEquals("phoneUi", PhoneToolCatalog.capabilityOf("PHONE_CLIPBOARD_GET"))
        // Sharing a file is a screen action (the compose screen must open on our display).
        assertEquals("phoneUi", PhoneToolCatalog.capabilityOf("PHONE_FILE_SHARE"))
        assertEquals(mapOf("phoneData" to "full"), PhoneToolCatalog.capabilities(CalendarAccess.NONE, phoneData = true))
        assertEquals(emptyMap(), PhoneToolCatalog.capabilities(CalendarAccess.NONE, phoneData = false))
    }

    @Test
    fun `the intent tools are phone UI writes on the wire the server sends`() {
        assertEquals("PHONE_SET_ALARM", PhoneTool.SET_ALARM.wire)
        assertEquals("PHONE_SET_TIMER", PhoneTool.SET_TIMER.wire)
        assertEquals("PHONE_OPEN_LINK", PhoneTool.OPEN_LINK.wire)
        assertEquals("PHONE_SHARE_TEXT", PhoneTool.SHARE_TEXT.wire)
        for (tool in listOf(PhoneTool.SET_ALARM, PhoneTool.SET_TIMER, PhoneTool.OPEN_LINK, PhoneTool.SHARE_TEXT)) {
            assertEquals("phoneUi", tool.capability, tool.wire)
            assertTrue(tool.writes, tool.wire)
            assertEquals(tool, PhoneTool.fromWire(tool.wire))
            assertEquals("phoneUi", PhoneToolCatalog.capabilityOf(tool.wire))
        }
        // The alarm and timer arguments travel as sent: the executor reads them itself.
        val job = PhoneJob(
            id = "job-2",
            tool = PhoneTool.SET_ALARM.wire,
            arguments = JsonObject(
                mapOf(
                    "hour" to JsonPrimitive(7),
                    "minute" to JsonPrimitive(30),
                    "days" to kotlinx.serialization.json.JsonArray(listOf(JsonPrimitive("MON"))),
                ),
            ),
            expiresAt = 1_760_000_000_000,
        )
        val json = CompanionJson.encodeToJsonElement(PhoneJob.serializer(), job).jsonObject
        assertEquals("PHONE_SET_ALARM", json.getValue("tool").jsonPrimitive.content)
        assertEquals(job.arguments, json.getValue("arguments").jsonObject)
    }

    @Test
    fun `the after-task choice is a phone UI write on the wire the server sends`() {
        assertEquals("PHONE_UI_AFTER_TASK", PhoneTool.UI_AFTER_TASK.wire)
        assertEquals("phoneUi", PhoneTool.UI_AFTER_TASK.capability)
        assertTrue(PhoneTool.UI_AFTER_TASK.writes)
        assertEquals(PhoneTool.UI_AFTER_TASK, PhoneTool.fromWire("PHONE_UI_AFTER_TASK"))
        assertEquals("phoneUi", PhoneToolCatalog.capabilityOf("PHONE_UI_AFTER_TASK"))
        // The choice and the optional package travel as sent: the executor reads them itself.
        val arguments = JsonObject(
            mapOf("action" to JsonPrimitive("close"), "app" to JsonPrimitive("com.tencent.mm")),
        )
        val job = PhoneJob(id = "job-3", tool = PhoneTool.UI_AFTER_TASK.wire, arguments = arguments, expiresAt = 1_760_000_000_000)
        val json = CompanionJson.encodeToJsonElement(PhoneJob.serializer(), job).jsonObject
        assertEquals("PHONE_UI_AFTER_TASK", json.getValue("tool").jsonPrimitive.content)
        assertEquals(arguments, json.getValue("arguments").jsonObject)
    }

    @Test
    fun `the collect tool is one phone UI write on the wire the server sends`() {
        assertEquals("PHONE_UI_COLLECT", PhoneTool.UI_COLLECT.wire)
        assertEquals("phoneUi", PhoneTool.UI_COLLECT.capability)
        // It scrolls the screen between reads, so it is a write, unlike observe.
        assertTrue(PhoneTool.UI_COLLECT.writes)
        assertFalse(PhoneTool.UI_OBSERVE.writes)
        assertEquals(PhoneTool.UI_COLLECT, PhoneTool.fromWire("PHONE_UI_COLLECT"))
        assertEquals("phoneUi", PhoneToolCatalog.capabilityOf("PHONE_UI_COLLECT"))
        // The call travels as sent: the executor reads its fields itself.
        val arguments = JsonObject(
            mapOf(
                "direction" to JsonPrimitive("down"),
                "pages" to JsonPrimitive(3),
                "maxLines" to JsonPrimitive(120),
            ),
        )
        val job = PhoneJob(id = "job-4", tool = PhoneTool.UI_COLLECT.wire, arguments = arguments, expiresAt = 1_760_000_000_000)
        val json = CompanionJson.encodeToJsonElement(PhoneJob.serializer(), job).jsonObject
        assertEquals("PHONE_UI_COLLECT", json.getValue("tool").jsonPrimitive.content)
        assertEquals(arguments, json.getValue("arguments").jsonObject)
    }

    @Test
    fun `only the implemented phone apps are in the catalog`() {
        assertEquals(49, PhoneTool.entries.size)
        assertTrue(
            PhoneTool.entries.all {
                it.capability in setOf("calendar", "contacts", "reminders", "location", "messages", "phoneUi", "phoneData")
            },
        )
        assertEquals(PhoneTool.CREATE_EVENT, PhoneTool.fromWire("PHONE_CREATE_EVENT"))
        assertEquals(PhoneTool.UPDATE_CONTACT, PhoneTool.fromWire("PHONE_UPDATE_CONTACT"))
        assertEquals(PhoneTool.COMPLETE_REMINDER, PhoneTool.fromWire("PHONE_COMPLETE_REMINDER"))
        assertEquals(PhoneTool.GET_LOCATION, PhoneTool.fromWire("PHONE_GET_LOCATION"))
        assertEquals(PhoneTool.SEND_MESSAGE, PhoneTool.fromWire("PHONE_SEND_MESSAGE"))
        assertEquals(PhoneTool.SEND_WHATSAPP, PhoneTool.fromWire("PHONE_SEND_WHATSAPP"))
        assertEquals(PhoneTool.REPLY_SMS, PhoneTool.fromWire("PHONE_REPLY_SMS"))
        assertEquals(PhoneTool.REPLY_WECHAT, PhoneTool.fromWire("PHONE_REPLY_WECHAT"))
        // Home and nearby places need a vendor SDK this build does not carry.
        assertNull(PhoneTool.fromWire("PHONE_RUN_SCENE"))
    }

    @Test
    fun `the WeChat reply is a messages write beside the SMS one`() {
        assertEquals("PHONE_REPLY_WECHAT", PhoneTool.REPLY_WECHAT.wire)
        assertEquals("messages", PhoneTool.REPLY_WECHAT.capability)
        assertTrue(PhoneTool.REPLY_WECHAT.writes)
        // It rides the messages capability the SMS relay already registers, so
        // a phone with the switch on claims it without a second grant.
        assertTrue(PhoneTool.REPLY_WECHAT.capability in PhoneToolCatalog.supportedCapabilities)
    }

    @Test
    fun `a WeChat text event has exactly the SMS shape plus its kind`() {
        val event = PhoneSmsEvent(kind = "wechat", sendId = "msg-2", from = "wxid_owner", text = "在吗")
        val json = CompanionJson.encodeToJsonElement(PhoneSmsEvent.serializer(), event).jsonObject
        // No `group` and no `images`: the runtime only forwards private text
        // and image messages, and the encoder drops empty collections.
        assertEquals(setOf("kind", "sendId", "from", "text"), json.keys)
        assertEquals("wechat", json.getValue("kind").jsonPrimitive.content)
        assertEquals("wxid_owner", json.getValue("from").jsonPrimitive.content)
    }

    @Test
    fun `an event with images lists them as base64 payloads`() {
        val event = PhoneSmsEvent(
            kind = "wechat",
            sendId = "msg-3",
            from = "wxid_owner",
            text = "",
            images = listOf(PhoneEventImage(mime = "image/jpeg", name = "wechat-1.jpg", data = "aGVsbG8=")),
        )
        val json = CompanionJson.encodeToJsonElement(PhoneSmsEvent.serializer(), event).jsonObject
        val images = json.getValue("images").jsonArray
        assertEquals(1, images.size)
        val image = images.single().jsonObject
        assertEquals("image/jpeg", image.getValue("mime").jsonPrimitive.content)
        assertEquals("wechat-1.jpg", image.getValue("name").jsonPrimitive.content)
        assertEquals("aGVsbG8=", image.getValue("data").jsonPrimitive.content)
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

    @Test
    fun `an inbound text serializes as exactly the event the server accepts`() {
        val event = PhoneSmsEvent(sendId = "+8613800138000:1730000000000", from = "+8613800138000", text = "在吗")
        val json = CompanionJson.encodeToJsonElement(PhoneSmsEvent.serializer(), event).jsonObject
        assertEquals(setOf("kind", "sendId", "from", "text"), json.keys)
        assertEquals("sms", json.getValue("kind").jsonPrimitive.content)
        assertEquals("+8613800138000:1730000000000", json.getValue("sendId").jsonPrimitive.content)
        assertEquals("在吗", json.getValue("text").jsonPrimitive.content)
    }
}
