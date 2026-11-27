package com.lunabot.companion.ui

import com.lunabot.companion.core.AppNetwork
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ChatAppNetworkTest {
    private val network = AppNetwork(
        connect = listOf(
            "https://api.example.com",
            "https://cdn.example.com",
            "https://*.assets.example.com",
            "wss://live.example.com:8443",
            "http://127.0.0.1:5174/api/page-files/token123/",
        ),
        resources = listOf("https://cdn.example.com", "https://fonts.gstatic.com"),
    )

    @Test
    fun allowsOnlyDeclaredOriginsAndFolderPrefixes() {
        assertTrue(ChatAppNetwork.allows("https://api.example.com/v1/query?q=x", network))
        assertTrue(ChatAppNetwork.allows("https://cdn.example.com/lib.js", network))
        assertTrue(ChatAppNetwork.allows("https://deep.assets.example.com/lib.js", network))
        assertTrue(ChatAppNetwork.allows("wss://live.example.com:8443/socket", network))
        assertTrue(ChatAppNetwork.allows("http://127.0.0.1:5174/api/page-files/token123/data.csv", network))

        assertFalse(ChatAppNetwork.allows("https://evil.example.com/lib.js", network))
        assertFalse(ChatAppNetwork.allows("https://assets.example.com/lib.js", network))
        assertFalse(ChatAppNetwork.allows("https://live.example.com/socket", network))
        assertFalse(ChatAppNetwork.allows("http://127.0.0.1:5174/api/other/token123/data.csv", network))
        assertFalse(ChatAppNetwork.allows("javascript:alert(1)", network))
        assertFalse(ChatAppNetwork.allows("file:///sdcard/secret", network))
    }

    @Test
    fun dataBlobAndAboutURLsStayLocalToTheFrame() {
        assertTrue(ChatAppNetwork.allows("data:text/plain,hello", network))
        assertTrue(ChatAppNetwork.allows("blob:https://example.com/id", network))
        assertTrue(ChatAppNetwork.allows("about:blank", network))
    }

    @Test
    fun nothingExternalPassesWithoutADocumentNetwork() {
        assertFalse(ChatAppNetwork.allows("https://cdn.example.com/lib.js", null))
    }
}
