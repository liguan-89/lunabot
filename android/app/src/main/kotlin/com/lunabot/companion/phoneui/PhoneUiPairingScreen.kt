package com.lunabot.companion.phoneui

/** What the system wireless-debugging pairing dialog shows: six digits and the pairing port. */
data class PhoneUiPairingCode(val code: String, val port: Int)

/**
 * Reads the system pairing dialog's texts into [PhoneUiPairingCode].
 *
 * This is the automatic half of pairing, adapted from Mika's `PairingScreen`:
 * the system dialog shows the six digits and an `IP:port` line, so a person
 * never has to copy either into this app. The parser is deliberately strict —
 * exactly one six-digit string and exactly one address port **in the same
 * window** — because the wireless-debugging page behind the dialog also shows
 * an `IP:port` (the connect port), and an ambiguous read must fail closed
 * rather than pair against the wrong port. Full-width digits are accepted
 * because some keys render them, and whitespace is ignored.
 */
object PhoneUiPairingScreen {
    fun read(windows: Iterable<Iterable<String?>>): PhoneUiPairingCode? {
        val found = LinkedHashSet<PhoneUiPairingCode>()
        for (texts in windows) {
            var code: String? = null
            var port: Int? = null
            var ambiguous = false
            for (text in texts) {
                val candidate = text?.trim()?.takeIf { it.isNotEmpty() } ?: continue
                codeOf(candidate)?.let { read ->
                    if (code == null) code = read else if (code != read) ambiguous = true
                }
                portOf(candidate)?.let { read ->
                    if (port == null) port = read else if (port != read) ambiguous = true
                }
            }
            if (!ambiguous && code != null && port != null) found += PhoneUiPairingCode(code, port)
        }
        return found.singleOrNull()
    }

    /** Exactly six digits after dropping whitespace and folding full-width forms. */
    private fun codeOf(text: String): String? {
        val compact = text.filterNot(Char::isWhitespace)
        if (compact.length != CODE_LENGTH) return null
        val digits = CharArray(CODE_LENGTH)
        for (index in compact.indices) {
            digits[index] = when (val char = compact[index]) {
                in '0'..'9' -> char
                in FULL_WIDTH_ZERO..FULL_WIDTH_NINE -> '0' + (char - FULL_WIDTH_ZERO)
                else -> return null
            }
        }
        return String(digits)
    }

    /** The port of a trailing `IPv4:port` or `[IPv6]:port`, never a bare number. */
    private fun portOf(text: String): Int? {
        val match = ADDRESS_PORT.find(text) ?: return null
        val port = match.groupValues[1].toIntOrNull() ?: return null
        return port.takeIf { it in 1..65_535 }
    }

    private val ADDRESS_PORT =
        Regex("""(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9A-Fa-f:.]+\]):(\d{1,5})$""")

    private const val CODE_LENGTH = 6
    private const val FULL_WIDTH_ZERO = '\uFF10'
    private const val FULL_WIDTH_NINE = '\uFF19'
}