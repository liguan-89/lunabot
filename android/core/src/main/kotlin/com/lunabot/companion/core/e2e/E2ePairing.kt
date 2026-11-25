package com.lunabot.companion.core.e2e

import com.lunabot.companion.core.PairingRouteError
import com.lunabot.companion.core.ServerPairingRetryError
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** The Android platform half: one OkHttp WebSocket per E2E session. */
class OkHttpE2eConnector(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build(),
) : E2eSocketConnector {
    /**
     * Away from the computer's network nothing answers its LAN address: that connection can only time out, and the
     * relay is tried right after it. OkHttp's default 10 s wait for an answer that is not coming is what made every
     * start away from home take that long to reach the relay.
     */
    private val lanClient = client.newBuilder()
        .connectTimeout(LAN_CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .build()

    override fun connect(url: String, protocols: List<String>, listener: E2eSocketListener): E2eSocket {
        val request = Request.Builder()
            .url(url)
            .apply { if (protocols.isNotEmpty()) header("Sec-WebSocket-Protocol", protocols.joinToString(", ")) }
            .build()
        val socket = OkHttpE2eSocket(listener)
        socket.webSocket = (if (isLanDial(url)) lanClient else client).newWebSocket(request, socket)
        return socket
    }

    companion object {
        const val LAN_CONNECT_TIMEOUT_MS = 3_000L

        /**
         * A cleartext dial to a private or loopback IPv4 address — the computer on this phone's own network. A
         * tailnet name may take seconds to find its path and a relay is far away; both keep the client's own timeout.
         */
        fun isLanDial(url: String): Boolean {
            if (!url.startsWith("ws://")) return false
            val authority = url.removePrefix("ws://").substringBefore('/')
            if (authority.startsWith("[")) return false
            val octets = authority.substringBeforeLast(':').split('.').map { it.toIntOrNull() ?: return false }
            if (octets.size != 4 || octets.any { it !in 0..255 }) return false
            return octets[0] == 127 || octets[0] == 10 ||
                (octets[0] == 172 && octets[1] in 16..31) ||
                (octets[0] == 192 && octets[1] == 168) ||
                (octets[0] == 169 && octets[1] == 254)
        }
    }
}

private class OkHttpE2eSocket(private val listener: E2eSocketListener) : WebSocketListener(), E2eSocket {
    var webSocket: WebSocket? = null
    @Volatile private var alive = false

    override val isOpen: Boolean get() = alive

    override val bufferedBytes: Long
        get() = webSocket?.queueSize() ?: 0

    override fun sendBinary(bytes: ByteArray) {
        webSocket?.send(okio.ByteString.of(*bytes))
    }

    override fun sendText(text: String) {
        webSocket?.send(text)
    }

    override fun close(code: Int) {
        webSocket?.close(code, null)
    }

    override fun onOpen(webSocket: WebSocket, response: Response) {
        alive = true
        listener.onOpen()
    }

    override fun onMessage(webSocket: WebSocket, bytes: okio.ByteString) = listener.onBinary(bytes.toByteArray())

    override fun onMessage(webSocket: WebSocket, text: String) = listener.onText(text)

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        E2eLog.line("closing $code $reason")
        alive = false
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        alive = false
        listener.onClosed(code)
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        alive = false
        val detail = buildString {
            append(t.javaClass.simpleName).append(": ").append(t.message)
            response?.let { append(" http=").append(it.code) }
            var cause = t.cause
            var depth = 0
            while (cause != null && depth < 3) {
                append(" <- ").append(cause.javaClass.simpleName).append(": ").append(cause.message)
                cause = cause.cause
                depth += 1
            }
        }
        listener.onFailure(detail)
    }
}

/** What `POST /api/pair` answers. `endpoints` is advisory and lossy per element: the token is already minted, so one
 * route the phone cannot read must not discard it. */
data class E2ePairResult(
    val token: String,
    val deviceId: String?,
    val deviceName: String?,
    val serverName: String?,
    val descriptor: E2eDescriptor?,
    val hosts: List<String>,
    val endpoints: List<com.lunabot.companion.core.CompanionEndpoint>,
)

