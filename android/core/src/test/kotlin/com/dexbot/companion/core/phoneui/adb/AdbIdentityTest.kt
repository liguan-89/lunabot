/*
 * Ported from Mika (https://github.com/wangzan101/Mika), files
 * core/src/test/kotlin/com/wangzan101/mika/core/adb/AdbIdentityTest.kt and
 * AdbIdentitySourceTest.kt.
 * Copyright 2026 wangzan101. The original is licensed under the Apache License,
 * Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 OpenMausBot contributors. Changes from the
 * original: repackaged under com.dexbot.companion.core.phoneui.adb, comments
 * translated into English, assertions moved from JUnit 4 to kotlin.test, and
 * the storage-glue tests (AdbIdentitySource, WrappedKeyFile) are not ported
 * because that glue stays app-side.
 */
package com.dexbot.companion.core.phoneui.adb

import java.math.BigInteger
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.interfaces.RSAPrivateCrtKey
import java.security.interfaces.RSAPrivateKey
import java.security.spec.RSAKeyGenParameterSpec
import java.security.spec.RSAPrivateKeySpec
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull

class AdbIdentityTest {
    private val crt = TestTls.client.keyPair.private as RSAPrivateCrtKey

    /** The same key, but as a platform RSA private key without CRT parameters (the encoding's public exponent is written as 0). */
    private fun nonCrt(key: RSAPrivateCrtKey = crt): RSAPrivateKey =
        KeyFactory.getInstance("RSA").generatePrivate(RSAPrivateKeySpec(key.modulus, key.privateExponent)) as RSAPrivateKey

    @Test
    fun generatedKeyRoundTripsToTheIdenticalPublicKey() {
        // What is stored before an upgrade is exactly the encoding of generate()'s private key:
        // reading it back must yield the same public key so a paired device needs no re-pairing.
        repeat(3) {
            val id = AdbIdentity.generate("dexbot@x")
            val back = AdbIdentity.fromPkcs8(id.keyPair.private.encoded, "dexbot@x")
            assertArrayEquals(id.publicKey.encoded, back.publicKey.encoded)
            assertEquals(id.adbPublicKey, back.adbPublicKey)
            assertArrayEquals(id.certificate.publicKey.encoded, back.certificate.publicKey.encoded)
        }
    }

    @Test
    fun nonCrtPrivateKeyStillParsesToTheSamePublicKey() {
        val key = nonCrt()
        assertFalse(key is RSAPrivateCrtKey)
        val id = AdbIdentity.fromPkcs8(key.encoded, "dexbot@x")
        assertEquals(TestTls.client.publicKey, id.publicKey)
        assertEquals(BigInteger.valueOf(65537), id.publicKey.publicExponent)
        id.certificate.verify(TestTls.client.publicKey)
    }

    @Test
    fun publicExponentComesFromTheEncodingWhenTheKeyObjectLacksIt() {
        assertEquals(BigInteger.valueOf(65537), Pkcs8Rsa.publicExponent(crt.encoded))
        // A non-CRT encoding carries the exponent as 0: treat it as unknown.
        assertEquals(BigInteger.ZERO, Pkcs8Rsa.publicExponent(nonCrt().encoded))
        assertNull(Pkcs8Rsa.publicExponent(byteArrayOf(0x30, 0x05, 1)))
        // The platform key has no CRT parameters but the encoding carries the exponent: use the encoding's.
        assertEquals(BigInteger.valueOf(65537), AdbIdentity.publicExponent(nonCrt(), crt.encoded))
    }

    @Test
    fun exponentThatIsNotF4AndNotStoredIsRejectedNotGuessed() {
        val g = KeyPairGenerator.getInstance("RSA").apply { initialize(RSAKeyGenParameterSpec(2048, BigInteger.valueOf(65539))) }
        val odd = g.generateKeyPair().private as RSAPrivateCrtKey
        val stripped = nonCrt(odd)
        assertFailsWith<AdbKeyUnreadableException> { AdbIdentity.fromPkcs8(stripped.encoded, "dexbot@x") }
        // An encoding that carries the exponent reads back as usual.
        assertEquals(BigInteger.valueOf(65539), AdbIdentity.fromPkcs8(odd.encoded, "dexbot@x").publicKey.publicExponent)
    }

    @Test
    fun garbageIsUnreadable() {
        assertFailsWith<AdbKeyUnreadableException> { AdbIdentity.fromPkcs8(byteArrayOf(1, 2, 3), "dexbot@x") }
    }

    @Test
    fun publicKeyStructure() {
        val id = TestTls.client
        val raw = AdbPublicKey.encode(id.publicKey)
        assertEquals(524, raw.size)
        val bb = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals(64, bb.getInt())
        val n0inv = bb.getInt().toLong() and 0xffffffffL
        val n = EdPoint.fromLe(raw.copyOfRange(8, 264))
        val rr = EdPoint.fromLe(raw.copyOfRange(264, 520))
        bb.position(520)
        assertEquals(65537, bb.getInt())
        assertEquals(id.publicKey.modulus, n)
        // n0inv · n ≡ −1 (mod 2^32)
        val r32 = BigInteger.ONE.shiftLeft(32)
        assertEquals(r32 - BigInteger.ONE, (BigInteger.valueOf(n0inv) * n).mod(r32))
        assertEquals(BigInteger.ONE.shiftLeft(4096).mod(n), rr)

        val (b64, name) = id.adbPublicKey.split(" ", limit = 2)
        assertArrayEquals(raw, Base64.getDecoder().decode(b64))
        assertEquals("dexbot@test", name)
    }

    @Test
    fun adbKeyNameHasNoWhitespace() {
        val id = AdbIdentity(TestTls.client.keyPair, "dexbot@Pixel 4\tXL")
        assertEquals("dexbot@Pixel_4_XL", id.adbPublicKey.substringAfter(' '))
    }

    @Test
    fun selfSignedCertificateParsesAndVerifies() {
        val cert = TestTls.client.certificate
        assertEquals(3, cert.version)
        assertEquals("CN=Mika", cert.subjectX500Principal.name)
        assertEquals(cert.subjectX500Principal, cert.issuerX500Principal)
        assertEquals("SHA256withRSA", cert.sigAlgName)
        assertArrayEquals(TestTls.client.publicKey.encoded, cert.publicKey.encoded)
        cert.verify(TestTls.client.publicKey)
        cert.checkValidity()
        assertEquals(0L, cert.notBefore.time)
    }

    @Test
    fun derLongLengths() {
        assertArrayEquals(byteArrayOf(4, 0x81.toByte(), 0x80.toByte()), SelfSignedCertificate.tlv(4, ByteArray(0x80)).copyOf(3))
        assertArrayEquals(byteArrayOf(4, 0x82.toByte(), 1, 0), SelfSignedCertificate.tlv(4, ByteArray(0x100)).copyOf(4))
    }
}
