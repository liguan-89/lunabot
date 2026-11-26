package com.lunabot.companion.core

import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * RFC 9180 base-mode HPKE for one phone credential envelope.
 *
 * The recipient public key is pinned by the pairing QR. This object only seals;
 * plaintext must never be logged, persisted, or placed in chat.
 */
object PhoneSecretCrypto {
    const val VERSION = 1
    const val MAX_VALUE_BYTES = 4_096
    private const val INFO = "LUNA BOT phone credential v2"
    private const val AAD_IDENTITY = "lunabot-phone-credential-v2"
    private val ROUTE_ID = Regex("^[\\w-]{1,128}$")
    private val TARGET_ID = Regex("^[A-Za-z][A-Za-z0-9]{0,63}$")
    private val KEY_ID = Regex("^[A-Za-z0-9_-]{22}$")
    private val encoder = Base64.getUrlEncoder().withoutPadding()
    private val decoder = Base64.getUrlDecoder()

    data class Context(
        val keyId: String,
        val deviceId: String,
        val botId: String,
        val threadId: String,
        val messageId: String,
        val target: String,
        val requestKey: String,
    )

    data class Envelope(
        val version: Int,
        val keyId: String,
        val deviceId: String,
        val target: String,
        val requestKey: String,
        val encapsulatedKey: String,
        val ciphertext: String,
        val threadId: String,
    )

    fun validRecipientPublicKey(value: String): Boolean =
        decodeBase64Url(value)?.let { publicPoint(it) != null } == true

    fun keyId(recipientPublicKey: String): String {
        val point = decodeBase64Url(recipientPublicKey)
            ?.takeIf { it.size == 65 && it[0].toInt() == 4 }
            ?: throw IllegalArgumentException("invalid recipient key")
        val digest = MessageDigest.getInstance("SHA-256").digest(point)
        return encoder.encodeToString(digest.copyOf(16))
    }

    fun aad(context: Context): ByteArray {
        require(KEY_ID.matches(context.keyId)) { "invalid key id" }
        require(ROUTE_ID.matches(context.deviceId)) { "invalid device id" }
        require(ROUTE_ID.matches(context.botId)) { "invalid bot id" }
        require(ROUTE_ID.matches(context.threadId)) { "invalid thread id" }
        require(ROUTE_ID.matches(context.messageId)) { "invalid message id" }
        require(TARGET_ID.matches(context.target)) { "invalid target" }
        require(ROUTE_ID.matches(context.requestKey)) { "invalid request key" }
        return listOf(
            AAD_IDENTITY,
            context.keyId,
            context.deviceId,
            context.botId,
            context.threadId,
            context.messageId,
            context.target,
            context.requestKey,
        ).joinToString("\n").toByteArray(Charsets.UTF_8)
    }

    fun seal(
        recipientPublicKey: String,
        context: Context,
        plaintext: String,
    ): Envelope {
        val encoded = plaintext.toByteArray(Charsets.UTF_8)
        require(encoded.isNotEmpty() && encoded.size <= MAX_VALUE_BYTES) { "credential size outside 1..4096 bytes" }
        val recipientKey = importPublicKey(decodeBase64Url(recipientPublicKey) ?: throw IllegalArgumentException("invalid recipient key"))
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"))
        val ephemeral = generator.generateKeyPair()
        val ephemeralPublic = (ephemeral.public as ECPublicKey).uncompressed()
        return sealWithEphemeral(recipientPublicKey, recipientKey, ephemeral.private, ephemeralPublic, context, encoded)
    }

    /** Deterministic seam for the cross-language vector; production callers use [seal]. */
    internal fun sealForTesting(
        recipientPublicKey: String,
        ephemeralPrivateKey: ByteArray,
        ephemeralPublicKey: ByteArray,
        context: Context,
        plaintext: String,
    ): Envelope {
        val recipientKey = importPublicKey(decodeBase64Url(recipientPublicKey) ?: throw IllegalArgumentException("invalid recipient key"))
        val privateKey = KeyFactory.getInstance("EC").generatePrivate(
            ECPrivateKeySpec(BigInteger(1, ephemeralPrivateKey), p256Params()),
        )
        return sealWithEphemeral(
            recipientPublicKey,
            recipientKey,
            privateKey,
            ephemeralPublicKey.copyOf(),
            context,
            plaintext.toByteArray(Charsets.UTF_8),
        )
    }

