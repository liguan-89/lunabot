package com.lunabot.companion.phoneui

/**
 * The keys a bot may press on its own display, by wire name. The helper has
 * its own copy of this set in `PhoneUiPolicy` so a compromised app side cannot
 * widen it; both must agree.
 *
 * Home and recents are deliberately absent: the system routes those to the
 * phone's default display group, not to the helper's display, so they would
 * change the person's screen rather than ours.
 */
object PhoneUiKeys {
    const val BACK = 4
    const val ENTER = 66
    const val DEL = 67
    const val TAB = 61
    const val DPAD_UP = 19
    const val DPAD_DOWN = 20
    const val DPAD_LEFT = 21
    const val DPAD_RIGHT = 22

    private val BY_NAME: Map<String, Int> = mapOf(
        "back" to BACK,
        "enter" to ENTER,
        "del" to DEL,
        "delete" to DEL,
        "tab" to TAB,
        "up" to DPAD_UP,
        "down" to DPAD_DOWN,
        "left" to DPAD_LEFT,
        "right" to DPAD_RIGHT,
    )

    val allowed: Set<Int> = BY_NAME.values.toSet()

    /** The key code for a wire name, or null outside the whitelist. */
    fun codeOf(name: String?): Int? = BY_NAME[name?.trim()?.lowercase()]

    /**
     * Whether [text] can be typed through the helper's key path: printable
     * ASCII only. Control characters could trigger other editor actions, and
     * non-ASCII input needs an IME, which this slice does not own.
     */
    fun typeableText(text: String): Boolean =
        text.length in 1..256 && text.all { it in ' '..'~' }
}