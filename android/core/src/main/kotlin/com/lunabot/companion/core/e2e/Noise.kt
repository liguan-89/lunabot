package com.lunabot.companion.core.e2e

import java.security.SecureRandom

/**
 * `Noise_NKpsk0_P256_AESGCM_SHA256` — the phone (initiator) half — and the
 * transport records that follow it. Normative spec:
 * `companion/src/e2e/README.md`, sections 5 and 6; `companion/src/e2e/noise.ts`
 * is the desktop implementation these byte-for-byte agree with.
 */
object Noise {
    const val PROTOCOL_NAME = "Noise_NKpsk0_P256_AESGCM_SHA256"
    const val TRANSPORT_RELAY: Byte = 0x01
    const val TRANSPORT_DIRECT: Byte = 0x02

    const val MAX_HANDSHAKE_PAYLOAD = 512
    const val MAX_RECORD_BYTES = 65_535
    const val MAX_RECORD_PLAINTEXT = MAX_RECORD_BYTES - E2eCrypto.TAG_BYTES
    /** A sender closes the session (1000) before a direction's counter reaches this. */
    const val NONCE_LIMIT: Long = 1L shl 32

    const val CONN_BYTES = 16
    const val MAX_APP_CHARS = 40

    fun prologue(transport: Byte): ByteArray =
        "omb-e2e/1".toByteArray(Charsets.UTF_8) + byteArrayOf(0x00, transport)

    /** `{"v":1,"conn":"…","app":"…"}` — key order is not load-bearing, but this matches the desktop's bytes. */
    fun encodePayload1(conn: ByteArray, app: String): ByteArray =
        """{"v":1,"conn":"${E2eBase64.encode(conn)}","app":${quote(app)}}""".toByteArray(Charsets.UTF_8)

    /** `{"v":1,"conn":"…"}` */
    fun encodePayload2(conn: String): ByteArray =
        """{"v":1,"conn":${quote(conn)}}""".toByteArray(Charsets.UTF_8)

    private fun quote(value: String): String {
        val out = StringBuilder("\"")
        for (character in value) {
            when (character) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                else -> if (character < ' ') out.append("\\u%04x".format(character.code)) else out.append(character)
            }
        }
        return out.append('"').toString()
    }
}

internal class CipherState(var key: ByteArray? = null, var nonce: Long = 0) {
    fun encryptWithAd(ad: ByteArray, plaintext: ByteArray): ByteArray {
        val current = key ?: return plaintext
        if (nonce >= Noise.NONCE_LIMIT) throw NoiseException("nonce_exhausted")
        val out = E2eCrypto.seal(current, nonce, ad, plaintext)
        nonce += 1
        return out
    }

    fun decryptWithAd(ad: ByteArray, ciphertext: ByteArray): ByteArray {
        val current = key ?: return ciphertext
        if (nonce >= Noise.NONCE_LIMIT) throw NoiseException("nonce_exhausted")
        val out = E2eCrypto.open(current, nonce, ad, ciphertext)
        nonce += 1
        return out
    }

    fun copy(): CipherState = CipherState(key?.copyOf(), nonce)
}

/** Noise's symmetric state (§5.2). */
internal class SymmetricState(var h: ByteArray, var ck: ByteArray, internal var cipher: CipherState) {
    companion object {
        fun initialize(): SymmetricState {
            val name = Noise.PROTOCOL_NAME.toByteArray(Charsets.UTF_8)
            val h = if (name.size <= 32) name + ByteArray(32 - name.size) else E2eCrypto.sha256(name)
            return SymmetricState(h, h.copyOf(), CipherState())
        }
    }

    fun mixHash(data: ByteArray) {
        h = E2eCrypto.sha256(h, data)
    }

    fun mixKey(ikm: ByteArray) {
        val (nextCk, key) = E2eCrypto.hkdf(ck, ikm, 2)
        ck = nextCk
        cipher = CipherState(key)
    }

    fun mixKeyAndHash(ikm: ByteArray) {
        val (nextCk, tempH, key) = E2eCrypto.hkdf(ck, ikm, 3)
        ck = nextCk
        mixHash(tempH)
        cipher = CipherState(key)
    }

    fun encryptAndHash(plaintext: ByteArray): ByteArray {
        val out = cipher.encryptWithAd(h, plaintext)
        mixHash(out)
        return out
    }