    private fun sealWithEphemeral(
        recipientPublicKey: String,
        recipientKey: ECPublicKey,
        ephemeralPrivateKey: java.security.PrivateKey,
        ephemeralPublicKey: ByteArray,
        context: Context,
        plaintext: ByteArray,
    ): Envelope {
        require(ephemeralPublicKey.size == 65 && ephemeralPublicKey[0].toInt() == 4) { "invalid ephemeral key" }
        val agreement = KeyAgreement.getInstance("ECDH")
        agreement.init(ephemeralPrivateKey)
        agreement.doPhase(recipientKey, true)
        val dh = fixed32(agreement.generateSecret())

        val kemContext = ephemeralPublicKey + recipientPublicKeyBytes(recipientKey)
        val sharedSecret = extractAndExpand(
            salt = ByteArray(0),
            ikm = labeledIkm(KEM_SUITE_ID, "eae_prk", dh),
            info = labeledInfo(KEM_SUITE_ID, "shared_secret", kemContext, 32),
            length = 32,
        )

        val pskIdHash = labeledExtract(HPKE_SUITE_ID, ByteArray(0), "psk_id_hash", ByteArray(0))
        val infoHash = labeledExtract(HPKE_SUITE_ID, ByteArray(0), "info_hash", INFO.toByteArray(Charsets.UTF_8))
        val keyScheduleContext = byteArrayOf(0) + pskIdHash + infoHash
        val secretIkm = labeledIkm(HPKE_SUITE_ID, "secret", ByteArray(0))
        val key = extractAndExpand(
            salt = sharedSecret,
            ikm = secretIkm,
            info = labeledInfo(HPKE_SUITE_ID, "key", keyScheduleContext, 32),
            length = 32,
        )
        val nonce = extractAndExpand(
            salt = sharedSecret,
            ikm = secretIkm,
            info = labeledInfo(HPKE_SUITE_ID, "base_nonce", keyScheduleContext, 12),
            length = 12,
        )

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad(context))
        val ciphertext = cipher.doFinal(plaintext)
        plaintext.fill(0)

