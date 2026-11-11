package com.openmausbot.companion.ui

import androidx.annotation.DrawableRes
import androidx.compose.ui.graphics.Color
import com.openmausbot.companion.R

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
}
