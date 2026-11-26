package com.lunabot.companion.phone

import android.service.notification.StatusBarNotification
import androidx.core.app.NotificationCompat
import kotlin.test.Test
import kotlin.test.assertEquals
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** The shade event's key set: ticked packages only, never this app, and the just-removed keys excluded. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NoticeShadeTest {

    private val context = RuntimeEnvironment.getApplication()

    private fun sbnOf(pkg: String, id: Int): StatusBarNotification {
        val notification = NotificationCompat.Builder(context, "c1")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("t").setContentText("x")
            .build()
        return StatusBarNotification(
            pkg, pkg, id, null, 0, 0, 0,
            notification, android.os.Process.myUserHandle(), 1_000L,
        )
    }

    @Test
    fun `only ticked packages' keys travel, minus self and the removed one`() {
        val ticked = sbnOf("com.chat.app", 1)
        val other = sbnOf("com.other.app", 2)
        val mine = sbnOf("com.lunabot.companion", 3)
        val removed = sbnOf("com.chat.app", 4)
        val keys = shadeKeys(
            arrayOf(ticked, other, mine, removed),
            setOf("com.chat.app"),
            "com.lunabot.companion",
            setOf(removed.key),
        )
        assertEquals(listOf(ticked.key), keys)
    }

    @Test
    fun `a removal under a key still listed while the callback runs is left out`() {
        val staying = sbnOf("com.chat.app", 1)
        val going = sbnOf("com.chat.app", 4)
        val keys = shadeKeys(
            arrayOf(staying, going),
            setOf("com.chat.app"),
            "com.lunabot.companion",
            setOf(going.key),
        )
        assertEquals(listOf(staying.key), keys)
    }

    @Test
    fun `every removal a cancelled debounce had not read is left out`() {
        val staying = sbnOf("com.chat.app", 1)
        val first = sbnOf("com.chat.app", 2)
        val second = sbnOf("com.chat.app", 3)
        val keys = shadeKeys(
            arrayOf(staying, first, second),
            setOf("com.chat.app"),
            "com.lunabot.companion",
            setOf(first.key, second.key),
        )
        assertEquals(listOf(staying.key), keys)
    }

    @Test
    fun `removal keys survive a cancelled debounce and drain once the shade is read`() {
        val tracker = ShadeRemovalTracker()
        tracker.add("first")
        tracker.add("second")
        assertEquals(setOf("first", "second"), tracker.drain())
        assertEquals(emptySet(), tracker.drain())
        tracker.add(null)
        assertEquals(emptySet(), tracker.drain())
    }
}
