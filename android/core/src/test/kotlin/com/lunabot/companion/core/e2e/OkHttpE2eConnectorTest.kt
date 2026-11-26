package com.lunabot.companion.core.e2e

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Which dials wait briefly for an answer before the relay is tried. */
class OkHttpE2eConnectorTest {
    @Test
    fun `only a dial to an address on this phone's own network waits briefly`() {
        for (url in listOf(
            "ws://192.168.1.42:8810/v1/e2e",
            "ws://10.0.0.3:8810/v1/e2e",
            "ws://172.16.4.5:8810/v1/e2e",
            "ws://172.31.255.254:8810/v1/e2e",
            "ws://127.0.0.1:8810/v1/e2e",
            "ws://169.254.10.20:8810/v1/e2e",
            "ws://[fd7a:115c:a1e0::1]:8810/v1/e2e",
            "ws://[::1]:8810/v1/e2e",
            "ws://[fe80::1]:8810/v1/e2e",
        )) {
            assertTrue(OkHttpE2eConnector.isLanDial(url), url)
        }

        for (url in listOf(
            "wss://cloud.dexai.vip/v1/phone",
            "ws://mac.tail1234.ts.net:8810/v1/e2e",
            "ws://[2606:4700:4700::1111]:8810/v1/e2e",
            "ws://172.32.0.1:8810/v1/e2e",
            "ws://192.169.1.42:8810/v1/e2e",
            "ws://192.168.1.999:8810/v1/e2e",
            "ws://macbook:8810/v1/e2e",
        )) {
            assertFalse(OkHttpE2eConnector.isLanDial(url), url)
        }
    }

    @Test
    fun `the brief wait is well inside the handshake deadline`() {
        assertTrue(OkHttpE2eConnector.LAN_CONNECT_TIMEOUT_MS < 10_000)
    }
}
