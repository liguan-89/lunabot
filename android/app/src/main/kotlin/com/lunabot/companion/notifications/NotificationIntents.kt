package com.lunabot.companion.notifications

import android.content.Intent
import android.net.Uri
import com.lunabot.companion.MainActivity
import com.lunabot.companion.core.NotificationFrame
import com.lunabot.companion.core.NotificationTarget
import androidx.core.net.toUri

/**
 * The two ids a notification tap carries — the same pair iOS reads from
 * `userInfo` in `Notifications.swift:65-69`. Both are required; a partial
 * extra is not a destination.
 */
fun Intent.notificationTarget(): NotificationTarget? =
    NotificationTarget.from(
        getStringExtra(LocalNotificationPoster.EXTRA_BOT_ID),
        getStringExtra(LocalNotificationPoster.EXTRA_THREAD_ID),
    )

/**
 * Filterable identity for notification content Intents.
 *
 * PendingIntent equality uses request code plus Intent.filterEquals fields
 * (action, data, type, package, component, categories) — **extras do not
 * participate**. Putting `botId` and `threadId` only in extras lets two
 * notifications for the same room thread, or two thread ids whose
 * `String.hashCode()` collide, share one PendingIntent and overwrite each
 * other's target under `FLAG_UPDATE_CURRENT`.
 *
 * The data URI below is the unambiguous discriminator; it is never hashed.
 */
object NotificationIntents {
    const val ACTION_OPEN = "com.lunabot.companion.OPEN_NOTIFICATION"
    const val ACTION_APPROVE = "com.lunabot.companion.APPROVE_NOTIFICATION"
    const val ACTION_DENY = "com.lunabot.companion.DENY_NOTIFICATION"

    /**
     * Stable, unhashed identity string for [android.content.Intent.setData].
     * Distinct for every `(botId, threadId)` pair — including UUID strings
     * that collide under 32-bit [String.hashCode].
     */
    fun contentIdentity(botId: String, threadId: String): String =
        "openmaus://notification/${encode(botId)}/${encode(threadId)}"

    fun contentUri(botId: String, threadId: String): Uri =
        contentIdentity(botId, threadId).toUri()

    fun contentIntent(
        packageContext: android.content.Context,
        notification: NotificationFrame,
    ): Intent = Intent(packageContext, MainActivity::class.java).apply {
        action = ACTION_OPEN
        data = contentUri(notification.botId, notification.threadId)
        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        putExtra(LocalNotificationPoster.EXTRA_THREAD_ID, notification.threadId)
        putExtra(LocalNotificationPoster.EXTRA_BOT_ID, notification.botId)
        putExtra(LocalNotificationPoster.EXTRA_KIND, notification.kind)
    }

    /**
     * One action button. The data URI carries the decision as well as the
     * identity, so the allow and deny PendingIntents are distinct even for the
     * same thread and the same request code.
     */
    fun decisionIntent(
        packageContext: android.content.Context,
        notification: NotificationFrame,
        allow: Boolean,
    ): Intent = Intent(packageContext, ApprovalActionReceiver::class.java).apply {
        action = if (allow) ACTION_APPROVE else ACTION_DENY
        data = (
            "openmaus://notification/${if (allow) "approve" else "deny"}/" +
                "${encode(notification.botId)}/${encode(notification.threadId)}"
            ).toUri()
        putExtra(LocalNotificationPoster.EXTRA_THREAD_ID, notification.threadId)
        putExtra(LocalNotificationPoster.EXTRA_BOT_ID, notification.botId)
    }

    /** Android's URI encoder is available throughout this app's API range. */
    private fun encode(value: String): String = Uri.encode(value)
}
