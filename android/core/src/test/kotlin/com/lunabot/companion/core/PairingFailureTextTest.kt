package com.lunabot.companion.core

import com.lunabot.companion.core.e2e.E2eRemovedException
import com.lunabot.companion.core.e2e.NoiseException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** What the pairing screen says when the encrypted connection does not complete. */
class PairingFailureTextTest {
    private val said = mapOf(
        "handshake_deadline" to "电脑没有及时应答：配对码可能已过期，或这台手机连不到这台电脑。",
        "no_route" to "没有可用的方式连到这台电脑。",
        "asleep" to "电脑现在不在线。",
        "payload2" to "应答的不是二维码上的那台电脑。",
        "payload2_conn" to "应答的不是二维码上的那台电脑。",
        "relay_rejected" to "电脑没有接起这次连接。",
        "direct_rejected" to "电脑没有接起这次连接。",
        "relay_no_data_socket" to "电脑没有接起这次连接。",
        "relay_busy" to "中继暂时不可用，请稍后重试。",
        "relay_restarting" to "中继暂时不可用，请稍后重试。",
        "removed" to "这台手机已从电脑上移除。",
    )

    @Test
    fun `no refusal reason reaches the screen as its wire name`() {
        for ((reason, text) in said) {
            val shown = pairingFailureText(NoiseException(reason))
            assertEquals(text, shown, reason)
            assertFalse("e2e:" in shown, reason)
        }
        assertEquals("这台手机已从电脑上移除。", pairingFailureText(E2eRemovedException()))
    }

    @Test
    fun `an expired code is not claimed to be one`() {
        // Offline and expired are one refusal on the wire; the text must not say which it was.
        val shown = pairingFailureText(NoiseException("handshake_deadline"))
        assertTrue("可能已过期" in shown)
        assertFalse(shown.startsWith("配对码已过期"))
    }

    @Test
    fun `everything else keeps its own message`() {
        assertEquals("无法通过任何可用路由连接到此电脑 ()。", pairingFailureText(PairingRouteError(emptyList(), "无法通过任何可用路由连接到此电脑 ()。")))
        assertEquals("Secure storage is unavailable.", pairingFailureText(IllegalStateException("Secure storage is unavailable.")))
        assertEquals("配对失败。", pairingFailureText(IllegalStateException()))
        assertEquals("e2e: closed_4400", pairingFailureText(NoiseException("closed_4400")), "an unknown reason is shown as it is, not guessed at")
    }
}
