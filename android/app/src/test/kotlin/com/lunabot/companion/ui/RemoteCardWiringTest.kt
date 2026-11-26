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
import com.lunabot.companion.core.CompanionEndpoint
import com.lunabot.companion.core.CompanionEndpointKind
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
import kotlinx.coroutines.runBlocking
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
                    target = "ttsKey",
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
        compose.onNodeWithText("连接 Slack").assertIsDisplayed()
        compose.onNodeWithText("授权在浏览器中完成，令牌仅保存在电脑端。", substring = true).assertExists()
        compose.onNodeWithText("ElevenLabs API key").assertIsDisplayed()
        compose.onNodeWithText("此配对还没有绑定桌面安全密钥。请重新扫码配对后，才能在手机上填写。").assertIsDisplayed()
        // The routine card sits below the fold of this fixture now that the
        // earlier cards' translated copy takes more room; being composed is
        // the property under test — the row is no longer dropped.
        compose.onNodeWithText("Nightly").assertExists()
        // The card's second line is one Text: "预定任务 · 运行中", not a bare
        // status word, so match on the status inside it.
        compose.onNodeWithText("运行中", substring = true).assertExists()
        compose.onNodeWithText("正在整理日志").assertExists()
        // The last card sits below the fold of this fixture; being composed is
        // the property under test — the row is no longer dropped.
        compose.onNodeWithText("Ship the release").assertExists()
        compose.onNodeWithText("已完成").assertExists()
        compose.onNodeWithText("协调者：Scout · 3/8 轮").assertExists()
    }

    @Test
    fun protectedPairingOffersSecureCredentialEntry() {
        val fixture = bot().copy(threadId = "first", messages = emptyList())
        val hosted = requireNotNull(
            CompanionEndpoint.create("https://mac.example", CompanionEndpointKind.HOSTED, 0),
        )
        val wiring = WiringScene(
            connection = Connection(
                id = "secret-fixture",
                name = "Fixture",
                host = "mac.example",
                port = 443,
                activeEndpoint = hosted,
                secretPublicKey = "BIPBQ12_dWnF1DZLsTZO3Vg0NGjds5-jp9h3jhjr2To7bJelczS0LM82rfXV68PmSJhz2ePosj3fL974XckCpDU",
                companionDeviceId = "device-1",
            ),
            fleet = Fleet(listOf(fixture), emptyList()),
        ) { flow { emit(StreamFrame(Frame.Hello(cursor = "fixture:1", resumed = false), seq = 1)); awaitCancellation() } }
        scene = wiring
        runBlocking { wiring.session.awaitRestored() }
        val message = Message(
            "secret", Message.Role.BOT, Message.Kind.SECRET, 1.0,
            secret = SecretRequestCardData(
                target = "ttsKey",
                label = "ElevenLabs API key",
                description = "用于语音回复",
                placeholder = "Paste your ElevenLabs API key",
                requestKey = "request-1",
            ),
        )

        compose.setContent {
            CompositionLocalProvider(LocalCompanion provides wiring.environment) {
                CompanionTheme(darkTheme = false) {
                    MessageRow(chat = Chat.BotChat(fixture), message = message)
                }
            }
        }

        compose.waitForIdle()
        compose.onNodeWithText("凭据只在此手机本地加密后提交；不会进入聊天，也不会保存在手机上。").assertExists()
        compose.onNodeWithText("Paste your ElevenLabs API key").assertExists()
        compose.onNodeWithText("加密并提交").assertExists()
        compose.onNodeWithText("跳过").assertExists()
    }

    @Test
    fun unpinnedPairingExplainsSecureEntryNeedsANewScan() {
        val fixture = bot().copy(threadId = "first", messages = emptyList())
        val wiring = WiringScene(
            connection = Connection(id = "unpinned-secret-fixture", name = "Fixture", host = "127.0.0.1", port = 1),
            fleet = Fleet(listOf(fixture), emptyList()),
        ) { flow { emit(StreamFrame(Frame.Hello(cursor = "fixture:1", resumed = false), seq = 1)); awaitCancellation() } }
        scene = wiring
        runBlocking { wiring.session.awaitRestored() }
        val message = Message(
            "secret", Message.Role.BOT, Message.Kind.SECRET, 1.0,
            secret = SecretRequestCardData(
                target = "ttsKey",
                label = "ElevenLabs API key",
                description = "用于语音回复",
                placeholder = "Paste your ElevenLabs API key",
                requestKey = "request-1",
            ),
        )

        compose.setContent {
            CompositionLocalProvider(LocalCompanion provides wiring.environment) {
                CompanionTheme(darkTheme = false) {
                    MessageRow(chat = Chat.BotChat(fixture), message = message)
                }
            }
        }

        compose.waitForIdle()
        compose.onNodeWithText("此配对还没有绑定桌面安全密钥。请重新扫码配对后，才能在手机上填写。").assertExists()
        compose.onNodeWithText("Paste your ElevenLabs API key").assertDoesNotExist()
        compose.onNodeWithText("跳过").assertExists()
    }
}
