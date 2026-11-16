/*
 * Ported from Mika (https://github.com/wangzan101/Mika), file
 * core/src/main/kotlin/com/wangzan101/mika/core/adb/Ed25519.kt.
 * Copyright 2026 wangzan101. The original is licensed under the Apache License,
 * Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 OpenMausBot contributors. Changes from the
 * original: repackaged under com.dexbot.companion.core.phoneui.adb and
 * comments translated into English.
 */
package com.dexbot.companion.core.phoneui.adb

import java.math.BigInteger

/**
 * Point arithmetic on edwards25519 (extended homogeneous coordinates X:Y:Z:T with x=X/Z,
 * y=Y/Z, xy=T/Z); formulas and encodings follow RFC 8032 §5.1.
 * Only used by SPAKE2 during pairing: a pairing performs a handful of scalar multiplications,
 * so BigInteger is fast enough, and constant time is not pursued because the private key is
 * single-use and the pairing code is visible on the device screen anyway.
 */
internal class EdPoint private constructor(
    private val x: BigInteger,
    private val y: BigInteger,
    private val z: BigInteger,
    private val t: BigInteger,
) {
    operator fun plus(o: EdPoint): EdPoint {
        val a = (y - x) * (o.y - o.x) % P
        val b = (y + x) * (o.y + o.x) % P
        val c = t * D2 % P * o.t % P
        val d = z * TWO * o.z % P
        val e = b - a
        val f = d - c
        val g = d + c
        val h = b + a
        return EdPoint(e * f % P, g * h % P, f * g % P, e * h % P)
    }

    operator fun unaryMinus() = EdPoint(P - x.mod(P), y, z, P - t.mod(P))

    operator fun minus(o: EdPoint) = this + (-o)

    /** k · this, k >= 0. */
    fun times(k: BigInteger): EdPoint {
        require(k.signum() >= 0)
        var acc = IDENTITY
        for (i in k.bitLength() - 1 downTo 0) {
            acc += acc
            if (k.testBit(i)) acc += this
        }
        return acc
    }

    /** Affine coordinates (x, y), both in [0, p). */
    fun affine(): Pair<BigInteger, BigInteger> {
        val zi = z.mod(P).modInverse(P)
        return (x * zi).mod(P) to (y * zi).mod(P)
    }

    /** 32 bytes: y little-endian, with the parity of x in the top bit. */
    fun encode(): ByteArray {
        val zi = z.mod(P).modInverse(P)
        val ax = x * zi % P
        val ay = (y * zi).mod(P)
        val out = toLe(ay, 32)
        if (ax.mod(P).testBit(0)) out[31] = (out[31].toInt() or 0x80).toByte()
        return out
    }

    override fun equals(other: Any?): Boolean =
        other is EdPoint && (x * other.z - other.x * z).mod(P).signum() == 0 && (y * other.z - other.y * z).mod(P).signum() == 0

    override fun hashCode(): Int = encode().contentHashCode()

    companion object {
        // Do not use BigInteger.TWO: it only exists since Android 13, and on Android 12 class
        // loading would throw NoSuchFieldError and crash the whole process during pairing.
        private val TWO = BigInteger.valueOf(2)
        val P: BigInteger = TWO.pow(255) - BigInteger.valueOf(19)
        /** Order of the prime-order subgroup. */
        val L: BigInteger = TWO.pow(252) + BigInteger("27742317777372353535851937790883648493")
        private val D: BigInteger = (BigInteger.valueOf(-121665) * BigInteger.valueOf(121666).modInverse(P)).mod(P)
        private val D2 = D * TWO % P
        private val SQRT_M1: BigInteger = TWO.modPow((P - BigInteger.ONE).shiftRight(2), P)

        val IDENTITY = EdPoint(BigInteger.ZERO, BigInteger.ONE, BigInteger.ONE, BigInteger.ZERO)

        val BASE: EdPoint = requireNotNull(
            decode(hex("5866666666666666666666666666666666666666666666666666666666666666")),
        )

        /** RFC 8032 §5.1.3; null if not on the curve or the encoding is not canonical. */
        fun decode(bytes: ByteArray): EdPoint? {
            if (bytes.size != 32) return null
            val raw = bytes.copyOf()
            val sign = (raw[31].toInt() ushr 7) and 1
            raw[31] = (raw[31].toInt() and 0x7f).toByte()
            val y = fromLe(raw)
            if (y >= P) return null
            val yy = y * y % P
            val u = (yy - BigInteger.ONE).mod(P)
            val v = (D * yy + BigInteger.ONE) % P
            val v3 = v * v % P * v % P
            val v7 = v3 * v3 % P * v % P
            var x = u * v3 % P * (u * v7 % P).modPow((P - BigInteger.valueOf(5)).shiftRight(3), P) % P
            val vxx = v * x % P * x % P
            x = when {
                vxx == u -> x
                vxx == (P - u).mod(P) -> x * SQRT_M1 % P
                else -> return null
            }
            if (x.signum() == 0 && sign == 1) return null
            if (x.testBit(0) != (sign == 1)) x = P - x
            return EdPoint(x, y, BigInteger.ONE, x * y % P)
        }

        fun fromLe(b: ByteArray): BigInteger = BigInteger(1, b.reversedArray())

        fun toLe(n: BigInteger, len: Int): ByteArray {
            val be = n.toByteArray()
            val out = ByteArray(len)
            for (i in 0 until minOf(len, be.size)) out[i] = be[be.size - 1 - i]
            require(be.size <= len || be.copyOfRange(0, be.size - len).all { it == 0.toByte() }) { "value too large" }
            return out
        }

        fun hex(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }
}
