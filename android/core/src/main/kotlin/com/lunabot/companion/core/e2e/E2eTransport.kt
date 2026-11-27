package com.lunabot.companion.core.e2e

import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.Socket
import java.net.SocketAddress
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.SocketFactory
import okhttp3.Dns

/**
 * Presents one E2E session as an ordinary socket, so every existing OkHttp
 * request and SSE stream runs unchanged through the tunnel (spec §8: the
 * Android recipe). One socket is one yamux stream, i.e. one HTTP connection.
 */
class E2eTransport(
    private val descriptor: E2eDescriptor,
    private val token: String,
    private val app: String,
    private val connector: E2eSocketConnector = OkHttpE2eConnector(),
    /** A direct route to try before the relay: `ws://host:port/v1/e2e`. Null leaves the relay to carry the session. */
    val directUrl: String? = null,
) {
    private val lock = Any()
    private var session: E2eSession? = null
    /** Called when the tunnel dies or is replaced, so the HTTP stack drops the
     * connections it pooled against it. Without this the pool keeps handing
     * back the dead socket, every request times out, and nothing ever dials
     * again. */
    var onTunnelLost: (() -> Unit)? = null

    /** The synthetic host OkHttp dials; [dns] resolves it to a placeholder. */
    val httpHost: String = "h-${(descriptor.hostId ?: ByteArray(16)).hex()}.e2e.invalid"

    val dns: Dns = object : Dns {
        override fun lookup(hostname: String): List<InetAddress> =
            if (hostname.equals(httpHost, ignoreCase = true) || hostname.endsWith(".e2e.invalid", ignoreCase = true)) {
                listOf(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)))
            } else {
                throw UnknownHostException("$hostname is not an E2E host")
            }
    }

    val socketFactory: SocketFactory = object : SocketFactory() {
        override fun createSocket(): Socket = E2eStreamSocket(this@E2eTransport)
        override fun createSocket(host: String?, port: Int): Socket = E2eStreamSocket(this@E2eTransport)
        override fun createSocket(host: String?, port: Int, localHost: InetAddress?, localPort: Int): Socket =
            E2eStreamSocket(this@E2eTransport)
        override fun createSocket(host: InetAddress?, port: Int): Socket = E2eStreamSocket(this@E2eTransport)
        override fun createSocket(address: InetAddress?, port: Int, localAddress: InetAddress?, localPort: Int): Socket =
            E2eStreamSocket(this@E2eTransport)
    }

    /** Non-null once the current session failed; `"removed"` means a re-pair is required. */
    fun failureReason(): String? = synchronized(lock) { session?.failure }

    fun openStream(): E2eStream {
        if (failureReason() == "removed") throw E2eRemovedException()
        return ensureSession().openStream()
    }

    fun ensureSession(): E2eSession = synchronized(lock) {
        val existing = session
        if (existing != null && existing.isUsable) return existing
        // A dead tunnel must not be reused: close it so the next attempt
        // builds a fresh session instead of writing into a closed socket.
        existing?.close()
        session = null
        val psk = E2eCredentials.psk(token, E2eCredentials.keyId(descriptor.transportKey))
        val hostId = descriptor.hostId
        val targets = ArrayList<E2eTarget>()
        // Spec §3 and §4: the direct routes lead and the relay is the fallback, so a phone at home never pays the
        // relay's round trip and a relay that refuses this device (signed out, outside the rollout) still leaves
        // Wi-Fi working. A descriptor that says `routes: "local"` offers no relay route at all.
        directUrl?.let { targets += E2eTarget.Direct(it) }
        if (descriptor.routes != "local" && hostId != null && descriptor.relays.isNotEmpty()) {
            val admission = E2eCredentials.admission(token, hostId)
            for (node in descriptor.relays) targets += E2eTarget.Relay("wss://$node/v1/phone", hostId, admission)
        }
        if (targets.isEmpty()) throw NoiseException("no_route")

        var lastError: Throwable? = null
        for (target in targets) {
            val candidate = E2eSession(
                connector = connector,
                target = target,
                transportKey = descriptor.transportKey,
                psk = psk,
                app = app,
            )
            try {
                candidate.onClosed = { onTunnelLost?.invoke() }
                candidate.connect()
                session = candidate
                return@synchronized candidate
            } catch (error: Throwable) {
                E2eLog.line("target failed: ${error.message}")
                candidate.close()
                // GoAway(3) inside the tunnel means the owner removed this phone. No other route changes that,
                // so the walk stops here rather than spending the relay's attempt on a device the computer will
                // refuse again (spec §12). A bare 4001 is transient (sidecar busy / pairing window lapsed) and
                // walks on to the relay.
                if (candidate.failure == "removed" || error is E2eRemovedException) throw E2eRemovedException()
                lastError = error
            }
        }
        throw (lastError as? IOException) ?: IOException(lastError?.message ?: "e2e: no route")
    }

    fun close() {
        synchronized(lock) {
            session?.close()
            session = null
        }
    }
}

private class E2eStreamSocket(private val transport: E2eTransport) : Socket() {
    private var stream: E2eStream? = null
    private var timeoutMs = 0
    @Volatile private var closed = false

    private val input = object : InputStream() {
        override fun read(): Int {
            val one = ByteArray(1)
            val read = read(one, 0, 1)
            return if (read <= 0) -1 else one[0].toInt() and 0xFF
        }

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            if (transport.failureReason() == "removed") throw E2eRemovedException()
            val active = stream ?: return -1
            while (true) {
                val read = try {
                    active.read(buffer, offset, length, timeoutMs.toLong())
                } catch (error: java.io.IOException) {
                    // A dead tunnel must not look healthy to the connection pool.
                    closed = true
                    throw error
                }
                if (read < 0) {
                    closed = true
                    return -1
                }
                if (read > 0) return read
                if (timeoutMs > 0) throw SocketTimeoutException("read timed out")
            }
        }

        override fun close() {
            this@E2eStreamSocket.close()
        }
    }

    private val output = object : OutputStream() {
        override fun write(value: Int) {
            write(byteArrayOf(value.toByte()), 0, 1)
        }

        override fun write(buffer: ByteArray, offset: Int, length: Int) {
            if (transport.failureReason() == "removed") throw E2eRemovedException()
            val active = stream ?: throw IOException("e2e: socket not connected")
            if (!active.write(buffer, offset, length)) {
                closed = true
                throw IOException("e2e: stream reset")
            }
        }

        override fun close() {
            runCatching { stream?.finish() }
        }
    }

    override fun connect(endpoint: SocketAddress?, timeout: Int) {
        stream = transport.openStream()
    }

    override fun getInputStream(): InputStream = input

    override fun getOutputStream(): OutputStream = output

    override fun setSoTimeout(timeout: Int) {
        timeoutMs = timeout
    }

    override fun getSoTimeout(): Int = timeoutMs

    override fun isConnected(): Boolean = stream != null && !closed

    override fun isClosed(): Boolean = closed

    override fun close() {
        if (closed) return
        closed = true
        // Closing the whole socket means this connection is abandoned — a cancel, a
        // pool eviction, a reconnecting SSE — not a half-close. finish() would leave
        // the computer's origin socket open (`end: false` in the pipe), so an
        // endless response like /api/events never hears the close and keeps eating
        // tunnel bandwidth as a zombie. reset() destroys the stream on both ends.
        runCatching { stream?.reset() }
        runCatching { super.close() }
    }

    override fun setTcpNoDelay(on: Boolean) = Unit

    override fun setKeepAlive(on: Boolean) = Unit

    override fun shutdownInput() = Unit

    override fun shutdownOutput() = Unit
}
