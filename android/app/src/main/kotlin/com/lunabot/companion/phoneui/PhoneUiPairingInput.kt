package com.lunabot.companion.phoneui

/**
 * The port and six-digit code the system wireless-debugging pairing dialog
 * shows. Deliberately host-free: the pairing service only exists on this
 * device, so there is no host input to accept — the exchange always runs
 * against [HOST] and the core's local-address check rejects anything wider.
 */
object PhoneUiPairingInput {
    /** adbd's pairing and connect services both live on this device itself. */
    const val HOST: String = "127.0.0.1"

    data class Input(val port: Int, val code: String)

    /** Strict digits only; anything else (signs, separators, paste artefacts) is rejected. */
    fun parse(portText: String, code: String): Input? {
        val port = portText.trim()
        if (port.isEmpty() || port.any { it !in '0'..'9' }) return null
        val portValue = port.toIntOrNull() ?: return null
        if (portValue !in 1..65535) return null
        val codeValue = code.trim()
        if (codeValue.length != 6 || codeValue.any { it !in '0'..'9' }) return null
        return Input(portValue, codeValue)
    }
}
