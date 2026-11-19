package com.openmausbot.companion.ui

import com.openmausbot.companion.core.Message
import com.openmausbot.companion.core.ToolActivity
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Repeated engine receipts are real attempts, but two identical lines in a row
 * are one thing to read. The transcript keeps the failure visible as a single
 * line with a count; different receipts and messages in between stay separate.
 */
class ChatReceiptCollapseTest {
    private fun receipt(id: String, name: String, ok: Boolean? = false) = Message(
        id = id,
        role = Message.Role.BOT,
        kind = Message.Kind.ACTIVITY,
        at = 1.0,
        tool = ToolActivity(name = name, ok = ok),
    )

    private fun text(id: String) = Message(
        id = id,
        role = Message.Role.USER,
        kind = Message.Kind.TEXT,
        at = 1.0,
        text = "你好",
    )

    @Test
    fun `consecutive identical receipts become one line with a count`() {
        val out = collapseRepeatedReceipts(
            listOf(
                receipt("1", "Claude had a temporary server problem"),
                receipt("2", "Claude had a temporary server problem"),
                receipt("3", "Claude had a temporary server problem"),
            ),
        )
        assertEquals(1, out.size)
        assertEquals("Claude had a temporary server problem ×3", out.single().tool?.name)
    }

    @Test
    fun `different receipts stay separate`() {
        val out = collapseRepeatedReceipts(
            listOf(
                receipt("1", "error: 402"),
                receipt("2", "notice: continuing on Claude"),
                receipt("3", "error: 402", ok = true),
            ),
        )
        assertEquals(3, out.size)
    }

    @Test
    fun `a message between identical receipts breaks the run`() {
        val out = collapseRepeatedReceipts(
            listOf(
                receipt("1", "error: 402"),
                text("2"),
                receipt("3", "error: 402"),
            ),
        )
        assertEquals(3, out.size)
        assertEquals("error: 402", out[0].tool?.name)
        assertEquals("error: 402", out[2].tool?.name)
    }

    @Test
    fun `only consecutive duplicates are collapsed`() {
        val out = collapseRepeatedReceipts(
            listOf(
                receipt("1", "error: 402"),
                receipt("2", "error: 402"),
                receipt("3", "read_file", ok = true),
                receipt("4", "read_file", ok = true),
            ),
        )
        assertEquals(2, out.size)
        assertEquals("error: 402 ×2", out[0].tool?.name)
        assertEquals("read_file ×2", out[1].tool?.name)
    }
}
