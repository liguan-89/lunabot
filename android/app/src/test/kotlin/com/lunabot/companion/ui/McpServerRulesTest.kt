package com.lunabot.companion.ui

import com.lunabot.companion.core.McpServerEntry
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The MCP card's one sentence per server. The three switches mean different
 * things and are fixed in different places, so they must not share a label —
 * "off" on the server is the computer's settings, `offFor` is this bot's
 * explicit refusal, and `on` is its own toggle.
 */
class McpServerRulesTest {

    @Test
    fun `the server switch comes before the bot's`() {
        assertEquals(
            "已在电脑上停用",
            McpServerRules.stateText(McpServerEntry(name = "github", enabled = false, on = true)),
        )
        assertEquals(
            "不为此智能体启动",
            McpServerRules.stateText(
                McpServerEntry(name = "github", enabled = true, on = true, offFor = true),
            ),
        )
        assertEquals(
            "此智能体已关闭",
            McpServerRules.stateText(McpServerEntry(name = "github", enabled = true, on = false)),
        )
        assertEquals(
            "已启用",
            McpServerRules.stateText(McpServerEntry(name = "github", enabled = true, on = true)),
        )
    }

    @Test
    fun `the two empty states say different things`() {
        // One is "this bot runs nothing", the other is "the phone may not see
        // the list"; a shared sentence would tell a member their bot has no
        // servers when the truth is that the session has no admin scope.
        assertEquals("读不到 MCP 服务器：这台电脑未允许此手机查看。", McpServerRules.UNAVAILABLE)
        assertEquals("此智能体没有可启用的 MCP 服务器。", McpServerRules.EMPTY)
    }
}
