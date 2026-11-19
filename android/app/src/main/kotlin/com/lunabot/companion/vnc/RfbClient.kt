package com.openmausbot.companion.vnc

import java.io.ByteArrayOutputStream

/**
 * A minimal RFB (VNC) 3.8 client: enough to show a Local VM and drive its
 * pointer and keyboard over the companion's viewer relay.
 *
 * The relay hands the phone raw RFB bytes over a WebSocket (`websockify`), so
 * there is no noVNC in between and nothing here parses a browser. The scope is
 * deliberate: security type None only, a 32-bpp little-endian true colour
 * pixel format, and Raw rectangles. Encodings the server might prefer
 * (CopyRect, ZRLE, Tight) are not requested, so it sends Raw or nothing.
 *
 * VNC Auth (RFB's DES challenge-response) is not implemented: DES is weak by
 * modern standards, and the bytes already travel inside the relay's TLS. The
 * viewer is only reachable through the paired, lease-bound relay, so the
 * server's own password handshake adds no transport protection this app does
 * not already have. A server that offers only VNC Auth is refused with an
 * explicit message rather than silently downgraded.
 *
 * The class is a pure state machine over a byte buffer: [feed] consumes any
 * number of bytes — a WebSocket frame boundary need not be a message boundary —
 * and [takeOutbound] returns what the client must send next. That is what makes
 * the handshake and the update decoder testable without a socket.
 */
class RfbClient {

    sealed interface Event {
        /** ServerInit arrived; the framebuffer is this big and the handshake is done. */
        data class Ready(val width: Int, val height: Int, val name: String) : Event

        /** One Raw rectangle in ARGB pixels, row-major, [width] × [height]. */
        data class Rectangle(
            val x: Int,
            val y: Int,
            val width: Int,
            val height: Int,
            val pixels: IntArray,
        ) : Event {
            override fun equals(other: Any?): Boolean =
                other is Rectangle && x == other.x && y == other.y &&
                    width == other.width && height == other.height && pixels.contentEquals(other.pixels)

            override fun hashCode(): Int =
                (((x * 31 + y) * 31 + width) * 31 + height) * 31 + pixels.contentHashCode()
        }

        data class Bell(val message: String) : Event

        data class Clipboard(val text: String) : Event

        /** The server ended the session, or the protocol could not be followed. */
        data class Closed(val reason: String) : Event
    }

    private enum class Phase {
        WAIT_VERSION,
        WAIT_SECURITY_TYPES,
        WAIT_AUTH_RESULT,
        WAIT_INIT,
        READY,
    }

    private var phase = Phase.WAIT_VERSION
    private val inbox = ByteArrayOutputStream()
    private val outbox = ByteArrayOutputStream()

    // Framebuffer geometry, known after ServerInit.
    var width: Int = 0
        private set
    var height: Int = 0
        private set

    /** The buffer [feed] has not consumed yet; exposed for diagnostics. */
    val pendingBytes: Int get() = inbox.size()

    fun takeOutbound(): ByteArray {
        val bytes = outbox.toByteArray()
        outbox.reset()
        return bytes
    }

    /** Handshake bytes the client owes before the server says anything. */
    fun start(): ByteArray {
        writeVersion()
        return takeOutbound()
    }

    fun feed(bytes: ByteArray): List<Event> {
        inbox.write(bytes)
        val events = mutableListOf<Event>()
        while (step(events)) {
            // step() consumed as much as it could.
        }
        return events
    }

    fun requestUpdate(incremental: Boolean) {
        outbox.write(byteArrayOf(3, if (incremental) 1 else 0))
        write16(0)
        write16(0)
        write16(width)
        write16(height)
    }

    fun pointer(x: Int, y: Int, buttonMask: Int) {
        outbox.write(byteArrayOf(5, buttonMask.toByte()))
        write16(x.coerceAtLeast(0))
        write16(y.coerceAtLeast(0))
    }

