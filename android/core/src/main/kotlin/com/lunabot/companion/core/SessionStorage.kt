package com.lunabot.companion.core

import kotlinx.serialization.Serializable

/**
 * Connection record store — UserDefaults analogue. Safe to back up; holds no token.
 */
interface ConnectionStore {
    suspend fun load(): Connection?
    suspend fun save(connection: Connection)
    suspend fun clear()

    /**
     * The non-secret index of computers this phone knows about.  The original
     * single-connection methods stay as the compatibility boundary for older
     * stores and test doubles; the Android DataStore implementation overrides
     * these registry methods so it never loses a second computer.
     */
    suspend fun loadRegistry(): ConnectionRegistryRestore {
        val legacy = load()
        return if (legacy == null) {
            ConnectionRegistryRestore(ConnectionRegistry(), migratedLegacyConnection = false)
        } else {
            // Only the concrete persistent store knows whether `load()` came
            // from the legacy key. Compatibility stores expose one active
            // record but must not receive a surprise migration write during a
            // restore (some intentionally make writes suspend in tests).
            ConnectionRegistryRestore(
                ConnectionRegistry(listOf(legacy), legacy.id),
                migratedLegacyConnection = false,
            )
        }
    }

    suspend fun saveRegistry(registry: ConnectionRegistry) {
        val active = registry.activeConnection
        if (active != null) save(active) else clear()
    }

    suspend fun clearRegistry() = clear()
}

/**
 * Device-token store — Keychain analogue. Must not appear in any backup path.
 *
 * Distinguishes "no token" from "cannot read yet" the same way iOS Keychain does:
 * a locked/unavailable store is offline, never unpaired.
 */
interface TokenStore {
    sealed class ReadResult {
        data class Found(val token: String) : ReadResult()
        data object Missing : ReadResult()
        data class Unavailable(val locked: Boolean, val message: String) : ReadResult()
    }

    suspend fun save(connectionId: String, token: String)
    suspend fun read(connectionId: String): ReadResult
    suspend fun remove(connectionId: String)
}

/**
 * The durable first-pair notification-education marker — the Android shape of
 * the `UserDefaults` key `ios/App/Session.swift` writes inside its pairing
 * commit.
 *
 * One boolean, and nothing else (§6). It is not a secret and never becomes a
 * place for one: the interface admits no other type, and the store behind it
 * is a file of its own holding only the keys in
 * [OnboardingPreferenceKeys.ALL].
 *
 * [setNotificationOnboardingPending] must not return until the value is
 * durable. [Session.pair] calls it before it saves the connection precisely so
 * that a process that stops between the two writes leaves an orphan marker
 * (harmless) rather than a restorable pairing that skipped education forever.
 */
interface OnboardingStore {
    suspend fun notificationOnboardingPending(): Boolean
    suspend fun setNotificationOnboardingPending(pending: Boolean)
}

/** In-memory [OnboardingStore] for tests and for callers with nothing to keep. */
class InMemoryOnboardingStore(initial: Boolean = false) : OnboardingStore {
    private var pending = initial
    override suspend fun notificationOnboardingPending(): Boolean = pending
    override suspend fun setNotificationOnboardingPending(pending: Boolean) {
        this.pending = pending
    }
}

/** Local notification surface fed by live/replayed notify frames. */
interface NotificationSink {
    fun deliver(notification: NotificationFrame, sequence: Int?)
    fun setBadge(count: Int)
}

object NoOpNotificationSink : NotificationSink {
    override fun deliver(notification: NotificationFrame, sequence: Int?) = Unit
    override fun setBadge(count: Int) = Unit
}

data class ExportedTranscript(
    val data: ByteArray,
    val filename: String,
    val contentType: String,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is ExportedTranscript) return false
        return filename == other.filename &&
            contentType == other.contentType &&
            data.contentEquals(other.data)
    }

    override fun hashCode(): Int {
        var result = data.contentHashCode()
        result = 31 * result + filename.hashCode()
        result = 31 * result + contentType.hashCode()
        return result
    }
}

/**
 * One offline roster cache entry: the message-bounded fleet exactly as the
 * computer last served it, plus the moment it was captured. Deliberately the
 * ONLY shape that reaches disk — no cursor, no screens, no notification
 * history, and no token. It is keyed by connection id and is only ever read
 * after [TokenStore] has already produced that connection's credential, so it
 * carries no authority of its own.
 */
@Serializable
data class RosterSnapshot(
    val savedAtMillis: Long,
    val fleet: Fleet,
)

/**
 * Where the offline roster cache lives, one snapshot per paired computer.
 *
 * Every method is best-effort by contract: [Session] treats any failure of
 * any of them as "no cache" — never as a pairing fault and never as a reason
 * to drop a live stream. [load] returning null is the ordinary cold state,
 * not an error.
 */
interface RosterSnapshotStore {
    suspend fun load(connectionId: String): RosterSnapshot?
    suspend fun save(connectionId: String, snapshot: RosterSnapshot)
    suspend fun clear(connectionId: String)
}

/**
 * In-memory [RosterSnapshotStore] — the default and the test double. It dies
 * with the process, which is exactly the failure the file-backed store in the
 * app module exists to prevent; only explicit wiring there turns this cache
 * into an offline feature.
 */
class InMemoryRosterSnapshotStore : RosterSnapshotStore {
    private val snapshots = mutableMapOf<String, RosterSnapshot>()

    override suspend fun load(connectionId: String): RosterSnapshot? = snapshots[connectionId]

    override suspend fun save(connectionId: String, snapshot: RosterSnapshot) {
        snapshots[connectionId] = snapshot
    }

    override suspend fun clear(connectionId: String) {
        snapshots.remove(connectionId)
    }
}
