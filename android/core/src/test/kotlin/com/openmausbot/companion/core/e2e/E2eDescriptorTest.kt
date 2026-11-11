package com.openmausbot.companion.core.e2e

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/** The `e2e` pairing descriptor, pinned to the desktop's V7 vectors. */
class E2eDescriptorTest {
    private val vectors: JsonObject by lazy {
        Json.parseToJsonElement(
            checkNotNull(javaClass.classLoader?.getResource("e2e-vectors-v1.json")).readText(),
        ).jsonObject.getValue("V7").jsonObject
    }

    private fun JsonObject.str(key: String): String = getValue(key).jsonPrimitive.content

    @Test
    fun `every valid descriptor parses to the vector's fields`() {
        for (entry in vectors.getValue("valid").jsonArray.map { it.jsonObject }) {
            val parsed = E2eDescriptorParser.parse(entry.str("value"))
            val ok = assertIs<DescriptorParse.Ok>(parsed, entry.str("name"))
            val expected = entry.getValue("parsed").jsonObject
            assertEquals(expected.str("k"), ok.descriptor.k, "${entry.str("name")} k")
            assertEquals(expected["h"]?.jsonPrimitive?.content, ok.descriptor.h, "${entry.str("name")} h")
            assertEquals(
                expected["r"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),
                ok.descriptor.relays,
                "${entry.str("name")} relays",
            )
            assertEquals(expected["routes"]?.jsonPrimitive?.content, ok.descriptor.routes, "${entry.str("name")} routes")
            assertTrue(ok.transportKey.size == 65, "${entry.str("name")} transport key")
            assertEquals(expected["h"] != null, ok.hostId != null, "${entry.str("name")} host id presence")
        }
    }

    @Test
    fun `every invalid descriptor is refused with the vector's outcome`() {
        for (entry in vectors.getValue("invalid").jsonArray.map { it.jsonObject }) {
            val outcome = entry.str("outcome")
            val parsed = E2eDescriptorParser.parse(entry.str("value"))
            when (outcome) {
                "update" -> assertIs<DescriptorParse.Update>(parsed, entry.str("name"))
                "reject" -> assertIs<DescriptorParse.Reject>(parsed, entry.str("name"))
                else -> throw AssertionError("unknown vector outcome $outcome for ${entry.str("name")}")
            }
        }
    }
}
