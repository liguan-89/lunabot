package com.openmausbot.companion.core.e2e

import java.nio.ByteBuffer

/**
 * The yamux profile the E2E session carries (spec §7, desktop `companion/src/e2e/yamux.ts`).
 * I/O-free: every rule is testable, and the transport feeds [receive] one frame per record.
 */
object Yamux {
    const val VERSION = 0
    const val TYPE_DATA = 0
    const val TYPE_WINDOW_UPDATE = 1
    const val TYPE_PING = 2
    const val TYPE_GO_AWAY = 3

    const val FLAG_SYN = 0x1
    const val FLAG_ACK = 0x2
    const val FLAG_FIN = 0x4
    const val FLAG_RST = 0x8
    private const val KNOWN_FLAGS = 0xF

    const val GO_AWAY_NORMAL = 0
    const val GO_AWAY_PROTOCOL = 1
    const val GO_AWAY_INTERNAL = 2
    const val GO_AWAY_REMOVED = 3

    const val HEADER_BYTES = 12
    const val MAX_DATA_PAYLOAD = 65_507
    const val INITIAL_WINDOW = 256 * 1024
    const val STREAM_WINDOW = 2 * 1024 * 1024
    const val OPEN_WINDOW_DELTA = STREAM_WINDOW - INITIAL_WINDOW
    const val WINDOW_UPDATE_AFTER = 1024 * 1024
    const val MAX_STREAMS = 64
    const val MAX_STREAM_ID = Int.MAX_VALUE
    const val PING_INTERVAL_MS = 20_000L
    const val PING_TIMEOUT_MS = 10_000L

    data class Frame(
        val type: Int,
        val flags: Int,
        val streamId: Int,
        /** Data: payload size. WindowUpdate: delta. Ping: opaque value. GoAway: code. */
        val length: Int,
        val data: ByteArray? = null,
    )

    fun encode(frame: Frame): ByteArray {
        val payload = if (frame.type == TYPE_DATA) frame.data ?: ByteArray(0) else ByteArray(0)
        if (frame.type == TYPE_DATA && payload.size != frame.length) throw YamuxException("data_length")
        if (payload.size > MAX_DATA_PAYLOAD) throw YamuxException("data_too_large")
        val out = ByteBuffer.allocate(HEADER_BYTES + payload.size)
        out.put(VERSION.toByte())
        out.put(frame.type.toByte())
        out.putShort(frame.flags.toShort())
        out.putInt(frame.streamId)
        out.putInt(frame.length)
        out.put(payload)
        return out.array()
    }

    /** Everything that can be checked without stream state. */
    fun decode(bytes: ByteArray): Frame {
        if (bytes.size < HEADER_BYTES) throw YamuxException("short_frame")
        val view = ByteBuffer.wrap(bytes)
        if (view.get().toInt() and 0xFF != VERSION) throw YamuxException("version")
        val type = view.get().toInt() and 0xFF
        if (type > TYPE_GO_AWAY) throw YamuxException("type")
        val flags = view.short.toInt() and 0xFFFF
        if (flags and KNOWN_FLAGS.inv() != 0) throw YamuxException("flags")
        val streamId = view.int
        val length = view.int
        if (type == TYPE_DATA) {
            if (length > MAX_DATA_PAYLOAD) throw YamuxException("data_too_large")
            if (bytes.size != HEADER_BYTES + length) throw YamuxException("data_length")
            if (streamId == 0) throw YamuxException("stream_zero")
            return Frame(type, flags, streamId, length, bytes.copyOfRange(HEADER_BYTES, bytes.size))
        }
        if (bytes.size != HEADER_BYTES) throw YamuxException("trailing_bytes")
        if (type == TYPE_WINDOW_UPDATE) {
            if (streamId == 0) throw YamuxException("stream_zero")
        } else {
            if (streamId != 0) throw YamuxException("session_frame_stream")
            if (type == TYPE_PING && flags != FLAG_SYN && flags != FLAG_ACK) throw YamuxException("ping_flags")
            if (type == TYPE_GO_AWAY && flags != 0) throw YamuxException("goaway_flags")
        }
        return Frame(type, flags, streamId, length)
    }

