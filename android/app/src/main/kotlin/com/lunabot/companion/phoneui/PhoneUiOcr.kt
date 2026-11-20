package com.lunabot.companion.phoneui

import android.graphics.Bitmap
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * Text recognition over a captured frame, for screens the accessibility tree
 * cannot describe: image-only tabs, canvas-drawn UIs, games, or a page that
 * exposed no text at all.
 *
 * The model is the bundled Chinese/Latin recognizer, so it works on phones
 * without Google Play Services. Recognition runs on-device; only the text and
 * its boxes leave the phone, never the frame.
 */
internal object PhoneUiOcr {
    data class Line(val text: String, val bounds: List<Int>)

    private val client by lazy {
        TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
    }

    /** Recognized lines in reading order, bounded by [maxLines] and [maxChars]. */
    suspend fun read(bitmap: Bitmap, maxLines: Int = 120, maxChars: Int = 6_000): List<Line> {
        val image = InputImage.fromBitmap(bitmap, 0)
        val result = suspendCancellableCoroutine<Text?> { continuation ->
            client.process(image)
                .addOnSuccessListener { continuation.resume(it) }
                .addOnFailureListener { continuation.resume(null) }
        } ?: return emptyList()
        val lines = ArrayList<Line>()
        var used = 0
        for (block in result.textBlocks) {
            for (line in block.lines) {
                if (lines.size >= maxLines || used >= maxChars) return lines
                val text = line.text?.trim().orEmpty()
                if (text.isEmpty()) continue
                used += text.length
                val box = line.boundingBox
                lines.add(
                    Line(
                        text = text,
                        bounds = if (box == null) emptyList() else listOf(box.left, box.top, box.right, box.bottom),
                    ),
                )
            }
        }
        return lines
    }
}