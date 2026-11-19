package com.openmausbot.companion.ui

import android.graphics.Bitmap
import android.util.Base64
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.Connection
import com.openmausbot.companion.core.Fleet
import com.openmausbot.companion.core.Frame
import com.openmausbot.companion.core.Message
import com.openmausbot.companion.core.StreamFrame
import java.io.ByteArrayOutputStream
import kotlin.test.assertEquals
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.flow
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** A screenshot in the transcript is also the way into that bot's live computer. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ScreenshotLiveWiringTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private var scene: WiringScene? = null

    @After
    fun cleanup() {
        compose.runOnIdle { scene?.session?.disconnect() }
    }

    @Test
    fun tappingAStillOpensTheLiveComputer() = exercise(openComputer = true)

    @Test
    fun aStillWithoutADestinationStaysInert() = exercise(openComputer = false)

    private fun exercise(openComputer: Boolean) {
        val fixture = bot().copy(threadId = "first", messages = emptyList())
        val wiring = WiringScene(
            connection = Connection(id = "live-fixture", name = "Fixture", host = "127.0.0.1", port = 1),
            fleet = Fleet(listOf(fixture), emptyList()),
        ) { flow { emit(StreamFrame(Frame.Hello(cursor = "fixture:1", resumed = false), seq = 1)); awaitCancellation() } }
        scene = wiring

        val png = ByteArrayOutputStream().also { out ->
            Bitmap.createBitmap(32, 20, Bitmap.Config.ARGB_8888).apply {
                eraseColor(android.graphics.Color.DKGRAY)
                compress(Bitmap.CompressFormat.PNG, 100, out)
                recycle()
            }
        }.toByteArray()
        val message = Message(
            id = "frame",
            role = Message.Role.BOT,
            kind = Message.Kind.SCREEN,
            at = 1.0,
            // Inline pixels: the row paints without asking the computer for them.
            png = Base64.encodeToString(png, Base64.NO_WRAP),
        )
        var opened = 0
        compose.setContent {
            CompositionLocalProvider(LocalCompanion provides wiring.environment) {
                CompanionTheme(darkTheme = false) {
                    MessageRow(
                        chat = Chat.BotChat(fixture),
                        message = message,
                        openComputer = if (openComputer) ({ opened += 1 }) else null,
                    )
                }
            }
        }

        if (!openComputer) {
            compose.waitForIdle()
            compose.onNodeWithText("实时画面").assertDoesNotExist()
            return
        }

        compose.waitUntil(5_000) {
            compose.onAllNodesWithText("实时画面").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("实时画面").assertIsDisplayed()
        compose.onNodeWithText("实时画面").performClick()
        compose.runOnIdle { assertEquals(1, opened) }
    }
}
