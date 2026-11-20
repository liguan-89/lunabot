/*
 * Ported from Mika (https://github.com/wangzan101/Mika), file
 * core/src/test/kotlin/com/wangzan101/mika/core/adb/AdbPairingTest.kt.
 * Copyright 2026 wangzan101. The original is licensed under the Apache License,
 * Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 OpenMausBot contributors. Changes from the
 * original: repackaged under com.lunabot.companion.core.phoneui.adb, comments
 * translated into English, and assertions moved from JUnit 4 to kotlin.test.
 */
package com.lunabot.companion.core.phoneui.adb

import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import kotlin.concurrent.thread
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.conscrypt.Conscrypt

class AdbPairingTest {
    private val client = TestTls.tls(TestTls.client)

    @Test
    fun pairsWithFakeServer() {
        FakePairingServer("123456").use { server ->
            val peer = AdbPairing(client).pair("127.0.0.1", server.port, "123456")
            server.join()
            assertNull(server.error)
            assertEquals(1, peer.type)
            assertEquals("adb-FAKE0001-abc123", peer.data)
            assertEquals(TestTls.client.adbPublicKey, server.receivedKey)
            assertArrayEquals(TestTls.client.publicKey.encoded, server.clientCertKey)
        }
    }

    @Test
    fun wrongCodeIsReported() {
        FakePairingServer("123456").use { server ->
            val e = assertFailsWith<AdbPairingException> { AdbPairing(client).pair("127.0.0.1", server.port, "654321") }
            assertEquals(AdbPairingException.Reason.WRONG_CODE, e.reason)
            server.join()
            assertNull(server.receivedKey)
        }
    }

    @Test
    fun deviceClosingAfterOurPeerInfoMeansWrongCode() {
        FakePairingServer("1", FakePairingServer.Behavior.CLOSE_AFTER_SPAKE).use { server ->
            val e = assertFailsWith<AdbPairingException> { AdbPairing(client).pair("127.0.0.1", server.port, "1") }
            assertEquals(AdbPairingException.Reason.WRONG_CODE, e.reason)
        }
    }

    @Test
    fun protocolViolationsAreRejected() {
        for (b in listOf(FakePairingServer.Behavior.BAD_HEADER_VERSION, FakePairingServer.Behavior.WRONG_TYPE)) {
            FakePairingServer("1", b).use { server ->
                val e = assertFailsWith<AdbPairingException> { AdbPairing(client).pair("127.0.0.1", server.port, "1") }
                assertEquals(AdbPairingException.Reason.PROTOCOL, e.reason, b.name)
            }
        }
    }

    @Test
    fun pairingUsesTheVerifiedMappedLoopbackAddress() {
        FakePairingServer("123456").use { server ->
            val peer = AdbPairing(client).pair(" [::ffff:127.0.0.1] ", server.port, "123456")
            server.join()
            assertNull(server.error)
            assertEquals("adb-FAKE0001-abc123", peer.data)
        }
    }

    @Test
    fun pairingRejectsHostileLookalikeHostsBeforeConnecting() {
        for (host in listOf("127.evil.com", "127.0.0.1.example.com", "localhost.example.com")) {
            val e = assertFailsWith<AdbPairingException>(host) {
                AdbPairing(client).pair(host, 5555, "123456", timeoutMs = 50)
            }
            assertEquals(AdbPairingException.Reason.NOT_LOCAL, e.reason, host)
        }
    }

    @Test
    fun connectFailureIsReported() {
        val port = ServerSocket(0).use { it.localPort }
        val e = assertFailsWith<AdbPairingException> { AdbPairing(client).pair("127.0.0.1", port, "1", timeoutMs = 2000) }
        assertEquals(AdbPairingException.Reason.CONNECT_FAILED, e.reason)
    }

    /** Both sides export the same material, and an empty context equals no context (the Android side passes an empty array). */
    @Test
    fun tls13ExporterAgreesAndIgnoresEmptyContext() {
        ServerSocket(0, 1, InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))).use { ss ->
            val serverTls = TestTls.tls(TestTls.device)
            var serverSide: ByteArray? = null
            val t = thread {
                ss.accept().use { p ->
                    val s = serverTls.wrap(p, InetSocketAddress(p.localAddress, ss.localPort), client = false)
                    serverSide = Conscrypt.exportKeyingMaterial(s, AdbPairing.EXPORT_LABEL, null, 64)
                    s.inputStream.read()
                }
            }
            client.connect(InetSocketAddress(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)), ss.localPort), 5000).use { s ->
                assertEquals("TLSv1.3", s.session.protocol)
                val a = Conscrypt.exportKeyingMaterial(s, AdbPairing.EXPORT_LABEL, null, 64)
                val b = Conscrypt.exportKeyingMaterial(s, AdbPairing.EXPORT_LABEL, ByteArray(0), 64)
                assertArrayEquals(a, b)
                assertTrue(!a.contentEquals(Conscrypt.exportKeyingMaterial(s, "adb-label", null, 64)))
                s.outputStream.write(0)
                t.join(5000)
                assertArrayEquals(a, serverSide)
            }
        }
    }

    @Test
    fun packetFraming() {
        val out = ByteArrayOutputStream()
        AdbPairing.writePacket(out, AdbPairing.TYPE_PEER_INFO, ByteArray(0x1234) { 7 })
        val bytes = out.toByteArray()
        assertArrayEquals(byteArrayOf(1, 1, 0, 0, 0x12, 0x34), bytes.copyOf(6))
        assertEquals(0x1234 + 6, bytes.size)
        val back = AdbPairing.readPacket(DataInputStream(bytes.inputStream()), AdbPairing.TYPE_PEER_INFO)!!
        assertEquals(0x1234, back.size)
        assertNull(AdbPairing.readPacket(DataInputStream(ByteArray(0).inputStream()), 0))
        val tooBig = byteArrayOf(1, 0, 0, 0, 0x40, 0x01)
        assertFailsWith<AdbPairingException> { AdbPairing.readPacket(DataInputStream(tooBig.inputStream()), 0) }
    }
}