    fun key(keysym: Int, down: Boolean) {
        outbox.write(byteArrayOf(4, if (down) 1 else 0, 0, 0))
        outbox.write(
            byteArrayOf(
                (keysym ushr 24).toByte(),
                (keysym ushr 16).toByte(),
                (keysym ushr 8).toByte(),
                keysym.toByte(),
            ),
        )
    }

    // MARK: - Parsing

    private fun step(events: MutableList<Event>): Boolean {
        val data = inbox.toByteArray()
        val consumed = when (phase) {
            Phase.WAIT_VERSION -> readVersion(data, events)
            Phase.WAIT_SECURITY_TYPES -> readSecurityTypes(data, events)
            Phase.WAIT_AUTH_RESULT -> readAuthResult(data, events)
            Phase.WAIT_INIT -> readInit(data, events)
            Phase.READY -> readMessage(data, events)
        }
        if (consumed <= 0) return false
        inbox.reset()
        inbox.write(data, consumed, data.size - consumed)
        return inbox.size() > 0
    }

    private fun readVersion(data: ByteArray, events: MutableList<Event>): Int {
        if (data.size < 12) return 0
        val text = String(data, 0, 12, Charsets.US_ASCII)
        if (!text.startsWith("RFB ")) {
            events += Event.Closed("服务器没有按 VNC 协议回答：$text")
            phase = Phase.WAIT_VERSION
            return 0
        }
        // 3.8 is what this client speaks; 3.3/3.7 answer with a different
        // security phase, which the relay's noVNC never asks for.
        writeVersion()
        phase = Phase.WAIT_SECURITY_TYPES
        return 12
    }

    private fun readSecurityTypes(data: ByteArray, events: MutableList<Event>): Int {
        if (data.size < 1) return 0
        val count = data[0].toInt() and 0xFF
        if (count == 0) {
            // 3.8 sends a reason string after a zero count.
            val reason = if (data.size > 4) {
                val length = readU32(data, 1)
                if (data.size >= 5 + length) String(data, 5, length, Charsets.UTF_8) else "服务器拒绝连接。"
            } else {
                "服务器拒绝连接。"
            }
            events += Event.Closed(reason)
            return 0
        }
        if (data.size < 1 + count) return 0
        val types = data.copyOfRange(1, 1 + count).map { it.toInt() and 0xFF }
        if (!types.contains(SEC_NONE)) {
            events += Event.Closed(
                "这台电脑要求 VNC 密码认证，当前构建只接受无需密码的本机连接。",
            )
            return 0
        }
        outbox.write(SEC_NONE)
        phase = Phase.WAIT_AUTH_RESULT
        return 1 + count
    }

    private fun readAuthResult(data: ByteArray, events: MutableList<Event>): Int {
        if (data.size < 4) return 0
        val result = readU32(data, 0)
        if (result != 0) {
            val reason = if (data.size > 8) {
                val length = readU32(data, 4)
                if (data.size >= 8 + length) String(data, 8, length, Charsets.UTF_8) else "认证失败。"
            } else {
                "认证失败。"
            }
            events += Event.Closed(reason)
            return 0
        }
        // ClientInit(shared = 1) follows a successful result.
        outbox.write(1)
        phase = Phase.WAIT_INIT
        return 4
    }

    private fun readInit(data: ByteArray, events: MutableList<Event>): Int {
        if (data.size < 24) return 0
        val w = readU16(data, 0)
        val h = readU16(data, 2)
        val nameLength = readU32(data, 20)
        if (data.size < 24 + nameLength) return 0
        val name = String(data, 24, nameLength, Charsets.UTF_8)
        width = w
        height = h
        // Pixel format, then only Raw: a server that honours this sends what
        // the decoder below understands.
        outbox.write(setPixelFormat())
        outbox.write(setEncodings())
        phase = Phase.READY
        events += Event.Ready(w, h, name)
        requestUpdate(incremental = false)
        return 24 + nameLength
    }

