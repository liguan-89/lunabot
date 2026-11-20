package com.lunabot.companion.ui

import android.content.res.Resources
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.annotation.DrawableRes
import androidx.compose.ui.graphics.Color
import com.lunabot.companion.R
import kotlin.math.abs
import androidx.core.graphics.scale

/**
 * The circular portrait library.
 *
 * One flat circle, two white pill eyes, no other detail — the same shape as the
 * Grok-style avatars the roster draws. A bot can adopt one from
 * Agent settings → Avatar; it is uploaded through the normal avatar route, so
 * the computer sees it too.
 *
 * The colours live here twice over, on purpose. The app draws the face itself
 * ([BotFace]) so the eyes can move, and the PNG named by [res] is what gets
 * uploaded to the computer and shown on every other client. Both come from the
 * same numbers, so the phone and the desktop agree on what a bot looks like.
 */
internal data class PresetAvatar(
    val key: String,
    val label: String,
    @DrawableRes val res: Int,
    val body: Color,
    val eye: Color,
)

internal object PresetAvatars {
    val all = listOf(
        PresetAvatar("black", "墨黑", R.drawable.bot_avatar_black, Color(0xFF000000), Color(0xFFFDFEFD)),
        PresetAvatar("white", "月白", R.drawable.bot_avatar_white, Color(0xFFF7F3ED), Color(0xFF1C1C1E)),
        PresetAvatar("blue", "钴蓝", R.drawable.bot_avatar_blue, Color(0xFF0E5AFD), Color(0xFFFEFEFE)),
        PresetAvatar("orange", "琥珀", R.drawable.bot_avatar_orange, Color(0xFFFF9432), Color(0xFFFEFEFE)),
        PresetAvatar("purple", "紫罗兰", R.drawable.bot_avatar_purple, Color(0xFF9443F4), Color(0xFFFEFEFE)),
        PresetAvatar("mint", "薄荷", R.drawable.bot_avatar_mint, Color(0xFF57E58C), Color(0xFFFEFEFE)),
        PresetAvatar("coral", "珊瑚", R.drawable.bot_avatar_coral, Color(0xFFFD5C59), Color(0xFFFEFEFE)),
        PresetAvatar("grey", "石墨", R.drawable.bot_avatar_grey, Color(0xFF777877), Color(0xFFFEFEFE)),
    )

    /** The circle a bot's own colour maps to in the roster. */
    fun forColor(color: String?): PresetAvatar = when (color?.lowercase()) {
        "blue" -> byKey("blue")
        "orange", "yellow" -> byKey("orange")
        "red" -> byKey("coral")
        "green" -> byKey("mint")
        "purple", "violet" -> byKey("purple")
        // The cream disc is the round face on a light background, so the
        // names that ask for "nothing to see here" all land on it — including
        // the preset's own key, which the avatar picker passes straight
        // through.
        "white", "cream", "sand", "grey", "gray", "chrome", "silver" -> byKey("white")
        else -> byKey("black")
    }

    private fun byKey(key: String): PresetAvatar = all.first { it.key == key }

    /**
     * The library face an uploaded picture is, if it is one of ours.
     *
     * Choosing a preset uploads the PNG, and a bot is then an image like any
     * other — which would freeze its eyes: a bitmap cannot blink. Recognising
     * the picture lets the app draw the live face again while the computer
     * keeps the same image for every other client. The comparison is on a
     * 16×16 signature rather than exact pixels, because the bundled PNGs were
     * regenerated once (the eyes moved) and older uploads are still the same
     * face with the eyes a couple of pixels lower.
     */
    fun match(resources: Resources, bitmap: Bitmap): PresetAvatar? {
        if (bitmap.width < SIGNATURE_EDGE || bitmap.height < SIGNATURE_EDGE) return null
        val signature = signatureOf(bitmap)
        return all
            .mapNotNull { preset ->
                signatureOf(resources, preset)?.let { known -> preset to distance(signature, known) }
            }
            .filter { it.second <= MAX_SIGNATURE_DISTANCE }
            .minByOrNull { it.second }
            ?.first
    }

    private const val SIGNATURE_EDGE = 16

    /** Total channel difference over the 16×16 grid that still counts as ours. */
    private const val MAX_SIGNATURE_DISTANCE = 20_000

    /** One 16×16 RGB grid, packed as ARGB ints, which is enough to recognise a face. */
    private fun signatureOf(bitmap: Bitmap): IntArray {
        val scaled = bitmap.scale(SIGNATURE_EDGE, SIGNATURE_EDGE)
        val pixels = IntArray(SIGNATURE_EDGE * SIGNATURE_EDGE)
        scaled.getPixels(pixels, 0, SIGNATURE_EDGE, 0, 0, SIGNATURE_EDGE, SIGNATURE_EDGE)
        if (scaled !== bitmap) scaled.recycle()
        return pixels
    }

    private val bundled = HashMap<String, IntArray?>()

    private fun signatureOf(resources: Resources, preset: PresetAvatar): IntArray? =
        synchronized(bundled) {
            if (bundled.containsKey(preset.key)) {
                bundled[preset.key]
            } else {
                val signature = runCatching {
                    BitmapFactory.decodeResource(resources, preset.res)?.let(::signatureOf)
                }.getOrNull()
                bundled[preset.key] = signature
                signature
            }
        }

    private fun distance(a: IntArray, b: IntArray): Int {
        var total = 0
        for (index in a.indices) {
            val left = a[index]
            val right = b[index]
            total += abs(((left shr 16) and 0xFF) - ((right shr 16) and 0xFF))
            total += abs(((left shr 8) and 0xFF) - ((right shr 8) and 0xFF))
            total += abs((left and 0xFF) - (right and 0xFF))
        }
        return total
    }
}
