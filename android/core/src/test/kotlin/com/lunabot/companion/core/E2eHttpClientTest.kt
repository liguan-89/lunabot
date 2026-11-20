package com.lunabot.companion.core

import com.lunabot.companion.core.e2e.E2eBase64
import com.lunabot.companion.core.e2e.E2eDescriptor
import com.lunabot.companion.core.e2e.E2eTransport
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ProxySelector
import java.net.URI
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertSame

/**
 * A phone with a system proxy — a VPN app's local HTTP proxy is the common one
 * on Android — must still speak origin-form HTTP inside the E2E tunnel.
 *
 * The tunnel's synthetic host is what makes this sharp: a proxied request names
 * that host in the request line, the computer reads the whole authority as a
 * path, and answers "no route" while the tunnel itself is perfectly healthy.
 */
class E2eHttpClientTest {
    private lateinit var server: MockWebServer
    private lateinit var tunnel: E2eTransport

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
        tunnel = E2eTransport(
            descriptor = E2eDescriptor(
                k = E2eBase64.encode(ByteArray(65) { 4 }),
                h = E2eBase64.encode(ByteArray(16) { 7 }),
                relays = listOf("cloud.dexai.vip"),
            ),
            token = "omb_pair_" + "A".repeat(43),
            app = "mausbot-test",
        )
    }

    @AfterTest
    fun tearDown() {
        server.shutdown()
    }

    /** A client that would send every request through the mock server as a proxy. */
    private fun proxied(): OkHttpClient = OkHttpClient.Builder()
        .proxySelector(ProxySelector.of(InetSocketAddress("127.0.0.1", server.port)))
        .build()

    @Test
    fun `a proxy turns the tunnel host into an absolute-form request line`() {
        server.enqueue(MockResponse().setBody("{}"))

        proxied().newCall(Request.Builder().url("http://${tunnel.httpHost}/api/phone-ping").build())
            .execute().close()

        // What the computer received when the phone reported 电脑暂不可达: the
        // whole authority is the path, so no route matches it.
        assertEquals(
            "GET http://${tunnel.httpHost}/api/phone-ping HTTP/1.1",
            server.takeRequest().requestLine,
        )
    }

    @Test
    fun `the tunnel stack ignores a system proxy`() {
        val tunneled = e2eHttpClient(proxied(), tunnel)

        assertEquals(Proxy.NO_PROXY, tunneled.proxy)
        // NO_PROXY brings a selector that answers DIRECT for every URL, replacing
        // the platform's — no proxy is ever consulted for a tunnelled request.
        assertEquals(
            listOf(Proxy.NO_PROXY),
            tunneled.proxySelector.select(URI("http://${tunnel.httpHost}/api/phone-ping")),
        )
    }

    @Test
    fun `the tunnel stack keeps the socket factory and the synthetic dns`() {
        val tunneled = e2eHttpClient(OkHttpClient(), tunnel)

        assertSame(tunnel.socketFactory, tunneled.socketFactory)
        assertSame(tunnel.dns, tunneled.dns)
    }
}
