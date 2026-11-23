package com.lunabot.companion.core.e2e

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread

/** Diagnostics for the tunnel: System.out reaches logcat as `I/System.out`. */
internal object E2eLog {
    fun line(message: String) = println("OMB-E2E $message")
}

/** The owner removed this phone from the computer (GoAway(3) inside the tunnel). */
class E2eRemovedException : java.io.IOException("e2e: this phone was removed from the computer")

/** One WebSocket carrying sealed bytes. The platform supplies it (OkHttp on Android, a fake in tests). */
interface E2eSocket {
    /** False once the socket is closed or failed; a session using it must be replaced. */
    val isOpen: Boolean
    fun sendBinary(bytes: ByteArray)
    fun sendText(text: String)
    fun close(code: Int)
    /** Bytes queued but not yet on the wire; the sender stops above 1 MiB. */
    val bufferedBytes: Long
}

interface E2eSocketListener {
    fun onOpen()
    fun onBinary(bytes: ByteArray)
    fun onText(text: String)
    fun onClosed(code: Int)
    fun onFailure(message: String)
}

fun interface E2eSocketConnector {
    fun connect(url: String, protocols: List<String>, listener: E2eSocketListener): E2eSocket
}

/** Where the phone dials: straight at the computer, or through MuxBot Relay. */
sealed class E2eTarget {
    /** `ws://<lan or tailnet host>:<port>/v1/e2e`, subprotocol `omb-e2e.v1`. */
    data class Direct(val url: String) : E2eTarget()

    /** `wss://<relay host>/v1/phone`, subprotocol `omb-relay.v1`. */
    data class Relay(val url: String, val hostId: ByteArray, val admission: ByteArray) : E2eTarget()
}

/**
 * One E2E session: the relay handshake (when relayed), the Noise handshake, the
 * record layer, and yamux streams carrying raw HTTP/1.1.
 *
 * A session serves many requests; the caller opens a stream per request and
 * writes the HTTP bytes into it.
 */
