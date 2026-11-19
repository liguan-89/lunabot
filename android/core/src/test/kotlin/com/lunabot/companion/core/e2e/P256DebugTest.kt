package com.lunabot.companion.core.e2e

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals

/** Temporary: locate the exact step where the scalar multiplication diverges. */
class P256DebugTest {
    private val root by lazy {
        Json.parseToJsonElement(
            checkNotNull(javaClass.classLoader?.getResource("e2e-vectors-v1.json")).readText(),
        ).jsonObject
    }

    @Test
    fun `one times the peer point is the peer point`() {
        val peer = hexToBytes(root.getValue("V1").jsonObject.getValue("transportPublic").jsonPrimitive.content)
        val point = P256.decodePoint(peer)
        println("peer           ${peer.hex()}")
        println("one*peer       ${P256.encodePoint(P256.decodePoint(peer)).hex()}")
        assertEquals(peer.hex(), P256.encodePoint(point).hex())

        val two = P256.encodePoint(P256.multiplyForTest(point, java.math.BigInteger.TWO))
        println("two*peer       ${two.hex()}")
    }
}
