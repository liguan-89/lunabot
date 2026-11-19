package com.openmausbot.companion.core.e2e

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Strict base64url, no padding — the only encoding the E2E wire accepts. */
object E2eBase64 {
    fun encode(bytes: ByteArray): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    /** Decodes and rejects anything that would re-encode differently (padding, non-canonical tail bits). */
    fun decode(text: String): ByteArray? {
        if (text.isEmpty() || text.length > 4096) return null
        if (!text.all { it.isLetterOrDigit() || it == '-' || it == '_' }) return null
        val bytes = try {
            Base64.getUrlDecoder().decode(text)
        } catch (_: IllegalArgumentException) {
            return null
        }
        return if (encode(bytes) == text) bytes else null
    }

    fun decodeOrThrow(text: String, what: String): ByteArray =
        decode(text) ?: throw NoiseException("bad_base64u_$what")
}

fun ByteArray.hex(): String = joinToString("") { "%02x".format(it) }

fun hexToBytes(hex: String): ByteArray {
    require(hex.length % 2 == 0) { "odd hex" }
    return ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}

/** Every handshake, record, descriptor and credential failure. The reason is local only. */
class NoiseException(val reason: String) : Exception("e2e: $reason")

object E2eCrypto {
    fun sha256(vararg parts: ByteArray): ByteArray {
        val digest = MessageDigest.getInstance("SHA-256")
        for (part in parts) digest.update(part)
        return digest.digest()
    }

    fun hmacSha256(key: ByteArray, vararg parts: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        for (part in parts) mac.update(part)
        return mac.doFinal()
    }

    /** Noise's HKDF: RFC 5869 with the chaining key as salt and empty info. */
    fun hkdf(chainingKey: ByteArray, ikm: ByteArray, outputs: Int): Array<ByteArray> {
        val prk = hmacSha256(chainingKey, ikm)
        val out = ArrayList<ByteArray>(outputs)
        var previous = ByteArray(0)
        for (index in 1..outputs) {
            previous = hmacSha256(prk, previous, byteArrayOf(index.toByte()))
            out += previous
        }
        return out.toTypedArray()
    }

    fun randomBytes(count: Int, random: SecureRandom = SecureRandom()): ByteArray =
        ByteArray(count).also(random::nextBytes)

    /** AES-256-GCM with the 12-byte nonce `0x00000000 || uint64be(n)`; the tag is appended. */
    fun seal(key: ByteArray, n: Long, ad: ByteArray, plaintext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce(n)))
        cipher.updateAAD(ad)
        return cipher.doFinal(plaintext)
    }

    fun open(key: ByteArray, n: Long, ad: ByteArray, ciphertext: ByteArray): ByteArray {
        if (ciphertext.size < TAG_BYTES) throw NoiseException("short_ciphertext")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce(n)))
        cipher.updateAAD(ad)
        return try {
            cipher.doFinal(ciphertext)
        } catch (_: Exception) {
            throw NoiseException("aead")
        }
    }

    private fun nonce(n: Long): ByteArray {
        val nonce = ByteArray(12)
        for (index in 0 until 8) {
            nonce[11 - index] = ((n ushr (8 * index)) and 0xFF).toByte()
        }
        return nonce
    }

    const val TAG_BYTES = 16
}
