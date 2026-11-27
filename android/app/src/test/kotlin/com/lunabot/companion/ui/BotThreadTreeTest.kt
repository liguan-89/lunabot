package com.lunabot.companion.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.lunabot.companion.core.BotProject
import com.lunabot.companion.core.BotTask
import com.lunabot.companion.core.Chat
import com.lunabot.companion.core.ChatSummary
import com.lunabot.companion.core.ThreadCloser
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Disposable, offline Compose fixtures: no pairing or user server is involved. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class BotThreadTreeTest {
    @get:Rule
    val compose = createComposeRule()

    private val fixture = bot().copy(
        threadId = "main",
        projects = listOf(BotProject(id = "launch", name = "Launch", emoji = "🚀")),
        tasks = listOf(
            BotTask(threadId = "second", title = "Release notes", createdAt = 0.0, projectId = "launch"),
            BotTask(
                threadId = "closed", title = "Earlier launch", createdAt = 0.0, projectId = "launch",
                closedBy = ThreadCloser(botId = "helper", name = "Parker", at = 1.0),
            ),
            BotTask(threadId = "main", title = "Main conversation", createdAt = 0.0),
            BotTask(threadId = "routine", title = "Private run", createdAt = 0.0, routineRunId = "run"),
        ),
    )

    @Test
    fun `expanding a bot exposes its folders and opens the exact child thread`() {
        var expanded by mutableStateOf(false)
        var collapsed by mutableStateOf(emptySet<String>())
        var opened: Chat? = null
        compose.setContent {
            CompanionTheme(darkTheme = false) {
                Column {
                    ThreadToggle(
                        bot = fixture,
                        expanded = expanded,
                        searching = false,
                        onToggle = { expanded = !expanded },
                    )
                    BotThreadTree(
                        fixture, query = "", expanded = expanded, collapsedFolders = collapsed, creating = false,
                        onToggleFolder = { key -> collapsed = if (key in collapsed) collapsed - key else collapsed + key },
                        onCreate = {}, onManage = {}, onOpen = { opened = it },
                    )
                }
            }
        }

        compose.onNodeWithTag("thread.second").assertDoesNotExist()
        compose.onNodeWithTag("threads-toggle.${fixture.id}").performClick()
        compose.onNodeWithTag("thread.second").assertIsDisplayed().performClick()
        assertEquals("second", opened?.threadId)
        assertEquals(fixture.id, opened?.id)
        compose.onNodeWithTag("thread.closed").assertDoesNotExist()
        compose.onNodeWithTag("thread.routine").assertDoesNotExist()
        compose.onNodeWithTag("thread-folder.${fixture.id}:launch").performClick()
        compose.onNodeWithTag("thread.second").assertDoesNotExist()
        compose.onNodeWithTag("thread.main").assertIsDisplayed()
    }

    @Test
    fun `folder search reveals closed threads without changing saved expansion`() {
        var query by mutableStateOf("launch")
        compose.setContent {
            CompanionTheme(darkTheme = false) {
                Column {
                    ThreadToggle(
                        bot = fixture,
                        expanded = false,
                        searching = query.isNotBlank(),
                        onToggle = {},
                    )
                    BotThreadTree(
                        fixture, query = query, expanded = false,
                        collapsedFolders = setOf("${fixture.id}:launch"), creating = false,
                        onToggleFolder = {}, onCreate = {}, onManage = {}, onOpen = {},
                    )
                }
            }
        }

        compose.onNodeWithTag("threads-toggle.${fixture.id}").assertIsNotEnabled()
        compose.onNodeWithTag("thread-folder.${fixture.id}:launch").assertIsNotEnabled()
        compose.onNodeWithTag("thread.second").assertIsDisplayed()
        compose.onNodeWithTag("thread.closed").assertIsDisplayed()
        compose.onNodeWithText("由 Parker 关闭").assertIsDisplayed()
        compose.onNodeWithTag("thread.main").assertDoesNotExist()
        compose.runOnIdle { query = "" }
        compose.onNodeWithTag("thread.second").assertDoesNotExist()
        compose.onNodeWithTag("thread.closed").assertDoesNotExist()
    }

    @Test
    fun `a live child update refreshes status unread and the opened projection`() {
        var liveBot by mutableStateOf(fixture)
        var opened: Chat? = null
        compose.setContent {
            CompanionTheme(darkTheme = false) {
                BotThreadTree(
                    liveBot, query = "", expanded = true, collapsedFolders = emptySet(), creating = false,
                    onToggleFolder = {}, onCreate = {}, onManage = {}, onOpen = { opened = it },
                )
            }
        }
        compose.onNodeWithText("等待你确认").assertDoesNotExist()
        compose.runOnIdle {
            liveBot = fixture.copy(tasks = fixture.tasks!!.map {
                if (it.threadId == "second") it.copy(activity = "waiting-on-you", busy = true, unread = true) else it
            })
        }
        compose.onNodeWithText("等待你确认").assertIsDisplayed()
        compose.onNodeWithText("未读").assertIsDisplayed()
        compose.onNodeWithTag("thread.second").performClick()
        assertEquals("second", opened?.threadId)
        assertTrue(opened!!.busy)
        assertTrue(opened!!.unread)
        assertFalse(fixture.unread)
    }

    @Test
    fun `creation stays disabled while its request is pending`() {
        compose.setContent {
            CompanionTheme(darkTheme = false) {
                BotThreadTree(
                    fixture, query = "Release", expanded = false, collapsedFolders = emptySet(), creating = true,
                    onToggleFolder = {}, onCreate = {}, onManage = {}, onOpen = {},
                )
            }
        }
        compose.onNodeWithContentDescription("正在与 ${fixture.name} 新建话题").assertIsNotEnabled()
        compose.onNodeWithContentDescription("与 ${fixture.name} 新建话题").assertDoesNotExist()
    }

    @Test
    fun `roster filtering keeps bots matched by a thread or folder`() {
        val summary = ChatSummary(Chat.BotChat(fixture), preview = "", lastActivity = 0.0, pinned = false)
        assertEquals(listOf(summary), rosterThreadRows(listOf(summary), "RELEASE NOTES"))
        assertEquals(listOf(summary), rosterThreadRows(listOf(summary), "Launch"))
        assertEquals(emptyList(), rosterThreadRows(listOf(summary), "Private run"))
        assertEquals(emptyList(), rosterThreadRows(listOf(summary), "kangaroo"))
    }
}