object E2ePairing {
    /**
     * Pairs over the encrypted connection. The QR's credential is the psk
     * input, so the pairing request itself is already inside the tunnel; the
     * relay only sees ciphertext.
     */
    fun pair(
        connector: E2eSocketConnector,
        descriptor: E2eDescriptor,
        credential: String,
        deviceName: String,
        app: String,
        directWsUrl: String? = null,
        pairRequestId: String? = null,
        readTimeoutMs: Int = 30_000,
    ): E2ePairResult {
        val transportKey = descriptor.transportKey
        val keyId = E2eCredentials.keyId(transportKey)
        val psk = E2eCredentials.psk(credential, keyId)
        val hostId = descriptor.hostId
        val relayNodes = descriptor.relays

        val targets = ArrayList<E2eTarget>()
        // Same order as E2eTransport: the direct route leads, the relay follows (spec §3, §4). A descriptor that
        // restricts this device to `"local"` offers no relay route.
        directWsUrl?.let { targets += E2eTarget.Direct(it) }
        if (descriptor.routes != "local" && hostId != null && relayNodes.isNotEmpty()) {
            val admission = E2eCredentials.admission(credential, hostId)
            for (node in relayNodes) {
                targets += E2eTarget.Relay("wss://$node/v1/phone", hostId, admission)
            }
        }
        if (targets.isEmpty()) throw NoiseException("no_route")

        var lastError: Throwable? = null
        var answered = false
        for (target in targets) {
            val session = E2eSession(
                connector = connector,
                target = target,
                transportKey = transportKey,
                psk = psk,
                app = app,
            )
            try {
                session.connect()
                val body = buildString {
                    append("{\"credential\":").append(JsonPrimitive(credential))
                    append(",\"deviceName\":").append(JsonPrimitive(deviceName))
                    if (pairRequestId != null) append(",\"pairRequestId\":").append(JsonPrimitive(pairRequestId))
                    append('}')
                }
                val response = E2eHttp.request(
                    session = session,
                    method = "POST",
                    path = "/api/pair",
                    headers = mapOf("Content-Type" to "application/json", "Accept" to "application/json"),
                    body = body.toByteArray(),
                    readTimeoutMs = readTimeoutMs,
                )
                answered = true
                if (response.status == 429 || response.status >= 500) {
                    // Rate-limited or a transient computer error: the same code stays retryable.
                    throw ServerPairingRetryError(IOException("HTTP ${response.status}: ${response.body.toString(Charsets.UTF_8).take(200)}"))
                }
                if (response.status !in 200..299) {
                    // Any other HTTP answer comes from inside the tunnel, i.e. from the computer itself: another
                    // route reaches the same computer and would answer the same, so the walk stops here with the
                    // original refusal instead of retrying and swallowing it.
                    throw E2eHttpException(response.status, response.body.toString(Charsets.UTF_8))
                }
                return parsePairResponse(response.body.toString(Charsets.UTF_8))
            } catch (error: E2eHttpException) {
                throw error
            } catch (error: ServerPairingRetryError) {
                throw error
            } catch (error: Throwable) {
                lastError = error
            } finally {
                session.close()
            }
        }
        val fatal = lastError ?: NoiseException("no_route")
        if (!answered && !isAuthoritativePairingRefusal((fatal as? NoiseException)?.reason)) {
            // Pure route failure: the computer never answered, so the one-time credential stays retryable
            // instead of burning (mirrors pairFirstReachable ending in PairingRouteError).
            throw PairingRouteError(targets.map {
                when (it) {
                    is E2eTarget.Direct -> it.url
                    is E2eTarget.Relay -> it.url
                }
            })
        }
        throw fatal
    }

    /**
     * The handshake proved the peer holds this pairing's key material: a removal announced inside the tunnel,
     * or a message-2 that decrypts but is not for this phone. Those are the computer's answer, not a route failure.
     */
    private fun isAuthoritativePairingRefusal(reason: String?): Boolean =
        reason == "removed" || reason == "payload2" || (reason?.startsWith("payload2_") == true)

    fun parsePairResponse(json: String): E2ePairResult {
        val root = Json.parseToJsonElement(json) as JsonObject
        val token = (root["token"] as? JsonPrimitive)?.contentOrNull ?: throw NoiseException("pair_without_token")
        val device = root["device"] as? JsonObject
        val descriptor = (root["e2e"] as? JsonObject)?.let { E2eDescriptorParser.parseObject(it) }
            .let { parsed -> (parsed as? DescriptorParse.Ok)?.descriptor }
        val hosts = (root["hosts"] as? kotlinx.serialization.json.JsonArray)
            ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
            ?: emptyList()
        // The routes the computer advertises for this device. Decoded one element at a time: a kind or URL this build
        // does not know is dropped, never the token beside it.
        val endpoints = (root["endpoints"] as? kotlinx.serialization.json.JsonArray)
            ?.mapNotNull { element ->
                runCatching {
                    Json.decodeFromJsonElement(com.lunabot.companion.core.CompanionEndpoint.serializer(), element)
                }.getOrNull()
            }
            ?: emptyList()
        return E2ePairResult(
            token = token,
            deviceId = (device?.get("id") as? JsonPrimitive)?.contentOrNull,
            deviceName = (device?.get("name") as? JsonPrimitive)?.contentOrNull,
            serverName = (root["serverName"] as? JsonPrimitive)?.contentOrNull,
            descriptor = descriptor,
            hosts = hosts,
            endpoints = endpoints,
        )
    }
}
