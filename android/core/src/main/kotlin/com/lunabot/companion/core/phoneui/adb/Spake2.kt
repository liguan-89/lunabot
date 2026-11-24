/*
 * Ported from Mika (https://github.com/wangzan101/Mika), file
 * core/src/main/kotlin/com/wangzan101/mika/core/adb/Spake2.kt.
 * Copyright 2026 wangzan101. The original is licensed under the Apache License,
 * Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 LunaBot contributors. Changes from the
 * original: repackaged under com.lunabot.companion.core.phoneui.adb and
 * comments translated into English.
 */
package com.lunabot.companion.core.phoneui.adb

import java.math.BigInteger
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * The SPAKE2 variant used by adb wireless pairing (edwards25519 + SHA-512). Must be
 * byte-for-byte identical to the implementation on the device:
 * - private key = (64 random bytes mod L) x 8, multiplied by the cofactor;
 * - password scalar = SHA-512(password) mod L, then L, 2L, 4L added according to the low three
 *   bits so that it becomes a multiple of 8 (matching the device side's historical fix);
 * - send P* = private key · B + password scalar · (M for Alice, N for Bob);
 * - shared secret = SHA-512 of (each part prefixed with its 8-byte little-endian length:
 *   Alice's name, Bob's name, Alice's message, Bob's message,
 *   private key · (Q* - password scalar · peer constant), SHA-512(password)).
 * M and N are derived from public seed strings, see [SEED_M]/[SEED_N]; the tests re-derive and
 * cross-check them.
 */
class Spake2(
    private val role: Role,
    private val myName: ByteArray,
    private val theirName: ByteArray,
) {
    enum class Role { ALICE, BOB }

    private var privateKey: BigInteger? = null
    private var passwordScalar: BigInteger? = null
    private var passwordHash: ByteArray? = null
    private var myMsg: ByteArray? = null
    private var done = false

    fun generateMessage(password: ByteArray, random: SecureRandom = SecureRandom()): ByteArray =
        generateMessage(password, ByteArray(64).also { random.nextBytes(it) })

    /** [seed] is the 64 random bytes; only tests pass a fixed value. */
    internal fun generateMessage(password: ByteArray, seed: ByteArray): ByteArray {
        check(myMsg == null) { "message already generated" }
        require(seed.size == 64)
        val priv = EdPoint.fromLe(seed).mod(EdPoint.L).shiftLeft(3)
        val hash = MessageDigest.getInstance("SHA-512").digest(password)
        var s = EdPoint.fromLe(hash).mod(EdPoint.L)
        if (s.testBit(0)) s += EdPoint.L
        if (s.testBit(1)) s += EdPoint.L.shiftLeft(1)
        if (s.testBit(2)) s += EdPoint.L.shiftLeft(2)
        val mask = (if (role == Role.ALICE) M else N).times(s)
        val msg = (EdPoint.BASE.times(priv) + mask).encode()
        privateKey = priv
        passwordScalar = s
        passwordHash = hash
        myMsg = msg
        return msg.copyOf()
    }

    /** Returns the 64-byte shared secret; throws [IllegalArgumentException] if the peer point is not on the curve. */
    fun processMessage(theirMsg: ByteArray): ByteArray {
        val msg = checkNotNull(myMsg) { "generateMessage first" }
        check(!done) { "already processed" }
        require(theirMsg.size == 32) { "peer message must be 32 bytes" }
        val qStar = requireNotNull(EdPoint.decode(theirMsg)) { "peer point not on curve" }
        val peerMask = (if (role == Role.ALICE) N else M).times(passwordScalar!!)
        val shared = (qStar - peerMask).times(privateKey!!).encode()
        val sha = MessageDigest.getInstance("SHA-512")
        fun put(b: ByteArray) {
            val len = ByteArray(8)
            var l = b.size.toLong()
            for (i in 0 until 8) { len[i] = (l and 0xff).toByte(); l = l ushr 8 }
            sha.update(len)
            sha.update(b)
        }
        if (role == Role.ALICE) {
            put(myName); put(theirName); put(msg); put(theirMsg)
        } else {
            put(theirName); put(myName); put(theirMsg); put(msg)
        }
        put(shared)
        put(passwordHash!!)
        done = true
        return sha.digest()
    }

    companion object {
        const val SEED_M = "edwards25519 point generation seed (M)"
        const val SEED_N = "edwards25519 point generation seed (N)"
        internal val M = requireNotNull(EdPoint.decode(EdPoint.hex("5ada7e4bf6ddd9adb6626d32131c6b5c51a1e347a3478f53cfcf441b88eed12e")))
        internal val N = requireNotNull(EdPoint.decode(EdPoint.hex("10e3df0ae37d8e7a99b5fe74b44672103dbddcbd06af680d71329a11693bc778")))

        /** Derive the constant point from its seed string: SHA-256 of the seed, and if that is not a curve point keep hashing SHA-256 until one is. */
        internal fun derivePoint(seed: String): EdPoint {
            var v = MessageDigest.getInstance("SHA-256").digest(seed.toByteArray(Charsets.US_ASCII))
            while (true) {
                EdPoint.decode(v)?.let { return it }
                v = MessageDigest.getInstance("SHA-256").digest(v)
            }
        }
    }
}
