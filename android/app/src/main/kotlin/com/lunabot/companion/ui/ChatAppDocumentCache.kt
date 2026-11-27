package com.lunabot.companion.ui

import com.lunabot.companion.core.AppDocument
import com.lunabot.companion.core.CompanionJson
import java.io.File
import java.security.MessageDigest
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString

/** Small on-disk cache for documents already fetched for their exact (thread, message, rev). */
class ChatAppDocumentCache(
    private val directory: File,
    private val maxBytes: Long = 20L * 1024 * 1024,
) {
    fun read(threadId: String, messageId: String, rev: Int): AppDocument? {
        val file = file(threadId, messageId, rev)
        if (!file.isFile) return null
        val document = runCatching {
            CompanionJson.decodeFromString<AppDocument>(file.readText())
        }.getOrNull()?.takeIf { it.valid && it.messageId == messageId && it.rev == rev } ?: return null
        file.setLastModified(System.currentTimeMillis())
        return document
    }

    fun write(threadId: String, document: AppDocument) {
        if (!document.valid || document.messageId.isEmpty()) return
        if (!directory.isDirectory && !directory.mkdirs()) return
        val target = file(threadId, document.messageId, document.rev)
        val temporary = File(directory, "${target.name}.tmp")
        runCatching {
            temporary.writeText(CompanionJson.encodeToString(document))
            if (!temporary.renameTo(target)) {
                target.writeText(temporary.readText())
                temporary.delete()
            }
        }
        prune()
    }

    private fun file(threadId: String, messageId: String, rev: Int): File =
        File(directory, sha256("$threadId\u0000$messageId\u0000$rev") + ".json")

    private fun prune() {
        val files = directory.listFiles { file -> file.isFile && file.name.endsWith(".json") }
            ?.sortedBy { it.lastModified() } ?: return
        var total = files.sumOf { it.length() }
        for (file in files) {
            if (total <= maxBytes) break
            val size = file.length()
            if (file.delete()) total -= size
        }
    }

    private fun sha256(value: String): String =
        MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
}
