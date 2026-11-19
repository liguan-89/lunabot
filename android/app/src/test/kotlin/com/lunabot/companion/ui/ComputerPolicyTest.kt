package com.lunabot.companion.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Who gets a join button, and what a still frame is claiming — the rules from
 * `ios/App/ComputerView.swift`.
 */
class ComputerPolicyTest {

    @Test
    fun `only a cloud bot offers the live desktop`() {
        assertTrue(ComputerPolicy.showsCloudDesktop(bot(id = "b").copy(computer = "cloud")))
        // Local VM and "this Mac" show the preview and no join button (§10).
        assertFalse(ComputerPolicy.showsCloudDesktop(bot(id = "b").copy(computer = "local")))
        assertFalse(ComputerPolicy.showsCloudDesktop(bot(id = "b").copy(computer = "mac")))
        assertFalse(ComputerPolicy.showsCloudDesktop(bot(id = "b").copy(computer = null)))
    }

    @Test
    fun `a VPS-backed cloud bot gets no button, because the server would refuse`() {
        assertFalse(
            ComputerPolicy.showsCloudDesktop(
                bot(id = "b").copy(computer = "cloud", cloudBackend = "vps"),
            ),
        )
    }

    @Test
    fun `an older harness that never sends cloudBackend keeps the button`() {
        assertTrue(
            ComputerPolicy.showsCloudDesktop(
                bot(id = "b").copy(computer = "cloud", cloudBackend = null),
            ),
        )
    }

    @Test
    fun `a non-vps backend keeps the button`() {
        assertTrue(
            ComputerPolicy.showsCloudDesktop(
                bot(id = "b").copy(computer = "cloud", cloudBackend = "fly"),
            ),
        )
    }

    /**
     * The note tells the person where to switch VNC on, so it has to name the
     * section the desktop has: Phone (`ios/App/ComputerView.swift:89`).
     */
    @Test
    fun `the VNC note names the desktop section that exists`() {
        assertEquals(
            "交互式 VNC 会话。必须在电脑端的「手机和设备」中为此手机启用访问权限。",
            ComputerPolicy.VNC_NOTE,
        )
    }

    @Test
    fun `the status label says whether the picture is still arriving`() {
        assertEquals("预览", ComputerPolicy.statusLabel(bot(id = "b", busy = true)))
        assertEquals("空闲", ComputerPolicy.statusLabel(bot(id = "b", busy = false)))
        assertEquals("空闲", ComputerPolicy.statusLabel(bot(id = "b", busy = null)))
        // A still from the transcript is not a live feed, and a fresh HTTP
        // capture is not the turn stream — each says which it is.
        assertEquals("上次画面", ComputerPolicy.statusLabel(bot(id = "b"), stale = true))
        assertEquals("截图", ComputerPolicy.statusLabel(bot(id = "b"), snapshot = true))
    }

    @Test
    fun `an idle bot explains why there is nothing to watch`() {
        assertTrue(ComputerPolicy.explainsIdle(bot(id = "b", busy = false)))
        assertFalse(ComputerPolicy.explainsIdle(bot(id = "b", busy = true)))
        assertEquals("暂无画面", ComputerPolicy.waitingHeadline(bot(id = "b")))
        assertEquals(
            "正在等待画面…",
            ComputerPolicy.waitingHeadline(bot(id = "b", busy = true)),
        )
        // A busy bot with no frame is usually a shell-only turn, so the copy
        // must not promise that a picture is coming.
        assertEquals(ComputerPolicy.BUSY_HINT, ComputerPolicy.waitingExplanation(bot(id = "b", busy = true)))
        assertEquals(ComputerPolicy.IDLE_HINT, ComputerPolicy.waitingExplanation(bot(id = "b")))
    }

    @Test
    fun `only remote surfaces can be captured outside a live turn`() {
        assertTrue(ComputerPolicy.hasRemoteCapture(bot(id = "b").copy(computer = "cloud")))
        assertTrue(ComputerPolicy.hasRemoteCapture(bot(id = "b").copy(computer = "vm")))
        // Auto with a configured cloud backend still has the route.
        assertTrue(ComputerPolicy.hasRemoteCapture(bot(id = "b").copy(computer = null, cloudBackend = "vps")))
        // "This Mac" is captured by the desktop, not by an HTTP route.
        assertFalse(ComputerPolicy.hasRemoteCapture(bot(id = "b").copy(computer = "local")))
        assertFalse(ComputerPolicy.hasRemoteCapture(bot(id = "b").copy(computer = null)))
    }
}

/**
 * Frames are hundreds of kilobytes each, so the watcher count decides whether the
 * stream carries them at all. A count that drifts either pulls screenshots
 * forever or turns them off under an open screen.
 */
class ScreenWatchTest {

    @Test
    fun `watching then leaving starts and stops once`() {
        val started = mutableListOf<String>()
        val stopped = mutableListOf<String>()
        val watch = ScreenWatch(start = { started += it }, stop = { stopped += it })

        watch.watch("bot-1")
        watch.release()
        watch.release()

        assertEquals(listOf("bot-1"), started)
        assertEquals(listOf("bot-1"), stopped)
    }

    @Test
    fun `releasing without watching stops nothing`() {
        val stopped = mutableListOf<String>()
        ScreenWatch(start = {}, stop = { stopped += it }).release()
        assertEquals(emptyList(), stopped)
    }

    @Test
    fun `watching the same bot twice does not double-count`() {
        val started = mutableListOf<String>()
        val stopped = mutableListOf<String>()
        val watch = ScreenWatch(start = { started += it }, stop = { stopped += it })

        watch.watch("bot-1")
        watch.watch("bot-1")

        assertEquals(listOf("bot-1"), started)
        assertEquals(emptyList(), stopped)
    }

    @Test
    fun `switching bots releases the first before taking the second`() {
        val calls = mutableListOf<String>()
        val watch = ScreenWatch(start = { calls += "start:$it" }, stop = { calls += "stop:$it" })

        watch.watch("bot-1")
        watch.watch("bot-2")
        watch.release()

        assertEquals(
            listOf("start:bot-1", "stop:bot-1", "start:bot-2", "stop:bot-2"),
            calls,
        )
    }

    @Test
    fun `every start is matched by exactly one stop`() {
        var balance = 0
        val watch = ScreenWatch(start = { balance += 1 }, stop = { balance -= 1 })

        watch.watch("bot-1")
        watch.watch("bot-2")
        watch.watch("bot-2")
        watch.watch("bot-3")
        watch.release()
        watch.release()

        assertEquals(0, balance)
    }
}
