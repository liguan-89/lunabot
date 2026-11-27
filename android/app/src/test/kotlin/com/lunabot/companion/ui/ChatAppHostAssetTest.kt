package com.lunabot.companion.ui

import java.io.File
import java.security.MessageDigest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class ChatAppHostAssetTest {
    @Test
    fun bundledHostMatchesTheSharedGeneratedPage() {
        val root = repoRoot()
        val shared = File(root, "shared/app-frame/app-host.html").readText()
        val bundled = File(root, "android/app/src/main/assets/app/app-host.html").readText()
        assertEquals(shared, bundled)

        val declared = Regex("^<!-- lunabot app-host v1 sha256:([0-9a-f]{64}) -->\\n")
            .find(shared)?.groupValues?.get(1)
        assertNotNull(declared)
        val body = shared.substringAfter('\n')
        val digest = MessageDigest.getInstance("SHA-256").digest(body.toByteArray(Charsets.UTF_8))
        assertEquals(declared, digest.joinToString("") { "%02x".format(it) })
    }

    private fun repoRoot(): File {
        var directory: File? = File(".").absoluteFile
        while (directory != null) {
            if (File(directory, "shared/app-frame/app-host.html").isFile) return directory
            directory = directory.parentFile
        }
        error("could not find the repository root from ${File(".").absolutePath}")
    }
}