class E2eSession(
    private val connector: E2eSocketConnector,
    private val target: E2eTarget,
    private val transportKey: ByteArray,
    private val psk: ByteArray,
    private val app: String,
    private val handshakeTimeoutMs: Long = 10_000,
    private val pingIntervalMs: Long = Yamux.PING_INTERVAL_MS,
    private val pingTimeoutMs: Long = Yamux.PING_TIMEOUT_MS,
    private val random: java.security.SecureRandom = java.security.SecureRandom(),
) : E2eSocketListener {
    private val conn = E2eCrypto.randomBytes(Noise.CONN_BYTES, random)
    private val connText = E2eBase64.encode(conn)
    private val ready = CountDownLatch(1)
    private val closed = AtomicBoolean(false)
    private val streams = ConcurrentHashMap<Int, E2eStream>()
    private var socket: E2eSocket? = null
    private var initiator: NoiseInitiator? = null
    private var keys: SessionKeys? = null
    private var mux: YamuxMux? = null
    private var pingTimer: java.util.Timer? = null
    private val lastPong = AtomicLong(System.currentTimeMillis())

    /** Invoked once when this session stops carrying records, whichever way it ends. */
    var onClosed: (() -> Unit)? = null

    @Volatile
    var closeCode: Int = 0
        private set

    @Volatile
    var failure: String? = null
        private set

    val handshakeHash: ByteArray? get() = keys?.handshakeHash

    /** True once records can flow and the underlying socket is still open. */
    val isUsable: Boolean get() = keys != null && !closed.get() && socket?.isOpen == true

    /** Dials, handshakes, and returns once records can flow. */
    fun connect(): E2eSession {
        val protocols = when (target) {
            is E2eTarget.Relay -> listOf("omb-relay.v1")
            is E2eTarget.Direct -> listOf("omb-e2e.v1")
        }
        val url = when (target) {
            is E2eTarget.Relay -> target.url
            is E2eTarget.Direct -> target.url
        }
        initiator = NoiseInitiator(
            transport = if (target is E2eTarget.Relay) Noise.TRANSPORT_RELAY else Noise.TRANSPORT_DIRECT,
            responderStaticPublic = transportKey,
            psk = psk,
            random = random,
        )
        E2eLog.line("dial $url as ${protocols.joinToString(",")}")
        socket = connector.connect(url, protocols, this)
        if (!ready.await(handshakeTimeoutMs, TimeUnit.MILLISECONDS)) {
            E2eLog.line("handshake deadline on $url")
            close(IF_HANDSHAKE_DEADLINE)
            throw NoiseException("handshake_deadline")
        }
        E2eLog.line("ready on $url")
        failure?.let { throw NoiseException(it) }
        startPings()
        return this
    }

    override fun onOpen() {
        E2eLog.line("socket open")
        // The relay wants its hello as the very first frame; direct routes go
        // straight to Noise message 1.
        when (val current = target) {
            is E2eTarget.Relay -> {
                val hello = """{"t":"phone","v":1,"hid":"${E2eBase64.encode(current.hostId)}","adm":"${E2eBase64.encode(current.admission)}"}"""
                socket?.sendText(hello)
            }
            is E2eTarget.Direct -> sendHandshake()
        }
    }

    override fun onText(text: String) {
        E2eLog.line("text ${text.take(80)}")
        when (target) {
            // The relay's only text message on this socket is `ready`; a bad
            // frame shows up as a close code instead.
            is E2eTarget.Relay -> if (text.contains("\"t\":\"ready\"")) sendHandshake()
            is E2eTarget.Direct -> onFailure("unexpected_text")
        }
    }

    private fun sendHandshake() {
        val payload = Noise.encodePayload1(conn, app.take(Noise.MAX_APP_CHARS))
        val message1 = try {
            initiator?.message1(payload) ?: throw NoiseException("no_initiator")
        } catch (error: NoiseException) {
            fail(error.reason)
            return
        }
        socket?.sendBinary(message1)
    }

    override fun onBinary(bytes: ByteArray) {
        if (keys == null) {
            val payload = try {
                val decoded = initiator?.readMessage2(bytes) ?: throw NoiseException("no_initiator")
                keys = initiator?.sessionKeys()
                decoded
            } catch (error: NoiseException) {
                fail(error.reason)
                return
            }
            if (!payloadMatches(payload)) {
                fail("payload2")
                return
            }
            // From here every binary message is one sealed yamux frame.
            mux = YamuxMux("phone", events())
            ready.countDown()
            return
        }

        val frame = try {
            mux?.let { Yamux.decode(keys!!.receive.open(bytes)) }
        } catch (error: NoiseException) {
            fail(error.reason)
            return
        } catch (error: YamuxException) {
            protocolError(error.reason)
            return
        } ?: return
        try {
            mux?.receive(frame)
        } catch (error: YamuxException) {
            protocolError(error.reason)
        }
    }

    private fun payloadMatches(payload: ByteArray): Boolean = try {
        val text = payload.toString(Charsets.UTF_8)
        val json = kotlinx.serialization.json.Json.parseToJsonElement(text) as kotlinx.serialization.json.JsonObject
        val version = (json["v"] as? kotlinx.serialization.json.JsonPrimitive)?.content
        val echoed = (json["conn"] as? kotlinx.serialization.json.JsonPrimitive)?.content
        version == "1" && echoed == connText
    } catch (_: Exception) {
        false
    }

    override fun onClosed(code: Int) {
        E2eLog.line("closed $code")
        closeCode = code
        // A close before the handshake finishes is this route refusing the session, not a live session ending.
        // Without a failure here, `close()` releases the wait in `connect()` and the caller gets a session with no
        // keys: the first request then fails with "handshake incomplete" and no other target is ever tried
        // (spec §9 close codes, §12 what the phone shows).
        if (keys == null && failure == null) failure = refusalFor(code)
        close(0)
    }

    /** What a close code means before any record can flow: a relay refusal is "try the next route", and only a
     * direct route's 4001 is the owner removing this phone (a relay may write any code it likes). */
    private fun refusalFor(code: Int): String = when {
        target is E2eTarget.Direct && code == IF_REJECTED -> "removed"
        code == 4404 -> "asleep"
        code == 4408 -> "relay_no_data_socket"
        code == 4429 -> "relay_busy"
        code == 4503 -> "relay_restarting"
        code == IF_REJECTED -> "relay_rejected"
        else -> "closed_$code"
    }

    override fun onFailure(message: String) {
        E2eLog.line("failure $message")
        fail(message)
    }

    private fun fail(reason: String) {
        E2eLog.line("fail $reason")
        if (failure == null) failure = reason
        ready.countDown()
        close(IF_PROTOCOL)
    }

    private fun protocolError(reason: String) {
        mux?.protocolError()
        if (failure == null) failure = reason
        close(IF_PROTOCOL)
    }

    /** Opens one yamux stream for one HTTP request. */
    fun openStream(): E2eStream {
        check(keys != null) { "e2e: handshake incomplete" }
        val active = mux ?: throw NoiseException("session_closed")
        val streamId = try {
            active.open()
        } catch (error: YamuxException) {
            // The mux refuses a new stream while 64 slots are held (a library
            // that opened streams and wrote nothing) or the IDs are spent.
            // Nothing on this session can carry a new request any more: fail it
            // so isUsable goes false and the transport dials a fresh session on
            // the next request instead of reusing this one until the socket
            // itself dies.
            fail(error.reason)
            throw error
        }
        return E2eStream(this, streamId).also { streams[streamId] = it }
    }

    internal fun muxInstance(): YamuxMux =
        mux ?: throw NoiseException("session_closed")

    private fun events(): YamuxEvents = object : YamuxEvents {
        override fun send(frame: Yamux.Frame) {
            val current = keys ?: return
            try {
                socket?.sendBinary(current.send.seal(Yamux.encode(frame)))
            } catch (error: NoiseException) {
                fail(error.reason)
            }
        }

        override fun data(streamId: Int, data: ByteArray) {
            streams[streamId]?.deliver(data)
            // Handing bytes to the HTTP stack consumes them: grant the window back.
            mux?.consumed(streamId, data.size)
        }

        override fun ended(streamId: Int) {
            streams[streamId]?.remoteEnd()
        }

        override fun reset(streamId: Int) {
            streams.remove(streamId)?.remoteReset()
        }

        override fun writable(streamId: Int) {
            streams[streamId]?.wakeWriter()
        }

        override fun accepted(streamId: Int) {
            streams[streamId]?.wakeWriter()
        }

        override fun goAway(code: Int) {
            E2eLog.line("yamux goaway $code")
            if (code == Yamux.GO_AWAY_REMOVED) failure = "removed"
            close(IF_NORMAL)
        }

        override fun pong(value: Int) {
            lastPong.set(System.currentTimeMillis())
        }
    }

    private fun startPings() {
        val timer = java.util.Timer("e2e-ping", true)
        val seq = AtomicLong(0)
        timer.scheduleAtFixedRate(object : java.util.TimerTask() {
            override fun run() {
                if (closed.get()) return
                if (System.currentTimeMillis() - lastPong.get() > pingIntervalMs + pingTimeoutMs) {
                    fail("ping_timeout")
                    return
                }
                mux?.ping(seq.incrementAndGet().toInt())
            }
        }, pingIntervalMs, pingIntervalMs)
        pingTimer = timer
    }

    fun close(code: Int = IF_NORMAL) {
        if (!closed.compareAndSet(false, true)) return
        runCatching { onClosed?.invoke() }
        pingTimer?.cancel()
        pingTimer = null
        for (stream in streams.values) stream.remoteReset()
        streams.clear()
        try {
            socket?.close(code)
        } catch (_: Exception) {
            // already gone
        }
        ready.countDown()
    }

    companion object {
        const val IF_NORMAL = 1000
        const val IF_GOING_AWAY = 1001
        const val IF_PROTOCOL = 4000
        const val IF_REJECTED = 4001
        const val IF_HANDSHAKE_DEADLINE = 4002
    }
}

