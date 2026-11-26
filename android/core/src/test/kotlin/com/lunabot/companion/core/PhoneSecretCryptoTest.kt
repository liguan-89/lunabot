package com.lunabot.companion.core

import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PhoneSecretCryptoTest {
    private val recipientPublicKey =
        "BIPBQ12_dWnF1DZLsTZO3Vg0NGjds5-jp9h3jhjr2To7bJelczS0LM82rfXV68PmSJhz2ePosj3fL974XckCpDU"

    @Test
    fun keyIdMatchesTheDesktopRecipientIdentity() {
        assertEquals("taWSR_nZ7ojlH_0Z3tar6Q", PhoneSecretCrypto.keyId(recipientPublicKey))
        assertTrue(PhoneSecretCrypto.validRecipientPublicKey(recipientPublicKey))
    }

    @Test
    fun sealMatchesTheNodeHpkeVectorByteForByte() {
        val envelope = PhoneSecretCrypto.sealForTesting(
            recipientPublicKey = recipientPublicKey,
            ephemeralPrivateKey = decode("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE"),
            ephemeralPublicKey = decode("BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU"),
            context = PhoneSecretCrypto.Context(
                keyId = "taWSR_nZ7ojlH_0Z3tar6Q",
                deviceId = "paired-device-1",
                botId = "bot-1",
                threadId = "thread-1",
                messageId = "message-1",
                target = "ttsKey",
                requestKey = "credential-request-1",
            ),
            plaintext = "elevenlabs-secret",
        )

        assertEquals(
            "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU",
            envelope.encapsulatedKey,
        )
        assertEquals("QEmpd33hVh8SeifRTQ-N7r63Shw4h1pwMg7yqVaF3Xso", envelope.ciphertext)
        assertEquals(1, envelope.version)
    }

    @Test
    fun aadHasTheExactEightNewlineSeparatedFields() {
        val aad = PhoneSecretCrypto.aad(
            PhoneSecretCrypto.Context(
                keyId = "taWSR_nZ7ojlH_0Z3tar6Q",
                deviceId = "paired-device-1",
                botId = "bot-1",
                threadId = "thread-1",
                messageId = "message-1",
                target = "ttsKey",
                requestKey = "credential-request-1",
            ),
        ).toString(Charsets.UTF_8)

        assertEquals(
            "lunabot-phone-credential-v2\n" +
                "taWSR_nZ7ojlH_0Z3tar6Q\n" +
                "paired-device-1\n" +
                "bot-1\n" +
                "thread-1\n" +
                "message-1\n" +
                "ttsKey\n" +
                "credential-request-1",
            aad,
        )
    }

    @Test
    fun malformedOrOffCurveRecipientKeysAreRefused() {
        assertFalse(PhoneSecretCrypto.validRecipientPublicKey("not-a-key"))
        assertFalse(PhoneSecretCrypto.validRecipientPublicKey(recipientPublicKey.dropLast(1)))
        val wrongPoint = recipientPublicKey.replaceFirst('B', 'A')
        assertFalse(PhoneSecretCrypto.validRecipientPublicKey(wrongPoint))
    }

    private fun decode(value: String): ByteArray = Base64.getUrlDecoder().decode(value)
}
