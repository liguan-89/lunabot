/*
 * Ported from Mika (https://github.com/wangzan101/Mika), file
 * core/src/test/kotlin/com/wangzan101/mika/core/adb/TestTls.kt.
 * Copyright 2026 wangzan101. The original is licensed under the Apache License,
 * Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 LunaBot contributors. Changes from the
 * original: repackaged under com.lunabot.companion.core.phoneui.adb, comments
 * translated into English, and assertions moved from JUnit 4 to kotlin.test.
 */
package com.lunabot.companion.core.phoneui.adb

import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.security.Provider
import javax.crypto.AEADBadTagException
import kotlin.concurrent.thread
import org.conscrypt.Conscrypt

/** kotlin.test no longer ships assertArrayEquals; compare byte arrays with the differing lengths in the message. */
internal fun assertArrayEquals(expected: ByteArray?, actual: ByteArray?, message: String? = null) {
    kotlin.test.assertTrue(
        expected.contentEquals(actual),
        (message?.let { "$it: " } ?: "") + "expected ${expected?.size ?: "null"} bytes [${expected?.joinToString("") { "%02x".format(it) }}] " +
            "but was ${actual?.size ?: "null"} bytes [${actual?.joinToString("") { "%02x".format(it) }}]",
    )
}

/** TLS for JVM tests: the same implementation family as the Android platform, providing TLS 1.3 and key export. */
object TestTls {
    val provider: Provider by lazy { Conscrypt.newProvider() }
    val exporter = KeyingMaterialExporter { s, label, len -> Conscrypt.exportKeyingMaterial(s, label, null, len) }

    /** Keys shared by the tests (RSA-2048 generation is slow, do it once). */
    val client: AdbIdentity by lazy { AdbIdentity.generate("dexbot@test") }
    val device: AdbIdentity by lazy { AdbIdentity.generate("device") }

    fun tls(identity: AdbIdentity) = AdbTls(identity, exporter, provider)
}

/** In-process fake pairing server that walks the device-side flow. [behavior] creates the various failure cases. */
class FakePairingServer(
    private val code: String,
    private val behavior: Behavior = Behavior.NORMAL,
    private val guid: String = "adb-FAKE0001-abc123",
) : AutoCloseable {
    enum class Behavior { NORMAL, BAD_HEADER_VERSION, WRONG_TYPE, CLOSE_AFTER_SPAKE }

    private val server = ServerSocket(0, 1, InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)))
    val port: Int get() = server.localPort
    @Volatile var receivedKey: String? = null
    @Volatile var clientCertKey: ByteArray? = null
    @Volatile var error: Throwable? = null
    private val tls = TestTls.tls(TestTls.device)

    private val worker = thread(isDaemon = true, name = "fake-pairing") {
        try {
            server.accept().use { plain -> serve(plain) }
        } catch (t: Throwable) {
            error = t
        }
    }

    private fun serve(plain: java.net.Socket) {
        val s = tls.wrap(plain, InetSocketAddress(plain.localAddress, port), client = false)
        s.use {
            clientCertKey = (s.session.peerCertificates[0] as java.security.cert.X509Certificate).publicKey.encoded
            val exported = tls.exportKeyingMaterial(s, AdbPairing.EXPORT_LABEL, AdbPairing.EXPORT_LENGTH)
            val auth = PairingAuth.server(code.toByteArray() + exported)
            val input = java.io.DataInputStream(s.inputStream)
            val out = s.outputStream
            val clientMsg = AdbPairing.readPacket(input, AdbPairing.TYPE_SPAKE2)!!
            when (behavior) {
                Behavior.BAD_HEADER_VERSION -> {
                    out.write(byteArrayOf(2, 0, 0, 0, 0, 32) + ByteArray(32)); out.flush(); return
                }
                Behavior.WRONG_TYPE -> {
                    AdbPairing.writePacket(out, AdbPairing.TYPE_PEER_INFO, auth.message); return
                }
                else -> AdbPairing.writePacket(out, AdbPairing.TYPE_SPAKE2, auth.message)
            }
            auth.initCipher(clientMsg)
            val sealed = AdbPairing.readPacket(input, AdbPairing.TYPE_PEER_INFO)!!
            if (behavior == Behavior.CLOSE_AFTER_SPAKE) return
            val info = try {
                auth.decrypt(sealed)
            } catch (e: AEADBadTagException) {
                return // Like the device: disconnect when decryption fails
            }
            check(info.size == AdbPairing.PEER_INFO_SIZE && info[0] == AdbPairing.PEER_RSA_PUB_KEY)
            receivedKey = String(info, 1, info.indexOfFirst(1) - 1, Charsets.UTF_8)
            val mine = ByteArray(AdbPairing.PEER_INFO_SIZE)
            mine[0] = AdbPairing.PEER_DEVICE_GUID
            guid.toByteArray().copyInto(mine, 1)
            AdbPairing.writePacket(out, AdbPairing.TYPE_PEER_INFO, auth.encrypt(mine))
            s.inputStream.read() // Wait for the client to close
        }
    }

    private fun ByteArray.indexOfFirst(from: Int): Int {
        for (i in from until size) if (this[i] == 0.toByte()) return i
        return size
    }

    fun join() = worker.join(10_000)

    override fun close() {
        server.close()
    }
}
