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
import com.lunabot.companion.core.ConnectorCardData
import com.lunabot.companion.core.Fleet
import com.lunabot.companion.core.Frame
import com.lunabot.companion.core.GroupGoalRunCardData
import com.lunabot.companion.core.Message
import com.lunabot.companion.core.RoutineRunCardData
import com.lunabot.companion.core.SecretRequestCardData
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
 * The four card kinds carry no `text`, so before this port they were whole rows
 * the transcript silently dropped. Each one has to draw something a person can
 * read without leaving the conversation.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class RemoteCardWiringTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private var scene: WiringScene? = null

    @After
    fun cleanup() {
        compose.runOnIdle { scene?.session?.disconnect() }
    }

    @Test
    fun everyRemoteCardDrawsItsOwnState() {
        val fixture = bot().copy(threadId = "first", messages = emptyList())
        val wiring = WiringScene(
            connection = Connection(id = "card-fixture", name = "Fixture", host = "127.0.0.1", port = 1),
            fleet = Fleet(listOf(fixture), emptyList()),
        ) { flow { emit(StreamFrame(Frame.Hello(cursor = "fixture:1", resumed = false), seq = 1)); awaitCancellation() } }
        scene = wiring

        val messages = listOf(
            Message(
                "connector", Message.Role.BOT, Message.Kind.CONNECTOR, 1.0,
                connector = ConnectorCardData(
                    slug = "slack",
                    label = "Slack",
                    description = "Post updates and read channels",
                    status = "required",
                ),
            ),
            Message(
                "secret", Message.Role.BOT, Message.Kind.SECRET, 2.0,
                secret = SecretRequestCardData(
                    target = "elevenlabs",
                    label = "ElevenLabs API key",
                    description = "用于语音回复",
                    requestKey = "request-1",
                ),
            ),
            Message(
                "routine", Message.Role.BOT, Message.Kind.ROUTINE_RUN, 3.0,
                routineRun = RoutineRunCardData(
                    runId = "run-1",
                    routineName = "Nightly",
                    status = "running",
                    summary = "正在整理日志",
                ),
            ),
            Message(
                "goal", Message.Role.BOT, Message.Kind.GOAL_RUN, 4.0,
                goalRun = GroupGoalRunCardData(
                    runId = "goal-1",
                    goal = "Ship the release",
                    status = "completed",
                    coordinatorName = "Scout",
                    turnCount = 3,
                    maxTurns = 8,
                ),
            ),
        )

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
        compose.onNodeWithText("Slack").assertIsDisplayed()
        compose.onNodeWithText("智能体需要你连接这个应用。").assertIsDisplayed()
        compose.onNodeWithText("ElevenLabs API key").assertIsDisplayed()
        compose.onNodeWithText("手机端暂不支持直接提交凭据，请在电脑上填写后保存。").assertIsDisplayed()
        // The routine card sits below the fold of this fixture now that the
        // earlier cards' translated copy takes more room; being composed is
        // the property under test — the row is no longer dropped.
        compose.onNodeWithText("Nightly").assertExists()
        compose.onNodeWithText("运行中").assertExists()
        compose.onNodeWithText("正在整理日志").assertExists()
        // The last card sits below the fold of this fixture; being composed is
        // the property under test — the row is no longer dropped.
        compose.onNodeWithText("Ship the release").assertExists()
        compose.onNodeWithText("已完成").assertExists()
        compose.onNodeWithText("协调者：Scout · 3/8 轮").assertExists()
    }
}
