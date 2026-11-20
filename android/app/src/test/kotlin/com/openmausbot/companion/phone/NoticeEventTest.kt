package com.openmausbot.companion.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Application
import android.content.Context
import android.os.Process
import android.service.notification.StatusBarNotification
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * The wire shape a posted notification becomes: which posts never leave the
 * phone (progress, presence, summaries) and what a MessagingStyle post keeps.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NoticeEventTest {

    private val context: Context = RuntimeEnvironment.getApplication()
    private val pkg = "com.chat.app"

    private fun sbnOf(
        notification: Notification,
        postTime: Long = 1_000L,
    ): StatusBarNotification = StatusBarNotification(
        pkg, pkg, 1, null, 0, 0, 0,
        notification, Process.myUserHandle(), postTime,
    )

    private fun builder(channelId: String = "c1"): NotificationCompat.Builder =
        NotificationCompat.Builder(context, channelId).setSmallIcon(android.R.drawable.ic_dialog_info)

    @Test
    fun `a plain post keeps its texts and flags`() {
        val notification = builder()
            .setContentTitle("Alex")
            .setContentText("到了吗")
            .build()
        val sbn = sbnOf(notification)
        val event = NoticeEvent.of(context, sbn)!!
        assertEquals("notice", event.kind)
        assertEquals(pkg, event.packageName)
        assertEquals(sbn.key, event.key)
        assertEquals(1_000L, event.postedAtMs)
        assertEquals("Alex", event.title)
        assertEquals("到了吗", event.text)
        assertEquals(emptyList(), event.messages)
    }

    @Test
    fun `progress, presence and summaries never leave the phone`() {
        val ongoing = builder().setContentTitle("t").setContentText("x").setOngoing(true).build()
        assertNull(NoticeEvent.of(context, sbnOf(ongoing)))

        val summary = builder().setContentTitle("t").setContentText("x").setGroupSummary(true).build()
        assertNull(NoticeEvent.of(context, sbnOf(summary)))

        val noClear = builder().setContentTitle("t").setContentText("x").build()
            .also { it.flags = it.flags or Notification.FLAG_NO_CLEAR or Notification.FLAG_FOREGROUND_SERVICE }
        assertNull(NoticeEvent.of(context, sbnOf(noClear)))
    }

    @Test
    fun `a MessagingStyle post keeps its lines and who said them`() {
        val me = Person.Builder().setName("Me").setKey("me").build()
        val alex = Person.Builder().setName("Alex").setKey("alex").build()
        val style = NotificationCompat.MessagingStyle(me)
            .setConversationTitle("Weekend")
            .setGroupConversation(true)
            .addMessage("中午吃什么", 900L, alex)
            .addMessage("面吧", 950L, me)
        val notification = builder().setContentTitle("Weekend").setContentText("面吧").setStyle(style).build()

        val event = NoticeEvent.of(context, sbnOf(notification))!!
        assertTrue(event.conversation)
        assertEquals("Weekend", event.conversationTitle)
        assertEquals(true, event.group)
        // The conversation has a name, so the title is not a speaker.
        assertEquals(false, event.titleIsSpeaker)
        assertEquals(listOf("Alex", null), event.messages.map { it.sender })
        assertEquals(listOf("中午吃什么", "面吧"), event.messages.map { it.text })
        // The top-level sender is the last line's speaker — my own line reads as null.
        assertNull(event.sender)
    }

    @Test
    fun `a chat without a conversation name marks its title as a speaker`() {
        val me = Person.Builder().setName("Me").build()
        val alex = Person.Builder().setName("Alex").build()
        val style = NotificationCompat.MessagingStyle(me)
            .addMessage("好", 900L, alex)
        val notification = builder().setContentTitle("Alex").setContentText("好").setStyle(style).build()

        val event = NoticeEvent.of(context, sbnOf(notification))!!
        assertEquals(true, event.titleIsSpeaker)
        assertNull(event.conversationTitle)
        assertEquals("Alex", event.sender)
    }

    @Test
    fun `a low-importance channel reads as silent`() {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel("quiet", "quiet", NotificationManager.IMPORTANCE_LOW),
        )
        val notification = builder("quiet").setContentTitle("t").setContentText("x").build()
        assertEquals(true, NoticeEvent.of(context, sbnOf(notification))!!.silent)

        manager.createNotificationChannel(
            NotificationChannel("loud", "loud", NotificationManager.IMPORTANCE_HIGH),
        )
        val loud = builder("loud").setContentTitle("t").setContentText("x").build()
        assertEquals(false, NoticeEvent.of(context, sbnOf(loud))!!.silent)
    }
}
