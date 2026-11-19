// Adapted from Mika's WechatApi and WechatRuntime (Apache-2.0).
package com.lunabot.companion.wechat

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

/**
 * The frozen answer to `PHONE_REPLY_WECHAT`.
 *
 * Exactly two shapes cross the wire here:
 *
 *   `{ "ok": true }`
 *   `{ "ok": false, "error": "<short code>" }`
 *
 * The short codes are `not_bound`, `not_owner`, `invalid` and `send_failed`.
 * The same function serves the runner and the tests, so the wire shape cannot
 * drift between them.
 */
internal suspend fun answerWechatReply(
    runtime: WechatRuntime?,
    jobId: String,
    arguments: JsonObject,
): JsonObject {
    if (runtime == null) return wechatFailure("not_bound")
    val to = arguments.string("to").orEmpty()
    val text = arguments.string("text").orEmpty()
    return when (val result = runtime.reply(clientId = jobId, to = to, text = text)) {
        is WechatReplyResult.Success -> buildJsonObject { put("ok", true) }
        is WechatReplyResult.Failure -> wechatFailure(result.code)
    }
}

internal fun wechatFailure(code: String): JsonObject = buildJsonObject {
    put("ok", false)
    put("error", code)
}

private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf(String::isNotEmpty)
