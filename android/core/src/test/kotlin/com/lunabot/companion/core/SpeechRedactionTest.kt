package com.lunabot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** 朗读前的密钥打码：宁可少读，也不能把凭证发给语音服务。 */
class SpeechRedactionTest {
    @Test
    fun providerKeysJwtAndBearerAreMasked() {
        val openAi = "sk-live-abcdef1234567890"
        assertEquals("key «redacted ${openAi.length} chars»", redactSecretsForSpeech("key $openAi"))

        val jwt = "eyJhhhhhhhh.pppppppp.ssssssss"
        assertEquals("token «redacted ${jwt.length} chars»", redactSecretsForSpeech("token $jwt"))
        assertEquals("Bearer «redacted 24 chars»", redactSecretsForSpeech("Bearer abcdef1234567890abcdef12"))
    }

    @Test
    fun assignmentsFlagsAndUrlPasswordsAreMasked() {
        assertEquals(
            "api_key=«redacted 12 chars»",
            redactSecretsForSpeech("api_key=abcd1234efgh"),
        )
        assertEquals(
            "--token «redacted 8 chars»",
            redactSecretsForSpeech("--token abcd1234"),
        )
        assertEquals(
            "postgres://user:«redacted 11 chars»@host/db",
            redactSecretsForSpeech("postgres://user:hunter2pass@host/db"),
        )
    }

    @Test
    fun privateKeyBodiesAreMaskedAndOrdinaryTextIsUnchanged() {
        val input = "before\n-----BEGIN RSA PRIVATE KEY-----\nabc123\n-----END RSA PRIVATE KEY-----\nafter"
        val out = redactSecretsForSpeech(input)
        assertFalse(out.contains("abc123"))
        assertTrue(out.contains("-----BEGIN RSA PRIVATE KEY-----"))
        assertTrue(out.contains("«redacted 6 chars»"))

        val ordinary = "password: leave blank if you like"
        assertEquals(ordinary, redactSecretsForSpeech(ordinary))
    }

    @Test
    fun partialCredentialShapesAreHeldBackFromStreaming() {
        assertTrue(holdsPotentialCredential("the key is sk-"))
        assertTrue(holdsPotentialCredential("-----BEGIN RSA PRIVATE KEY-----\npartial"))
        assertFalse(holdsPotentialCredential("普通回复，没有凭证。"))
    }
}