    fun openFrame(streamId: Int) = Frame(TYPE_WINDOW_UPDATE, FLAG_SYN, streamId, OPEN_WINDOW_DELTA)
    fun acceptFrame(streamId: Int) = Frame(TYPE_WINDOW_UPDATE, FLAG_ACK, streamId, OPEN_WINDOW_DELTA)
    fun resetFrame(streamId: Int) = Frame(TYPE_WINDOW_UPDATE, FLAG_RST, streamId, 0)
    fun finFrame(streamId: Int) = Frame(TYPE_WINDOW_UPDATE, FLAG_FIN, streamId, 0)
    fun windowFrame(streamId: Int, delta: Int) = Frame(TYPE_WINDOW_UPDATE, 0, streamId, delta)
    fun dataFrame(streamId: Int, data: ByteArray, flags: Int = 0) = Frame(TYPE_DATA, flags, streamId, data.size, data)
    fun pingFrame(value: Int, flags: Int = FLAG_SYN) = Frame(TYPE_PING, flags, 0, value)
    fun goAwayFrame(code: Int) = Frame(TYPE_GO_AWAY, 0, 0, code)
}

class YamuxException(val reason: String) : Exception("yamux: $reason")

/** Every frame to seal and send, plus the stream events the HTTP bridge reacts to. */
interface YamuxEvents {
    fun send(frame: Yamux.Frame)
    fun data(streamId: Int, data: ByteArray)
    fun ended(streamId: Int)
    fun reset(streamId: Int)
    fun writable(streamId: Int)
    fun accepted(streamId: Int) {}
    fun opened(streamId: Int) {}
    fun goAway(code: Int) {}
    fun pong(value: Int) {}
}

private class StreamState(
    var established: Boolean,
    var receiveWindow: Int,
    var sendWindow: Int,
) {
    var uncredited: Int = 0
    var localFin: Boolean = false
    var remoteFin: Boolean = false
}

/**
 * The phone opens every stream; the computer only accepts. A frame that breaks
 * the profile throws [YamuxException]; the caller then sends GoAway(1) via
 * [protocolError] and closes the session with 4000.
 */
class YamuxMux(private val role: String, private val events: YamuxEvents) {
    private val streams = HashMap<Int, StreamState>()
    private var highestId = 0
    var peerGoneAway: Boolean = false
        private set
    private var localGoneAway = false

    val activeStreams: Int get() = streams.size

    fun has(streamId: Int): Boolean = streams.containsKey(streamId)

    fun sendWindow(streamId: Int): Int = streams[streamId]?.sendWindow ?: 0

    /** Data may follow at once, within the first 256 KiB. */
    @Synchronized
    fun open(): Int {
        if (role != "phone") throw YamuxException("computer_open")
        if (localGoneAway || peerGoneAway) throw YamuxException("gone_away")
        if (streams.size >= Yamux.MAX_STREAMS) throw YamuxException("too_many_streams")
        val streamId = if (highestId == 0) 1 else highestId + 2
        if (streamId > Yamux.MAX_STREAM_ID) throw YamuxException("ids_exhausted")
        highestId = streamId
        streams[streamId] = StreamState(
            established = false,
            receiveWindow = Yamux.INITIAL_WINDOW + Yamux.OPEN_WINDOW_DELTA,
            sendWindow = Yamux.INITIAL_WINDOW,
        )
        events.send(Yamux.openFrame(streamId))
        return streamId
    }

    /** The computer side, once its origin socket is connected. */
    @Synchronized
    fun accept(streamId: Int) {
        val stream = streams[streamId] ?: return
        if (stream.established || role != "computer") return
        stream.established = true
        stream.receiveWindow += Yamux.OPEN_WINDOW_DELTA
        events.send(Yamux.acceptFrame(streamId))
    }

    /** Sends up to the window and the frame cap; returns the bytes taken. */
    @Synchronized
    fun write(streamId: Int, data: ByteArray, offset: Int = 0): Int {
        val stream = streams[streamId] ?: return 0
        if (stream.localFin || (role == "computer" && !stream.established)) return 0
        val size = minOf(data.size - offset, stream.sendWindow, Yamux.MAX_DATA_PAYLOAD)
        if (size <= 0) return 0
        stream.sendWindow -= size
        events.send(Yamux.dataFrame(streamId, data.copyOfRange(offset, offset + size)))
        return size
    }

    @Synchronized
    fun finish(streamId: Int) {
        val stream = streams[streamId] ?: return
        if (stream.localFin) return
        stream.localFin = true
        events.send(Yamux.finFrame(streamId))
        closeIfDone(streamId, stream)
    }

    @Synchronized
    fun reset(streamId: Int) {
        if (streams.remove(streamId) == null) return
        events.send(Yamux.resetFrame(streamId))
        events.reset(streamId)
    }

    /** The receiver handed `bytes` on; grants them back in 1 MiB steps. */
    @Synchronized
    fun consumed(streamId: Int, bytes: Int) {
        val stream = streams[streamId] ?: return
        if (stream.remoteFin) return
        stream.uncredited += bytes
        if (stream.uncredited < Yamux.WINDOW_UPDATE_AFTER) return
        val delta = stream.uncredited
        stream.uncredited = 0
        stream.receiveWindow += delta
        events.send(Yamux.windowFrame(streamId, delta))
    }

