package com.lunabot.companion.core.e2e

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** The `e2e` value carried in a pairing link and returned by the computer (spec §3). */
data class E2eDescriptor(
    /** base64url of the 65-byte transport key T.pub */
    val k: String,
    /** base64url of the 16-byte relay host id; present only with [relays] */
    val h: String? = null,
    /** relay hostnames, in the order to try */
    val relays: List<String> = emptyList(),
    /** "local" means the computer restricted this device to Wi-Fi and Tailscale. */
    val routes: String? = null,
) {
    val transportKey: ByteArray get() = E2eBase64.decodeOrThrow(k, "transport_key")
    val hostId: ByteArray? get() = h?.let { E2eBase64.decodeOrThrow(it, "host_id") }

    /** The `e2e=` text for a link or a stored connection: the same shape the desktop emits. */
    fun encode(): String {
        val fields = buildString {
            append("{\"v\":1,\"k\":").append(JsonPrimitive(k))
            if (h != null && relays.isNotEmpty()) {
                append(",\"h\":").append(JsonPrimitive(h))
                append(",\"r\":[").append(relays.joinToString(",") { JsonPrimitive(it).toString() }).append(']')
            }
            if (routes != null) append(",\"routes\":").append(JsonPrimitive(routes))
            append('}')
        }
        return E2eBase64.encode(fields.toByteArray(Charsets.UTF_8))
    }
}

sealed class DescriptorParse {
    data class Ok(val descriptor: E2eDescriptor, val transportKey: ByteArray, val hostId: ByteArray?) : DescriptorParse()
    /** A newer descriptor version: the phone says "update the app" and never falls back to plain pairing. */
    object Update : DescriptorParse()
    data class Reject(val reason: String) : DescriptorParse()
}

object E2eDescriptorParser {
    const val MAX_CHARS = 1024
    const val MAX_RELAY_NODES = 4
    /** The same list `companion/src/e2e/descriptor.ts` parses: a descriptor the computer writes must be one this
     * phone reads, or a malformed invite would reject the whole QR and leave no encrypted route at all. */
    val RELAY_HOST = Regex("^(?:relay[1-9][0-9]?\\.lunabot\\.com|(?:relay[1-9][0-9]?|cloud)\\.dexai\\.vip)$")

    /** Accepts the base64url text (the QR parameter) or the already-decoded JSON object (a response field). */
    fun parse(text: String): DescriptorParse {
        if (text.length > MAX_CHARS) return DescriptorParse.Reject("too_long")
        val bytes = E2eBase64.decode(text) ?: return DescriptorParse.Reject("base64")
        val json = try {
            Json.parseToJsonElement(bytes.toString(Charsets.UTF_8))
        } catch (_: Exception) {
            return DescriptorParse.Reject("json")
        }
        return parseObject(json)
    }

    fun parseObject(value: kotlinx.serialization.json.JsonElement): DescriptorParse {
        val fields = value as? JsonObject ?: return DescriptorParse.Reject("json")
        // Only a JSON number is a version: a quoted "1" is not (desktop: Number.isSafeInteger).
        val version = (fields["v"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull
        if (version == null || version < 1) return DescriptorParse.Reject("version")
        if (version > 1) return DescriptorParse.Update

        val keyText = (fields["k"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val transportKey = keyText?.let(E2eBase64::decode)
        if (transportKey == null ||
            transportKey.size != P256.PUBLIC_KEY_BYTES ||
            !P256.isValidPublicKey(transportKey)
        ) {
            return DescriptorParse.Reject("key")
        }

        val hasHost = fields.containsKey("h")
        val hasRelays = fields.containsKey("r")
        if (hasHost != hasRelays) return DescriptorParse.Reject("relay_pair")

        val routes = (fields["routes"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (fields.containsKey("routes") && routes != "any" && routes != "local") {
            return DescriptorParse.Reject("routes")
        }

        if (!hasHost) {
            return DescriptorParse.Ok(E2eDescriptor(k = keyText!!, routes = routes), transportKey, null)
        }

        val hostId = (fields["h"] as? JsonPrimitive)
            ?.takeIf { it.isString }
            ?.let { E2eBase64.decode(it.content) }
        if (hostId == null || hostId.size != 16) return DescriptorParse.Reject("host_id")

        val relayArray = fields["r"] as? JsonArray ?: return DescriptorParse.Reject("relays")
        val relays = relayArray.mapNotNull { (it as? JsonPrimitive)?.takeIf { primitive -> primitive.isString }?.content }
        if (relays.size != relayArray.size || relays.size !in 1..MAX_RELAY_NODES) {
            return DescriptorParse.Reject("relays")
        }
        if (!relays.all { RELAY_HOST.matches(it) }) return DescriptorParse.Reject("relay_host")

        return DescriptorParse.Ok(
            E2eDescriptor(k = keyText!!, h = fields["h"]!!.jsonPrimitive.content, relays = relays, routes = routes),
            transportKey,
            hostId,
        )
    }
}
