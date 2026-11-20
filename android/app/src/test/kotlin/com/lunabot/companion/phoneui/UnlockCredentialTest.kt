// Adapted from Mika's DeviceUnlockInput and DeviceAccess (Apache-2.0).
package com.lunabot.companion.phoneui

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The credential shape is the first gate on the unlock path: a PIN of 4-16
 * digits or a password of 4-64 printable ASCII, and nothing else. These are
 * Mika's `DeviceCredential.valid` rules, and the helper's `enter` refuses on the
 * same predicate, so a value that gets past the store is a value the helper will
 * type.
 */
class UnlockCredentialTest {
    private fun chars(text: String) = text.toCharArray()

    @Test
    fun `a pin is four to sixteen digits`() {
        assertTrue(UnlockCredential.valid(UnlockCredential.KIND_PIN, chars("1234")))
        assertTrue(UnlockCredential.valid(UnlockCredential.KIND_PIN, chars("1234567890123456")))
        assertFalse(UnlockCredential.valid(UnlockCredential.KIND_PIN, chars("123")))
        assertFalse(UnlockCredential.valid(UnlockCredential.KIND_PIN, chars("12345678901234567")))
        assertFalse(UnlockCredential.valid(UnlockCredential.KIND_PIN, chars("12a4")))
        assertFalse(UnlockCredential.valid(UnlockCredential.KIND_PIN, chars("12 4")))
        assertFalse(UnlockCredential.valid(UnlockCredential.KIND_PIN, chars("")))
    }

    @Test
    fun `a password is four to sixty-four printable ascii characters`() {
        assertTrue(UnlockCredential.valid(UnlockCredential.KIND_PASSWORD, chars("abcd")))
        assertTrue(UnlockCredential.valid(UnlockCredential.KIND_PASSWORD, chars("a b~!")))
        assertTrue(UnlockCredential.valid(UnlockCredential.KIND_PASSWORD, chars("x".repeat(64))))
        assertFalse(UnlockCredential.valid(UnlockCredential.KIND_PASSWORD, chars("abc")))
        assertFalse(UnlockCredential.valid(UnlockCredential.KIND_PASSWORD, chars("x".repeat(65))))
        // Whitespace-only is a shape that would type four spaces and submit.
        assertFalse(UnlockCredential.valid(UnlockCredential.KIND_PASSWORD, chars("    ")))
        assertFalse(UnlockCredential.valid(UnlockCredential.KIND_PASSWORD, chars("ab\tc")))
        assertFalse(UnlockCredential.valid(UnlockCredential.KIND_PASSWORD, chars("密码密码")))
        assertFalse(UnlockCredential.valid(UnlockCredential.KIND_PASSWORD, chars("ab\u007fc")))
    }

    @Test
    fun `an unknown kind is never valid`() {
        assertFalse(UnlockCredential.valid(-1, chars("1234")))
        assertFalse(UnlockCredential.valid(2, chars("1234")))
        assertFalse(UnlockCredential.validBytes(7, byteArrayOf(49, 50, 51, 52)))
    }

    @Test
    fun `the wire bytes obey the same rules`() {
        assertTrue(UnlockCredential.validBytes(UnlockCredential.KIND_PIN, "1234".toByteArray()))
        assertTrue(UnlockCredential.validBytes(UnlockCredential.KIND_PASSWORD, "pass word".toByteArray()))
        assertFalse(UnlockCredential.validBytes(UnlockCredential.KIND_PIN, "12a4".toByteArray()))
        assertFalse(UnlockCredential.validBytes(UnlockCredential.KIND_PIN, "123".toByteArray()))
        assertFalse(UnlockCredential.validBytes(UnlockCredential.KIND_PIN, "1".repeat(17).toByteArray()))
        // A byte outside printable ASCII is refused even where the character
        // would have been in range: the helper never builds a key for it.
        assertFalse(UnlockCredential.validBytes(UnlockCredential.KIND_PASSWORD, byteArrayOf(97, 98, 99, 0x7f)))
        assertFalse(UnlockCredential.validBytes(UnlockCredential.KIND_PASSWORD, byteArrayOf(97, 98, 99, 0x09)))
        assertFalse(UnlockCredential.validBytes(UnlockCredential.KIND_PASSWORD, ByteArray(0)))
    }
}
