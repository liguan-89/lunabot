/*
 * Pins the phone-UI slice's input rules and output budgets: only
 * PackageManager-shaped package names are injectable, text leaving the phone
 * is clamped and control-character-stripped, and the snapshot budget bounds
 * an element payload the way the JSON will.
 */
package com.openmausbot.companion.phoneui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PhoneUiRulesTest {
    @Test
    fun `ordinary application ids pass`() {
        for (name in listOf(
            "com.example.app",
            "org.wikipedia",
            "com.openmausbot.companion",
            "a.b",
            "com.ex_ample.app2",
        )) {
            assertTrue(PhoneUiRules.isValidPackageName(name), "name $name must pass")
        }
    }

    @Test
    fun `anything that could carry more than a package name is refused`() {
        for (name in listOf(
            null,
            "",
            "com",
            "com.",
            ".com.example",
            "com..example",
            "com.exa mple",
            "com.example;rm",
            "com/example",
            "com.example\napp",
            "com.example\tapp",
            "com.例子.app",
            "1com.example",
            "com.1example",
            "com.-example",
            "com.example--x.app",
            "com." + "a".repeat(256),
        )) {
            assertFalse(PhoneUiRules.isValidPackageName(name), "name $name must be refused")
        }
    }

    @Test
    fun `display sizes fall back on garbage and clamp on extremes`() {
        assertEquals(720, PhoneUiRules.clampedInt(null, 720, 200, 2560))
        assertEquals(720, PhoneUiRules.clampedInt("abc", 720, 200, 2560))
        assertEquals(720, PhoneUiRules.clampedInt("  ", 720, 200, 2560))
        assertEquals(1080, PhoneUiRules.clampedInt("1080", 720, 200, 2560))
        assertEquals(2560, PhoneUiRules.clampedInt("99999", 720, 200, 2560))
        assertEquals(200, PhoneUiRules.clampedInt("1", 720, 200, 2560))
        assertEquals(200, PhoneUiRules.clampedInt("-50", 720, 200, 2560))
    }

    @Test
    fun `text is cut at the per-node limit`() {
        val long = "x".repeat(PhoneUiRules.MAX_TEXT_PER_NODE + 500)
        assertEquals(PhoneUiRules.MAX_TEXT_PER_NODE, PhoneUiRules.clampText(long)?.length)
        assertEquals("abc", PhoneUiRules.clampText("abc"))
        assertNull(PhoneUiRules.clampText(null))
        assertNull(PhoneUiRules.clampText(""))
    }

    @Test
    fun `control characters never leave the phone`() {
        assertEquals("a b", PhoneUiRules.clampText("a\u0000b"))
        assertEquals("a b", PhoneUiRules.clampText("a\u0007b"))
        assertEquals("a b", PhoneUiRules.clampText("a\u000bb"))
        assertEquals("a\tb", PhoneUiRules.clampText("a\tb"))
        assertEquals("a\nb", PhoneUiRules.clampText("a\nb"))
        assertEquals("a b", PhoneUiRules.clampText("a\u007Fb"))
    }

    @Test
    fun `result counts default when absent and stay inside the tool's band`() {
        assertEquals(
            PhoneUiRules.DEFAULT_QUERY_LIMIT,
            PhoneUiRules.clampedLimit(null, PhoneUiRules.DEFAULT_QUERY_LIMIT, PhoneUiRules.MAX_QUERY_LIMIT),
        )
        assertEquals(5, PhoneUiRules.clampedLimit(5, PhoneUiRules.DEFAULT_QUERY_LIMIT, PhoneUiRules.MAX_QUERY_LIMIT))
        assertEquals(
            PhoneUiRules.MAX_QUERY_LIMIT,
            PhoneUiRules.clampedLimit(10_000, PhoneUiRules.DEFAULT_QUERY_LIMIT, PhoneUiRules.MAX_QUERY_LIMIT),
        )
        assertEquals(1, PhoneUiRules.clampedLimit(0, PhoneUiRules.DEFAULT_QUERY_LIMIT, PhoneUiRules.MAX_QUERY_LIMIT))
        assertEquals(1, PhoneUiRules.clampedLimit(-3, PhoneUiRules.DEFAULT_APP_LIMIT, PhoneUiRules.MAX_APP_LIMIT))
    }

    @Test
    fun `the snapshot budget stops before it overruns`() {
        assertTrue(PhoneUiRules.budgetHasRoom(0, PhoneUiRules.MAX_TOTAL_TEXT_CHARS))
        assertFalse(PhoneUiRules.budgetHasRoom(1, PhoneUiRules.MAX_TOTAL_TEXT_CHARS))
        assertFalse(PhoneUiRules.budgetHasRoom(PhoneUiRules.MAX_TOTAL_TEXT_CHARS - 9, 10))
        assertTrue(PhoneUiRules.budgetHasRoom(PhoneUiRules.MAX_TOTAL_TEXT_CHARS - 10, 10))
    }

    @Test
    fun `the per-element payload estimate covers its own JSON overhead`() {
        assertEquals(
            "hello".length + "com.example:id/save".length + PhoneUiRules.REF_OVERHEAD_CHARS,
            PhoneUiRules.elementPayloadChars("hello", null, "com.example:id/save", null),
        )
        // The fixed overhead must cover a minimal elementJson: a 24-char ref,
        // the field names, and four bounds numbers.
        assertTrue(
            PhoneUiRules.REF_OVERHEAD_CHARS >= 24 + 24 + 16,
            "fixed overhead ${PhoneUiRules.REF_OVERHEAD_CHARS} must exceed the JSON skeleton",
        )
    }
}