    @Synchronized
    fun ping(value: Int) {
        events.send(Yamux.pingFrame(value))
    }

    @Synchronized
    fun goAway(code: Int = Yamux.GO_AWAY_NORMAL) {
        localGoneAway = true
        events.send(Yamux.goAwayFrame(code))
    }

    /** Sends GoAway(1); the caller closes with 4000. */
    @Synchronized
    fun protocolError() {
        goAway(Yamux.GO_AWAY_PROTOCOL)
        closeAll()
    }

    @Synchronized
    fun closeAll() {
        val ids = streams.keys.toList()
        streams.clear()
        for (id in ids) events.reset(id)
    }

    @Synchronized
    fun receive(frame: Yamux.Frame) {
        when (frame.type) {
            Yamux.TYPE_PING -> {
                if (frame.flags == Yamux.FLAG_SYN) events.send(Yamux.pingFrame(frame.length, Yamux.FLAG_ACK))
                else events.pong(frame.length)
                return
            }
            Yamux.TYPE_GO_AWAY -> {
                peerGoneAway = true
                events.goAway(frame.length)
                return
            }
        }
        if (frame.flags and Yamux.FLAG_SYN != 0) {
            receiveOpen(frame)
            return
        }
        if (frame.flags and Yamux.FLAG_ACK != 0) {
            receiveAck(frame)
            return
        }
        val stream = known(frame.streamId) ?: return
        receiveOnStream(frame.streamId, stream, frame)
    }

    /** An ended stream is ignored: an RST and the peer's last frames cross. An ID never opened is an error. */
    private fun known(streamId: Int): StreamState? {
        if (streamId % 2 == 0 || streamId > highestId) throw YamuxException("unknown_stream")
        return streams[streamId]
    }

    private fun receiveOpen(frame: Yamux.Frame) {
        if (role == "phone") throw YamuxException("computer_opened_stream")
        if (frame.type != Yamux.TYPE_WINDOW_UPDATE || frame.flags != Yamux.FLAG_SYN) throw YamuxException("open_flags")
        if (frame.streamId % 2 == 0) throw YamuxException("even_stream")
        if (frame.streamId <= highestId) throw YamuxException("stream_reused")
        highestId = frame.streamId
        if (localGoneAway || streams.size >= Yamux.MAX_STREAMS) {
            events.send(Yamux.resetFrame(frame.streamId))
            return
        }
        streams[frame.streamId] = StreamState(
            established = false,
            receiveWindow = Yamux.INITIAL_WINDOW,
            sendWindow = Yamux.INITIAL_WINDOW + frame.length,
        )
        events.opened(frame.streamId)
    }

    private fun receiveAck(frame: Yamux.Frame) {
        if (role == "computer") throw YamuxException("phone_ack")
        if (frame.type != Yamux.TYPE_WINDOW_UPDATE ||
            frame.flags and (Yamux.FLAG_ACK or Yamux.FLAG_FIN or Yamux.FLAG_RST).inv() != 0
        ) {
            throw YamuxException("ack_flags")
        }
        val stream = known(frame.streamId) ?: return
        if (stream.established) throw YamuxException("duplicate_ack")
        stream.established = true
        events.accepted(frame.streamId)
        receiveOnStream(
            frame.streamId,
            stream,
            frame.copy(flags = frame.flags and Yamux.FLAG_ACK.inv(), data = frame.data),
        )
    }

    private fun receiveOnStream(streamId: Int, stream: StreamState, frame: Yamux.Frame) {
        if (frame.flags and Yamux.FLAG_RST != 0) {
            streams.remove(streamId)
            events.reset(streamId)
            return
        }
        if (frame.type == Yamux.TYPE_DATA) {
            if (stream.remoteFin && (frame.length > 0 || frame.flags and Yamux.FLAG_FIN != 0)) {
                throw YamuxException("data_after_fin")
            }
            if (frame.length > stream.receiveWindow) throw YamuxException("window_exceeded")
            stream.receiveWindow -= frame.length
            if (frame.length > 0) events.data(streamId, frame.data ?: ByteArray(0))
        } else if (frame.length > 0) {
            stream.sendWindow += frame.length
            events.writable(streamId)
        }
        if (frame.flags and Yamux.FLAG_FIN != 0) {
            if (stream.remoteFin) throw YamuxException("data_after_fin")
            stream.remoteFin = true
            events.ended(streamId)
            closeIfDone(streamId, stream)
        }
    }

    private fun closeIfDone(streamId: Int, stream: StreamState) {
        if (stream.localFin && stream.remoteFin) streams.remove(streamId)
    }
}
