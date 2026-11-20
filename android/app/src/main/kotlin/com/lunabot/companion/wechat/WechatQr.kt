// Not ported: Mika drew its QR with zxing, which this build does not carry.
// This encoder is written here from ISO/IEC 18004 so the bind screen can draw
// the iLink payload offline. See WechatApi.kt for the ported half.
package com.lunabot.companion.wechat

/**
 * A QR Code encoder, byte mode, error correction level M.
 *
 * This app already carries ML Kit for *reading* a QR code (pairing) but has no
 * encoder, and the iLink bind flow needs to *draw* one: WeChat's own scanner
 * reads it from a saved image in the album. Adding zxing for that one call
 * would put a dependency on the offline build path, so the encoder lives here.
 * It implements ISO/IEC 18004 for versions 1–20 with ECC level M — more than
 * enough for an iLink payload — and nothing else: no other modes, no other
 * versions, no micro QR.
 *
 * Correctness is pinned by a test that decodes the produced matrix with an
 * independent decoder.
 */
internal class QrMatrix(val size: Int, private val cells: BooleanArray) {
    operator fun get(x: Int, y: Int): Boolean = cells[y * size + x]

    /** Rows as strings of `#`/`.`, for tests and for eyeballing a failure. */
    fun render(): List<String> = List(size) { y -> String(CharArray(size) { x -> if (this[x, y]) '#' else '.' }) }
}

private const val ECC_LEVEL_M_FORMAT_BITS = 0b00

/** `qrcode_img_content` from iLink is a short URL; the cap only stops a runaway. */
private const val MAX_CONTENT_BYTES = 1_200

internal fun encodeQr(content: String): QrMatrix {
    require(content.isNotBlank()) { "QR content is empty" }
    val data = content.toByteArray(Charsets.UTF_8)
    require(data.size <= MAX_CONTENT_BYTES) { "QR content is too long" }

    val version = (1..20).firstOrNull { capacityBits(it) >= 4 + countBits(it) + data.size * 8 }
        ?: error("QR content does not fit in version 20")
    val codewords = interleavedCodewords(version, data)

    var best: QrMatrix? = null
    var bestPenalty = Int.MAX_VALUE
    for (mask in 0 until 8) {
        val candidate = buildMatrix(version, codewords, mask)
        val penalty = penalty(candidate)
        if (penalty < bestPenalty) {
            bestPenalty = penalty
            best = candidate
        }
    }
    return best!!
}

/** Data bits available at level M: every block's data codewords, across its copies. */
private fun capacityBits(version: Int): Int = dataCodewords(version) * 8

private fun countBits(version: Int): Int = if (version <= 9) 8 else 16

private fun dataCodewords(version: Int): Int = blocks(version).sumOf { it.count * it.data }

/** `count` blocks of `total` codewords each, `data` of which carry data. */
private data class Block(val count: Int, val total: Int, val data: Int)

private fun blocks(version: Int): List<Block> = RS_BLOCKS.getValue(version)

/**
 * The level-M block table for versions 1–20, from ISO/IEC 18004 table 9. Each
 * entry is (number of blocks, codewords per block, data codewords per block);
 * two entries mean two groups.
 */
private val RS_BLOCKS: Map<Int, List<Block>> = mapOf(
    1 to listOf(Block(1, 26, 16)),
    2 to listOf(Block(1, 44, 28)),
    3 to listOf(Block(1, 70, 44)),
    4 to listOf(Block(2, 50, 32)),
    5 to listOf(Block(2, 67, 43)),
    6 to listOf(Block(4, 43, 27)),
    7 to listOf(Block(4, 49, 31)),
    8 to listOf(Block(2, 60, 38), Block(2, 61, 39)),
    9 to listOf(Block(3, 58, 36), Block(2, 59, 37)),
    10 to listOf(Block(4, 69, 43), Block(1, 70, 44)),
    11 to listOf(Block(1, 80, 50), Block(4, 81, 51)),
    12 to listOf(Block(6, 58, 36), Block(2, 59, 37)),
    13 to listOf(Block(8, 59, 37), Block(1, 60, 38)),
    14 to listOf(Block(4, 64, 40), Block(5, 65, 41)),
    15 to listOf(Block(5, 65, 41), Block(5, 66, 42)),
    16 to listOf(Block(7, 73, 45), Block(3, 74, 46)),
    17 to listOf(Block(10, 74, 46), Block(1, 75, 47)),
    18 to listOf(Block(9, 69, 43), Block(4, 70, 44)),
    19 to listOf(Block(3, 70, 44), Block(11, 71, 45)),
    20 to listOf(Block(3, 67, 41), Block(13, 68, 42)),
)

