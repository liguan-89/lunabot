package com.lunabot.companion.ui

import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

class ChatAppPoolTest {
    @AfterTest
    fun clearPool() {
        ChatAppPool.owner?.let(ChatAppPool::release)
    }

    @Test
    fun automaticClaimsDoNotStealAnOwnedSlot() {
        ChatAppPool.claimIfFree("first")
        ChatAppPool.claimIfFree("second")
        assertEquals("first", ChatAppPool.owner)

        ChatAppPool.claim("second")
        ChatAppPool.claimIfFree("third")
        assertEquals("second", ChatAppPool.owner)

        ChatAppPool.release("second")
        ChatAppPool.claimIfFree("third")
        assertEquals("third", ChatAppPool.owner)
    }
}
