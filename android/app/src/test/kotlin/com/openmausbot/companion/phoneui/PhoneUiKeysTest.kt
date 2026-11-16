/*
 * Pins the key whitelist and the text typing rule: only navigation keys, and
 * only printable ASCII can be typed through key events.
 */
package com.openmausbot.companion.phoneui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PhoneUiKeysTest {
    @Test
    fun `names map to their android key codes`() {
        assertEquals(4, PhoneUiKeys.codeOf("back"))
        assertEquals(4, PhoneUiKeys.codeOf(" BACK "))
        assertEquals(66, PhoneUiKeys.codeOf("enter"))
        assertEquals(67, PhoneUiKeys.codeOf("del"))
        assertEquals(67, PhoneUiKeys.codeOf("delete"))
        assertEquals(61, PhoneUiKeys.codeOf("tab"))
        assertEquals(19, PhoneUiKeys.codeOf("up"))
        assertEquals(22, PhoneUiKeys.codeOf("right"))
        assertNull(PhoneUiKeys.codeOf("home"))
        assertNull(PhoneUiKeys.codeOf("recents"))
        assertNull(PhoneUiKeys.codeOf(null))
        assertNull(PhoneUiKeys.codeOf(""))
    }

    @Test
    fun `the allowed set is exactly the mapped keys`() {
        assertEquals(setOf(4, 66, 67, 61, 19, 20, 21, 22), PhoneUiKeys.allowed)
        assertFalse(3 in PhoneUiKeys.allowed, "home must stay out of the whitelist")
        assertFalse(187 in PhoneUiKeys.allowed, "recents must stay out of the whitelist")
    }

    @Test
    fun `only printable ascii is typeable`() {
        assertTrue(PhoneUiKeys.typeableText("hello world 123"))
        assertTrue(PhoneUiKeys.typeableText("a"))
        assertFalse(PhoneUiKeys.typeableText(""))
        assertFalse(PhoneUiKeys.typeableText("你好"))
        assertFalse(PhoneUiKeys.typeableText("café"))
        assertFalse(PhoneUiKeys.typeableText("line\nbreak"))
        assertFalse(PhoneUiKeys.typeableText("tab\there"))
        assertFalse(PhoneUiKeys.typeableText("x".repeat(257)))
    }
}