/** Alignment pattern centres per version (1–20); version 1 has none. */
private val ALIGNMENT: Map<Int, List<Int>> = mapOf(
    2 to listOf(6, 18), 3 to listOf(6, 22), 4 to listOf(6, 26), 5 to listOf(6, 30), 6 to listOf(6, 34),
    7 to listOf(6, 22, 38), 8 to listOf(6, 24, 42), 9 to listOf(6, 26, 46), 10 to listOf(6, 28, 50),
    11 to listOf(6, 30, 54), 12 to listOf(6, 32, 58), 13 to listOf(6, 34, 62), 14 to listOf(6, 26, 46, 66),
    15 to listOf(6, 26, 48, 70), 16 to listOf(6, 26, 50, 74), 17 to listOf(6, 30, 54, 78),
    18 to listOf(6, 30, 56, 82), 19 to listOf(6, 30, 58, 86), 20 to listOf(6, 34, 62, 90),
)

/** Trailing bits that do not complete a codeword; they stay light and are skipped by the walk. */
@Suppress("unused")
private fun remainderBits(version: Int): Int = when (version) {
    1 -> 0
    in 2..6 -> 7
    in 7..13 -> 0
    else -> 3
}

private fun interleavedCodewords(version: Int, data: ByteArray): IntArray {
    val groups = blocks(version)
    val totalData = groups.sumOf { it.count * it.data }
    val bits = BitList(totalData * 8)

    // Mode 0100 = byte.
    bits.append(0b0100, 4)
    bits.append(data.size, countBits(version))
    for (byte in data) bits.append(byte.toInt() and 0xff, 8)
    // Terminator, then pad to a codeword boundary.
    val capacity = totalData * 8
    bits.append(0, minOf(4, capacity - bits.size))
    while (bits.size % 8 != 0) bits.append(0, 1)
    // Pad codewords alternate 0xEC, 0x11.
    var pad = 0
    while (bits.size < capacity) {
        bits.append(if (pad % 2 == 0) 0xEC else 0x11, 8)
        pad++
    }

    val dataCodewords = IntArray(totalData) { bits.byteAt(it) }
    val blocksOut = ArrayList<IntArray>(groups.sumOf { it.count })
    var offset = 0
    for (group in groups) {
        repeat(group.count) {
            val block = dataCodewords.copyOfRange(offset, offset + group.data)
            offset += group.data
            blocksOut += block
        }
    }
    val ecc = blocksOut.map { it to reedSolomon(it, groups.first().total - groups.first().data) }

    // Interleave: one data codeword from each block, then one ECC codeword from each.
    val out = ArrayList<Int>()
    val longestData = blocksOut.maxOf { it.size }
    for (index in 0 until longestData) {
        for (block in blocksOut) if (index < block.size) out += block[index]
    }
    val longestEcc = ecc.maxOf { it.second.size }
    for (index in 0 until longestEcc) {
        for ((_, parity) in ecc) if (index < parity.size) out += parity[index]
    }
    return out.toIntArray()
}

/** Reed–Solomon over GF(256) with the QR polynomial 0x11D. */
private fun reedSolomon(data: IntArray, eccCount: Int): IntArray {
    val generator = IntArray(eccCount)
    generator[eccCount - 1] = 1
    var root = 1
    for (i in 0 until eccCount) {
        for (j in 0 until eccCount) {
            generator[j] = multiply(generator[j], root)
            if (j + 1 < eccCount) generator[j] = generator[j] xor generator[j + 1]
        }
        root = multiply(root, 0x02)
    }
    val remainder = IntArray(eccCount)
    for (value in data) {
        val factor = value xor remainder[0]
        System.arraycopy(remainder, 1, remainder, 0, eccCount - 1)
        remainder[eccCount - 1] = 0
        for (i in 0 until eccCount) remainder[i] = remainder[i] xor multiply(generator[i], factor)
    }
    return remainder
}

private fun multiply(a: Int, b: Int): Int {
    var x = a
    var y = b
    var z = 0
    for (i in 7 downTo 0) {
        z = (z shl 1) xor ((z ushr 7) * 0x11D)
        z = z xor (((y ushr i) and 1) * x)
    }
    return z and 0xff
}

private class BitList(capacity: Int) {
    private val bits = BooleanArray(capacity)
    var size = 0
        private set

