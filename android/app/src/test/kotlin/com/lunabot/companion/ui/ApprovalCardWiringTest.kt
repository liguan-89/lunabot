package com.lunabot.companion.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.lunabot.companion.core.Chat
import com.lunabot.companion.core.Connection
import com.lunabot.companion.core.Fleet
import com.lunabot.companion.core.Frame
import com.lunabot.companion.core.Message
import com.lunabot.companion.core.OptionCard
import com.lunabot.companion.core.StreamFrame
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.flow
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * What an approval card draws, in each of the four states it can be in.
 *
 * The card already carried every one of these facts; before this port it drew
 * all four the same way, so "waiting on you" and "already allowed" differed only
 * by a 1.5dp ring and one line of small grey text. These assertions are the
 * contract the design depends on: the state line names the state, the slip names
 * the tool, and the stamp appears only once the card has landed.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ApprovalCardWiringTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private var scene: WiringScene? = null

    @After
    fun cleanup() {
        compose.runOnIdle { scene?.session?.disconnect() }
    }

    private fun render(vararg cards: OptionCard) {
        val fixture = bot().copy(threadId = "first", messages = emptyList())
        val wiring = WiringScene(
            connection = Connection(id = "card-fixture", name = "Fixture", host = "127.0.0.1", port = 1),
            fleet = Fleet(listOf(fixture), emptyList()),
        ) { flow { emit(StreamFrame(Frame.Hello(cursor = "fixture:1", resumed = false), seq = 1)); awaitCancellation() } }
        scene = wiring

        val messages = cards.mapIndexed { index, card ->
            Message(
                id = "card-$index",
                role = Message.Role.BOT,
                kind = Message.Kind.OPTIONS,
                at = 1.0 + index,
                card = card,
            )
        }
        compose.setContent {
            CompositionLocalProvider(LocalCompanion provides wiring.environment) {
                CompanionTheme(darkTheme = false) {
                    Column(Modifier.verticalScroll(rememberScrollState())) {
                        messages.forEach { message ->
                            MessageRow(chat = Chat.BotChat(fixture), message = message)
                        }
                    }
                }
            }
        }
        compose.waitForIdle()
    }

    private fun permissionCard(
        answered: String? = null,
        answeredText: String? = null,
        expired: Boolean? = null,
        danger: Boolean? = null,
        options: List<String> = listOf("Allow", "Deny"),
    ) = OptionCard(
        title = "读取日历事件",
        subtitle = "允许 Moss 查看 11 月 20 日至 21 日的日程",
        options = options,
        requestId = "req-1",
        tool = "calendar.events.list",
        answered = answered,
        answeredText = answeredText,
        expired = expired,
        danger = danger,
    )

    @Test
    fun pendingNamesItsStateOffersItsOptionsAndNamesItsTool() {
        render(permissionCard())

        compose.onNodeWithText("需要你确认").assertIsDisplayed()
        compose.onNodeWithText("读取日历事件").assertIsDisplayed()
        // The slip: the machine's own name for what it is about to call.
        compose.onNodeWithText("calendar.events.list").assertIsDisplayed()
        compose.onNodeWithText("Allow").assertIsDisplayed()
        compose.onNodeWithText("Deny").assertIsDisplayed()
    }

    @Test
    fun allowedReplacesTheActionsWithAStamp() {
        render(permissionCard(answered = "allow"))

        compose.onNodeWithText("已允许").assertIsDisplayed()
        compose.onNodeWithText("Allow").assertDoesNotExist()
        compose.onNodeWithText("Deny").assertDoesNotExist()
        // The wire's behavior word is not shown to a person.
        compose.onNodeWithText("allow").assertDoesNotExist()
    }

    @Test
    fun deniedIsSettledAndSaysSo() {
        render(permissionCard(answered = "Deny"))

        compose.onNodeWithText("已拒绝").assertIsDisplayed()
        compose.onNodeWithText("Allow").assertDoesNotExist()
        compose.onNodeWithText("Deny").assertDoesNotExist()
    }

    @Test
    fun expiredOffersNothingAndRecordsNoDecision() {
        render(permissionCard(expired = true))

        compose.onNodeWithText("已过期").assertIsDisplayed()
        compose.onNodeWithText("Allow").assertDoesNotExist()
        compose.onNodeWithText("Deny").assertDoesNotExist()
    }

    @Test
    fun aDangerCardStillDrawsItsOptions() {
        // The colour is the difference, and a screenshot is the wrong oracle for
        // it; what a test can hold is that danger never removes the choices.
        render(permissionCard(danger = true, options = listOf("删除 3 个事件", "暂不")))

        compose.onNodeWithText("需要你确认").assertIsDisplayed()
        compose.onNodeWithText("删除 3 个事件").assertIsDisplayed()
        compose.onNodeWithText("暂不").assertIsDisplayed()
    }
}
