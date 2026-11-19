package com.openmausbot.companion.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * The socket-relay Live call's wire rules — the Android half of
 * `src/lib/live-relay-client.ts`. Up the socket goes PCM s16le 16 kHz mono;
 * down comes PCM s16le 24 kHz audio and JSON events. The provider key never
 * leaves the computer; a text `{"t":"end"}` is the hang-up.
 */
object LiveRelay {
    const val PATH = "/api/live/relay"
    const val INPUT_HZ = 16_000
    const val OUTPUT_HZ = 24_000
    const val END_MESSAGE = """{"t":"end"}"""

    /** The providers whose realtime transport is this socket; the rest call over WebRTC, which this build does not carry. */
    val SOCKET_PROVIDERS = setOf("qwen", "volc")

    fun query(botId: String, threadId: String): List<Pair<String, String>> =
        listOf("botId" to botId, "threadId" to threadId, "client" to "android")

    /** What one text frame says. Unknown shapes and bad JSON are skipped, like the desktop's. */
    sealed interface Event {
        /** The provider session is up; capture may start. Rates are the server's word for the socket's formats. */
        data class Ready(val provider: String, val inputHz: Int, val outputHz: Int) : Event
        data class Transcript(val user: Boolean, val delta: String) : Event
        /** A provider-side signal the call may log but does not act on (`volc:<event>`). */
        data class Named(val name: String) : Event
        data class Failure(val message: String) : Event
        data object End : Event
    }

    fun decodeEvent(text: String): Event? = runCatching {
        decodeEventOrThrow(text)
    }.getOrNull()

    private fun decodeEventOrThrow(text: String): Event? {
        val parsed = CompanionJson.parseToJsonElement(text) as? JsonObject ?: return null
        return when (parsed["t"]?.jsonPrimitive?.contentOrNull) {
            "ready" -> Event.Ready(
                provider = parsed["provider"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                inputHz = parsed["inputHz"]?.jsonPrimitive?.intOrNull ?: INPUT_HZ,
                outputHz = parsed["outputHz"]?.jsonPrimitive?.intOrNull ?: OUTPUT_HZ,
            )
            "transcript" -> {
                val role = parsed["role"]?.jsonPrimitive?.contentOrNull
                val delta = parsed["delta"]?.jsonPrimitive?.contentOrNull
                if ((role == "user" || role == "assistant") && delta != null) {
                    Event.Transcript(user = role == "user", delta = delta)
                } else {
                    null
                }
            }
            "event" -> parsed["name"]?.jsonPrimitive?.contentOrNull?.let { Event.Named(it) }
            "error" -> parsed["message"]?.jsonPrimitive?.contentOrNull?.let { Event.Failure(it) }
            "end" -> Event.End
            else -> null
        }
    }
}
