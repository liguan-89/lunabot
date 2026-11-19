package com.lunabot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The frame this computer's own screen comes back in. The server draws the picture at one size and takes a tap in
 * another — the Mac's logical points — so the scaling between them is the one thing a tap cannot get wrong.
 */
class DesktopScreenFrameTest {

    private val frame = DesktopScreenFrame(
        png = "AAAA",
        imageWidth = 1280,
        imageHeight = 829,
        screenWidth = 1710,
        screenHeight = 1107,
    )

    @Test
    fun `a tap scales from the drawn picture to the screen points the server takes`() {
        // The middle of the picture is the middle of the screen.
        val (x, y) = frame.toScreen(640f, 414.5f)
        assertEquals(855f, x)
        assertEquals(553.5f, y)
    }

    @Test
    fun `the top-left corner is the origin`() {
        assertEquals(0f to 0f, frame.toScreen(0f, 0f))
    }

    @Test
    fun `the bottom-right corner lands on the screen's own corner`() {
        val (x, y) = frame.toScreen(1280f, 829f)
        assertEquals(1710f, x)
        assertEquals(1107f, y)
    }

    @Test
    fun `a frame with no size is passed through rather than divided by zero`() {
        val broken = frame.copy(imageWidth = 0, imageHeight = 0)
        assertEquals(12f to 34f, broken.toScreen(12f, 34f))
    }
}
