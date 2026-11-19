package com.lunabot.companion.core.e2e

import java.math.BigInteger
import java.security.SecureRandom

/**
 * P-256 (secp256r1) arithmetic for the E2E handshake.
 *
 * The wire needs three things: a 65-byte uncompressed public key (0x04‖X‖Y), the
 * 32-byte X coordinate of a shared point, and a hard rejection of anything that
 * is not a canonical point on the curve. This is implemented here rather than
 * through JCA so the desktop vectors and the phone produce byte-identical
 * results on every JVM and every Android provider, and so a private scalar can
 * be turned into its public key without a key store.
 *
 * Affine coordinates, one modular inverse per point operation: a handshake does
 * a few hundred operations, so the simplicity is worth more than the constant
 * factor. `E2eVectorsTest` pins every result against the desktop's vectors.
 */
object P256 {
    val P: BigInteger = BigInteger("FFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF", 16)
    val A: BigInteger = P.subtract(BigInteger.valueOf(3))
    val B: BigInteger = BigInteger("5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B", 16)
    val N: BigInteger = BigInteger("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", 16)
    private val GX = BigInteger("6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296", 16)
    private val GY = BigInteger("4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5", 16)
    private val G = Point(GX, GY)
    private val THREE = BigInteger.valueOf(3)

    const val PUBLIC_KEY_BYTES = 65
    const val PRIVATE_KEY_BYTES = 32
    const val SHARED_BYTES = 32

    /** An affine point; null stands for the point at infinity inside the arithmetic. */
    data class Point(val x: BigInteger, val y: BigInteger)

    data class KeyPair(val privateKey: ByteArray, val publicKey: ByteArray) {
        override fun equals(other: Any?): Boolean =
            other is KeyPair && privateKey.contentEquals(other.privateKey) && publicKey.contentEquals(other.publicKey)

        override fun hashCode(): Int = 31 * privateKey.contentHashCode() + publicKey.contentHashCode()
    }

    fun generateKeyPair(random: SecureRandom = SecureRandom()): KeyPair {
        while (true) {
            val bytes = ByteArray(PRIVATE_KEY_BYTES)
            random.nextBytes(bytes)
            val d = BigInteger(1, bytes)
            if (d.signum() <= 0 || d >= N) continue
            return KeyPair(bytes, encodePoint(multiply(G, d)))
        }
    }

    /** The scalar as it goes on the wire: 32 big-endian bytes. Throws for a scalar outside [1, n). */
    fun privateKeyBytes(d: BigInteger): ByteArray {
        require(d.signum() > 0 && d < N) { "bad_private_key" }
        return unsignedFixed(d, PRIVATE_KEY_BYTES)
    }

    fun publicKeyOf(privateKey: ByteArray): ByteArray {
        require(privateKey.size == PRIVATE_KEY_BYTES) { "bad_private_key" }
        val d = BigInteger(1, privateKey)
        require(d.signum() > 0 && d < N) { "bad_private_key" }
        return encodePoint(multiply(G, d))
    }

    /** Q = priv · pub, as the 32-byte X coordinate. Rejects anything that is not a canonical 65-byte point. */
    fun dh(privateKey: ByteArray, publicKey: ByteArray): ByteArray {
        require(publicKey.size == PUBLIC_KEY_BYTES && publicKey[0] == 0x04.toByte()) { "bad_point" }
        val peer = decodePoint(publicKey)
        val shared = multiply(peer, BigInteger(1, privateKey))
        return unsignedFixed(shared.x, SHARED_BYTES)
    }

    /** True for a 65-byte, on-curve, canonical point. */
    fun isValidPublicKey(bytes: ByteArray): Boolean = try {
        dh(ByteArray(PRIVATE_KEY_BYTES) { 1 }, bytes)
        true
    } catch (_: IllegalArgumentException) {
        false
    }

    fun encodePoint(point: Point): ByteArray {
        val out = ByteArray(PUBLIC_KEY_BYTES)
        out[0] = 0x04
        System.arraycopy(unsignedFixed(point.x, 32), 0, out, 1, 32)
        System.arraycopy(unsignedFixed(point.y, 32), 0, out, 33, 32)
        return out
    }

    /** Decodes and validates a point, including the "not at or above p" and on-curve checks. */
    fun decodePoint(bytes: ByteArray): Point {
        require(bytes.size == PUBLIC_KEY_BYTES && bytes[0] == 0x04.toByte()) { "bad_point" }
        val x = BigInteger(1, bytes.copyOfRange(1, 33))
        val y = BigInteger(1, bytes.copyOfRange(33, 65))
        require(x.signum() >= 0 && x < P && y.signum() >= 0 && y < P) { "bad_point" }
        // y² ≡ x³ + ax + b (mod p)
        val left = y.multiply(y).mod(P)
        val right = x.multiply(x).multiply(x).add(A.multiply(x)).add(B).mod(P)
        require(left == right) { "bad_point" }
        return Point(x, y)
    }

    /** Test-only: scalar multiplication of an arbitrary point. */
    internal fun multiplyForTest(point: Point, scalar: BigInteger): Point = multiply(point, scalar)

    private fun multiply(point: Point, scalar: BigInteger): Point {
        var result: Point? = null
        var addend: Point? = point
        var k = scalar.mod(N)
        while (k.signum() > 0) {
            if (k.testBit(0)) result = add(result, addend)
            addend = addend?.let(::double)
            k = k.shiftRight(1)
        }
        return requireNotNull(result) { "bad_point" }
    }

    private fun double(point: Point): Point? {
        if (point.y.signum() == 0) return null
        val lambda = point.x.multiply(point.x).multiply(THREE).add(A)
            .multiply(point.y.shiftLeft(1).modInverse(P)).mod(P)
        val x3 = lambda.multiply(lambda).subtract(point.x.shiftLeft(1)).mod(P)
        val y3 = lambda.multiply(point.x.subtract(x3)).subtract(point.y).mod(P)
        return Point(x3, y3)
    }

    private fun add(a: Point?, b: Point?): Point? {
        if (a == null) return b
        if (b == null) return a
        if (a.x == b.x) return if (a.y.add(b.y).mod(P).signum() == 0) null else double(a)
        val lambda = b.y.subtract(a.y).multiply(b.x.subtract(a.x).modInverse(P)).mod(P)
        val x3 = lambda.multiply(lambda).subtract(a.x).subtract(b.x).mod(P)
        val y3 = lambda.multiply(a.x.subtract(x3)).subtract(a.y).mod(P)
        return Point(x3, y3)
    }

    private fun unsignedFixed(value: BigInteger, size: Int): ByteArray {
        val raw = value.toByteArray()
        val out = ByteArray(size)
        val src = raw.dropWhile { it == 0.toByte() }
        require(src.size <= size) { "value too large" }
        System.arraycopy(src.toByteArray(), 0, out, size - src.size, src.size)
        return out
    }
}
