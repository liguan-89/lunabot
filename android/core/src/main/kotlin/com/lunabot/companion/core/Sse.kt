package com.lunabot.companion.core

import java.io.IOException
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.decodeFromString
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/** One server-sent event. `event` is the `event:` name (the browser's live view names every message this way); the
 * general event feed leaves it out and puts the kind inside `data`. */
data class SSEEvent(val id: String? = null, val data: String, val event: String? = null)

/** A line-oriented parser whose empty input line is the SSE event terminator. */
class SSEParser {
    private val fields = mutableListOf<Pair<String, String>>()

    fun line(raw: String): SSEEvent? {
        val line = raw.removeSuffix("\r")
        if (line.isEmpty()) {
            val event = event(fields)
            fields.clear()
            return event
        }
        if (line.startsWith(':')) return null
        val colon = line.indexOf(':')
        if (colon < 0) return null
        var value = line.substring(colon + 1)
        if (value.startsWith(' ')) value = value.drop(1)
        fields += line.substring(0, colon) to value
        return null
    }

    /** Discards an event that never received its terminating blank line. */
    fun reset() {
        fields.clear()
    }

    companion object {
        internal fun event(fields: List<Pair<String, String>>): SSEEvent? {
            var id: String? = null
            var name: String? = null
            val data = mutableListOf<String>()
            fields.forEach { (field, value) ->
                when (field) {
                    "id" -> id = value
                    "event" -> name = value
                    "data" -> data += value
                }
            }
            return data.takeIf { it.isNotEmpty() }?.let { SSEEvent(id, it.joinToString("\n"), name) }
        }
    }
}

/**
 * Every server-sent event on `request`, undecoded: the browser's live view names each message with `event:` and its
 * payload is that view's own, not the general feed's frame kinds.
 */
fun namedEventStream(
    request: Request,
    client: OkHttpClient,
): Flow<SSEEvent> = callbackFlow {
    val call = client.newCall(request)
    val responseRef = AtomicReference<Response?>(null)
    val reader = launch(Dispatchers.IO) {
        try {
            val response = call.execute()
            responseRef.set(response)
            if (response.code != 200) throw APIError.Status(response.code)
            val body = response.body ?: throw APIError.Transport("The computer sent an empty event stream.")
            val source = body.source()
            val parser = SSEParser()
            while (isActive) {
                val line = source.readUtf8Line() ?: break
                val event = parser.line(line) ?: continue
                try {
                    send(event)
                } catch (_: Throwable) {
                    break
                }
            }
            parser.reset()
            close()
        } catch (_: CancellationException) {
            // A collector leaving the flow deliberately tears down the call.
        } catch (error: APIError) {
            runCatching { close(error) }
        } catch (error: IOException) {
            runCatching { close(APIError.Transport(error.message ?: "Could not reach the computer.", error)) }
        } finally {
            responseRef.getAndSet(null)?.close()
        }
    }

    awaitClose {
        responseRef.getAndSet(null)?.close()
        call.cancel()
        reader.cancel()
    }
}

/**
 * Malformed JSON drops one frame; unknown frame kinds decode as [Frame.Unknown]
 * and keep the stream alive.
 */
fun eventStream(
    request: Request,
    client: OkHttpClient,
): Flow<StreamFrame> = callbackFlow {
    val call = client.newCall(request)
    val responseRef = AtomicReference<Response?>(null)
    val reader = launch(Dispatchers.IO) {
        try {
            val response = call.execute()
            responseRef.set(response)
            if (response.code != 200) throw APIError.Status(response.code)
            val body = response.body ?: throw APIError.Transport("The computer sent an empty event stream.")
            val source = body.source()
            val parser = SSEParser()

            while (isActive) {
                val line = source.readUtf8Line() ?: break
                val event = parser.line(line) ?: continue
                val frame = runCatching {
                    CompanionJson.decodeFromString<StreamFrame>(event.data)
                }.getOrNull() ?: continue
                // The collector can go away between the read and this send
                // (a reconnect, a sign-out). Sending into a closed channel
                // throws "Unbalanced enter/exit" from inside the flow and
                // leaves the retry loop wedged, so stop reading instead.
                try {
                    send(frame)
                } catch (_: Throwable) {
                    break
                }
            }
            parser.reset()
            close()
        } catch (_: CancellationException) {
            // A collector leaving the flow deliberately tears down the call.
        } catch (error: APIError) {
            runCatching { close(error) }
        } catch (error: IOException) {
            runCatching { close(APIError.Transport(error.message ?: "Could not reach the computer.", error)) }
        } finally {
            responseRef.getAndSet(null)?.close()
        }
    }

    awaitClose {
        responseRef.getAndSet(null)?.close()
        call.cancel()
        reader.cancel()
    }
}
