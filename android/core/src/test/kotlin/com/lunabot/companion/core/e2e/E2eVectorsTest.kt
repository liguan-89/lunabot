package com.openmausbot.companion.core.e2e

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The desktop's wire vectors (`companion/src/e2e/vectors/v1.json`, spec
 * `companion/src/e2e/README.md`). Every implementation must agree with these
 * byte for byte; they are the contract the phone is tested against.
 */
class E2eVectorsTest {
    private val root: JsonObject by lazy {
        val text = checkNotNull(javaClass.classLoader?.getResource("e2e-vectors-v1.json")) {
            "e2e-vectors-v1.json is missing from test resources"
        }.readText()
        Json.parseToJsonElement(text).jsonObject
    }

    private val inputs get() = root.obj("inputs")

    private fun JsonObject.obj(key: String): JsonObject = getValue(key).jsonObject
    private fun JsonObject.arr(key: String): JsonArray = getValue(key).jsonArray
    private fun JsonObject.str(key: String): String = getValue(key).jsonPrimitive.content
    private fun JsonObject.num(key: String): Int = getValue(key).jsonPrimitive.int

    private fun credential(name: String): JsonObject =
        root.obj("V1").arr("credentials").map { it.jsonObject }.first { it.str("name") == name }

    @Test
    fun `V1 derives the transport identity and both credentials secrets`() {
        val v1 = root.obj("V1")
        val transportPrivate = hexToBytes(inputs.str("transportPrivate"))
        val transportPublic = hexToBytes(v1.str("transportPublic"))

        assertEquals(v1.str("transportPublic"), P256.publicKeyOf(transportPrivate).hex())
        assertEquals(v1.str("keyId"), E2eCrypto.sha256(transportPublic).copyOfRange(0, 16).hex())
        assertEquals(v1.str("hostIdB64u"), E2eBase64.encode(hexToBytes(inputs.str("hostId"))))

        for (entry in v1.arr("credentials").map { it.jsonObject }) {
            val token = entry.str("token").toByteArray(Charsets.UTF_8)
            val credHash = E2eCrypto.sha256(token)
            assertEquals(entry.str("credHash"), credHash.hex(), "credHash of ${entry.str("name")}")
            val psk = E2eCrypto.hmacSha256(
                credHash,
                E2eCredentials.PSK_LABEL.toByteArray(Charsets.UTF_8) + hexToBytes(v1.str("keyId")),
            )
            assertEquals(entry.str("psk"), psk.hex(), "psk of ${entry.str("name")}")
            val adm = E2eCrypto.hmacSha256(
                credHash,
                E2eCredentials.ADMISSION_LABEL.toByteArray(Charsets.UTF_8) + hexToBytes(inputs.str("hostId")),
            )
            assertEquals(entry.str("adm"), adm.hex(), "adm of ${entry.str("name")}")
            assertEquals(entry.str("admB64u"), E2eBase64.encode(adm))
            assertEquals(entry.str("admHash"), E2eBase64.encode(E2eCrypto.sha256(adm)))
        }

        val phoneEphemeral = hexToBytes(inputs.str("phoneEphemeralPrivate"))
        val dh = v1.obj("dh")
        assertEquals(dh.str("es"), P256.dh(phoneEphemeral, transportPublic).hex())
        assertEquals(
            dh.str("ee"),
            P256.dh(phoneEphemeral, hexToBytes(v1.str("computerEphemeralPublic"))).hex(),
        )

        for (point in v1.arr("points").map { it.jsonObject }) {
            assertEquals(
                point.getValue("valid").jsonPrimitive.content.toBoolean(),
                P256.isValidPublicKey(hexToBytes(point.str("hex"))),
                "point ${point.str("name")}",
            )
        }
    }

    @Test
    fun `V2 handshake over the relay matches every byte`() = verifyHandshake("V2")

    @Test
    fun `V3 handshake over a direct route matches every byte`() = verifyHandshake("V3")

    private fun verifyHandshake(name: String) {
        val vector = root.obj(name)
        val transport = vector.num("transport").toByte()
        val transportPublic = hexToBytes(root.obj("V1").str("transportPublic"))
        val psk = hexToBytes(credential(vector.str("psk")).str("psk"))

        assertEquals(vector.str("prologue"), Noise.prologue(transport).hex())

        val initiator = NoiseInitiator(
            transport = transport,
            responderStaticPublic = transportPublic,
            psk = psk,
            ephemeralPrivate = hexToBytes(inputs.str("phoneEphemeralPrivate")),
        )
        val message1 = initiator.message1(hexToBytes(vector.str("payload1")))
        assertEquals(vector.str("message1"), message1.hex(), "$name message 1")

        val payload2 = initiator.readMessage2(hexToBytes(vector.str("message2")))
        assertEquals(vector.str("payload2"), payload2.hex(), "$name payload 2")

        val keys = initiator.sessionKeys()
        assertEquals(vector.str("kPc"), keys.kPc.hex(), "$name k_pc")
        assertEquals(vector.str("kCp"), keys.kCp.hex(), "$name k_cp")
        assertEquals(vector.str("handshakeHash"), keys.handshakeHash.hex(), "$name handshake hash")
    }

    @Test
    fun `V4 transport records open and seal exactly`() {
        val records = root.obj("V4")
        val keysOfSession = mapOf(
            "V2" to (root.obj("V2").str("kPc") to root.obj("V2").str("kCp")),
        )
        for (record in records.arr("records").map { it.jsonObject }) {
            val (kPc, kCp) = keysOfSession.getValue(records.str("session"))
            val key = hexToBytes(if (record.str("direction") == "pc") kPc else kCp)
            val n = record.num("n").toLong()
            val frame = hexToBytes(record.str("frame"))
            val sealed = E2eCrypto.seal(key, n, ByteArray(0), frame)
            assertEquals(record.str("record"), sealed.hex(), "record ${record.str("direction")}/$n")
            assertEquals(record.str("frame"), E2eCrypto.open(key, n, ByteArray(0), sealed).hex())
            assertTrue(record.str("nonce").isNotEmpty())
        }
    }

    @Test
    fun `a record on the wrong counter never opens`() {
        val v2 = root.obj("V2")
        val key = hexToBytes(v2.str("kPc"))
        val frame = hexToBytes(root.obj("V4").arr("records").first().jsonObject.str("frame"))
        val sealed = E2eCrypto.seal(key, 0, ByteArray(0), frame)
        var failed = false
        try {
            E2eCrypto.open(key, 1, ByteArray(0), sealed)
        } catch (_: NoiseException) {
            failed = true
        }
        assertTrue(failed, "a replayed record must not open under the next counter")
    }
}