    fun decryptAndHash(ciphertext: ByteArray): ByteArray {
        val out = cipher.decryptWithAd(h, ciphertext)
        mixHash(ciphertext)
        return out
    }

    /** `k_pc` then `k_cp`. */
    fun split(): Pair<CipherState, CipherState> {
        val (phoneToComputer, computerToPhone) = E2eCrypto.hkdf(ck, ByteArray(0), 2)
        return CipherState(phoneToComputer) to CipherState(computerToPhone)
    }
}

/** One direction's post-handshake records. Each WebSocket binary message is exactly one. */
class RecordCipher internal constructor(private val state: CipherState) {
    /** The next counter this direction will use, for diagnostics. */
    @get:Synchronized
    val nonce: Long get() = state.nonce
    @Synchronized
    fun seal(plaintext: ByteArray): ByteArray {
        if (plaintext.size > Noise.MAX_RECORD_PLAINTEXT) throw NoiseException("record_too_large")
        return state.encryptWithAd(ByteArray(0), plaintext)
    }

    @Synchronized
    fun open(record: ByteArray): ByteArray {
        if (record.size > Noise.MAX_RECORD_BYTES) throw NoiseException("record_too_large")
        return state.decryptWithAd(ByteArray(0), record)
    }
}

/** The phone sends on `k_pc` and receives on `k_cp`; the raw keys are exposed for the wire vectors. */
data class SessionKeys(
    val send: RecordCipher,
    val receive: RecordCipher,
    val handshakeHash: ByteArray,
    val kPc: ByteArray,
    val kCp: ByteArray,
)

/**
 * The phone side of the handshake.
 *
 * `ephemeralPrivate` and `random` exist so the desktop vectors can replay a
 * fixed handshake; production omits both.
 */
class NoiseInitiator(
    private val transport: Byte,
    private val responderStaticPublic: ByteArray,
    private val psk: ByteArray,
    private val random: SecureRandom = SecureRandom(),
    ephemeralPrivate: ByteArray? = null,
) {
    private val state: SymmetricState
    private val ephemeral: P256.KeyPair
    private var keys: SessionKeys? = null

    init {
        if (!P256.isValidPublicKey(responderStaticPublic)) throw NoiseException("bad_point")
        if (psk.size != 32) throw NoiseException("bad_psk")
        state = SymmetricState.initialize().also {
            it.mixHash(Noise.prologue(transport))
            it.mixHash(responderStaticPublic)
        }
        ephemeral = if (ephemeralPrivate != null) {
            P256.KeyPair(ephemeralPrivate, P256.publicKeyOf(ephemeralPrivate))
        } else {
            P256.generateKeyPair(random)
        }
    }

    /** Message 1: `e.pub ‖ EncryptAndHash(payload1)`. */
    fun message1(payload1: ByteArray): ByteArray {
        if (payload1.size > Noise.MAX_HANDSHAKE_PAYLOAD) throw NoiseException("payload_too_large")
        state.mixKeyAndHash(psk)
        state.mixHash(ephemeral.publicKey)
        state.mixKey(ephemeral.publicKey)
        state.mixKey(P256.dh(ephemeral.privateKey, responderStaticPublic))
        return ephemeral.publicKey + state.encryptAndHash(payload1)
    }

    /** Message 2: parses and authenticates the computer's reply, then fixes the session keys. */
    fun readMessage2(message2: ByteArray): ByteArray {
        if (message2.size <= P256.PUBLIC_KEY_BYTES) throw NoiseException("short_message")
        val peerEphemeral = message2.copyOfRange(0, P256.PUBLIC_KEY_BYTES)
        val sealedPayload = message2.copyOfRange(P256.PUBLIC_KEY_BYTES, message2.size)
        // Decoding validates the point before it is used.
        P256.decodePoint(peerEphemeral)
        state.mixHash(peerEphemeral)
        state.mixKey(peerEphemeral)
        state.mixKey(P256.dh(ephemeral.privateKey, peerEphemeral))
        val payload2 = state.decryptAndHash(sealedPayload)
        val (phoneToComputer, computerToPhone) = state.split()
        keys = SessionKeys(
            RecordCipher(phoneToComputer),
            RecordCipher(computerToPhone),
            state.h.copyOf(),
            phoneToComputer.key!!.copyOf(),
            computerToPhone.key!!.copyOf(),
        )
        return payload2
    }

    fun sessionKeys(): SessionKeys = keys ?: throw NoiseException("handshake_incomplete")
}
