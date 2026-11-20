package com.lunabot.companion.storage

import com.lunabot.companion.core.CompanionJson
import com.lunabot.companion.core.RosterSnapshot
import com.lunabot.companion.core.RosterSnapshotStore
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString

/**
 * The offline roster cache on disk: one JSON file per paired computer under
 * [DIRECTORY] in filesDir, what turns "没有缓存？" into a roster that
 * survives a relaunch and an unreachable computer.
 *
 * - **The filename is a SHA-256 of the connection id**, never the id itself.
 *   Ids are remote-supplied strings; hashing means an id containing `/` or
 *   `..` cannot steer a write out of the cache directory, and two computers
 *   with colliding ids would collide in [com.lunabot.companion.core.TokenStore]
 *   long before they could collide here.
 * - **The write is atomic** — bytes land in a `.tmp` sibling that is renamed
 *   over the target — so a process killed mid-save leaves either the old
 *   snapshot or the new one, never a truncated file that reads as corrupt.
 * - **Oversized snapshots are refused, not truncated.** The cache is an
 *   amenity; a fleet whose JSON passes [MAX_BYTES] indicates a runaway
 *   roster, and squeezing it onto disk would trade a clear skip for silent
 *   corruption of the size budget this directory is allowed to cost.
 * - **Every failure is survivable.** [Session] calls all of this best-effort:
 *   a missing or corrupt file reads as null, an unwritable directory drops
 *   the save, and nothing here can fail a pairing or a hydrate.
 *
 * Nothing in a snapshot is a secret — it is bounded roster data the computer
 * serves to any paired phone — but it is device-local convenience that the
 * next live hydrate replaces wholesale, so the directory is excluded from
 * backup and device transfer in `backup_rules.xml` /
 * `data_extraction_rules.xml` rather than carried across installs.
 *
 * All IO runs on [Dispatchers.IO]; the store is called from [Session]'s
 * `Dispatchers.Main.immediate` scope and must never block it.
 */
class FileRosterSnapshotStore(private val directory: File) : RosterSnapshotStore {

    override suspend fun load(connectionId: String): RosterSnapshot? = withContext(Dispatchers.IO) {
        val file = fileFor(connectionId)
        try {
            CompanionJson.decodeFromString(
                RosterSnapshot.serializer(),
                file.readBytes().decodeToString(),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            // Missing, unreadable, truncated, or written by some future
            // schema — all of it reads as "no cache", which is exactly how
            // the session consumes this store.
            null
        }
    }

    override suspend fun save(connectionId: String, snapshot: RosterSnapshot): Unit =
        withContext(Dispatchers.IO) {
            val bytes = CompanionJson.encodeToString(RosterSnapshot.serializer(), snapshot)
                .toByteArray(Charsets.UTF_8)
            if (bytes.size > MAX_BYTES) return@withContext
            val target = fileFor(connectionId)
            val tmp = File(directory, "${target.name}.tmp")
            try {
                directory.mkdirs()
                tmp.writeBytes(bytes)
                // rename(2) replaces atomically within a directory; the
                // delete-then-retry exists for the filesystems where it does not.
                if (!tmp.renameTo(target)) {
                    target.delete()
                    if (!tmp.renameTo(target)) tmp.delete()
                }
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                // An unwritable cache is a lost amenity, not a fault: the next
                // hydrate writes it again, and the session has already moved on.
                tmp.delete()
            }
        }

    override suspend fun clear(connectionId: String): Unit = withContext(Dispatchers.IO) {
        try {
            fileFor(connectionId).delete()
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            // Best effort: a file that refuses to die is overwritten by the
            // next save for this id and orphaned otherwise.
        }
    }

    /** SHA-256 hex of the connection id — URL-safe, fixed-length, no escapes. */
    private fun fileFor(connectionId: String): File {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(connectionId.toByteArray(Charsets.UTF_8))
        val name = digest.joinToString(separator = "") { byte -> "%02x".format(byte) }
        return File(directory, name)
    }

    companion object {
        /** The directory under filesDir; named here so the backup rules and the wiring agree. */
        const val DIRECTORY = "roster-cache"

        /** ~2 MB of JSON per computer. The bounded fleet fits with room to spare. */
        const val MAX_BYTES = 2 * 1024 * 1024
    }
}
