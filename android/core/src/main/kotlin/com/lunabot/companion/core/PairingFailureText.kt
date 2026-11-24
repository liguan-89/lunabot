package com.lunabot.companion.core

import com.lunabot.companion.core.e2e.E2eRemovedException
import com.lunabot.companion.core.e2e.NoiseException

/**
 * What a failed pairing says about an encrypted connection the computer did not complete. The reasons are names the
 * two ends use between themselves. A computer that is offline and a pairing code that has expired are the same
 * refusal on purpose — a phone must not be able to tell whether a computer is online — so the text names both
 * rather than guess.
 */
internal fun pairingFailureText(error: Throwable): String {
    if (error is E2eRemovedException) return "这台手机已从电脑上移除。"
    val reason = (error as? NoiseException)?.reason
        ?: return error.message?.takeIf { it.isNotBlank() } ?: "配对失败。"
    return when {
        reason == "handshake_deadline" -> "电脑没有及时应答：配对码可能已过期，或这台手机连不到这台电脑。"
        reason == "no_route" -> "没有可用的方式连到这台电脑。"
        reason == "asleep" -> "电脑现在不在线。"
        reason.startsWith("payload2_") -> "应答的不是二维码上的那台电脑。"
        reason == "relay_rejected" || reason == "relay_no_data_socket" -> "电脑没有接起这次连接。"
        reason == "relay_busy" || reason == "relay_restarting" -> "中继暂时不可用，请稍后重试。"
        reason == "removed" -> "这台手机已从电脑上移除。"
        else -> error.message?.takeIf { it.isNotBlank() } ?: "配对失败。"
    }
}
