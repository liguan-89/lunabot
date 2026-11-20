package com.lunabot.companion.ui

import com.lunabot.companion.core.SignInCardData
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The sign-in card's two sentences, pinned where the copy is.
 *
 * The phone cannot open the bot's browser tab for it, so every "where"
 * sentence has to end by naming the button that is actually on this screen.
 * Copy is the whole feature here: the two answers are one POST each.
 */
class SignInCardRulesTest {

    @Test
    fun `every place names where to sign in and ends at the button on this screen`() {
        val places = listOf("browser", "vm", "cloud", "local", "host")
        places.forEach { place ->
            val text = SignInCardRules.whereText(place, "MausBot")
            assertTrue(text.contains("MausBot"), "$place should name the bot: $text")
            assertTrue(text.endsWith("点「完成」。"), "$place must end at the button: $text")
        }
        // A frame from a newer computer may name a surface this build has not
        // heard of; the fallback still has to be true and actionable.
        val unknown = SignInCardRules.whereText("teleporter", "MausBot")
        assertTrue(unknown.contains("MausBot"))
        assertTrue(unknown.endsWith("点「完成」。"))
    }

    @Test
    fun `an open card says it is waiting, not that it failed`() {
        val open = SignInCardData(url = "https://github.com/login", site = "github.com")
        assertTrue(open.isPending)
        assertEquals(
            "等待你在电脑上登录",
            SignInCardRules.statusLabel(open, "github.com"),
        )
    }

    @Test
    fun `settled cards say how they settled in the desktop's words`() {
        val site = "github.com"
        assertEquals(
            "已登录 $site",
            SignInCardRules.statusLabel(SignInCardData(site = site, done = true), site),
        )
        assertEquals(
            "已取消登录 $site",
            SignInCardRules.statusLabel(SignInCardData(site = site, cancelled = true), site),
        )
        assertEquals(
            "已被更新的请求取代",
            SignInCardRules.statusLabel(SignInCardData(site = site, superseded = true), site),
        )
        assertEquals(
            "你已在聊天中回复",
            SignInCardRules.statusLabel(SignInCardData(site = site, answeredInChat = true), site),
        )
        assertEquals(
            "已保存 $site 的登录信息",
            SignInCardRules.statusLabel(SignInCardData(site = site, savedLogin = site), site),
        )
    }

    @Test
    fun `a stopped or answered card offers no buttons`() {
        assertFalse(SignInCardData(stopped = true).isPending)
        assertFalse(SignInCardData(answeredInChat = true).isPending)
        assertFalse(SignInCardData(done = true).isPending)
        assertFalse(SignInCardData(cancelled = true).isPending)
        assertFalse(SignInCardData(superseded = true).isPending)
    }
}
