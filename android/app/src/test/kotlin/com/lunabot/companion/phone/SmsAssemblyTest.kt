package com.lunabot.companion.phone

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SmsAssemblyTest {
    private var clock = 1_000L

    private fun assembly(): InboundSmsAssembly = InboundSmsAssembly(now = { clock }, windowMs = 10_000)

    private fun part(sequence: Int, text: String, reference: Int = 7, total: Int = 2, from: String = "+8613800000000") =
        InboundSmsPart(from = from, at = 100L + sequence, text = text, reference = reference, total = total, sequence = sequence)

    @Test
    fun `parts arriving in separate broadcasts assemble in sequence order`() {
        val assembly = assembly()

        assertTrue(assembly.add(listOf(part(2, "世界"))).isEmpty())
        val events = assembly.add(listOf(part(1, "你好")))

        assertEquals(1, events.size)
        assertEquals("你好世界", events[0].text)
        assertEquals("+8613800000000:part7:101", events[0].sendId)
    }

    @Test
    fun `complete parts inside one broadcast pass immediately`() {
        val events = assembly().add(listOf(part(2, "bar"), part(1, "foo")))

        assertEquals(listOf("foobar"), events.map { it.text })
    }

    @Test
    fun `two long texts from one sender stay apart by reference`() {
        val assembly = assembly()

        assertTrue(assembly.add(listOf(part(1, "甲", reference = 7))).isEmpty())
        val events = assembly.add(listOf(part(1, "乙", reference = 8), part(2, "二", reference = 8)))

        assertEquals(listOf("乙二"), events.map { it.text })
    }

    @Test
    fun `an incomplete text is dropped after its assembly window`() {
        val assembly = assembly()
        assertTrue(assembly.add(listOf(part(1, "缺尾"))).isEmpty())

        clock += 9_999
        assembly.expireOlderThan()
        val stillHeld = assembly.add(listOf(part(2, "尾")))
        assertEquals(listOf("缺尾" + "尾"), stillHeld.map { it.text })

        val again = assembly()
        assertTrue(again.add(listOf(part(1, "缺尾"))).isEmpty())
        clock += 10_000
        again.expireOlderThan()
        assertTrue(again.add(listOf(part(2, "尾"))).isEmpty(), "过期后晚到的片段不能冒充完整短信")
    }

    @Test
    fun `a plain text still passes immediately`() {
        val events = assembly().add(listOf(InboundSmsPart(from = "10086", at = 1L, text = "余额不足")))

        assertEquals(1, events.size)
        assertEquals("10086:1", events[0].sendId)
        assertEquals("余额不足", events[0].text)
    }


    @Test
    fun `plain parts in one broadcast keep the old timestamp grouping`() {
        val events = assembly().add(listOf(
            InboundSmsPart(from = "10086", at = 1L, text = "前半"),
            InboundSmsPart(from = "10086", at = 1L, text = "后半"),
            InboundSmsPart(from = "10086", at = 2L, text = "另一条"),
        ))

        assertEquals(listOf("前半后半", "另一条"), events.map { it.text })
    }

    @Test
    fun `an eight-bit concatenation header is read from the user data header`() {
        val header = concatenatedSmsHeader(pduWithHeader(byteArrayOf(0, 3, 7, 2, 1)))

        assertEquals(ConcatenatedSmsHeader(reference = 7, total = 2, sequence = 1), header)
    }

    @Test
    fun `a sixteen-bit concatenation header keeps its wide reference`() {
        val header = concatenatedSmsHeader(pduWithHeader(byteArrayOf(8, 4, 1, 2, 3, 2)))

        assertEquals(ConcatenatedSmsHeader(reference = 258, total = 3, sequence = 2), header)
    }

    /** 最小 SMS-DELIVER PDU：无 SMSC、UDHI 置位、UCS2；用户数据头后无需有效正文，解析器只读头。 */
    private fun pduWithHeader(informationElement: ByteArray): ByteArray {
        val headerLength = informationElement.size
        val userDataLength = 1 + headerLength
        return byteArrayOf(
            0, 0x40, 0x0B, 0x91.toByte(),
            0x21, 0x43, 0x65, 0x87.toByte(), 0x09, 0xF1.toByte(),
            0, 0x08, 0, 0, 0, 0, 0, 0, 0,
            userDataLength.toByte(), headerLength.toByte(),
        ) + informationElement
    }
}
