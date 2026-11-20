/*
 * Pins the pure half of the four intent tools: what the argument object is
 * parsed into, which extra the intent carries, and which inputs are refused.
 * No Android runtime and no launch: the request types and the intent builders
 * are plain functions over data.
 */
package com.lunabot.companion.phoneui

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Robolectric only for `Intent`: the extras are the assertion here, and no
 * activity is started and no package is resolved.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PhoneUiSystemActionsTest {

    private fun args(vararg fields: Pair<String, Any?>): JsonObject = buildJsonObject {
        for ((key, value) in fields) {
            when (value) {
                null -> put(key, JsonNull)
                is String -> put(key, value)
                is Int -> put(key, value)
                is Boolean -> put(key, value)
                is List<*> -> put(key, JsonArray(value.map { JsonPrimitive(it as String) }))
                else -> error("unsupported test value for $key")
            }
        }
    }

    private fun refused(parsed: PhoneUiSystemActions.Parsed<*>): String {
        assertTrue(parsed is PhoneUiSystemActions.Parsed.Refused, "expected a refusal, got $parsed")
        return (parsed as PhoneUiSystemActions.Parsed.Refused).message
    }

    private fun <T> ready(parsed: PhoneUiSystemActions.Parsed<T>): T {
        assertTrue(parsed is PhoneUiSystemActions.Parsed.Ready, "expected a request, got $parsed")
        return (parsed as PhoneUiSystemActions.Parsed.Ready).request
    }

    @Test
    fun `an alarm needs a valid hour and minute`() {
        assertEquals(PhoneUiSystemActions.AlarmRequest(7, 30), ready(PhoneUiSystemActions.parseAlarm(args("hour" to 7, "minute" to 30))))
        assertTrue(refused(PhoneUiSystemActions.parseAlarm(args("minute" to 30))).contains("hour"))
        assertTrue(refused(PhoneUiSystemActions.parseAlarm(args("hour" to 7))).contains("minute"))
        assertTrue(refused(PhoneUiSystemActions.parseAlarm(args("hour" to 24, "minute" to 0))).contains("hour"))
        assertTrue(refused(PhoneUiSystemActions.parseAlarm(args("hour" to -1, "minute" to 0))).contains("hour"))
        assertTrue(refused(PhoneUiSystemActions.parseAlarm(args("hour" to 7, "minute" to 60))).contains("minute"))
        // The bounds are the whole clock, so 23:59 and 00:00 are fine.
        assertEquals(23, ready(PhoneUiSystemActions.parseAlarm(args("hour" to 23, "minute" to 59))).hour)
        assertEquals(0, ready(PhoneUiSystemActions.parseAlarm(args("hour" to 0, "minute" to 0))).minute)
    }

    @Test
    fun `a one-time alarm omits the day extra and a repeating one carries Calendar constants`() {
        val oneTime = PhoneUiSystemActions.alarmIntent(
            ready(PhoneUiSystemActions.parseAlarm(args("hour" to 6, "minute" to 15, "label" to "Run"))),
        )
        assertEquals("android.intent.action.SET_ALARM", oneTime.action)
        assertEquals(6, oneTime.getIntExtra("android.intent.extra.alarm.HOUR", -1))
        assertEquals(15, oneTime.getIntExtra("android.intent.extra.alarm.MINUTES", -1))
        assertEquals("Run", oneTime.getStringExtra("android.intent.extra.alarm.MESSAGE"))
        assertTrue(oneTime.getBooleanExtra("android.intent.extra.alarm.SKIP_UI", false))
        // No days asked for: the alarm is one-time, so EXTRA_DAYS is absent rather than empty.
        assertFalse(oneTime.hasExtra("android.intent.extra.alarm.DAYS"))
        assertFalse(oneTime.hasExtra("android.intent.extra.alarm.VIBRATE"))

        val repeating = PhoneUiSystemActions.alarmIntent(
            ready(
                PhoneUiSystemActions.parseAlarm(
                    args("hour" to 6, "minute" to 15, "days" to listOf("MON", "WED", "SUN"), "vibrate" to false),
                ),
            ),
        )
        // SUNDAY=1 … SATURDAY=7: Monday 2, Wednesday 4, Sunday 1.
        assertEquals(
            listOf(2, 4, 1),
            repeating.getIntegerArrayListExtra("android.intent.extra.alarm.DAYS")?.toList(),
        )
        // An explicit false is carried as false, not left to the Clock app's own setting.
        assertTrue(repeating.hasExtra("android.intent.extra.alarm.VIBRATE"))
        assertFalse(repeating.getBooleanExtra("android.intent.extra.alarm.VIBRATE", true))
    }

    @Test
    fun `days are the seven three letter names and nothing else`() {
        assertEquals(
            listOf(2, 3, 4, 5, 6, 7, 1),
            PhoneUiSystemActions.dayConstants(listOf("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN")),
        )
        // Case does not matter, and the parsed day is the wire name again.
        assertEquals(listOf("MON"), ready(PhoneUiSystemActions.parseAlarm(args("hour" to 1, "minute" to 2, "days" to listOf("mon")))).days)
        // An empty list is no repeat days either: still a one-time alarm.
        assertNull(ready(PhoneUiSystemActions.parseAlarm(args("hour" to 1, "minute" to 2, "days" to emptyList<String>()))).days)
        assertTrue(refused(PhoneUiSystemActions.parseAlarm(args("hour" to 1, "minute" to 2, "days" to listOf("MONDAY")))).contains("days"))
        assertTrue(refused(PhoneUiSystemActions.parseAlarm(args("hour" to 1, "minute" to 2, "days" to listOf("MON", "FUN")))).contains("days"))
        assertTrue(
            refused(
                PhoneUiSystemActions.parseAlarm(
                    args("hour" to 1, "minute" to 2, "days" to List(8) { "MON" }),
                ),
            ).contains("days"),
        )
    }

    @Test
    fun `a timer carries its length in seconds and skips the editor`() {
        val request = ready(PhoneUiSystemActions.parseTimer(args("seconds" to 90, "label" to "Tea")))
        assertEquals(PhoneUiSystemActions.TimerRequest(90, "Tea"), request)
        val intent = PhoneUiSystemActions.timerIntent(request)
        assertEquals("android.intent.action.SET_TIMER", intent.action)
        assertEquals(90, intent.getIntExtra("android.intent.extra.alarm.LENGTH", -1))
        assertEquals("Tea", intent.getStringExtra("android.intent.extra.alarm.MESSAGE"))
        assertTrue(intent.getBooleanExtra("android.intent.extra.alarm.SKIP_UI", false))
        // One second and a day are both inside the advertised range.
        assertEquals(1, ready(PhoneUiSystemActions.parseTimer(args("seconds" to 1))).seconds)
        assertEquals(86_400, ready(PhoneUiSystemActions.parseTimer(args("seconds" to 86_400))).seconds)
        assertTrue(refused(PhoneUiSystemActions.parseTimer(args())).contains("seconds"))
        assertTrue(refused(PhoneUiSystemActions.parseTimer(args("seconds" to 0))).contains("seconds"))
        assertTrue(refused(PhoneUiSystemActions.parseTimer(args("seconds" to 86_401))).contains("seconds"))
    }

    @Test
    fun `a link has to be http or https, never a file or another app's scheme`() {
        assertEquals("https", PhoneUiSystemActions.schemeOf("https://example.com/a"))
        assertEquals("http", PhoneUiSystemActions.schemeOf("  HTTP://example.com"))
        assertNull(PhoneUiSystemActions.schemeOf("example.com"))
        assertEquals(
            PhoneUiSystemActions.LinkRequest("https://example.com/a?b=c", null),
            ready(PhoneUiSystemActions.parseLink(args("url" to "https://example.com/a?b=c"))),
        )
        for (url in listOf("file:///sdcard/a.txt", "intent://scan/#Intent;end", "javascript:alert(1)", "market://details?id=x")) {
            assertTrue(refused(PhoneUiSystemActions.parseLink(args("url" to url))).isNotEmpty(), url)
        }
        // No scheme at all is its own refusal, so the model knows what to fix.
        assertTrue(refused(PhoneUiSystemActions.parseLink(args("url" to "example.com"))).contains("http"))
        assertTrue(refused(PhoneUiSystemActions.parseLink(args())).contains("url"))
        assertTrue(refused(PhoneUiSystemActions.parseLink(args("url" to "https://example.com", "app" to "not a package"))).isNotEmpty())
    }

    @Test
    fun `a link opens the url and only sets a package when one was named`() {
        val browser = PhoneUiSystemActions.linkIntent(PhoneUiSystemActions.LinkRequest("https://example.com"))
        assertEquals("android.intent.action.VIEW", browser.action)
        assertEquals("https://example.com", browser.data?.toString())
        assertNull(browser.`package`)

        val inApp = PhoneUiSystemActions.linkIntent(PhoneUiSystemActions.LinkRequest("https://example.com", "com.tencent.mm"))
        assertEquals("com.tencent.mm", inApp.`package`)
    }

    @Test
    fun `shared text keeps its own whitespace and goes as text plain`() {
        // A draft may start with a space; only an empty string is refused.
        assertEquals(
            PhoneUiSystemActions.ShareRequest("  ship it  ", null),
            ready(PhoneUiSystemActions.parseShare(args("text" to "  ship it  "))),
        )
        val intent = PhoneUiSystemActions.shareIntent(PhoneUiSystemActions.ShareRequest("见字如面"))
        assertEquals("android.intent.action.SEND", intent.action)
        assertEquals("text/plain", intent.type)
        assertEquals("见字如面", intent.getStringExtra("android.intent.extra.TEXT"))
        assertNull(intent.`package`)
        assertEquals(
            "com.tencent.mm",
            PhoneUiSystemActions.shareIntent(PhoneUiSystemActions.ShareRequest("hi", "com.tencent.mm")).`package`,
        )
        assertTrue(refused(PhoneUiSystemActions.parseShare(args())).contains("text"))
        assertTrue(refused(PhoneUiSystemActions.parseShare(args("text" to ""))).contains("text"))
        assertTrue(refused(PhoneUiSystemActions.parseShare(args("text" to "a".repeat(5_001)))).contains("text"))
        // Whitespace alone is not text to send.
        assertTrue(refused(PhoneUiSystemActions.parseShare(args("text" to "   "))).contains("text"))
    }

    @Test
    fun `a label over the schema bound is refused before any intent is built`() {
        val long = "x".repeat(201)
        assertTrue(refused(PhoneUiSystemActions.parseAlarm(args("hour" to 7, "minute" to 0, "label" to long))).contains("label"))
        assertTrue(refused(PhoneUiSystemActions.parseTimer(args("seconds" to 60, "label" to long))).contains("label"))
        // At the bound it is fine.
        assertEquals(200, ready(PhoneUiSystemActions.parseTimer(args("seconds" to 60, "label" to "x".repeat(200)))).label?.length)
    }
}