    private fun readMessage(data: ByteArray, events: MutableList<Event>): Int {
        if (data.isEmpty()) return 0
        return when (data[0].toInt() and 0xFF) {
            MSG_FRAMEBUFFER_UPDATE -> readUpdate(data, events)
            MSG_SET_COLOUR_MAP -> {
                // Never requested: this client uses a true-colour format, and a
                // colour-map message has no length this parser can skip.
                events += Event.Closed("服务器发送了未协商的调色板消息。")
                0
            }
            MSG_BELL -> {
                events += Event.Bell("")
                1
            }
            MSG_SERVER_CUT_TEXT -> {
                if (data.size < 8) return 0
                val length = readU32(data, 4)
                if (data.size < 8 + length) return 0
                events += Event.Clipboard(String(data, 8, length, Charsets.ISO_8859_1))
                8 + length
            }
            else -> {
                // An unknown message would desynchronise every byte after it;
                // closing is the only safe reading.
                events += Event.Closed("服务器发送了此版本不认识的画面消息。")
                0
            }
        }
    }

    private fun readUpdate(data: ByteArray, events: MutableList<Event>): Int {
        if (data.size < 4) return 0
        val count = readU16(data, 2)
        var offset = 4
        val rects = mutableListOf<Event.Rectangle>()
        repeat(count) {
            if (data.size < offset + 12) return 0
            val x = readU16(data, offset)
            val y = readU16(data, offset + 2)
            val w = readU16(data, offset + 4)
            val h = readU16(data, offset + 6)
            val encoding = readU32(data, offset + 8)
            offset += 12
            if (encoding != ENCODING_RAW) {
                // It should never happen — Raw is the only encoding offered —
                // and this client cannot skip an unknown payload's length.
                events += Event.Closed("服务器使用了未协商的画面编码。")
                return 0
            }
            val bytes = w * h * 4
            if (data.size < offset + bytes) return 0
            val pixels = IntArray(w * h)
            for (index in pixels.indices) {
                val base = offset + index * 4
                // little-endian B, G, R, pad → ARGB.
                val b = data[base].toInt() and 0xFF
                val g = data[base + 1].toInt() and 0xFF
                val r = data[base + 2].toInt() and 0xFF
                pixels[index] = (0xFF shl 24) or (r shl 16) or (g shl 8) or b
            }
            offset += bytes
            rects += Event.Rectangle(x, y, w, h, pixels)
        }
        events += rects
        return offset
    }

    // MARK: - Pieces

    private fun writeVersion() {
        outbox.write("RFB 003.008\n".toByteArray(Charsets.US_ASCII))
    }

    private fun setPixelFormat(): ByteArray {
        val format = ByteArray(20)
        format[4] = 32
        format[5] = 24
        format[7] = 1
        format[9] = 255.toByte() // red max
        format[11] = 255.toByte() // green max
        format[13] = 255.toByte() // blue max
        format[14] = 16 // red shift
        format[15] = 8 // green shift
        return format
    }

    private fun setEncodings(): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(byteArrayOf(2, 0, 0, 1)) // type, padding, count = 1
        out.write(
            byteArrayOf(0, 0, 0, ENCODING_RAW.toByte()), // Raw
        )
        return out.toByteArray()
    }

    private fun write16(value: Int) {
        outbox.write((value ushr 8) and 0xFF)
        outbox.write(value and 0xFF)
    }

    private companion object {
        const val SEC_NONE = 1
        const val MSG_FRAMEBUFFER_UPDATE = 0
        const val MSG_SET_COLOUR_MAP = 1
        const val MSG_BELL = 2
        const val MSG_SERVER_CUT_TEXT = 3
        const val ENCODING_RAW = 0

        fun readU16(data: ByteArray, at: Int): Int =
            ((data[at].toInt() and 0xFF) shl 8) or (data[at + 1].toInt() and 0xFF)

        fun readU32(data: ByteArray, at: Int): Int =
            ((data[at].toInt() and 0xFF) shl 24) or
                ((data[at + 1].toInt() and 0xFF) shl 16) or
                ((data[at + 2].toInt() and 0xFF) shl 8) or
                (data[at + 3].toInt() and 0xFF)
    }
}
