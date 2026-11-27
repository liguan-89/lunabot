package com.lunabot.companion.ui

import com.lunabot.companion.core.AppCan
import com.lunabot.companion.core.AppDocument
import com.lunabot.companion.core.AppNetwork
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ChatAppDocumentCacheTest {
    @Test
    fun roundTripsOnlyTheExactRevisionAndPrunesLeastRecentlyUsedFiles() {
        val directory = createTempDir()
        val cache = ChatAppDocumentCache(directory, maxBytes = 700)
        val first = document(1, "first")
        val second = document(2, "second")
        cache.write("thread", first)
        cache.write("thread", second)

        assertEquals(first, cache.read("thread", "first", 1))
        assertNull(cache.read("thread", "first", 2))
        assertNull(cache.read("other", "first", 1))

        val files = directory.listFiles { file -> file.name.endsWith(".json") }.orEmpty()
        assertTrue(files.sumOf { it.length() } <= 700)
        directory.deleteRecursively()
    }

    private fun document(rev: Int, messageId: String) = AppDocument(
        v = 1,
        messageId = messageId,
        rev = rev,
        srcdoc = "<!DOCTYPE html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'\"><p>x</p>",
        csp = "default-src 'none'",
        network = AppNetwork(connect = emptyList(), resources = emptyList()),
        can = AppCan(),
    )
}
