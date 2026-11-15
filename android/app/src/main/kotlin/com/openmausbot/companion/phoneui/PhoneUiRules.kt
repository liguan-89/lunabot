package com.openmausbot.companion.phoneui

/**
 * The pure limits and input rules of the phone-UI observation/action slice.
 * Free of Android imports so the budgets, the package-name rule and the text
 * clamping can be pinned by JVM tests; the accessibility service and the
 * executor apply them, they do not re-derive them.
 */
object PhoneUiRules {
    /** The system-provided UI tree is walked no deeper than this. */
    const val MAX_TREE_DEPTH = 30

    /** A snapshot reports at most this many elements. */
    const val MAX_ELEMENTS = 80

    /** Per-node text and description are clamped to this before they leave the phone. */
    const val MAX_TEXT_PER_NODE = 500

    /** Approximate character budget for one snapshot's payload (about 12 KB of JSON). */
    const val MAX_TOTAL_TEXT_CHARS = 12_000

    /** A bot-typed string is refused above this rather than silently cut. */
    const val MAX_TYPE_TEXT = 4_000

    const val DEFAULT_WIDTH = 720
    const val DEFAULT_HEIGHT = 1280
    const val DEFAULT_DPI = 160
    const val MIN_WIDTH = 200
    const val MAX_WIDTH = 2560
    const val MIN_HEIGHT = 200
    const val MAX_HEIGHT = 2560
    const val MIN_DPI = 120
    const val MAX_DPI = 640

    const val MAX_ANCESTOR_HOPS = 8

    /** Milliseconds a session display may sit unused before the executor releases it. */
    const val SESSION_IDLE_TIMEOUT_MS = 120_000L

    /** Milliseconds PHONE_UI_LAUNCH waits for the app to appear on the display. */
    const val LAUNCH_SETTLE_TIMEOUT_MS = 8_000L
    const val LAUNCH_POLL_INTERVAL_MS = 300L

    private val PACKAGE_NAME = Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+")

    /**
     * What may be handed to the helper's launchApp as a package name: the
     * shape PackageManager accepts, no whitespace, separators or control
     * characters that could carry anything further. Being well-formed does
     * not mean installed; the executor checks that separately.
     */
    fun isValidPackageName(value: String?): Boolean =
        value != null && value.length <= 255 && PACKAGE_NAME.matches(value)

    /**
     * A bot-supplied display size, clamped into the safe band; anything
     * unparseable or outside it falls back to [default].
     */
    fun clampedInt(value: String?, default: Int, min: Int, max: Int): Int {
        val parsed = value?.trim()?.toIntOrNull() ?: return default
        return parsed.coerceIn(min, max)
    }

    /**
     * Text that may leave the phone: control characters other than newline
     * and tab become spaces, and the result is cut at [MAX_TEXT_PER_NODE].
     * Password fields never reach this; their text is not read at all.
     */
    fun clampText(value: String?): String? {
        if (value.isNullOrEmpty()) return null
        val cleaned = StringBuilder(value.length)
        for (ch in value) {
            val replacement = when {
                ch == '\n' || ch == '\t' -> ch
                ch.code < 32 || ch.code == 127 -> ' '
                else -> ch
            }
            cleaned.append(replacement)
        }
        return cleaned.toString().take(MAX_TEXT_PER_NODE)
    }

    /**
     * Whether one more element with [incomingChars] of text payload still
     * fits the snapshot budget given the [usedChars] so far.
     */
    fun budgetHasRoom(usedChars: Int, incomingChars: Int): Boolean =
        usedChars + incomingChars <= MAX_TOTAL_TEXT_CHARS

    /** Rough per-element payload size, so the budget counts like the JSON will. */
    fun elementPayloadChars(text: String?, description: String?, viewId: String?, className: String?): Int =
        (text?.length ?: 0) + (description?.length ?: 0) + (viewId?.length ?: 0) +
            (className?.length ?: 0) + REF_OVERHEAD_CHARS

    const val REF_OVERHEAD_CHARS = 96
}
