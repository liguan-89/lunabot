package com.lunabot.companion.phoneui

import kotlin.test.assertEquals
import kotlin.test.assertNull
import org.junit.Test

/** Only a clean dialog port and six-digit code reach the pairing exchange, and the host is never input. */
class PhoneUiPairingInputTest {
    @Test
    fun `accepts the system dialog's port and code`() {
        val input = PhoneUiPairingInput.parse("41235", "902154")
        assertEquals(41235, input?.port)
        assertEquals("902154", input?.code)
    }

    @Test
    fun `host is always loopback and never taken from input`() {
        assertEquals("127.0.0.1", PhoneUiPairingInput.HOST)
    }

    @Test
    fun `rejects non numeric or out of range ports`() {
        assertNull(PhoneUiPairingInput.parse("", "123456"))
        assertNull(PhoneUiPairingInput.parse("0", "123456"))
        assertNull(PhoneUiPairingInput.parse("70000", "123456"))
        assertNull(PhoneUiPairingInput.parse("41 235", "123456"))
        assertNull(PhoneUiPairingInput.parse("-1235", "123456"))
        assertNull(PhoneUiPairingInput.parse("0x1f", "123456"))
    }

    @Test
    fun `rejects codes that are not exactly six digits`() {
        assertNull(PhoneUiPairingInput.parse("41235", "12345"))
        assertNull(PhoneUiPairingInput.parse("41235", "1234567"))
        assertNull(PhoneUiPairingInput.parse("41235", "12 456"))
        assertNull(PhoneUiPairingInput.parse("41235", "abcdef"))
        assertNull(PhoneUiPairingInput.parse("41235", ""))
    }
}
