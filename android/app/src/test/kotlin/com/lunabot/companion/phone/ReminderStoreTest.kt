package com.openmausbot.companion.phone

import java.io.File
import kotlin.io.path.createTempDirectory
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking

/**
 * The reminder file: one JSON list, written through a temp file, readable by a
 * second instance (the boot receiver builds its own). Corruption must degrade
 * to an empty list, never to a crash on the next bot call.
 */
class ReminderStoreTest {
    private val directory = createTempDirectory("reminders").toFile()

    @AfterTest
    fun cleanUp() {
        directory.deleteRecursively()
    }

    private fun store(file: File = File(directory, "phone-reminders.json")) =
        ReminderStore(file, clock = { 1_000L })

    @Test
    fun `records survive a reload and completion is sticky`() = runBlocking {
        val file = File(directory, "phone-reminders.json")
        val first = store(file)
        val dated = first.create("Call Ada", 5_000, "about the lease", "Work")
        val undated = first.create("Someday", null, "", "")
        assertEquals(listOf(dated.id, undated.id), first.all().map { it.id })

        // A second instance reads the same file, which is what the boot
        // receiver does after a restart.
        val second = store(file)
        assertEquals(2, second.all().size)

        val completed = assertNotNull(second.complete(dated.id))
        assertTrue(completed.completed)
        assertNotNull(completed.completedAt)

        // Completion survives another reload.
        assertTrue(assertNotNull(store(file).get(dated.id)).completed)
    }

    @Test
    fun `an update changes only what it was given`() = runBlocking {
        val store = store()
        val record = store.create("Original", 5_000, "notes", "Inbox")

        val updated = assertNotNull(store.update(record.id, title = "Renamed", dueAt = null, notes = null))
        assertEquals("Renamed", updated.title)
        assertEquals(5_000L, updated.dueAt, "a null due means untouched")
        assertEquals("notes", updated.notes)

        val moved = assertNotNull(store.update(record.id, title = null, dueAt = 9_000, notes = null))
        assertEquals(9_000L, moved.dueAt)
        assertNull(store.update("missing", title = "x", dueAt = null, notes = null))
    }

    @Test
    fun `delete removes once and reports it`() = runBlocking {
        val store = store()
        val record = store.create("Temporary", null, "", "")
        assertTrue(store.delete(record.id))
        assertFalse(store.delete(record.id))
        assertNull(store.get(record.id))
    }

    @Test
    fun `a corrupt file reads as empty and can be written again`() = runBlocking {
        val file = File(directory, "phone-reminders.json")
        file.writeText("{not json")
        val store = store(file)
        assertEquals(emptyList(), store.all())

        store.create("Fresh start", null, "", "")
        assertEquals(1, store(file).all().size)
    }
}
