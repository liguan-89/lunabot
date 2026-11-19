package com.lunabot.companion.phoneui

import java.security.SecureRandom
import java.util.Random

/**
 * Opaque, single-snapshot element references.
 *
 * A ref is a random token the bot can neither construct nor widen: it only
 * resolves to its stored handle while the snapshot it was issued in is still
 * the latest one. Rotating to a new snapshot clears every outstanding ref,
 * so a stale ref from an earlier observation can never act on the UI.
 * Generic over the stored handle so the rotation rules are unit-testable on
 * the JVM.
 */
class PhoneUiRefRegistry<T>(random: Random = SecureRandom()) {
    private class Entry<T>(val snapshot: String, val value: T)

    private val random: Random = random
    private val entries = HashMap<String, Entry<T>>()
    private var snapshot: String? = null

    /** Make [snapshotId] the only valid snapshot; every outstanding ref dies. */
    @Synchronized
    fun rotate(snapshotId: String) {
        entries.clear()
        snapshot = snapshotId
    }

    /** Forget everything; used when the service disconnects. */
    @Synchronized
    fun clear() {
        entries.clear()
        snapshot = null
    }

    /** Issue a ref for [value] in the current snapshot, or null when no snapshot is open. */
    @Synchronized
    fun register(value: T): String? {
        val current = snapshot ?: return null
        val token = newToken()
        entries[token] = Entry(current, value)
        return token
    }

    /**
     * The handle behind [ref], only when the ref was issued in the current
     * (latest) snapshot. Anything else — unknown, malformed, superseded —
     * returns null.
     */
    @Synchronized
    fun resolve(ref: String?): T? {
        if (ref.isNullOrEmpty()) return null
        val current = snapshot ?: return null
        val entry = entries[ref] ?: return null
        if (entry.snapshot != current) return null
        return entry.value
    }

    @Synchronized
    fun size(): Int = entries.size

    private fun newToken(): String {
        while (true) {
            val bytes = ByteArray(TOKEN_BYTES)
            random.nextBytes(bytes)
            val token = bytes.joinToString(separator = "") { "%02x".format(it) }
            if (token !in entries) return token
        }
    }

    private companion object {
        const val TOKEN_BYTES = 12
    }
}
