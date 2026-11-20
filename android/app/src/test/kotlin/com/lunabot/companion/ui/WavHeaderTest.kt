package com.lunabot.companion.ui

import java.io.File
import java.io.RandomAccessFile
import kotlin.test.Test
import kotlin.test.assertEquals

/** The bytes a computer's `/api/tts/transcribe` route parses before it hears audio. */
class WavHeaderTest {
    private fun header(dataBytes: Long): ByteArray {
        val file = File.createTempFile("wav", null).apply { deleteOnExit() }
        RandomAccessFile(file, "rw").use { WavHeader.write(it, dataBytes) }
        return file.readBytes()
    }

    @Test
    fun `the container announces RIFF and WAVE around a PCM fmt chunk`() {
        val header = header(1_920)

        assertEquals(44, header.size)
        assertEquals("RIFF", header.decodeToString(0, 4))
        assertEquals(36 + 1_920, le32(header, 4))
        assertEquals("WAVE", header.decodeToString(8, 12))
        assertEquals("fmt ", header.decodeToString(12, 16))
        assertEquals(16, le32(header, 16))
        assertEquals(1, le16(header, 20)) // linear PCM
        assertEquals(1, le16(header, 22)) // mono
        assertEquals(16_000, le32(header, 24))
        assertEquals(32_000, le32(header, 28)) // samples * one channel * 2 bytes
        assertEquals(2, le16(header, 32)) // block align
        assertEquals(16, le16(header, 34)) // bits per sample
        assertEquals("data", header.decodeToString(36, 40))
        assertEquals(1_920, le32(header, 40))
    }

    @Test
    fun `the declared length tracks the recorded bytes`() {
        val empty = header(0)
        assertEquals(36, le32(empty, 4))
        assertEquals(0, le32(empty, 40))

        val minute = header(16_000L * 60 * 2)
        assertEquals(36 + 1_920_000, le32(minute, 4))
        assertEquals(1_920_000, le32(minute, 40))
    }

    private fun le16(bytes: ByteArray, at: Int): Int =
        (bytes[at].toInt() and 0xFF) or ((bytes[at + 1].toInt() and 0xFF) shl 8)

    private fun le32(bytes: ByteArray, at: Int): Long =
        (bytes[at].toLong() and 0xFF) or
            ((bytes[at + 1].toLong() and 0xFF) shl 8) or
            ((bytes[at + 2].toLong() and 0xFF) shl 16) or
            ((bytes[at + 3].toLong() and 0xFF) shl 24)
}
