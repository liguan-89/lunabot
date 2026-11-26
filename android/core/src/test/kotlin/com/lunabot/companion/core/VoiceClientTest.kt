package com.lunabot.companion.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The calls a call makes — the voice half of `Client.swift` on the call-mode branch. */
class VoiceClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: CompanionClient

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = CompanionClient(requireNotNull(Connection.parse(server.url("/").toString())), "paired-token")
    }

    @AfterTest
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun prepareSendsTheWholeReplyAndTheBotsVoice() = runBlocking {
        server.enqueue(json("""{"ready":true,"utterances":["One.","Two."]}"""))
        val prepared = client.prepareSpeech("One. Two.", "rachel")
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/tts/prepare", request.path)
        val body = CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("One. Two.", body.getValue("text").jsonPrimitive.content)
        assertEquals("rachel", body.getValue("voiceId").jsonPrimitive.content)
        assertTrue(prepared.ready)
        assertEquals(listOf("One.", "Two."), prepared.utterances)
    }

    @Test
    fun aMissingVoiceMeansTheWorkspaceDefaultAndIsNotSentAsAnEmptyString() = runBlocking {
        server.enqueue(json("""{"ready":false,"utterances":[]}"""))
        val prepared = client.prepareSpeech("Hello", null)
        val body = CompanionJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals(setOf("text"), body.keys)
        assertFalse(prepared.ready)

        server.enqueue(MockResponse().setHeader("Content-Type", "audio/mpeg").setBody("mp3"))
        client.speak("Hello", "")
        val speak = CompanionJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals(setOf("text"), speak.keys)
    }

    @Test
    fun speakCapsOneUtteranceAtTheServersFiveHundredCharacters() = runBlocking {
        server.enqueue(MockResponse().setHeader("Content-Type", "audio/mpeg").setBody("mp3"))
        val audio = client.speak("a".repeat(600), "rachel")
        val request = server.takeRequest()
        assertEquals("/api/tts/speak", request.path)
        val body = CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals(500, body.getValue("text").jsonPrimitive.content.length)
        assertEquals("rachel", body.getValue("voiceId").jsonPrimitive.content)
        assertContentEquals("mp3".toByteArray(), audio)
    }

    @Test
    fun currentLiveCallReadsTheComputersAuthoritativeState() = runBlocking {
        server.enqueue(json("""{"call":{"callId":"c1","botId":"b1","threadId":"t1","client":"desktop","voice":"alloy","startedAt":1,"status":"live"}}"""))
        val call = client.liveCall()
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/api/live/call", request.path)
        assertEquals("c1", call?.callId)
        assertEquals("live", call?.status)

        server.enqueue(json("""{"call":null}"""))
        assertEquals(null, client.liveCall())
    }

    @Test
    fun theProviderTravelsAsExactlyTheVoiceShapeTheCompanionForwards() = runBlocking {
        server.enqueue(json("{}"))
        client.updateVoiceProvider("system")
        val request = server.takeRequest()
        assertEquals("PUT", request.method)
        assertEquals("/api/config", request.path)
        val body = CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals(setOf("tts"), body.keys)
        val tts = body.getValue("tts").jsonObject
        assertEquals(setOf("provider"), tts.keys)
        assertEquals("system", tts.getValue("provider").jsonPrimitive.content)
    }

    @Test
    fun aVoiceClipGoesUpAsWavAndComesBackAsWords() = runBlocking {
        server.enqueue(json("""{"text":"你好"}"""))
        val wav = "RIFF....WAVEfmt ".toByteArray() + ByteArray(100) { it.toByte() }
        val text = client.transcribe(wav)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/tts/transcribe", request.path)
        assertEquals("audio/wav", request.headers["Content-Type"])
        assertContentEquals(wav, request.body.readByteArray())
        assertEquals("你好", text)
    }

    private fun json(body: String): MockResponse =
        MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(body)
}
