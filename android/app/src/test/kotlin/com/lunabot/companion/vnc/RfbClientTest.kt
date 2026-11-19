package com.lunabot.companion.vnc

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * The RFB handshake and the Raw decoder, against byte streams written out by
 * hand. No socket, no VNC server: the point is that every message boundary can
 * be tested, including one split across feeds, which is how a WebSocket frame
 * arrives.
 */
class RfbClientTest {

    private fun serverInit(width: Int, height: Int, name: String = "vm"): ByteArray {
        val nameBytes = name.toByteArray(Charsets.UTF_8)
        return byteArrayOf(
            (width ushr 8).toByte(), width.toByte(),
            (height ushr 8).toByte(), height.toByte(),
            32, 24, 0, 1, // bpp, depth, big-endian, true-colour
            0, 255.toByte(), 0, 255.toByte(), 0, 255.toByte(),
            16, 8, 0, 0, 0, 0, // red/shift green/shift blue/shift + padding
            0, 0, (nameBytes.size ushr 8).toByte(), nameBytes.size.toByte(),
        ) + nameBytes
    }

    private fun rawUpdate(x: Int, y: Int, width: Int, height: Int, argb: IntArray): ByteArray {
        val out = mutableListOf<Byte>()
        out += listOf<Byte>(0, 0, 0, 1) // type, padding, rect count
        out += listOf<Byte>(
            (x ushr 8).toByte(), x.toByte(),
            (y ushr 8).toByte(), y.toByte(),
            (width ushr 8).toByte(), width.toByte(),
            (height ushr 8).toByte(), height.toByte(),
            0, 0, 0, 0, // Raw
        )
        argb.forEach { pixel ->
            val b = (pixel and 0xFF).toByte()
            val g = ((pixel ushr 8) and 0xFF).toByte()
            val r = ((pixel ushr 16) and 0xFF).toByte()
            out += listOf(b, g, r, 0)
        }
        return out.toByteArray()
    }

    @Test
    fun `a None-authenticated session reaches Ready and asks for one Raw frame`() {
        val client = RfbClient()
        assertContentEquals("RFB 003.008\n".toByteArray(), client.start())

        assertTrue(client.feed("RFB 003.008\n".toByteArray()).isEmpty())
        assertContentEquals("RFB 003.008\n".toByteArray(), client.takeOutbound())

        // One security type: None.
        assertTrue(client.feed(byteArrayOf(1, 1)).isEmpty())
        assertContentEquals(byteArrayOf(1), client.takeOutbound())

        // SecurityResult = ok.
        assertTrue(client.feed(byteArrayOf(0, 0, 0, 0)).isEmpty())
        assertContentEquals(byteArrayOf(1), client.takeOutbound(), "shared flag")

        val events = client.feed(serverInit(width = 800, height = 600, name = "Local VM"))
        val ready = assertIs<RfbClient.Event.Ready>(events.single())
        assertEquals(800, ready.width)
        assertEquals(600, ready.height)
        assertEquals("Local VM", ready.name)

        // SetPixelFormat (20) + SetEncodings (8) + one full update request (10).
        assertEquals(38, client.takeOutbound().size)
    }

    @Test
    fun `the same bytes split one at a time reach the same Ready`() {
        val client = RfbClient()
        client.start()
        val stream = "RFB 003.008\n".toByteArray() +
            byteArrayOf(1, 1) +
            byteArrayOf(0, 0, 0, 0) +
            serverInit(width = 64, height = 48)

        val events = stream.flatMap { byte -> client.feed(byteArrayOf(byte)) }
        val ready = assertIs<RfbClient.Event.Ready>(events.single())
        assertEquals(64, ready.width)
        assertEquals(48, ready.height)
    }

    @Test
    fun `a Raw rectangle decodes to ARGB in row order`() {
        val client = readyClient()
        val pixels = intArrayOf(0xFF302010.toInt(), 0xFFFF0000.toInt())
        val events = client.feed(rawUpdate(x = 0, y = 0, width = 2, height = 1, argb = pixels))

        val rect = assertIs<RfbClient.Event.Rectangle>(events.single())
        assertEquals(2, rect.width)
        assertEquals(1, rect.height)
        assertContentEquals(pixels, rect.pixels)
    }

    @Test
    fun `a server that only offers VNC Auth is refused explicitly`() {
        // This build dropped RFB's DES challenge-response: it is weak crypto,
        // and the relay already carries the bytes inside TLS. Refuse rather
        // than pretend the viewer can connect.
        val client = RfbClient()
        client.start()
        client.feed("RFB 003.008\n".toByteArray())
        client.takeOutbound()

        val closed = assertIs<RfbClient.Event.Closed>(client.feed(byteArrayOf(1, 2)).single())
        assertTrue(closed.reason.contains("密码认证"))
    }

    @Test
    fun `a security offer this build cannot answer closes instead of hanging`() {
        val client = RfbClient()
        client.start()
        client.feed("RFB 003.008\n".toByteArray())
        client.takeOutbound()

        val closed = assertIs<RfbClient.Event.Closed>(client.feed(byteArrayOf(1, 19)).single())
        assertTrue(closed.reason.isNotBlank())
    }

    @Test
    fun `pointer and key messages carry the coordinates the viewer expects`() {
        val client = readyClient()
        client.takeOutbound()

        client.pointer(x = 300, y = 200, buttonMask = 1)
        assertContentEquals(
            byteArrayOf(5, 1, 0x01, 0x2C, 0x00, 0xC8.toByte()),
            client.takeOutbound(),
        )

        client.key(keysym = 0xFF0D, down = true)
        assertContentEquals(
            // X11 keysym 0xFF0D is four bytes big-endian: 00 00 FF 0D.
            byteArrayOf(4, 1, 0, 0, 0, 0, 0xFF.toByte(), 0x0D),
            client.takeOutbound(),
        )
    }

    private fun readyClient(): RfbClient {
        val client = RfbClient()
        client.start()
        client.feed("RFB 003.008\n".toByteArray())
        client.takeOutbound()
        client.feed(byteArrayOf(1, 1))
        client.takeOutbound()
        client.feed(byteArrayOf(0, 0, 0, 0))
        client.takeOutbound()
        client.feed(serverInit(width = 10, height = 10))
        client.takeOutbound()
        return client
    }
}
