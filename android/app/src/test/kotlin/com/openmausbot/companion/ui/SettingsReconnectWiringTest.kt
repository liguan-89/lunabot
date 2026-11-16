package com.openmausbot.companion.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.openmausbot.companion.core.Connection
import com.openmausbot.companion.core.Frame
import com.openmausbot.companion.core.Session
import com.openmausbot.companion.core.StreamFrame
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.flow
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Try reconnecting, measured where it can be measured.
 *
 * `Session.refresh()` returns nothing and leaves no flag behind; what it does is
 * open the event stream again. So the scene counts stream collections, the
 * stream this tap opens is held, and the assertions are: the tap opened one —
 * exactly one — and the button was dead while it was in flight. Asserting some
 * `refreshing` boolean would prove the boolean, and a button wired to nothing
 * would leave that green.
 *
 * The two pure helpers this screen gained are pinned here as well: they are read
 * off `ios/App/SettingsView.swift`, and this is the file about that screen.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SettingsReconnectWiringTest {

    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val reconnect = "尝试重新连接"
    private val mac = Connection(id = "c1", name = "Mac", host = "127.0.0.1", port = 8810)

    @Test
    fun `the reconnect button opens one stream and stays dead until it settles`() {
        // Nothing else opens a stream in this scene: the Application is what
        // calls connect(), and there is no Application here. So every collection
        // counted below was started by the button.
        val hello = CompletableDeferred<Unit>()
        val scene = WiringScene(connection = mac) {
            flow {
                hello.await()
                emit(StreamFrame(Frame.Hello(cursor = "s:1", resumed = true), seq = 1))
                awaitCancellation()
            }
        }

        compose.setContent {
            CompositionLocalProvider(LocalCompanion provides scene.environment) {
                CompanionTheme(darkTheme = false) {
                    SettingsScreen(onBack = {})
                }
            }
        }
        compose.waitUntil(5_000) { scene.session.connection.value != null }
        compose.waitForIdle()
        assertEquals(0, scene.streamStarts.get(), "mounting Settings must not dial anything")

        // The section sits below the fold on a phone-sized screen.
        compose.onNodeWithText(reconnect).performScrollTo().assertIsEnabled().performClick()
        compose.waitUntil(5_000) { scene.streamStarts.get() == 1 }

        compose.onNodeWithText(reconnect).assertIsNotEnabled()

        hello.complete(Unit)
        compose.waitUntil(5_000) { scene.session.status.value == Session.Status.Live }
        compose.waitUntil(5_000) { reconnectEnabled() }
        assertEquals(1, scene.streamStarts.get(), "one tap, one reconnect")
    }

    @Test
    fun `the troubleshooting line says what the connection is doing`() {
        assertEquals(
            "此电脑已连接且响应正常。",
            troubleshootingText(Session.Status.Live),
        )
        assertEquals(
            "Luna Bot 正在自动尝试已保存的连接。",
            troubleshootingText(Session.Status.Connecting),
        )
        assertEquals(
            "此手机已从电脑移除，请重新配对以恢复连接。",
            troubleshootingText(Session.Status.Unauthorized),
        )
        assertEquals(
            "此手机尚未与电脑配对。",
            troubleshootingText(Session.Status.Unpaired),
        )
        // Offline already carries advice written for the failure that caused it.
        assertEquals(
            "Could not reach the computer.",
            troubleshootingText(Session.Status.Offline("Could not reach the computer.")),
        )
    }

    @Test
    fun `a hidden address keeps both ends and loses its middle`() {
        // Fourteen characters or fewer are shown whole; iOS draws the same line.
        assertEquals("192.168.1.42", shortenedAddress("192.168.1.42"))
        assertEquals("short.lan", shortenedAddress("short.lan"))
        assertEquals("192.168.1…2:8810", shortenedAddress("192.168.1.42:8810"))

        val long = "https://macbook-pro.tail1234abcd.ts.net:8811"
        val short = shortenedAddress(long)
        assertEquals("https://macbook-pro.…t:8811", short)
        assertTrue(long.startsWith(short.substringBefore("…")), "the head is the real head")
        assertTrue(long.endsWith(short.substringAfter("…")), "the tail is the real tail")
    }

    @Test
    fun `a full address breaks inside its long relay label`() {
        // ICU breaks at "/" and around "." and nowhere inside the 32-character
        // relay label, so the expanded row used to draw "https://c" alone on
        // the first line. The breaks added here are invisible and leave every
        // visible character — and 复制 — untouched.
        val address = "https://c-520e4f9f627b551883c94878b2bcd2c4.openmausbot.com"
        val wrapped = wrapAddress(address)

        assertEquals(address, wrapped.replace("\u200B", ""))
        assertTrue(wrapped.contains('\u200B'))
        wrapped.split('\u200B').forEach { run ->
            assertTrue(run.length <= 40, "no break opportunity inside \"$run\"")
        }
        // Short addresses are left exactly as they are.
        assertEquals("192.168.1.42:8810", wrapAddress("192.168.1.42:8810"))
    }

    /** Disabled is a semantics property, so its absence is the honest question. */
    private fun reconnectEnabled(): Boolean =
        compose.onNodeWithText(reconnect).fetchSemanticsNode()
            .config.getOrNull(SemanticsProperties.Disabled) == null
}
