/*
 * Rejection-case tests for the helper handoff validator and the one-time
 * nonce gate, ported alongside the protocol they pin from Mika
 * (https://github.com/wangzan101/Mika), file
 * core/src/test/kotlin/com/wangzan101/mika/core/shell/HelperHandoffTest.kt.
 * Copyright 2026 wangzan101. The original is licensed under the Apache
 * License, Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 OpenMausBot contributors: adapted to the
 * trimmed protocol in HandoffProtocol.kt (no USB-script surface).
 */
package com.openmausbot.companion.phoneui.shell

import com.openmausbot.companion.phoneui.shell.HandoffProtocol.Reject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PhoneUiHandoffValidatorTest {
    private class MemStore : NonceStore {
        var slots = NonceSlots()
        override fun load() = slots
        override fun save(slots: NonceSlots) {
            this.slots = slots
        }
    }

    private var now = 1_000L

    private fun nonces(store: NonceStore = MemStore()): NonceGate {
        var n = 0
        return NonceGate(store, clock = { now }) { "n${++n}" }
    }

    @Test
    fun `only shell with matching ids and the current apk passes`() {
        fun check(
            uid: Int = 2000,
            pid: Int = 77,
            rUid: Int = uid,
            rPid: Int = pid,
            apk: String? = "/a.apk",
            binder: Boolean = true,
        ) = HandoffProtocol.check(uid, pid, rUid, rPid, apk, "/a.apk", binder)
        assertNull(check())
        assertEquals(Reject.NotShell, check(uid = 10123))
        assertEquals(Reject.NotShell, check(uid = 0))
        assertEquals(Reject.NotShell, check(uid = 2000 + 100_000))
        assertEquals(Reject.IdMismatch, check(rPid = 78))
        assertEquals(Reject.IdMismatch, check(rUid = 0))
        assertEquals(Reject.StaleApk, check(apk = "/old.apk"))
        assertEquals(Reject.StaleApk, check(apk = null))
        assertEquals(Reject.NoBinder, check(binder = false))
    }

    @Test
    fun `the launch nonce is single use and rotates`() {
        val g = nonces()
        val launch = g.issueLaunch()
        assertFalse(g.matches("nope"))
        assertFalse(g.matches(null))
        assertTrue(g.matches(launch))
        val next = g.accept(launch)
        assertNotNull(next)
        assertNotEquals(launch, next)
        // Spent: rejected even for matches.
        assertNull(g.accept(launch))
        assertFalse(g.matches(launch))
        // The rotated nonce is also one-time.
        val after = g.accept(next)
        assertNotNull(after)
        assertNull(g.accept(next))
    }

    @Test
    fun `accepting either slot voids the other`() {
        val g = nonces()
        val resume = g.accept(g.issueLaunch())!!
        val launch = g.issueLaunch()
        // The older helper re-handoffs first: the freshly started one's nonce is void.
        assertNotNull(g.accept(resume))
        assertNull(g.accept(launch))

        val resume2 = g.accept(g.issueLaunch())!!
        val launch2 = g.issueLaunch()
        assertNotNull(g.accept(launch2))
        assertNull(g.accept(resume2))
    }

    @Test
    fun `the resume nonce survives a process restart`() {
        val store = MemStore()
        val resume = nonces(store).accept(nonces(store).issueLaunch())
        // A new process reads the same store.
        assertNotNull(nonces(store).accept(resume))
    }

    @Test
    fun `clear voids everything`() {
        val g = nonces()
        val launch = g.issueLaunch()
        g.clear()
        assertFalse(g.matches(launch))
        assertNull(g.accept(launch))
    }

    @Test
    fun `random nonces are long and distinct`() {
        val a = NonceGate.randomNonce()
        assertEquals(64, a.length)
        assertNotEquals(a, NonceGate.randomNonce())
    }

    @Test
    fun `an unused launch nonce expires`() {
        val g = nonces()
        val launch = g.issueLaunch()
        now += NonceGate.LAUNCH_TTL_MS
        assertTrue(g.matches(launch))
        now += 1
        assertFalse(g.matches(launch))
        assertNull(g.accept(launch))
    }

    @Test
    fun `a launch nonce from the future is not trusted`() {
        // The recorded issue time is ahead of now (clock restarted from zero): expired.
        val store = MemStore()
        val launch = nonces(store).issueLaunch()
        now -= 1
        assertFalse(nonces(store).matches(launch))
    }

    @Test
    fun `the resume nonce does not expire`() {
        val g = nonces()
        val resume = g.accept(g.issueLaunch())
        now += 10 * NonceGate.LAUNCH_TTL_MS
        assertNotNull(g.accept(resume))
    }

    @Test
    fun `the cert pin is sha-256 hex and ignores signer order`() {
        val a = "abc".toByteArray()
        val b = "xyz".toByteArray()
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", HandoffProtocol.certPin(listOf(a)))
        assertEquals(HandoffProtocol.certPin(listOf(a, b)), HandoffProtocol.certPin(listOf(b, a)))
        assertNotEquals(HandoffProtocol.certPin(listOf(a)), HandoffProtocol.certPin(listOf(a, b)))
        assertNull(HandoffProtocol.certPin(emptyList()))
        assertNull(HandoffProtocol.certPin(null))
    }

    @Test
    fun `the launch command runs the helper detached and feeds the nonce through stdin`() {
        val cmd = HandoffProtocol.command(
            "/data/app/~~x/com.dexbot.companion-y/base.apk",
            "com.dexbot.companion",
            10234,
            "ab'cd",
        )
        assertTrue(cmd.startsWith("read n; (echo \"\$n\" | CLASSPATH="))
        // Detached session, named process, entry point and pinned cert as arguments.
        assertTrue(cmd.contains(" setsid app_process /system/bin --nice-name='com.dexbot.companion:phoneui-helper' "))
        assertTrue(cmd.contains(" com.openmausbot.companion.phoneui.shell.PhoneUiHelperMain 'com.dexbot.companion' 10234 'ab'\\''cd' "))
        // No nonce in the command line, and stdin held open until the handoff.
        assertTrue(cmd.endsWith(" >/dev/null 2>&1 &); read _"))
        assertFalse(cmd.contains("nonce"))
    }

    @Test
    fun `the nonce travels on its own stdin line`() {
        assertEquals("abc\n", String(HandoffProtocol.stdinLine("abc"), Charsets.UTF_8))
    }

    @Test
    fun `the provider authority is the application id plus phoneui dot helper`() {
        assertEquals("com.dexbot.companion.phoneui.helper", HandoffProtocol.authority("com.dexbot.companion"))
    }

    @Test
    fun `the helper process name is package plus phoneui-helper`() {
        assertEquals("com.dexbot.companion:phoneui-helper", HandoffProtocol.processName("com.dexbot.companion"))
    }
}
