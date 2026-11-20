package com.lunabot.companion.ui

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import java.io.File
import org.robolectric.annotation.GraphicsMode
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.lunabot.companion.core.CompanionJson
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.*
import okhttp3.mockwebserver.*
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Real pairing form, parser, Session and HTTP client against a disposable server. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ServerPairingScreenTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private lateinit var scene: WiringScene
    private lateinit var server: MockWebServer
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    private var failFirstPair = false
    private var failureStatus = 503

    @Before
    fun start() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                if (request.path == "/api/auth/pair") {
                    if (failFirstPair) {
                        failFirstPair = false
                        return MockResponse().setResponseCode(failureStatus).setBody("{\"error\":\"temporarily unavailable\"}")
                    }
                    return MockResponse().setBody("""{"token":"omb_sess_fixture","session":{"id":"s1","label":"Pixel","scopes":["client"]},"environment":{"environmentId":"env-fixture","label":"Headless test server"}}""")
                }
                return MockResponse().setBody("""{"environmentId":"env-fixture","label":"Headless test server"}""")
            }
        }
        server.start()
        scene = WiringScene(connection = null, token = null)
        compose.setContent {
            CompositionLocalProvider(LocalCompanion provides scene.environment) {
                CompanionTheme(darkTheme = false) { PairingScreen(onCancel = {}) }
            }
        }
    }

    @After
    fun stop() {
        scene.session.disconnect()
        server.shutdown()
    }

    @Test
    fun scannedServerLinkRequiresConfirmationAndPairsThroughServerApi() {
        acceptScan()
        compose.onNodeWithText("与此电脑配对").assertIsDisplayed()
        compose.onNodeWithText(server.url("/").toString().trimEnd('/')).assertIsDisplayed()
        screenshot("server-confirmation")
        assertTrue(requests.isEmpty(), "scanning must not redeem or probe before confirmation")
        compose.onNodeWithText("与此电脑配对").performClick()
        awaitPairing()
        val request = requests.single { it.path == "/api/auth/pair" }
        assertNull(request.getHeader("Authorization"))
        val sent = CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("ABCDEFGHJKLM", sent["code"]?.jsonPrimitive?.content)
        assertEquals("Pixel", sent["label"]?.jsonPrimitive?.content)
        assertNotNull(sent["attemptId"])
        assertTrue(requests.none { it.path == "/api/pair" })
    }

    @Test
    fun manualEntryAcceptsServerCodesAndRetainsSixDigitCompanionCodes() {
        compose.onNodeWithText("其他连接方式").performClick()
        compose.onAllNodes(hasSetTextAction())[0].performTextInput(server.url("/").toString().trimEnd('/'))
        compose.onNodeWithText("继续").performScrollTo().performClick()
        compose.onNodeWithText("连接").assertIsNotEnabled()
        screenshot("manual-code")
        val code = compose.onNode(hasSetTextAction())
        code.performTextInput("123456")
        compose.onNodeWithText("连接").assertIsEnabled()
        code.performTextReplacement("abcd-efgh-jklm")
        compose.onNodeWithText("连接").assertIsEnabled().performClick()
        awaitPairing()
    }

    @Test
    fun temporaryServerFailureRetainsTheScannedCodeAndAttemptIdForRetry() {
        failFirstPair = true
        acceptScan()
        compose.onNodeWithText("与此电脑配对").performClick()
        compose.waitUntil(5_000) { scene.session.actionError == null && requests.any { it.path == "/api/auth/pair" } }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("无法完成与服务器的连接。请使用相同的配对码重试。").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("与此电脑配对").performScrollTo().performClick()
        awaitPairing()
        val posts = requests.filter { it.path == "/api/auth/pair" }.map { it.body.readUtf8() }
        assertEquals(2, posts.size)
        assertEquals(posts[0], posts[1])
    }

    @Test
    fun rateLimitRetainsScannedCodeAndAttemptId() {
        failureStatus = 429
        retryAfterRateLimit(manual = false)
    }

    @Test
    fun rateLimitRetainsTypedCodeAndAttemptId() {
        failureStatus = 429
        retryAfterRateLimit(manual = true)
    }

    private fun retryAfterRateLimit(manual: Boolean) {
        failFirstPair = true
        val button = if (manual) {
            compose.onNodeWithText("其他连接方式").performClick()
            compose.onAllNodes(hasSetTextAction())[0].performTextInput(server.url("/").toString().trimEnd('/'))
            compose.onNodeWithText("继续").performScrollTo().performClick()
            compose.onNode(hasSetTextAction()).performTextInput("abcd-efgh-jklm")
            "连接"
        } else {
            acceptScan()
            "与此电脑配对"
        }
        compose.onNodeWithText(button).performScrollTo().performClick()
        compose.waitUntil(5_000) {
            compose.onAllNodesWithText("temporarily unavailable").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText(button).performScrollTo().performClick()
        awaitPairing()
        val posts = requests.filter { it.path == "/api/auth/pair" }.map { it.body.readUtf8() }
        assertEquals(2, posts.size)
        assertEquals(posts[0], posts[1])
    }

    private fun screenshot(name: String) {
        compose.runOnIdle {
            val view = compose.activity.window.decorView
            val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            view.draw(android.graphics.Canvas(bitmap))
            val file = File("build/outputs/server-pairing-screenshots/$name.png")
            file.parentFile?.mkdirs()
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }

    private fun acceptScan() {
        compose.runOnIdle { scene.session.receivePairingURL(server.url("/pair#code=ABCD-EFGH-JKLM").toString()) }
        compose.waitForIdle()
    }

    private fun awaitPairing() {
        compose.waitUntil(5_000) { scene.session.connection.value?.serverEnvironmentId == "env-fixture" }
        assertEquals("Headless test server", scene.session.connection.value?.name)
    }
}
