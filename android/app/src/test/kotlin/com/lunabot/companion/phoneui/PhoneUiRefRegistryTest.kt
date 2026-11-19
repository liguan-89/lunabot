/*
 * Pins the opaque-ref security invariant: a ref resolves only while the
 * snapshot it was issued in is the latest one, and every rotation, clear or
 * service handoff kills every outstanding ref.
 */
package com.openmausbot.companion.phoneui

import java.util.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PhoneUiRefRegistryTest {
    private class Node(val id: Int)

    private fun registry(seed: Long = 1L) = PhoneUiRefRegistry<Node>(Random(seed))

    @Test
    fun `refs are issued only while a snapshot is open`() {
        val registry = registry()
        assertNull(registry.register(Node(1)), "no ref before the first snapshot")
        registry.rotate("s1")
        val ref = registry.register(Node(1))
        assertNotNull(ref)
        assertEquals(1, registry.resolve(ref)?.id)
    }

    @Test
    fun `refs are opaque and neither sequential nor structural`() {
        val registry = registry()
        registry.rotate("s1")
        val refs = (1..50).map { registry.register(Node(it))!! }
        // A bot that saw one ref must not be able to widen it to another.
        for (ref in refs) {
            assertTrue(ref.length == 24, "ref $ref must be a fixed random token")
            assertTrue(ref.all { it in "0123456789abcdef" }, "ref $ref must be a hex token")
            assertTrue(ref !in setOf("0", "1", "000000000000000000000000"))
        }
        assertEquals(refs.size, refs.toSet().size, "refs must be unique")
    }

    @Test
    fun `a rotation kills every ref from the previous snapshot`() {
        val registry = registry()
        registry.rotate("s1")
        val oldRef = registry.register(Node(1))!!
        registry.rotate("s2")
        assertNull(registry.resolve(oldRef), "a ref from a superseded snapshot must not resolve")
        val newRef = registry.register(Node(2))!!
        assertEquals(2, registry.resolve(newRef)?.id)
        assertEquals(1, registry.size())
    }

    @Test
    fun `garbage and empty refs resolve to nothing`() {
        val registry = registry()
        registry.rotate("s1")
        registry.register(Node(1))
        for (ref in listOf(null, "", "n0", "0", "../1", "s1", " ".repeat(24))) {
            assertNull(registry.resolve(ref), "ref $ref must not resolve")
        }
    }

    @Test
    fun `clear wipes the snapshot and every ref`() {
        val registry = registry()
        registry.rotate("s1")
        val ref = registry.register(Node(1))!!
        registry.clear()
        assertNull(registry.resolve(ref))
        assertNull(registry.register(Node(2)), "no ref after clear")
    }

    @Test
    fun `a valid ref survives an unrelated resolve attempt`() {
        val registry = registry()
        registry.rotate("s1")
        val ref = registry.register(Node(7))!!
        for (attempt in 1..100) assertNull(registry.resolve("guess-$attempt"))
        assertEquals(7, registry.resolve(ref)?.id)
    }
}
