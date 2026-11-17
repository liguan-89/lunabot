// Adapted from Mika's DeviceUnlockInput and DeviceAccess (Apache-2.0).
package com.openmausbot.companion.phoneui

/**
 * The device-credential shapes both sides of the unlock path agree on, kept
 * free of Android imports so they can be tested on the JVM.
 *
 * The wire kind is the int the helper receives: 0 is a PIN, 1 a password. A PIN
 * is 4-16 ASCII digits; a password is 4-64 printable ASCII (0x20-0x7e) and not
 * all spaces — a value of four spaces is a typo, not a credential, and it would
 * be typed and submitted like any other. Anything else is refused before a
 * single key event is built.
 */
object UnlockCredential {
    const val KIND_PIN = 0
    const val KIND_PASSWORD = 1

    const val MIN_PIN_DIGITS = 4
    const val MAX_PIN_DIGITS = 16
    const val MIN_PASSWORD_CHARS = 4
    const val MAX_PASSWORD_CHARS = 64

    fun kindOf(kind: Int): Boolean = kind == KIND_PIN || kind == KIND_PASSWORD

    fun validPin(chars: CharArray): Boolean =
        chars.size in MIN_PIN_DIGITS..MAX_PIN_DIGITS && chars.all { it in '0'..'9' }

    fun validPassword(chars: CharArray): Boolean =
        chars.size in MIN_PASSWORD_CHARS..MAX_PASSWORD_CHARS && chars.all { it in ' '..'~' } &&
            chars.any { it != ' ' }

    fun valid(kind: Int, chars: CharArray): Boolean = when (kind) {
        KIND_PIN -> validPin(chars)
        KIND_PASSWORD -> validPassword(chars)
        else -> false
    }

    /** The same rules over the helper's wire bytes; false for any byte outside printable ASCII. */
    fun validBytes(kind: Int, bytes: ByteArray): Boolean {
        if (!kindOf(kind) || bytes.any { it.toInt() !in 32..126 }) return false
        val chars = CharArray(bytes.size) { bytes[it].toInt().toChar() }
        return try {
            valid(kind, chars)
        } finally {
            chars.fill('\u0000')
        }
    }
}