    fun append(value: Int, count: Int) {
        for (i in count - 1 downTo 0) {
            check(size < bits.size) { "QR bit buffer overflow" }
            bits[size++] = ((value shr i) and 1) != 0
        }
    }

    fun byteAt(index: Int): Int {
        var value = 0
        for (i in 0 until 8) value = (value shl 1) or (if (bits[index * 8 + i]) 1 else 0)
        return value
    }
}

/**
 * Place everything: function patterns first (so the data walk can skip them),
 * then the interleaved codewords, then the mask and its format information.
 * [mask] null means "no mask yet", used for the penalty comparison pass.
 */
private fun buildMatrix(version: Int, codewords: IntArray, mask: Int = 0): QrMatrix {
    val size = version * 4 + 17
    val cells = BooleanArray(size * size)
    // Which cells are function patterns and therefore not data.
    val reserved = BooleanArray(size * size)
    fun set(x: Int, y: Int, dark: Boolean) {
        if (x in 0 until size && y in 0 until size) cells[y * size + x] = dark
    }
    fun reserve(x: Int, y: Int, dark: Boolean) {
        set(x, y, dark)
        reserved[y * size + x] = true
    }

    // Finder patterns and their separators, in three corners.
    for ((cx, cy) in listOf(0 to 0, size - 7 to 0, 0 to size - 7)) {
        for (dy in -1..7) {
            for (dx in -1..7) {
                val x = cx + dx
                val y = cy + dy
                if (x !in 0 until size || y !in 0 until size) continue
                val inRing = dx in 0..6 && dy in 0..6
                val dark = inRing && (dx == 0 || dx == 6 || dy == 0 || dy == 6 || (dx in 2..4 && dy in 2..4))
                reserve(x, y, dark)
            }
        }
    }
    // Timing patterns.
    for (i in 8 until size - 8) {
        reserve(i, 6, i % 2 == 0)
        reserve(6, i, i % 2 == 0)
    }
    // Alignment patterns, skipping the three finder corners.
    ALIGNMENT[version]?.let { centres ->
        for (cy in centres) {
            for (cx in centres) {
                if ((cx == 6 && cy == 6) || (cx == 6 && cy == size - 7) || (cx == size - 7 && cy == 6)) continue
                for (dy in -2..2) {
                    for (dx in -2..2) {
                        val dark = maxOf(kotlin.math.abs(dx), kotlin.math.abs(dy)) != 1
                        reserve(cx + dx, cy + dy, dark)
                    }
                }
            }
        }
    }
    // Format information areas are reserved now and filled after masking.
    for (i in 0..8) {
        if (i != 6) {
            reserve(i, 8, false)
            reserve(8, i, false)
        }
    }
    for (i in 0 until 8) {
        reserve(size - 1 - i, 8, false)
        reserve(8, size - 1 - i, false)
    }
    // The dark module, always at (8, size - 8). Reserved after the format areas
    // so their loop cannot clear it.
    reserve(8, size - 8, true)
    if (version >= 7) {
        // Version information: two 6x3 blocks.
        for (i in 0 until 18) {
            val a = size - 11 + i % 3
            val b = i / 3
            reserve(a, b, false)
            reserve(b, a, false)
        }
    }

    // Data walk: two-column stripes from the right. The direction alternates by
    // the stripe index, exactly as the spec defines it (and as decoders assume).
    var bitIndex = 0
    var right = size - 1
    while (right >= 1) {
        if (right == 6) right = 5 // the vertical timing column is not data
        val upward = ((right + 1) and 2) == 0
        for (step in 0 until size) {
            val y = if (upward) size - 1 - step else step
            for (column in 0..1) {
                val x = right - column
                if (reserved[y * size + x]) continue
                val bit = if (bitIndex < codewords.size * 8) {
                    val codeword = codewords[bitIndex / 8]
                    ((codeword shr (7 - bitIndex % 8)) and 1) != 0
                } else {
                    false
                }
                cells[y * size + x] = bit
                bitIndex++
            }
        }
        right -= 2
    }

    // Mask every non-function cell.
    for (y in 0 until size) {
        for (x in 0 until size) {
            if (reserved[y * size + x]) continue
            if (maskApplies(mask, x, y)) cells[y * size + x] = !cells[y * size + x]
        }
    }

    // Format information: level M, the chosen mask, BCH(15,5) and the 0x5412
    // XOR. Bit i (i = 0 is the least significant) has two fixed homes; the
    // second copy is split between the top-right and the bottom-left.
    val format = formatBits(mask)
    for (i in 0..14) {
        val bit = ((format shr i) and 1) != 0
        val (x1, y1) = when (i) {
            in 0..5 -> 8 to i
            6 -> 8 to 7
            7 -> 8 to 8
            8 -> 7 to 8
            else -> 14 - i to 8
        }
        cells[y1 * size + x1] = bit
        val (x2, y2) = if (i < 8) size - 1 - i to 8 else 8 to size - 15 + i
        cells[y2 * size + x2] = bit
    }

    if (version >= 7) {
        val info = versionBits(version)
        for (i in 0 until 18) {
            val bit = ((info shr i) and 1) != 0
            val a = size - 11 + i % 3
            val b = i / 3
            cells[b * size + a] = bit
            cells[a * size + b] = bit
        }
    }

    return QrMatrix(size, cells)
}

