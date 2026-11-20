// Adapted from Mika's WechatApi and WechatRuntime (Apache-2.0).
package com.lunabot.companion.wechat

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The QR encoder, pinned against known-good matrices.
 *
 * The golden rows below were produced by an independent implementation and
 * checked by decoding them: a byte-mode, level-M code for "hello" (version 1)
 * and for a typical iLink bind URL (version 4). If the encoder drifts, these
 * fail, which is the only way a hand-written encoder is safe to ship.
 */
class WechatQrTest {

    private val hello = listOf(
        "#######..##...#######",
        "#.....#.##....#.....#",
        "#.###.#..#.##.#.###.#",
        "#.###.#...##..#.###.#",
        "#.###.#.##..#.#.###.#",
        "#.....#.....#.#.....#",
        "#######.#.#.#.#######",
        "..........###........",
        "#.#.#.#..#.#....#..#.",
        "..#.##....#...#....##",
        ".#.#..#.###.#...#####",
        "##..#.........#....#.",
        ".##.#.##..#.#.#.#....",
        "........####.#.#..###",
        "#######...##.###..###",
        "#.....#...####.##....",
        "#.###.#.#.##.###...##",
        "#.###.#..#....##..##.",
        "#.###.#.###.#...#.#.#",
        "#.....#..#....#.#..#.",
        "#######.###.#.##...##",
    )

    private val link = listOf(
        "#######..####.....####.#..#######",
        "#.....#..#.#...####.###...#.....#",
        "#.###.#.#####.###....#.##.#.###.#",
        "#.###.#.#.###.....###.###.#.###.#",
        "#.###.#.#.#.########.#.#..#.###.#",
        "#.....#.#..####..#...#....#.....#",
        "#######.#.#.#.#.#.#.#.#.#.#######",
        "........#####.#.#.##.###.........",
        "#.#####...##.##..##...###.#####..",
        "#.#.#....##.##..######.#..##.##.#",
        ".###..#.#....#####...##.##..#.##.",
        "##......##...#..###..###....####.",
        "##.##.#####...#.#..##..##...##..#",
        "###..#...##.##.#.###...#..#..#.##",
        "#.###########.####..##...##.#..#.",
        ".##.##.##.######..#..######.###..",
        "##..###.##.###.#.#..#...##.##...#",
        "#.#..#.##...#...#..##..#..##.##.#",
        "##...##.#......##.#.#.#..####.##.",
        "##.#...#..##..#......##.#######..",
        "##..###...#.#.##..###.####.###.##",
        "#......#.#...#.##..#...#.##.....#",
        "#.....##.#.#..#...#.#.#.#.####.#.",
        "#.#.##...#.#.#..#..#.#.###.#..##.",
        "#.#...#.#.####...#....#.#####..#.",
        "........######..##.####.#...#.#.#",
        "#######..#..####.#..##.##.#.#.##.",
        "#.....#.#.#.###.###.#####...####.",
        "#.###.#.#.#.....#.....#.######..#",
        "#.###.#.#.###.##..####..##..##.##",
        "#.###.#.##...####.#...##..##.#...",
        "#.....#..#.#..##...#.###....###..",
        "#######.#.#..#.#.##...####.#...#.",
    )

    @Test
    fun `a short payload encodes as version 1`() {
        val matrix = encodeQr("hello")
        assertEquals(21, matrix.size)
        assertEquals(hello, matrix.render())
    }

    @Test
    fun `an iLink payload encodes as version 4`() {
        val matrix = encodeQr("https://ilinkai.weixin.qq.com/ilink/bot/qrcode/abc123")
        assertEquals(33, matrix.size)
        assertEquals(link, matrix.render())
    }

    @Test
    fun `the three finder patterns are where a scanner looks`() {
        val matrix = encodeQr("hello")
        for ((ox, oy) in listOf(0 to 0, 14 to 0, 0 to 14)) {
            // The outer ring is dark, the inner ring light, the centre dark.
            assertTrue(matrix[ox, oy], "finder corner $ox,$oy")
            assertFalse(matrix[ox + 1, oy + 1], "finder separator $ox,$oy")
            assertTrue(matrix[ox + 3, oy + 3], "finder centre $ox,$oy")
        }
    }

    @Test
    fun `the timing patterns alternate from the eighth module`() {
        val matrix = encodeQr("hello")
        for (i in 8 until matrix.size - 8) {
            assertEquals(i % 2 == 0, matrix[i, 6], "horizontal timing at $i")
            assertEquals(i % 2 == 0, matrix[6, i], "vertical timing at $i")
        }
    }

    @Test
    fun `a longer payload picks a bigger version and still encodes`() {
        val matrix = encodeQr("https://example.test/" + "a".repeat(200))
        assertTrue(matrix.size > 33)
        assertEquals(0, (matrix.size - 17) % 4)
        assertNotNull(matrix.render())
    }

    @Test
    fun `an empty payload is refused`() {
        val failed = runCatching { encodeQr("") }.isFailure
        assertTrue(failed)
    }

    @Test
    fun `a payload too large for version 20 is refused rather than truncated`() {
        val failed = runCatching { encodeQr("x".repeat(1_201)) }.isFailure
        assertTrue(failed)
    }
}
