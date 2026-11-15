/*
 * The auto-pair reader must never guess: one six-digit code and one address
 * port in the same window, or nothing. The wireless debugging page behind the
 * dialog carries a second `IP:port` (the connect port), so a cross-window read
 * would pair against the wrong socket.
 */
package com.openmausbot.companion.phoneui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class PhoneUiPairingScreenTest {
    @Test
    fun `reads the dialog code and pairing port`() {
        val windows = listOf(
            listOf("无线调试", "使用六位数的配对码配对新设备", "输入配对码配对设备"),
            listOf(
                "与设备配对",
                "WLAN 配对码",
                "123456",
                "IP 地址和端口",
                "10.140.99.239:43535",
                "取消",
            ),
        )
        assertEquals(PhoneUiPairingCode("123456", 43535), PhoneUiPairingScreen.read(windows))
    }

    @Test
    fun `the page behind the dialog cannot supply the port`() {
        val windows = listOf(
            listOf("无线调试", "IP 地址和端口", "10.140.99.239:43305"),
            listOf("与设备配对", "WLAN 配对码", "654321", "IP 地址和端口", "10.140.99.239:43535"),
        )
        assertEquals(PhoneUiPairingCode("654321", 43535), PhoneUiPairingScreen.read(windows))
    }

    @Test
    fun `a window with the code but no address port is not enough`() {
        val windows = listOf(listOf("与设备配对", "WLAN 配对码", "123456"))
        assertNull(PhoneUiPairingScreen.read(windows))
    }

    @Test
    fun `two different codes in one window fail closed`() {
        val windows = listOf(
            listOf("123456", "654321", "10.140.99.239:43535"),
        )
        assertNull(PhoneUiPairingScreen.read(windows))
    }

    @Test
    fun `two different ports in one window fail closed`() {
        val windows = listOf(
            listOf("123456", "10.140.99.239:43535", "10.140.99.239:43305"),
        )
        assertNull(PhoneUiPairingScreen.read(windows))
    }

    @Test
    fun `a six digit run inside a longer text is not a code`() {
        val windows = listOf(
            listOf("1234567", "设备 123456", "10.140.99.239:43535"),
        )
        assertNull(PhoneUiPairingScreen.read(windows))
        assertEquals(
            PhoneUiPairingCode("123456", 43535),
            PhoneUiPairingScreen.read(listOf(listOf(" 123 456 ", "10.140.99.239:43535"))),
        )
    }

    @Test
    fun `full width digits count`() {
        val windows = listOf(listOf("１２３４５６", "10.140.99.239:43535"))
        assertEquals(PhoneUiPairingCode("123456", 43535), PhoneUiPairingScreen.read(windows))
    }

    @Test
    fun `a bare number is not a port and a bracketed ipv6 is`() {
        assertNull(PhoneUiPairingScreen.read(listOf(listOf("123456", "43535"))))
        assertEquals(
            PhoneUiPairingCode("123456", 43535),
            PhoneUiPairingScreen.read(listOf(listOf("123456", "[fd00::1]:43535"))),
        )
    }

    @Test
    fun `a port outside the range is refused`() {
        assertNull(PhoneUiPairingScreen.read(listOf(listOf("123456", "10.140.99.239:70000"))))
    }
}