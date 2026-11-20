package com.lunabot.companion.core.e2e

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** The yamux half of the desktop wire vectors (V5 frames, V6 invalid frames and sessions). */
class YamuxVectorsTest {
    private val root: JsonObject by lazy {
        Json.parseToJsonElement(
            checkNotNull(javaClass.classLoader?.getResource("e2e-vectors-v1.json")).readText(),
        ).jsonObject
    }

    private fun JsonObject.obj(key: String): JsonObject = getValue(key).jsonObject
    private fun JsonObject.arr(key: String): JsonArray = getValue(key).jsonArray
    private fun JsonObject.str(key: String): String = getValue(key).jsonPrimitive.content

    @Test
    fun `V5 every frame decodes and re-encodes to the same bytes`() {
        for (vector in root.arr("V5").map { it.jsonObject }) {
            val bytes = hexToBytes(vector.str("hex"))
            val frame = Yamux.decode(bytes)
            assertEquals(vector.getValue("type").jsonPrimitive.int, frame.type, "${vector.str("name")} type")
            assertEquals(vector.getValue("flags").jsonPrimitive.int, frame.flags, "${vector.str("name")} flags")
            assertEquals(vector.getValue("streamId").jsonPrimitive.int, frame.streamId, "${vector.str("name")} stream")
            assertEquals(vector.getValue("length").jsonPrimitive.int, frame.length, "${vector.str("name")} length")
            assertEquals(vector.str("hex"), Yamux.encode(frame).hex(), "${vector.str("name")} re-encode")
        }
    }

    @Test
    fun `V6 malformed frames are refused with the vector's reason`() {
        for (vector in root.obj("V6").arr("frames").map { it.jsonObject }) {
            val error = assertFailsWith<YamuxException>(vector.str("name")) {
                Yamux.decode(hexToBytes(vector.str("hex")))
            }
            assertEquals(vector.str("reason"), error.reason, vector.str("name"))
        }
    }

    @Test
    fun `V6 sessions behave exactly like the desktop state machine`() {
        for (session in root.obj("V6").arr("sessions").map { it.jsonObject }) {
            runSession(session)
        }
    }

    private class Recorder : YamuxEvents {
        val sent = ArrayList<Yamux.Frame>()
        var removed = false
        override fun send(frame: Yamux.Frame) {
            sent.add(frame)
        }
        override fun data(streamId: Int, data: ByteArray) = Unit
        override fun ended(streamId: Int) = Unit
        override fun reset(streamId: Int) = Unit
        override fun writable(streamId: Int) = Unit
        override fun goAway(code: Int) {
            removed = code == Yamux.GO_AWAY_REMOVED
        }
    }

    private fun runSession(session: JsonObject) {
        val name = session.str("name")
        val role = session.str("role")
        val expect = session.obj("expect")
        val autoAccept = session["accept"]?.jsonPrimitive?.content == "immediate"
        val recorder = Recorder()
        var state: YamuxMux? = null
        val events = object : YamuxEvents {
            override fun send(frame: Yamux.Frame) = recorder.send(frame)
            override fun data(streamId: Int, data: ByteArray) = Unit
            override fun ended(streamId: Int) = Unit
            override fun reset(streamId: Int) = Unit
            override fun writable(streamId: Int) = Unit
            override fun accepted(streamId: Int) = Unit
            override fun opened(streamId: Int) {
                if (autoAccept) state?.accept(streamId)
            }
            override fun goAway(code: Int) = recorder.goAway(code)
            override fun pong(value: Int) = Unit
        }
        val mux = YamuxMux(role, events)
        state = mux
        val expectedErrorAt = expect["errorAt"]?.jsonPrimitive?.int
        val steps = session.arr("steps").map { it.jsonObject }
        var thrownAt = -1
        steps.forEachIndexed { index, step ->
            if (thrownAt >= 0) return@forEachIndexed
            try {
                when {
                    step["open"]?.jsonPrimitive?.booleanOrNull == true -> mux.open()
                    step["consume"] != null -> {
                        val consume = step.obj("consume")
                        mux.consumed(
                            consume.getValue("stream").jsonPrimitive.int,
                            consume.getValue("bytes").jsonPrimitive.int,
                        )
                    }
                    step["in"] != null -> {
                        val inbound = step.obj("in")
                        val header = hexToBytes(inbound.str("header"))
                        val payload = when {
                            inbound["payload"] != null -> hexToBytes(inbound.str("payload"))
                            inbound["fill"] != null -> {
                                val fill = inbound.getValue("fill").jsonPrimitive.int.toByte()
                                // The payload length comes from the header's length field.
                                val length = java.nio.ByteBuffer.wrap(header, 8, 4).int
                                ByteArray(length) { fill }
                            }
                            else -> ByteArray(0)
                        }
                        mux.receive(Yamux.decode(header + payload))
                    }
                    else -> Unit
                }
            } catch (error: YamuxException) {
                thrownAt = index
            }
        }

        if (expectedErrorAt != null) {
            assertEquals(expectedErrorAt, thrownAt, "$name: expected the profile error at step $expectedErrorAt")
        } else {
            assertEquals(-1, thrownAt, "$name: unexpected profile error at step $thrownAt")
        }

        val expectedSent = expect["sent"]?.jsonArray?.map { it.jsonPrimitive.content }
        if (expectedSent != null) {
            assertEquals(expectedSent, recorder.sent.map { Yamux.encode(it).hex() }, "$name: frames sent")
        }
    }
}