        return Envelope(
            version = VERSION,
            keyId = context.keyId,
            deviceId = context.deviceId,
            target = context.target,
            requestKey = context.requestKey,
            encapsulatedKey = encoder.encodeToString(ephemeralPublicKey),
            ciphertext = encoder.encodeToString(ciphertext),
            threadId = context.threadId,
        )
    }

    private val KEM_SUITE_ID = byteArrayOf('K'.code.toByte(), 'E'.code.toByte(), 'M'.code.toByte(), 0x00, 0x10)
    private val HPKE_SUITE_ID = byteArrayOf(
        'H'.code.toByte(), 'P'.code.toByte(), 'K'.code.toByte(), 'E'.code.toByte(),
        0x00, 0x10, 0x00, 0x01, 0x00, 0x02,
    )
    private val HPKE_VERSION = "HPKE-v1".toByteArray(Charsets.US_ASCII)

    private fun labeledIkm(suiteId: ByteArray, label: String, ikm: ByteArray): ByteArray =
        HPKE_VERSION + suiteId + label.toByteArray(Charsets.US_ASCII) + ikm

    private fun labeledInfo(suiteId: ByteArray, label: String, info: ByteArray, length: Int): ByteArray =
        byteArrayOf((length ushr 8).toByte(), length.toByte()) +
            HPKE_VERSION + suiteId + label.toByteArray(Charsets.US_ASCII) + info

    private fun labeledExtract(suiteId: ByteArray, salt: ByteArray, label: String, ikm: ByteArray): ByteArray =
        hkdfExtract(salt, labeledIkm(suiteId, label, ikm))

    private fun extractAndExpand(salt: ByteArray, ikm: ByteArray, info: ByteArray, length: Int): ByteArray =
        hkdfExpand(hkdfExtract(salt, ikm), info, length)

    private fun hkdfExtract(salt: ByteArray, ikm: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(if (salt.isEmpty()) ByteArray(32) else salt, "HmacSHA256"))
        return mac.doFinal(ikm)
    }

    private fun hkdfExpand(prk: ByteArray, info: ByteArray, length: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        val output = ByteArray(length)
        var previous = ByteArray(0)
        var offset = 0
        var counter = 1
        while (offset < length) {
            previous = mac.doFinal(previous + info + byteArrayOf(counter.toByte()))
            val take = minOf(previous.size, length - offset)
            previous.copyInto(output, offset, 0, take)
            offset += take
            counter += 1
        }
        return output
    }

    private fun decodeBase64Url(value: String): ByteArray? {
        if (!value.matches(Regex("^[A-Za-z0-9_-]+$"))) return null
        return runCatching { decoder.decode(value) }.getOrNull()
            ?.takeIf { encoder.encodeToString(it) == value }
    }

    private fun p256Params(): ECParameterSpec {
        val parameters = java.security.AlgorithmParameters.getInstance("EC")
        parameters.init(ECGenParameterSpec("secp256r1"))
        return parameters.getParameterSpec(ECParameterSpec::class.java)
    }

    private fun importPublicKey(encodedPoint: ByteArray): ECPublicKey {
        require(encodedPoint.size == 65 && encodedPoint[0].toInt() == 4) { "invalid P-256 point" }
        val x = BigInteger(1, encodedPoint.copyOfRange(1, 33))
        val y = BigInteger(1, encodedPoint.copyOfRange(33, 65))
        require(isOnCurve(x, y)) { "P-256 point is not on curve" }
        return KeyFactory.getInstance("EC").generatePublic(
            ECPublicKeySpec(ECPoint(x, y), p256Params()),
        ) as ECPublicKey
    }

    private fun publicPoint(encodedPoint: ByteArray): ECPublicKey? =
        runCatching { importPublicKey(encodedPoint) }.getOrNull()

    private fun isOnCurve(x: BigInteger, y: BigInteger): Boolean {
        if (x.signum() < 0 || x >= P256_P || y.signum() < 0 || y >= P256_P) return false
        val left = y.modPow(BigInteger.TWO, P256_P)
        val right = x.modPow(BigInteger.valueOf(3), P256_P)
            .subtract(P256_THREE.multiply(x))
            .add(P256_B)
            .mod(P256_P)
        return left == right
    }

    private fun recipientPublicKeyBytes(key: ECPublicKey): ByteArray = key.uncompressed()

    private fun ECPublicKey.uncompressed(): ByteArray =
        byteArrayOf(4) + fixed32(w.affineX.toByteArray()) + fixed32(w.affineY.toByteArray())

    private fun fixed32(value: ByteArray): ByteArray {
        val unsigned = if (value.size > 32 && value[0].toInt() == 0) value.copyOfRange(1, value.size) else value
        require(unsigned.size <= 32) { "P-256 integer is too large" }
        return ByteArray(32 - unsigned.size) + unsigned
    }

    private val P256_P = BigInteger("FFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF", 16)
    private val P256_B = BigInteger("5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B", 16)
    private val P256_THREE = BigInteger.valueOf(3)
}


/** Why a pairing cannot submit a secure credential here. */
enum class PhoneSecretEntryBlocker {
    /** The scan did not pin a recipient key, or this build does not know the paired-device id. */
    NEEDS_RESCAN,
    /** LAN/Bonjour cleartext HTTP may carry chat, but never a credential submission. */
    NEEDS_PROTECTED_ROUTE,
}

/** Null means this connection may carry one HPKE credential envelope. */
fun Connection.phoneSecretEntryBlocker(): PhoneSecretEntryBlocker? {
    if (secretPublicKey == null || companionDeviceId == null) return PhoneSecretEntryBlocker.NEEDS_RESCAN
    val endpoint = activeEndpoint ?: CompanionEndpoint.direct(host, port, priority = 0)
    val protectedRoute = e2eDescriptor != null || endpoint?.protectsCredentials == true
    return if (protectedRoute) null else PhoneSecretEntryBlocker.NEEDS_PROTECTED_ROUTE
}

/** Seal [plaintext] for this exact pending card. The caller clears its plaintext field immediately after this returns. */
fun Connection.sealPhoneSecret(
    botId: String,
    threadId: String,
    messageId: String,
    target: String,
    requestKey: String,
    plaintext: String,
): PhoneSecretCrypto.Envelope {
    check(phoneSecretEntryBlocker() == null) { "secure credential entry is unavailable on this connection" }
    val recipient = requireNotNull(secretPublicKey)
    val device = requireNotNull(companionDeviceId)
    val keyId = PhoneSecretCrypto.keyId(recipient)
    return PhoneSecretCrypto.seal(
        recipientPublicKey = recipient,
        context = PhoneSecretCrypto.Context(
            keyId = keyId,
            deviceId = device,
            botId = botId,
            threadId = threadId,
            messageId = messageId,
            target = target,
            requestKey = requestKey,
        ),
        plaintext = plaintext,
    )
}
