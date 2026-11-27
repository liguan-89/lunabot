package com.lunabot.companion.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Origins a frame may reach after the host's filter; `refused` is informational chrome only. */
@Serializable
data class AppNetwork(
    val connect: List<String>,
    val resources: List<String>,
    val refused: List<String>? = null,
)

@Serializable
data class AppContextState(
    val text: String,
    val at: Double,
    val delivered: Boolean? = null,
)

/** The last successful change an MCP app made from its own card. */
@Serializable
data class AppDoneState(
    val tool: String,
    val text: String? = null,
    val url: String? = null,
    val at: Double,
)

@Serializable
data class AppMcpRef(
    val server: String,
    val serverTitle: String? = null,
    val tool: String,
    val resourceUri: String,
    val isError: Boolean? = null,
)

/** A user row sent by an app's `ui/message`. */
@Serializable
data class AppFromRef(
    val messageId: String,
    val title: String,
)

/** What the frame may do right now; the host page builds hostCapabilities from exactly this. */
@Serializable
data class AppCan(
    val serverTools: Boolean = false,
    val serverResources: Boolean = false,
    val message: Boolean = false,
    val openLinks: Boolean = false,
    val modelContext: Boolean = false,
)

@Serializable
data class AppDocumentBlocked(
    val reason: String,
    val text: String? = null,
)

@Serializable
data class AppToolDefinition(
    val name: String,
    val title: String? = null,
    val description: String? = null,
    val inputSchema: JsonObject? = null,
    val annotations: JsonObject? = null,
    @SerialName("_meta") val meta: JsonObject? = null,
)

@Serializable
data class AppToolResult(
    val content: List<JsonElement> = emptyList(),
    val structuredContent: JsonElement? = null,
    @SerialName("_meta") val meta: JsonObject? = null,
    val isError: Boolean? = null,
)

/** The document a client fetches only when it mounts one app row. */
@Serializable
data class AppDocument(
    val v: Int,
    val messageId: String,
    val rev: Int,
    val srcdoc: String,
    val csp: String,
    val network: AppNetwork,
    val tool: AppToolDefinition? = null,
    val toolInput: JsonObject? = null,
    val toolResult: AppToolResult? = null,
    val can: AppCan,
    val blocked: AppDocumentBlocked? = null,
    val room: Boolean? = null,
) {
    val valid: Boolean
        get() = v == 1 && messageId.isNotEmpty() &&
            srcdoc.startsWith("<!DOCTYPE html><meta http-equiv=\"Content-Security-Policy\" content=\"")
}

/** The outcome of one app-initiated RPC, preserving the server's refusal shape for the View. */
sealed interface AppRpcOutcome {
    data class Result(val value: JsonElement?) : AppRpcOutcome
    data class Refusal(
        val code: Int,
        val message: String,
        val signInServer: String? = null,
        val blockedReason: String? = null,
        val blockedText: String? = null,
        val offline: Boolean = false,
    ) : AppRpcOutcome
}
