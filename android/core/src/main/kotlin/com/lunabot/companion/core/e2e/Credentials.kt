package com.openmausbot.companion.core.e2e

/**
 * The two values a credential derives (spec §2). The phone holds the token;
 * everything else is a one-way function of it, so neither the relay nor the
 * computer ever needs the token itself.
 */
object E2eCredentials {
    const val PSK_LABEL = "omb-e2e psk v1"
    const val ADMISSION_LABEL = "omb-relay admission v1"

    /** `SHA256(T.pub)[0:16]` — binds the psk to the computer's static key. */
    fun keyId(transportPublic: ByteArray): ByteArray =
        E2eCrypto.sha256(transportPublic).copyOfRange(0, 16)

    /** The handshake pre-shared key for a pairing or device token. */
    fun psk(token: String, keyId: ByteArray): ByteArray =
        E2eCrypto.hmacSha256(tokenHash(token), PSK_LABEL.toByteArray(Charsets.UTF_8) + keyId)

    /** What the phone presents to the relay; the relay only stores its SHA-256. */
    fun admission(token: String, hostId: ByteArray): ByteArray =
        E2eCrypto.hmacSha256(tokenHash(token), ADMISSION_LABEL.toByteArray(Charsets.UTF_8) + hostId)

    fun admissionHash(admission: ByteArray): ByteArray = E2eCrypto.sha256(admission)

    /** The raw 32-byte digest of the token string's UTF-8 bytes. */
    fun tokenHash(token: String): ByteArray = E2eCrypto.sha256(token.toByteArray(Charsets.UTF_8))
}
