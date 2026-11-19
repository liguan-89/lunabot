package com.lunabot.companion.phone

/**
 * One inbound text can reach us twice: SMS_RECEIVED for a carrier text and the
 * messaging app's notification for that same message (and a re-broadcast of the
 * broadcast itself). Each source notes what it posted here; the second arrival
 * is dropped inside a two-minute window.
 */
object SmsEventDedup {

    private const val WINDOW_MS = 120_000L
    private const val MAX_ENTRIES = 100

    private val recent = LinkedHashMap<String, Long>()

    /** True the first time this (sender, text) is seen within the window; false on any repeat. */
    @Synchronized
    fun note(from: String, text: String): Boolean {
        val now = System.currentTimeMillis()
        recent.entries.removeIf { now - it.value > WINDOW_MS }
        // Digits-only sender so "+86 138-0000-0000" and "13800000000" dedupe to the same message.
        val key = from.replace(Regex("[^0-9A-Za-z一-鿿]"), "") + "" + text
        if (recent.containsKey(key)) return false
        if (recent.size >= MAX_ENTRIES) recent.remove(recent.keys.first())
        recent[key] = now
        return true
    }
}
