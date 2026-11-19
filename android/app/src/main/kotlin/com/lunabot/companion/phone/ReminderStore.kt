package com.openmausbot.companion.phone

import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.util.UUID

/** One reminder in this app's own store — no calendar event is invented for it. */
@Serializable
internal data class ReminderRecord(
    val id: String,
    val title: String,
    val dueAt: Long? = null,
    val notes: String = "",
    val list: String = "",
    val completed: Boolean = false,
    val createdAt: Long = 0,
    val completedAt: Long? = null,
)

/**
 * Reminders, kept here rather than in the calendar: a reminder is not an
 * appointment, and writing one as an event would show up on the person's real
 * calendar and sync to every device they own.
 *
 * One small JSON file, written through a temp file so a kill mid-write cannot
 * truncate the list. All access is a single mutex: the job runner and the
 * Settings screen may read at the same time.
 */
internal class ReminderStore(
    private val file: File,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val mutex = Mutex()
    private var loaded: MutableList<ReminderRecord>? = null

    suspend fun all(): List<ReminderRecord> = mutex.withLock { withContext(Dispatchers.IO) { allLocked() } }

    suspend fun get(id: String): ReminderRecord? = mutex.withLock {
        withContext(Dispatchers.IO) { allLocked().firstOrNull { it.id == id } }
    }

    suspend fun create(
        title: String,
        dueAt: Long?,
        notes: String,
        list: String,
    ): ReminderRecord = mutex.withLock {
        withContext(Dispatchers.IO) {
            val record = ReminderRecord(
                id = UUID.randomUUID().toString(),
                title = title,
                dueAt = dueAt,
                notes = notes,
                list = list,
                createdAt = clock(),
            )
            allLocked().add(record)
            saveLocked()
            record
        }
    }

    /** Only the fields the caller passed are changed; null means untouched. */
    suspend fun update(
        id: String,
        title: String?,
        dueAt: Long?,
        notes: String?,
    ): ReminderRecord? = mutex.withLock {
        withContext(Dispatchers.IO) {
            val records = allLocked()
            val index = records.indexOfFirst { it.id == id }
            if (index < 0) return@withContext null
            val current = records[index]
            val next = current.copy(
                title = title ?: current.title,
                dueAt = if (dueAt != null) dueAt else current.dueAt,
                notes = notes ?: current.notes,
            )
            records[index] = next
            saveLocked()
            next
        }
    }

    suspend fun complete(id: String): ReminderRecord? = mutex.withLock {
        withContext(Dispatchers.IO) {
            val records = allLocked()
            val index = records.indexOfFirst { it.id == id }
            if (index < 0) return@withContext null
            val next = records[index].copy(completed = true, completedAt = clock())
            records[index] = next
            saveLocked()
            next
        }
    }

    suspend fun delete(id: String): Boolean = mutex.withLock {
        withContext(Dispatchers.IO) {
            val removed = allLocked().removeAll { it.id == id }
            if (removed) saveLocked()
            removed
        }
    }

    private fun allLocked(): MutableList<ReminderRecord> {
        loaded?.let { return it }
        val parsed = runCatching {
            if (!file.isFile) emptyList() else {
                CompanionReminderJson.decodeFromString(
                    ReminderFile.serializer(),
                    file.readText(),
                ).reminders
            }
        }.getOrDefault(emptyList())
        val records = parsed.toMutableList()
        loaded = records
        return records
    }

    private fun saveLocked() {
        val records = loaded ?: return
        val text = CompanionReminderJson.encodeToString(
            ReminderFile.serializer(),
            ReminderFile(reminders = records),
        )
        file.parentFile?.mkdirs()
        val temp = File(file.parentFile, "${file.name}.tmp")
        temp.writeText(text)
        if (!temp.renameTo(file)) {
            file.writeText(text)
            temp.delete()
        }
    }

    @Serializable
    private data class ReminderFile(
        val version: Int = 1,
        val reminders: List<ReminderRecord> = emptyList(),
    )

    private companion object {
        val CompanionReminderJson = Json {
            ignoreUnknownKeys = true
            encodeDefaults = true
        }
    }
}
