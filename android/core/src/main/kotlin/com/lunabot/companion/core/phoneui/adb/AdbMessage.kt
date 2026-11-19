/*
 * Ported from Mika (https://github.com/wangzan101/Mika), file
 * core/src/main/kotlin/com/wangzan101/mika/core/adb/AdbMessage.kt.
 * Copyright 2026 wangzan101. The original is licensed under the Apache License,
 * Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 OpenMausBot contributors. Changes from the
 * original: repackaged under com.lunabot.companion.core.phoneui.adb and
 * comments translated into English.
 */
package com.lunabot.companion.core.phoneui.adb

import java.io.DataInputStream
import java.io.EOFException
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * One packet of the adb transport: a 24-byte little-endian header (command, arg0, arg1, data
 * length, data checksum, command inverted) followed by the data.
 * The checksum is the sum of all data bytes (unsigned); with a protocol version >=
 * [VERSION_SKIP_CHECKSUM] the receiver no longer verifies it.
 */
class AdbMessage(val command: Int, val arg0: Int, val arg1: Int, val data: ByteArray = EMPTY) {
    fun encode(): ByteArray {
        val bb = ByteBuffer.allocate(HEADER_SIZE + data.size).order(ByteOrder.LITTLE_ENDIAN)
        bb.putInt(command).putInt(arg0).putInt(arg1).putInt(data.size).putInt(checksum(data)).putInt(command.inv())
        bb.put(data)
        return bb.array()
    }

    override fun toString() = "${name(command)}($arg0, $arg1, ${data.size} bytes)"

    companion object {
        const val CNXN = 0x4e584e43
        const val AUTH = 0x48545541
        const val OPEN = 0x4e45504f
        const val OKAY = 0x59414b4f
        const val CLSE = 0x45534c43
        const val WRTE = 0x45545257
        const val STLS = 0x534c5453

        const val VERSION = 0x01000001
        const val VERSION_SKIP_CHECKSUM = 0x01000001
        const val STLS_VERSION = 0x01000000
        const val MAX_PAYLOAD = 1024 * 1024
        const val HEADER_SIZE = 24
        private val EMPTY = ByteArray(0)

        fun checksum(data: ByteArray): Int {
            var sum = 0
            for (b in data) sum += b.toInt() and 0xff
            return sum
        }

        fun name(cmd: Int): String =
            ByteArray(4) { (cmd ushr (8 * it)).toByte() }.toString(Charsets.US_ASCII).takeIf { s -> s.all { it in 'A'..'Z' } } ?: "0x%08x".format(cmd)

        /** Reads one packet; null on end of stream before a header, [IOException] on a malformed one. */
        fun read(input: DataInputStream, maxData: Int = MAX_PAYLOAD, verifyChecksum: Boolean = false): AdbMessage? {
            val header = ByteArray(HEADER_SIZE)
            try {
                input.readFully(header)
            } catch (e: EOFException) {
                return null
            }
            val bb = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN)
            val cmd = bb.getInt()
            val a0 = bb.getInt()
            val a1 = bb.getInt()
            val len = bb.getInt()
            val sum = bb.getInt()
            val magic = bb.getInt()
            if (magic != cmd.inv()) throw IOException("bad adb packet magic for ${name(cmd)}")
            if (len < 0 || len > maxData) throw IOException("adb packet too large: $len")
            val data = if (len == 0) EMPTY else ByteArray(len).also { input.readFully(it) }
            if (verifyChecksum && checksum(data) != sum) throw IOException("bad adb packet checksum")
            return AdbMessage(cmd, a0, a1, data)
        }
    }
}
