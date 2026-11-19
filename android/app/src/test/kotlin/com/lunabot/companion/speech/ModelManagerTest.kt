package com.lunabot.companion.speech

import java.io.File
import kotlin.io.path.createTempDirectory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Readiness and file picking — the download itself never runs in a test. */
class ModelManagerTest {
    private val root = createTempDirectory("asr").toFile()
    private val manager = ModelManager(root)

    @Test
    fun `the model lives under its own directory inside the injected root`() {
        assertEquals("zipformer-zh-14M", manager.directory().name)
        assertEquals(root, manager.directory().parentFile)
        assertFalse(manager.isReady())
    }

    @Test
    fun `a missing piece, including tokens, is not ready`() {
        val dir = manager.directory().apply { mkdirs() }
        File(dir, "encoder-epoch-99-avg-1.int8.onnx").writeBytes(byteArrayOf(1))
        File(dir, "decoder-epoch-99-avg-1.int8.onnx").writeBytes(byteArrayOf(1))
        File(dir, "joiner-epoch-99-avg-1.int8.onnx").writeBytes(byteArrayOf(1))
        assertFalse(manager.isReady())

        File(dir, "tokens.txt").writeText("a b c")
        assertTrue(manager.isReady())
    }

    @Test
    fun `int8 wins over the float file of the same stem`() {
        val dir = manager.directory().apply { mkdirs() }
        File(dir, "encoder-epoch-99-avg-1.onnx").writeBytes(byteArrayOf(1))
        File(dir, "encoder-epoch-99-avg-1.int8.onnx").writeBytes(byteArrayOf(2))
        File(dir, "decoder-epoch-99-avg-1.onnx").writeBytes(byteArrayOf(1))
        File(dir, "joiner-epoch-99-avg-1.onnx").writeBytes(byteArrayOf(1))
        File(dir, "tokens.txt").writeText("a b c")

        val resolved = manager.resolved()!!
        assertEquals("encoder-epoch-99-avg-1.int8.onnx", resolved.encoder.name)
        // No int8 twin on disk: the float decoder and joiner are accepted.
        assertEquals("decoder-epoch-99-avg-1.onnx", resolved.decoder.name)
        assertEquals("joiner-epoch-99-avg-1.onnx", resolved.joiner.name)
    }

    @Test
    fun `a zero byte onnx file is a failed download, not a model`() {
        val dir = manager.directory().apply { mkdirs() }
        File(dir, "encoder-epoch-99-avg-1.int8.onnx").writeBytes(ByteArray(0))
        File(dir, "decoder-epoch-99-avg-1.int8.onnx").writeBytes(byteArrayOf(1))
        File(dir, "joiner-epoch-99-avg-1.int8.onnx").writeBytes(byteArrayOf(1))
        File(dir, "tokens.txt").writeText("a b c")
        assertNull(manager.resolved())
    }

    @Test
    fun `delete removes the staged and the landed copy`() {
        val dir = manager.directory().apply { mkdirs() }
        File(dir, "tokens.txt").writeText("a b c")
        File(root, "zipformer-zh-14M.download").apply {
            mkdirs()
            File(this, "partial").writeBytes(byteArrayOf(1))
        }

        manager.delete()
        assertFalse(manager.isReady())
        assertFalse(dir.exists())
    }
}
