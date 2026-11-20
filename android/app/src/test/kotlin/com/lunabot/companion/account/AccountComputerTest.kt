package com.lunabot.companion.account

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The account lists every installation, so the list in 我的电脑 has to be told
 * which rows are computers a phone can ask to connect.
 */
class AccountComputerTest {
    @Test
    fun `a desktop is connectable`() {
        val desktop = AccountComputer(id = "a", name = "Mac", platform = "darwin", online = true, kind = "desktop")

        assertTrue(desktop.connectable)
    }

    @Test
    fun `this phone's own row is not`() {
        val phone = AccountComputer(id = "b", name = "OnePlus", platform = "android", online = true, kind = "phone")

        assertFalse(phone.connectable)
    }

    @Test
    fun `a server row is not`() {
        val server = AccountComputer(id = "c", name = "Team server", platform = "linux", online = false, kind = "server")

        assertFalse(server.connectable)
    }

    @Test
    fun `an installation from before kind existed reads as a computer`() {
        // Older control planes answered without `kind`; every row they had was a
        // desktop, so the default keeps them reachable instead of hiding them.
        val legacy = AccountComputer(id = "d", name = "Mac", platform = "darwin", online = false)

        assertEquals("desktop", legacy.kind)
        assertTrue(legacy.connectable)
    }
}
