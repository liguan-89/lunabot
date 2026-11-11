package com.openmausbot.companion.ui

import com.openmausbot.companion.core.BotTask
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** The row's status line is wording only — these tests keep the split honest. */
class BotThreadRowTest {
    private fun task(id: String, activity: String? = null, busy: Boolean? = null, waiting: Boolean? = null) =
        BotTask(threadId = id, title = id, createdAt = 0.0, activity = activity, busy = busy, waitingOnTeammate = waiting)

    @Test
    fun teammateWaitIsLabeledAsWaitingNeverAsWork() {
        assertEquals("等待队友", task("dispatch", activity = "idle", waiting = true).runtimeLabel())
    }

    @Test
    fun aTeammateWaitOutranksThePaintedWorkingStatus() {
        assertEquals("等待队友", task("run", activity = "working", busy = true, waiting = true).runtimeLabel())
        assertEquals("工作中", task("run", busy = true).runtimeLabel())
    }

    @Test
    fun onlyWorkShowsWorkAndUnknownActivitiesStayQuiet() {
        assertEquals("工作中", task("run", activity = "working").runtimeLabel())
        assertEquals("工作中", task("run", activity = "running").runtimeLabel(), "a running thread is work, exactly as its row labels it")
        assertEquals("等待你确认", task("ask", activity = "waiting-on-you").runtimeLabel())
        assertEquals("排队中", task("later", activity = "queued").runtimeLabel())
        assertEquals("排队中", task("held").runtimeLabel(queued = true), "a client-held send labels the row Queued without wire activity")
        assertNull(task("idle", activity = "idle").runtimeLabel())
        assertNull(task("idle").runtimeLabel())
    }
}