private fun maskApplies(mask: Int, x: Int, y: Int): Boolean = when (mask) {
    0 -> (x + y) % 2 == 0
    1 -> y % 2 == 0
    2 -> x % 3 == 0
    3 -> (x + y) % 3 == 0
    4 -> (y / 2 + x / 3) % 2 == 0
    5 -> (x * y) % 2 + (x * y) % 3 == 0
    6 -> ((x * y) % 2 + (x * y) % 3) % 2 == 0
    else -> ((x + y) % 2 + (x * y) % 3) % 2 == 0
}

/** The 15-bit format word: 5 data bits, BCH(15,5), XOR 0x5412. */
private fun formatBits(mask: Int): Int {
    val data = (ECC_LEVEL_M_FORMAT_BITS shl 3) or mask
    var value = data shl 10
    val generator = 0b10100110111
    for (i in 14 downTo 10) {
        if ((value shr i) and 1 != 0) value = value xor (generator shl (i - 10))
    }
    return ((data shl 10) or value) xor 0b101010000010010
}

/** The 18-bit version word: 6 data bits, BCH(18,6). */
private fun versionBits(version: Int): Int {
    var value = version shl 12
    val generator = 0b1111100100101
    for (i in 17 downTo 12) {
        if ((value shr i) and 1 != 0) value = value xor (generator shl (i - 12))
    }
    return (version shl 12) or value
}

/** ISO/IEC 18004 §8.8.2 penalty rules, used only to pick the least ugly mask. */
private fun penalty(matrix: QrMatrix): Int {
    val size = matrix.size
    var score = 0

    // N1: runs of five or more same-coloured modules.
    for (y in 0 until size) {
        var run = 1
        for (x in 1 until size) {
            if (matrix[x, y] == matrix[x - 1, y]) run++ else {
                if (run >= 5) score += 3 + (run - 5)
                run = 1
            }
        }
        if (run >= 5) score += 3 + (run - 5)
    }
    for (x in 0 until size) {
        var run = 1
        for (y in 1 until size) {
            if (matrix[x, y] == matrix[x, y - 1]) run++ else {
                if (run >= 5) score += 3 + (run - 5)
                run = 1
            }
        }
        if (run >= 5) score += 3 + (run - 5)
    }

    // N2: every 2x2 block of one colour.
    for (y in 0 until size - 1) {
        for (x in 0 until size - 1) {
            val c = matrix[x, y]
            if (matrix[x + 1, y] == c && matrix[x, y + 1] == c && matrix[x + 1, y + 1] == c) score += 3
        }
    }

    // N3: the 1:1:3:1:1 finder-like pattern with four light modules beside it.
    val pattern = booleanArrayOf(true, false, true, true, true, false, true, false, false, false, false)
    val reversed = pattern.reversedArray()
    for (y in 0 until size) {
        for (x in 0 until size - 10) {
            if (matches(matrix, x, y, 1, 0, pattern) || matches(matrix, x, y, 1, 0, reversed)) score += 40
        }
    }
    for (x in 0 until size) {
        for (y in 0 until size - 10) {
            if (matches(matrix, x, y, 0, 1, pattern) || matches(matrix, x, y, 0, 1, reversed)) score += 40
        }
    }

    // N4: deviation from 50% dark.
    var dark = 0
    for (y in 0 until size) for (x in 0 until size) if (matrix[x, y]) dark++
    val percent = dark * 100 / (size * size)
    score += 10 * (kotlin.math.abs(percent - 50) / 5)
    return score
}

private fun matches(
    matrix: QrMatrix,
    x: Int,
    y: Int,
    dx: Int,
    dy: Int,
    pattern: BooleanArray,
): Boolean = pattern.indices.all { matrix[x + dx * it, y + dy * it] == pattern[it] }
