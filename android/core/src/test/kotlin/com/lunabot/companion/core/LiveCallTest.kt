package com.openmausbot.companion.core

import kotlinx.coroutines.runBlocking
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class LiveCallTest {
    private lateinit var server: MockWebServer

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @AfterTest
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun relayQueryNamesTheCallAndTheClient() {
        assertEquals(
            listOf("botId" to "b1", "threadId" to "t1", "client" to "android"),
            LiveRelay.query("b1", "t1"),
        )
    }

    @Test
    fun relayEventsDecodeEveryWireShape() {
        val ready = assertIs<LiveRelay.Event.Ready>(
            LiveRelay.decodeEvent("""{"t":"ready","provider":"volc","inputHz":16000,"outputHz":24000}"""),
        )
        assertEquals("volc", ready.provider)
        assertEquals(24_000, ready.outputHz)

        // A relay on an older computer may not report rates; the socket's
        // formats are still the constants.
        val sparse = assertIs<LiveRelay.Event.Ready>(LiveRelay.decodeEvent("""{"t":"ready","provider":"qwen"}"""))
        assertEquals(LiveRelay.INPUT_HZ, sparse.inputHz)
        assertEquals(LiveRelay.OUTPUT_HZ, sparse.outputHz)

        val user = assertIs<LiveRelay.Event.Transcript>(
            LiveRelay.decodeEvent("""{"t":"transcript","role":"user","delta":"你好"}"""),
        )
        assertTrue(user.user)
        assertEquals("你好", user.delta)
        assertFalse(
            assertIs<LiveRelay.Event.Transcript>(
                LiveRelay.decodeEvent("""{"t":"transcript","role":"assistant","delta":"hi"}"""),
            ).user,
        )

        assertEquals(
            LiveRelay.Event.Named("volc:450"),
            LiveRelay.decodeEvent("""{"t":"event","name":"volc:450"}"""),
        )
        assertEquals(
            LiveRelay.Event.Failure("boom"),
            LiveRelay.decodeEvent("""{"t":"error","message":"boom"}"""),
        )
        assertEquals(LiveRelay.Event.End, LiveRelay.decodeEvent("""{"t":"end"}"""))
    }

    @Test
    fun relayEventsRejectWhatTheWireCannotSay() {
        assertNull(LiveRelay.decodeEvent("not json"))
        assertNull(LiveRelay.decodeEvent("""{"t":"transcript","role":"bot","delta":"x"}"""))
        assertNull(LiveRelay.decodeEvent("""{"t":"transcript","role":"user"}"""))
        assertNull(LiveRelay.decodeEvent("""{"t":"error"}"""))
        assertNull(LiveRelay.decodeEvent("""{"t":"mystery"}"""))
        assertNull(LiveRelay.decodeEvent("""["ready"]"""))
    }

    @Test
    fun socketLiveCallNeedsARelayProviderAndItsKey() {
        fun config(live: ConfigFlag?) = ConfigStatus(live = live)
        assertTrue(config(ConfigFlag(configured = true, provider = "volc")).hasSocketLiveCall)
        assertTrue(config(ConfigFlag(configured = true, provider = "qwen")).hasSocketLiveCall)
        // OpenAI/Azure answer "openai"/"azure" or omit the field — both go over WebRTC.
        assertFalse(config(ConfigFlag(configured = true, provider = "openai")).hasSocketLiveCall)
        assertFalse(config(ConfigFlag(configured = true)).hasSocketLiveCall)
        assertFalse(config(ConfigFlag(configured = false, provider = "volc")).hasSocketLiveCall)
        assertFalse(config(null).hasSocketLiveCall)
    }

    @Test
    fun relaySocketCarriesTheCallTargetAndBearer() = runBlocking {
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {}))
        val connection = requireNotNull(Connection.parse(server.url("/").toString()))
        val client = CompanionClient(connection, "device-token")
        val socket = client.openSocket(
            LiveRelay.PATH,
            LiveRelay.query("b1", "t1"),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                    webSocket.close(1000, null)
                }
            },
        )
        try {
            val request = server.takeRequest()
            assertEquals("GET", request.method)
            assertEquals("/api/live/relay?botId=b1&threadId=t1&client=android", request.path)
            assertEquals("Bearer device-token", request.getHeader("Authorization"))
        } finally {
            socket.close(1000, null)
        }
    }
}
