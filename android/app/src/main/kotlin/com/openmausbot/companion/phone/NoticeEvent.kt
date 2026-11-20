package com.openmausbot.companion.phone

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.service.notification.StatusBarNotification
import androidx.core.app.NotificationCompat
import com.openmausbot.companion.core.PhoneNoticeEvent
import com.openmausbot.companion.core.PhoneNoticeMessage

/**
 * Builds the `notice` wire event (`PhoneNoticeEvent`, schema in
 * `server/phone-notices.ts`) out of a posted notification. Pure extraction:
 * consent and the allow-list live in [NoticeRelay]; every field is bounded to
 * the wire's maximums because the server validates, not trusts.
 */
internal object NoticeEvent {

    private const val TITLE_MAX = 2_000
    private const val TEXT_MAX = 8_000
    private const val LINE_MAX = 2_000
    private const val MESSAGES_MAX = 30

    /**
     * The event, or null when the notification is not worth a post: the cheap
     * drops [PhoneNoticeStore.record] already makes (no title and no text,
     * group summary) plus the classes the server filters anyway — ongoing,
     * foreground-service and non-clearable posts are progress or presence,
     * not content.
     */
    fun of(context: Context, sbn: StatusBarNotification): PhoneNoticeEvent? {
        val notification = sbn.notification ?: return null
        if (notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return null
        if (notification.flags and Notification.FLAG_ONGOING_EVENT != 0) return null
        if (notification.flags and Notification.FLAG_FOREGROUND_SERVICE != 0) return null
        if (!sbn.isClearable) return null

        val style = messagingStyle(notification)
        val extras = notification.extras
        val messages = style?.messages.orEmpty().takeLast(MESSAGES_MAX).mapNotNull { message ->
            val text = message.text?.toString()?.trim().orEmpty()
            if (text.isEmpty()) return@mapNotNull null
            PhoneNoticeMessage(
                sender = senderOf(style, message),
                text = text.take(LINE_MAX),
                atMs = message.timestamp,
            )
        }
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim().orEmpty()
        val text = (
            extras.getCharSequence(Notification.EXTRA_TEXT)
                ?: extras.getCharSequence(Notification.EXTRA_BIG_TEXT)
            )?.toString()?.trim().orEmpty()
        if (title.isEmpty() && text.isEmpty() && messages.isEmpty()) return null

        return PhoneNoticeEvent(
            key = sbn.key.orEmpty().take(300),
            packageName = sbn.packageName.orEmpty(),
            postedAtMs = sbn.postTime,
            title = title.take(TITLE_MAX),
            text = text.take(TEXT_MAX),
            category = notification.category?.take(80),
            clearable = true,
            conversation = style != null,
            silent = isSilent(context, notification),
            sender = messages.lastOrNull()?.sender?.take(300),
            group = style?.isGroupConversation,
            conversationTitle = style?.conversationTitle?.toString()?.take(300),
            // Without a conversation title the title is the latest speaker.
            titleIsSpeaker = style != null && style.conversationTitle == null,
            messages = messages,
        )
    }

    private fun messagingStyle(notification: Notification): NotificationCompat.MessagingStyle? =
        runCatching {
            NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(notification)
        }.getOrNull()

    /** A line's speaker; null for the person's own messages and for lines the app did not attribute. */
    private fun senderOf(
        style: NotificationCompat.MessagingStyle?,
        message: NotificationCompat.MessagingStyle.Message,
    ): String? {
        val person = message.person ?: return null
        val own = style?.user
        if (own != null && person.key != null && person.key == own.key) return null
        if (own != null && person.key == null && person.name == own.name) return null
        return person.name?.toString()?.take(300)
    }

    /** Low-or-lower channel importance reads as silent; pre-O channels always read as audible. */
    private fun isSilent(context: Context, notification: Notification): Boolean {
        val channelId = notification.channelId ?: return false
        val manager = context.getSystemService(NotificationManager::class.java) ?: return false
        return runCatching { manager.getNotificationChannel(channelId) }
            .getOrNull()
            ?.let { it.importance <= NotificationManager.IMPORTANCE_LOW }
            ?: false
    }
}