/**
 * One yamux stream as a blocking byte pipe: [read] returns -1 at EOF, [write]
 * blocks while the peer's window is closed.
 */
class E2eStream internal constructor(
    private val session: E2eSession,
    val streamId: Int,
) {
    private val inbound = LinkedBlockingQueue<ByteArray>()
    private val stateLock = java.lang.Object()
    private var eof = false
    private var reset = false
    private var pending = ByteArray(0)
    private var pendingOffset = 0

    internal fun deliver(data: ByteArray) {
        if (data.isNotEmpty()) inbound.offer(data)
    }

    internal fun remoteEnd() {
        synchronized(stateLock) { eof = true }
    }

    internal fun remoteReset() {
        synchronized(stateLock) { reset = true }
        inbound.offer(ByteArray(0))
    }

    internal fun wakeWriter() {
        synchronized(stateLock) { stateLock.notifyAll() }
    }

    fun read(buffer: ByteArray, offset: Int = 0, length: Int = buffer.size, timeoutMs: Long = 0): Int {
        if (pendingOffset < pending.size) return copyOut(buffer, offset, length)
        val next = if (timeoutMs > 0) inbound.poll(timeoutMs, TimeUnit.MILLISECONDS) else inbound.take()
        if (next == null) return 0
        if (next.isEmpty()) {
            val ended = synchronized(stateLock) { eof || reset }
            return if (ended) -1 else 0
        }
        pending = next
        pendingOffset = 0
        return copyOut(buffer, offset, length)
    }

    private fun copyOut(buffer: ByteArray, offset: Int, length: Int): Int {
        val count = minOf(length, pending.size - pendingOffset)
        System.arraycopy(pending, pendingOffset, buffer, offset, count)
        pendingOffset += count
        if (pendingOffset >= pending.size) {
            pending = ByteArray(0)
            pendingOffset = 0
        }
        return count
    }

    /** Writes everything, waiting for window; returns false when the stream is gone. */
    fun write(bytes: ByteArray, offset: Int = 0, length: Int = bytes.size): Boolean {
        var sent = 0
        while (sent < length) {
            val taken = session.muxInstance().write(streamId, bytes.copyOfRange(offset + sent, offset + length))
            if (taken > 0) {
                sent += taken
                continue
            }
            synchronized(stateLock) {
                if (reset) return false
                // The peer's ACK or a window update wakes this.
                stateLock.wait(1_000)
            }
        }
        return true
    }

    fun finish() {
        session.muxInstance().finish(streamId)
    }

    fun reset() {
        session.muxInstance().reset(streamId)
    }

    /** Runs [body] on a background thread; returns the thread so callers can join. */
    internal fun runOn(name: String, body: () -> Unit): Thread = thread(start = true, name = name) { body() }
}
