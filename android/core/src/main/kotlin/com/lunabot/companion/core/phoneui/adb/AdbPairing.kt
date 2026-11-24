/*
 * Ported from Mika (https://github.com/wangzan101/Mika), file
 * core/src/main/kotlin/com/wangzan101/mika/core/adb/AdbPairing.kt.
 * Copyright 2026 wangzan101. The original is licensed under the Apache License,
 * Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 LunaBot contributors. Changes from the
 * original: repackaged under com.lunabot.companion.core.phoneui.adb, comments
 * translated into English, and the mDNS/NSD service discovery types
 * (AdbServiceTypes, AdbServiceFinder) are not ported, that stays app-side.
 */
package com.lunabot.companion.core.phoneui.adb

import java.io.DataInputStream
import java.io.EOFException
import java.io.IOException
import java.io.OutputStream
import java.nio.ByteBuffer
import javax.crypto.AEADBadTagException
import javax.net.ssl.SSLException
import javax.net.ssl.SSLSocket

class AdbPairingException(val reason: Reason, message: String, cause: Throwable? = null) : IOException(message, cause) {
    enum class Reason {
        /** The target is not this device's own address: refused before any Socket is created, must not be retried as a network failure. */
        NOT_LOCAL,
        CONNECT_FAILED, TLS_FAILED, WRONG_CODE, PROTOCOL,
    }
}

/** The identity the device reports on a successful pairing (usually a type=1 device GUID). */
class AdbPeerInfo(val type: Int, val data: String)

/**
 * Pairing with a wireless-debugging pairing code (client). The flow:
 * TLS 1.3 -> export 64 bytes of keying material ("adb-label\0") -> password = pairing code +
 * exported key -> exchange SPAKE2 messages -> exchange 8192-byte PeerInfo over the negotiated
 * AES-GCM (we send the adb public key, the device replies with the GUID).
 * Each packet is preceded by a 6-byte header: version (1), type (0=SPAKE2, 1=PEER_INFO),
 * payload length (big-endian uint32).
 */
class AdbPairing(private val tls: AdbTls) {
    /** Pairs with the device on this machine; the verified address is the one actually connected to, the host is never re-resolved. */
    fun pair(host: String, port: Int, code: String, timeoutMs: Int = 15_000): AdbPeerInfo {
        val target = AdbHosts.ownSocketAddress(host, port) ?: throw AdbPairingException(
            AdbPairingException.Reason.NOT_LOCAL,
            "refusing to pair with $host: adb is only reachable on this device",
        )
        val socket = try {
            tls.connect(target, timeoutMs)
        } catch (e: SSLException) {
            throw AdbPairingException(AdbPairingException.Reason.TLS_FAILED, "TLS handshake failed", e)
        } catch (e: IOException) {
            throw AdbPairingException(AdbPairingException.Reason.CONNECT_FAILED, "cannot connect to $host:$port", e)
        }
        socket.use { return exchange(it, code) }
    }

    private fun exchange(socket: SSLSocket, code: String): AdbPeerInfo {
        val exported = tls.exportKeyingMaterial(socket, EXPORT_LABEL, EXPORT_LENGTH)
        val auth = PairingAuth.client(code.toByteArray(Charsets.UTF_8) + exported)
        val input = DataInputStream(socket.inputStream)
        val output = socket.outputStream

        writePacket(output, TYPE_SPAKE2, auth.message)
        val theirMsg = readPacket(input, TYPE_SPAKE2) ?: throw protocol("connection closed before key exchange")
        try {
            auth.initCipher(theirMsg)
        } catch (e: IllegalArgumentException) {
            throw protocol("bad key exchange message: ${e.message}")
        }

        val info = ByteArray(PEER_INFO_SIZE)
        info[0] = PEER_RSA_PUB_KEY
        val key = tls.identity.adbPublicKey.toByteArray(Charsets.UTF_8)
        check(key.size < PEER_INFO_SIZE - 1)
        System.arraycopy(key, 0, info, 1, key.size)
        writePacket(output, TYPE_PEER_INFO, auth.encrypt(info))

        // With a wrong pairing code the device cannot decrypt our PeerInfo and simply disconnects.
        val sealed = try {
            readPacket(input, TYPE_PEER_INFO)
        } catch (e: IOException) {
            if (e is AdbPairingException) throw e
            null
        } ?: throw AdbPairingException(AdbPairingException.Reason.WRONG_CODE, "device closed the connection (wrong pairing code?)")
        val plain = try {
            auth.decrypt(sealed)
        } catch (e: AEADBadTagException) {
            throw AdbPairingException(AdbPairingException.Reason.WRONG_CODE, "cannot decrypt device info (wrong pairing code?)", e)
        }
        if (plain.size != PEER_INFO_SIZE) throw protocol("peer info has ${plain.size} bytes")
        var end = 1
        while (end < plain.size && plain[end] != 0.toByte()) end++
        return AdbPeerInfo(plain[0].toInt() and 0xff, String(plain, 1, end - 1, Charsets.UTF_8))
    }

    private fun protocol(msg: String) = AdbPairingException(AdbPairingException.Reason.PROTOCOL, msg)

    companion object {
        const val EXPORT_LABEL = "adb-label\u0000"
        const val EXPORT_LENGTH = 64
        const val PEER_INFO_SIZE = 8192
        const val MAX_PAYLOAD = PEER_INFO_SIZE * 2
        const val VERSION: Byte = 1
        const val TYPE_SPAKE2: Byte = 0
        const val TYPE_PEER_INFO: Byte = 1
        const val PEER_RSA_PUB_KEY: Byte = 0
        const val PEER_DEVICE_GUID: Byte = 1

        fun writePacket(out: OutputStream, type: Byte, payload: ByteArray) {
            val header = ByteBuffer.allocate(6).put(VERSION).put(type).putInt(payload.size).array()
            out.write(header + payload)
            out.flush()
        }

        /** Reads one packet and checks its type; null if the peer disconnects before the header. */
        fun readPacket(input: DataInputStream, expectedType: Byte): ByteArray? {
            val header = ByteArray(6)
            try {
                input.readFully(header)
            } catch (e: EOFException) {
                return null
            }
            val bb = ByteBuffer.wrap(header)
            val version = bb.get()
            val type = bb.get()
            val len = bb.getInt()
            if (version != VERSION) throw AdbPairingException(AdbPairingException.Reason.PROTOCOL, "unsupported pairing version $version")
            if (type != expectedType) throw AdbPairingException(AdbPairingException.Reason.PROTOCOL, "unexpected packet type $type")
            if (len <= 0 || len > MAX_PAYLOAD) throw AdbPairingException(AdbPairingException.Reason.PROTOCOL, "bad payload size $len")
            return ByteArray(len).also { input.readFully(it) }
        }
    }
}
