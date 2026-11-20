package com.lunabot.companion.core.e2e

/** A minimal HTTP/1.1 client over one yamux stream. The E2E layer never parses HTTP; this does. */
data class E2eHttpResponse(
    val status: Int,
    val headers: Map<String, String>,
    val body: ByteArray,
) {
    fun header(name: String): String? = headers[name.lowercase()]
}

class E2eHttpException(val status: Int, val body: String) : Exception("HTTP $status: $body")

/**
 * Sends one request on its own stream and reads the response. Bodies are read
 * to `Content-Length` or to EOF; chunked responses are decoded. Compressed
 * bodies are avoided by the caller (`Accept-Encoding: identity`).
 */
object E2eHttp {
    fun request(
        session: E2eSession,
        method: String,
        path: String,
        headers: Map<String, String> = emptyMap(),
        body: ByteArray? = null,
        host: String = "h.e2e.invalid",
        readTimeoutMs: Int = 30_000,
    ): E2eHttpResponse {
        val stream = session.openStream()
        try {
            val out = StringBuilder()
            out.append("$method $path HTTP/1.1\r\n")
            out.append("Host: $host\r\n")
            out.append("Connection: close\r\n")
            out.append("Accept-Encoding: identity\r\n")
            for ((name, value) in headers) out.append("$name: $value\r\n")
            val payload = body ?: ByteArray(0)
            out.append("Content-Length: ${payload.size}\r\n")
            out.append("\r\n")
            if (!stream.write(out.toString().toByteArray())) throw E2eHttpException(0, "stream closed")
            if (payload.isNotEmpty() && !stream.write(payload)) throw E2eHttpException(0, "stream closed")
            stream.finish()
            return readResponse(stream, readTimeoutMs)
        } finally {
            runCatching { stream.reset() }
        }
    }

    private fun readResponse(stream: E2eStream, readTimeoutMs: Int): E2eHttpResponse {
        val head = readHead(stream, readTimeoutMs)
        val lines = head.split("\r\n")
        val status = lines.firstOrNull()?.split(" ")?.getOrNull(1)?.toIntOrNull()
            ?: throw IllegalStateException("bad status line: ${lines.firstOrNull()}")
        val headers = LinkedHashMap<String, String>()
        for (line in lines.drop(1)) {
            val separator = line.indexOf(':')
            if (separator <= 0) continue
            headers[line.substring(0, separator).trim().lowercase()] = line.substring(separator + 1).trim()
        }
        val chunked = headers["transfer-encoding"]?.contains("chunked", ignoreCase = true) == true
        val body = if (chunked) {
            readChunked(stream, readTimeoutMs)
        } else {
            headers["content-length"]?.toIntOrNull()?.let { readExactly(stream, it, readTimeoutMs) }
                ?: readToEnd(stream, readTimeoutMs)
        }
        return E2eHttpResponse(status, headers, body)
    }

    private fun readHead(stream: E2eStream, timeoutMs: Int): String {
        val buffer = StringBuilder()
        val chunk = ByteArray(1)
        while (!buffer.endsWith("\r\n\r\n")) {
            if (stream.read(chunk, timeoutMs = timeoutMs.toLong()) <= 0) {
                throw IllegalStateException("connection closed before the response head")
            }
            buffer.append(chunk[0].toInt().toChar())
            if (buffer.length > 64 * 1024) throw IllegalStateException("response head too large")
        }
        return buffer.substring(0, buffer.length - 4)
    }

    private fun readExactly(stream: E2eStream, length: Int, timeoutMs: Int): ByteArray {
        val out = ByteArray(length)
        var offset = 0
        val chunk = ByteArray(8192)
        while (offset < length) {
            val read = stream.read(chunk, timeoutMs = timeoutMs.toLong())
            if (read <= 0) throw IllegalStateException("connection closed after $offset of $length bytes")
            val count = minOf(read, length - offset)
            System.arraycopy(chunk, 0, out, offset, count)
            offset += count
        }
        return out
    }

    private fun readToEnd(stream: E2eStream, timeoutMs: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val chunk = ByteArray(8192)
        while (true) {
            val read = stream.read(chunk, timeoutMs = timeoutMs.toLong())
            if (read <= 0) break
            out.write(chunk, 0, read)
        }
        return out.toByteArray()
    }

    private fun readChunked(stream: E2eStream, timeoutMs: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val chunk = ByteArray(8192)
        while (true) {
            val line = readLine(stream, timeoutMs)
            val size = line.substringBefore(';').trim().toIntOrNull(16)
                ?: throw IllegalStateException("bad chunk size: $line")
            if (size == 0) {
                // Trailers end with a blank line.
                while (readLine(stream, timeoutMs).isNotEmpty()) Unit
                break
            }
            var remaining = size
            while (remaining > 0) {
                val read = stream.read(chunk, 0, minOf(chunk.size, remaining), timeoutMs.toLong())
                if (read <= 0) throw IllegalStateException("connection closed inside a chunk")
                out.write(chunk, 0, read)
                remaining -= read
            }
            readLine(stream, timeoutMs)
        }
        return out.toByteArray()
    }

    private fun readLine(stream: E2eStream, timeoutMs: Int): String {
        val line = StringBuilder()
        val one = ByteArray(1)
        while (true) {
            if (stream.read(one, timeoutMs = timeoutMs.toLong()) <= 0) throw IllegalStateException("closed")
            val value = one[0].toInt() and 0xFF
            if (value == '\r'.code) continue
            if (value == '\n'.code) return line.toString()
            line.append(value.toChar())
            if (line.length > 8192) throw IllegalStateException("line too long")
        }
    }
}
