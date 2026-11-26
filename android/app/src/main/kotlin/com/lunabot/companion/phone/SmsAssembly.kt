package com.lunabot.companion.phone

import com.lunabot.companion.core.PhoneSmsEvent

/** 等不齐的片段至多保留这么久：运营商补发的后续片段通常几秒内到齐。 */
internal const val SMS_ASSEMBLY_WINDOW_MS = 15_000L

/** 一条短信片段；[reference]/[total]/[sequence] 来自长短信用户数据头。 */
internal data class InboundSmsPart(
    val from: String,
    val at: Long,
    val text: String,
    val reference: Int? = null,
    val total: Int? = null,
    val sequence: Int? = null,
)

/** 跨广播重组长短信；只有带拼接头的片段会等待，普通短信仍即时通过。 */
internal class InboundSmsAssembly(
    private val now: () -> Long = System::currentTimeMillis,
    private val windowMs: Long = SMS_ASSEMBLY_WINDOW_MS,
) {
    private data class Key(val from: String, val reference: Int)
    private data class Pending(var updatedAt: Long, val parts: MutableMap<Int, InboundSmsPart>)

    private val pending = LinkedHashMap<Key, Pending>()

    @Synchronized
    fun add(parts: List<InboundSmsPart>): List<PhoneSmsEvent> {
        val ready = mutableListOf<PhoneSmsEvent>()
        val plain = LinkedHashMap<Pair<String, Long>, MutableList<InboundSmsPart>>()
        val clock = now()
        expireOlderThan(clock)
        for (part in parts) {
            val reference = part.reference
            val total = part.total
            val sequence = part.sequence
            if (reference == null || total == null || sequence == null || total <= 0 || sequence !in 1..total) {
                plain.getOrPut(part.from to part.at) { mutableListOf() } += part
                continue
            }
            val key = Key(part.from, reference)
            val held = pending.getOrPut(key) { Pending(clock, mutableMapOf()) }
            held.updatedAt = clock
            held.parts.putIfAbsent(sequence, part)
            if (held.parts.size == total) {
                pending.remove(key)
                eventFor(part.from, part.at, held.parts.values.sortedBy { it.sequence })?.let(ready::add)
            }
        }
        for ((key, group) in plain) eventFor(key.first, key.second, group)?.let(ready::add)
        return ready
    }

    /** 只清过期片段；缺片段拼出的短信不是原短信，不能投递给电脑。 */
    @Synchronized
    fun expireOlderThan(clock: Long = now()) {
        val expired = pending.filterValues { clock - it.updatedAt >= windowMs }.keys
        expired.forEach(pending::remove)
    }

    private fun eventFor(from: String, at: Long, parts: List<InboundSmsPart>): PhoneSmsEvent? {
        if (from.isBlank()) return null
        val text = parts.joinToString("") { it.text }.trim()
        if (text.isEmpty()) return null
        val reference = parts.firstNotNullOfOrNull { it.reference }
        val firstAt = parts.firstOrNull { it.sequence == 1 }?.at ?: at
        val sendId = if (reference == null) "$from:$at" else "$from:part$reference:$firstAt"
        return PhoneSmsEvent(sendId = sendId.take(120), from = from.take(64), text = text.take(4000))
    }
}

/** 进程级重组器：系统把同一条长短信拆成几条广播，状态必须活在两次 onReceive 之间。 */
internal val inboundSmsAssembly = InboundSmsAssembly()

internal data class ConcatenatedSmsHeader(val reference: Int, val total: Int, val sequence: Int)

/** 从 SMS-DELIVER PDU 里找 3GPP 23.040 的 concatenated short message IEI（0x00 或 0x08）。 */
internal fun concatenatedSmsHeader(pdu: ByteArray): ConcatenatedSmsHeader? {
    fun octet(index: Int): Int? = pdu.getOrNull(index)?.toInt()?.and(0xff)
    var index = (octet(0) ?: return null) + 1
    val first = octet(index++) ?: return null
    if (first and 0x40 == 0) return null
    val addressDigits = octet(index++) ?: return null
    index += 1 + (addressDigits + 1) / 2 + 2 + 7
    if (octet(index++) == null) return null
    val headerLength = octet(index++) ?: return null
    val end = index + headerLength
    if (end > pdu.size) return null
    while (index + 1 < end) {
        val id = octet(index++) ?: return null
        val length = octet(index++) ?: return null
        if (index + length > end) return null
        if (id == 0x00 && length == 3) {
            val reference = octet(index) ?: return null
            val total = octet(index + 1) ?: return null
            val sequence = octet(index + 2) ?: return null
            return ConcatenatedSmsHeader(reference, total, sequence)
        }
        if (id == 0x08 && length == 4) {
            val high = octet(index) ?: return null
            val low = octet(index + 1) ?: return null
            val total = octet(index + 2) ?: return null
            val sequence = octet(index + 3) ?: return null
            return ConcatenatedSmsHeader((high shl 8) or low, total, sequence)
        }
        index += length
    }
    return null
}
