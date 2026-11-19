package com.openmausbot.companion.core.e2e

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
    override fun connect(url: String, protocols: List<String>, listener: E2eSocketListener): E2eSocket {
        val request = Request.Builder()
            .url(url)
            .apply { if (protocols.isNotEmpty()) header("Sec-WebSocket-Protocol", protocols.joinToString(", ")) }
            .build()
        val socket = OkHttpE2eSocket(listener)
        socket.webSocket = client.newWebSocket(request, socket)
        return socket
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

/** What `POST /api/pair` answers. */
data class E2ePairResult(
    val token: String,
    val deviceId: String?,
    val deviceName: String?,
    val serverName: String?,
    val descriptor: E2eDescriptor?,
    val hosts: List<String>,
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
        if (hostId != null && relayNodes.isNotEmpty()) {
            val admission = E2eCredentials.admission(credential, hostId)
            for (node in relayNodes) {
                targets += E2eTarget.Relay("wss://$node/v1/phone", hostId, admission)
            }
        }
        directWsUrl?.let { targets += E2eTarget.Direct(it) }
        if (targets.isEmpty()) throw NoiseException("no_route")

        var lastError: Throwable? = null
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
                if (response.status !in 200..299) {
                    throw E2eHttpException(response.status, response.body.toString(Charsets.UTF_8))
                }
                return parsePairResponse(response.body.toString(Charsets.UTF_8))
            } catch (error: Throwable) {
                lastError = error
            } finally {
                session.close()
            }
        }
        throw lastError ?: NoiseException("no_route")
    }

    fun parsePairResponse(json: String): E2ePairResult {
        val root = Json.parseToJsonElement(json) as JsonObject
        val token = (root["token"] as? JsonPrimitive)?.contentOrNull ?: throw NoiseException("pair_without_token")
        val device = root["device"] as? JsonObject
        val descriptor = (root["e2e"] as? JsonObject)?.let { E2eDescriptorParser.parseObject(it) }
            .let { parsed -> (parsed as? DescriptorParse.Ok)?.descriptor }
        val hosts = (root["hosts"] as? kotlinx.serialization.json.JsonArray)
            ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
            ?: emptyList()
        return E2ePairResult(
            token = token,
            deviceId = (device?.get("id") as? JsonPrimitive)?.contentOrNull,
            deviceName = (device?.get("name") as? JsonPrimitive)?.contentOrNull,
            serverName = (root["serverName"] as? JsonPrimitive)?.contentOrNull,
            descriptor = descriptor,
            hosts = hosts,
        )
    }
}
