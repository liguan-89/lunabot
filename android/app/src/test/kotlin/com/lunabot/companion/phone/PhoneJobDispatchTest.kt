package com.lunabot.companion.phone

import com.lunabot.companion.core.PhoneTool
import com.lunabot.companion.core.PhoneToolCatalog
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

/**
 * The runner's dispatch table against the catalog: a tool the registration
 * can claim has to land on a real executor, not the unsupported answer.
 */
class PhoneJobDispatchTest {

    @Test
    fun `every tool in the catalog routes to an executor`() {
        for (tool in PhoneTool.entries) {
            assertNotNull(JobTarget.of(tool), tool.wire)
        }
    }

    @Test
    fun `every claimed capability has a target`() {
        assertEquals(
            PhoneToolCatalog.supportedCapabilities,
            JobTarget.entries.mapTo(mutableSetOf(), JobTarget::capability),
        )
    }

    @Test
    fun `file and notification reads go to the data executor`() {
        assertEquals(JobTarget.DATA, JobTarget.of(PhoneTool.NOTIF_LIST))
        assertEquals(JobTarget.DATA, JobTarget.of(PhoneTool.FILE_LIST))
        assertEquals(JobTarget.DATA, JobTarget.of(PhoneTool.FILE_READ))
        assertEquals(JobTarget.DATA, JobTarget.of(PhoneTool.FILE_SEND))
        // Sharing a file opens the compose sheet on our display, so it is UI.
        assertEquals(JobTarget.UI, JobTarget.of(PhoneTool.FILE_SHARE))
    }
}
