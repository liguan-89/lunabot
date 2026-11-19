package com.lunabot.companion.ui

import com.lunabot.companion.core.CompanionJson
import com.lunabot.companion.core.FirstReplyRescue
import com.lunabot.companion.core.Message
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The words a receipt wears, read off the desktop's own two rules:
 * `src/lib/live-activity.ts` (an engine's tool id, said the way a person would
 * say it) and `src/lib/engine-name.ts` (`pi` is named by the provider it runs).
 */
class ActivityNamingTest {
    @Test
    fun `engine tool ids are said as what the call does`() {
        assertEquals("正在执行命令", ActivityNaming.toolLabel("bash"))
        assertEquals("正在读取文件", ActivityNaming.toolLabel("read_file"))
        assertEquals("正在编辑文件", ActivityNaming.toolLabel("edit"))
        assertEquals("正在搜索网页", ActivityNaming.toolLabel("web_search"))
        // Case is the engine's business, not the reader's.
        assertEquals("正在执行命令", ActivityNaming.toolLabel("Bash"))
    }

    @Test
    fun `a name that is already a sentence is left alone`() {
        // Notices, errors and anything the harness wrote for this row: the
        // desktop prints those verbatim, and so does the phone.
        assertEquals("提示：pi 在缓慢启动后回复了。", ActivityNaming.toolLabel("提示：pi 在缓慢启动后回复了。"))
        assertEquals("notice: the model is signed out", ActivityNaming.toolLabel("notice: the model is signed out"))
        assertEquals("bash --login", ActivityNaming.toolLabel("bash --login"))
        assertEquals("", ActivityNaming.toolLabel(""))
    }

    @Test
    fun `an unknown tool keeps its own name rather than becoming a guess`() {
        assertEquals("some_new_tool", ActivityNaming.toolLabel("some_new_tool"))
    }

    @Test
    fun `the one engine this build runs is named by the provider, not by its id`() {
        assertEquals("自定义模型提供方", ActivityNaming.engineName("pi"))
        assertEquals("自定义模型提供方", ActivityNaming.engineName("piAgent"))
        assertEquals("Claude", ActivityNaming.engineName("Claude"))
    }

    @Test
    fun `a notice's sentence has its engine id replaced where it landed`() {
        val rescue = rescue(ai = "pi")
        assertEquals(
            "提示：自定义模型提供方 在缓慢启动后回复了。",
            ActivityNaming.rescueEngine("提示：pi 在缓慢启动后回复了。", rescue),
        )
        // Whole words only: a bot called "pilot" is not the engine.
        assertEquals("提示：pilot 回复了。", ActivityNaming.rescueEngine("提示：pilot 回复了。", rescue))
        // No payload (an older computer): nothing to replace, nothing to invent.
        assertEquals("提示：pi 回复了。", ActivityNaming.rescueEngine("提示：pi 回复了。", null))
    }

    @Test
    fun `a rescue payload is decoded, and says whether the wait is over`() {
        val message = CompanionJson.decodeFromString<Message>(
            """
            {"id":"r","role":"bot","kind":"activity","at":1,
             "tool":{"name":"提示：pi 在缓慢启动后回复了。","ok":true,
               "rescue":{"botId":"b","threadId":"th","turnId":"t","instanceId":"pi","ai":"pi","settled":true}}}
            """,
        )
        val decoded = assertNotNull(message.tool?.rescue)
        assertTrue(decoded.answered)
        assertEquals("pi", decoded.ai)
        assertEquals("t", decoded.turnId)

        val waiting = rescue()
        assertFalse(waiting.answered)
        assertNull(waiting.requestMessageId)
    }

    private fun rescue(ai: String = "pi") = FirstReplyRescue(
        botId = "b", threadId = "th", turnId = "t", instanceId = "pi", ai = ai,
    )
}
