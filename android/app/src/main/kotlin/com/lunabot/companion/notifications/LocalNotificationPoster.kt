package com.openmausbot.companion.notifications

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.openmausbot.companion.MainActivity
import com.openmausbot.companion.R
import com.openmausbot.companion.core.NotificationFrame
import com.openmausbot.companion.core.NotificationSink
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Local-only notifications from live/replayed notify frames. No FCM.
 * PendingIntent carries both `botId` and `threadId` — the same pair iOS puts
 * in `userInfo` — so a tap opens the exact task (the one allowed quality
 * delta vs iOS, which only presents the banner).
 */
class LocalNotificationPoster(
    context: Context,
    /**
     * The bot's avatar, fetched through the same authenticated route the app
     * uses. Notifications are posted immediately and the face is added when it
     * arrives, so a slow image never delays the alert.
     */
    private val avatarLoader: (suspend (String) -> ByteArray?)? = null,
) : NotificationSink {
    private val appContext = context.applicationContext
    private val manager = NotificationManagerCompat.from(appContext)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    init {
        ensureChannels()
    }

    // canPost() checks POST_NOTIFICATIONS up front, and the second notify below
    // is inside runCatching; lint cannot see either and asks for a per-call
    // guard on an asynchronous re-post whose permission can be revoked anyway.
    @SuppressLint("MissingPermission")
    override fun deliver(notification: NotificationFrame, sequence: Int?) {
        if (!canPost()) return
        val channelId = NotificationMapping.channelId(notification)
        // Identity lives in Intent data (botId + threadId), not a hashed
        // requestCode — extras alone cannot distinguish PendingIntents.
        val intent = NotificationIntents.contentIntent(appContext, notification)
        val pending = PendingIntent.getActivity(
            appContext,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // The shade is SystemUI's window, so the app's reading-direction policy
        // has to travel inside the string. See NotificationText.
        val title = NotificationText.anchored(notification.title)
        val body = NotificationText.anchored(notification.body)
        val builder = NotificationCompat.Builder(appContext, channelId)
            // The app's own mark, monochrome as the status bar requires.
            .setSmallIcon(R.drawable.ic_dexbot_mark)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setNumber(lastBadge)
            .setPriority(
                if (NotificationMapping.isHighImportance(notification)) {
                    NotificationCompat.PRIORITY_HIGH
                } else {
                    NotificationCompat.PRIORITY_DEFAULT
                },
            )
            .setCategory(
                if (notification.isBlocking) NotificationCompat.CATEGORY_ALARM
                else NotificationCompat.CATEGORY_STATUS,
            )
            // A room's banners stack under the room; everything else under the
            // bot. Android groups four or more of the same key by itself.
            .setGroup(NotificationMapping.groupKey(notification))
        if (notification.kind == "approval") {
            // Answerable from the shade: the receiver fetches the pending card
            // and refuses the two kinds that need their full body on screen.
            builder
                .addAction(0, "允许", decision(notification, allow = true))
                .addAction(0, "拒绝", decision(notification, allow = false))
        }
        try {
            manager.notify(NotificationMapping.dedupeId(notification, sequence), 0, builder.build())
        } catch (_: SecurityException) {
            // Permission can be revoked between canPost() and notify(). A missed
            // local banner is safer than crashing the live companion session.
        }
        if (notification.avatarUrl != null && avatarLoader != null) {
            scope.launch {
                val bytes = runCatching { avatarLoader.invoke(notification.botId) }.getOrNull()
                    ?: return@launch
                val bitmap = withContext(Dispatchers.Default) {
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                } ?: return@launch
                builder.setLargeIcon(bitmap).setOnlyAlertOnce(true)
                runCatching {
                    manager.notify(
                        NotificationMapping.dedupeId(notification, sequence),
                        0,
                        builder.build(),
                    )
                }
            }
        }
    }

    private fun decision(notification: NotificationFrame, allow: Boolean): PendingIntent =
        PendingIntent.getBroadcast(
            appContext,
            if (allow) REQUEST_APPROVE else REQUEST_DENY,
            NotificationIntents.decisionIntent(appContext, notification, allow),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    /**
     * A plain tappable follow-up for a shade action that could not be finished
     * out here — the receiver answers what the card's identity carries, and the
     * two kinds that need their full body on screen decline and land here.
     *
     * The blocking channel, so the follow-up sits beside the conversation it
     * belongs to; the builder priority is LOW, which documents the intent and
     * only matters below O — the channel's own importance governs the
     * presentation from there. The tap opens the app itself: the failing action
     * carried identity only, so there is no full target to hand the Intent.
     *
     * One fixed id, so repeated failures replace each other in the shade
     * instead of stacking.
     */
    fun postActionNeeded(title: String, text: String) {
        if (!canPost()) return
        // NEW_TASK: the caller is a broadcast receiver with no activity stack
        // to land on; SINGLE_TOP so a tap never piles up launch modes.
        val intent = Intent(appContext, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pending = PendingIntent.getActivity(
            appContext,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // The same reading-direction anchor the frames get: the shade's
        // template is still SystemUI's, not ours to draw.
        val anchoredTitle = NotificationText.anchored(title)
        val anchoredText = NotificationText.anchored(text)
        val builder = NotificationCompat.Builder(appContext, NotificationMapping.CHANNEL_BLOCKING)
            .setSmallIcon(R.drawable.ic_dexbot_mark)
            .setContentTitle(anchoredTitle)
            .setContentText(anchoredText)
            .setStyle(NotificationCompat.BigTextStyle().bigText(anchoredText))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
        try {
            manager.notify(ACTION_NEEDED_ID, builder.build())
        } catch (_: SecurityException) {
            // Permission can be revoked between canPost() and notify(). Same
            // trade as deliver(): silence, not a crash.
        }
    }

    override fun setBadge(count: Int) {
        // No universal launcher-badge API without a posted notification. Unread
        // count is attached via setNumber on real notify posts; badge-only updates
        // are a no-op so we never leave a phantom notification in the shade.
        lastBadge = maxOf(0, count)
    }

    @Volatile
    var lastBadge: Int = 0
        private set

    fun ensureChannels() {
        val system = appContext.getSystemService(NotificationManager::class.java) ?: return

        // Re-creating a channel that already exists is supposed to be a no-op
        // for anything but name/description, but a plain process restart on
        // Kate's S26+ (2026-09-09) reset a custom sound she had picked for
        // `bot_messages` — the channel's own mUserLockedFields showed
        // visibility+lights locked but *not* sound, so this call's freshly
        // built (soundless) NotificationChannel object was silently winning.
        // Only ever create each channel once; leave an existing one alone,
        // full stop, so nothing this call passes can clobber a real pick.
        if (system.getNotificationChannel(NotificationMapping.CHANNEL_BLOCKING) == null) {
            system.createNotificationChannel(
                NotificationChannel(
                    NotificationMapping.CHANNEL_BLOCKING,
                    appContext.getString(R.string.notification_channel_blocking),
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply {
                    description = appContext.getString(R.string.notification_channel_blocking_desc)
                },
            )
        }

        if (system.getNotificationChannel(NotificationMapping.CHANNEL_DONE) == null) {
            // The legacy channel could only ever be at DEFAULT or something the
            // user explicitly lowered it to in system settings (Android caps a
            // channel at what the app first declared, so DEFAULT is the
            // ceiling). A lower importance is therefore a deliberate mute, not
            // a default — starting fresh at HIGH would silently override that
            // choice. Carry it forward; only a fresh install or an untouched
            // legacy channel gets the HIGH bump Kate asked for. This whole
            // branch only runs the one time `bot_messages` doesn't exist yet,
            // so it can't re-fire on every launch and re-decide anything.
            val legacyDone = system.getNotificationChannel(LEGACY_CHANNEL_DONE)
            val doneImportance = if (legacyDone != null &&
                legacyDone.importance < NotificationManager.IMPORTANCE_DEFAULT
            ) {
                legacyDone.importance
            } else {
                // HIGH so this pops up (heads-up banner + lock screen) with sound,
                // the way a normal messaging app does — DEFAULT only shows quietly
                // in the shade. Kate's ask (2026-09-08): every bot message, not just
                // approvals, should read as "interesting app noise" rather than sit
                // unnoticed until she happens to pull the shade down.
                NotificationManager.IMPORTANCE_HIGH
            }
            system.createNotificationChannel(
                NotificationChannel(
                    NotificationMapping.CHANNEL_DONE,
                    appContext.getString(R.string.notification_channel_done),
                    doneImportance,
                ).apply {
                    description = appContext.getString(R.string.notification_channel_done_desc)
                    // Importance isn't the only thing a person can customize on a
                    // channel — a picked sound, an intentionally silent one
                    // (sound=null), vibration, and lock-screen visibility all
                    // deserve the same carry-forward as importance above: copy
                    // them straight off the legacy channel rather than letting
                    // this constructor's plain defaults silently win. A fresh
                    // install has no legacy channel, so this is a no-op there.
                    if (legacyDone != null) {
                        setSound(legacyDone.sound, legacyDone.audioAttributes)
                        enableVibration(legacyDone.shouldVibrate())
                        vibrationPattern = legacyDone.vibrationPattern
                        lockscreenVisibility = legacyDone.lockscreenVisibility
                    }
                },
            )
        }
        // The old channel this replaced. Deleting it (rather than leaving it
        // orphaned) keeps Settings -> App notifications from showing a dead
        // "Finished work" entry alongside the new one; harmless no-op once
        // it's already gone.
        system.deleteNotificationChannel(LEGACY_CHANNEL_DONE)

        if (system.getNotificationChannel(NotificationMapping.CHANNEL_ROUTINE_FAILED) == null) {
            system.createNotificationChannel(
                NotificationChannel(
                    NotificationMapping.CHANNEL_ROUTINE_FAILED,
                    appContext.getString(R.string.notification_channel_routine),
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply {
                    description = appContext.getString(R.string.notification_channel_routine_desc)
                },
            )
        }
    }

    /** True when the platform will accept a notification post right now. */
    fun canPost(): Boolean {
        if (!manager.areNotificationsEnabled()) return false
        if (Build.VERSION.SDK_INT < 33) return true
        return ContextCompat.checkSelfPermission(
            appContext,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
    }

    /** True when a runtime POST_NOTIFICATIONS request is still required. */
    fun needsNotificationPermission(): Boolean =
        Build.VERSION.SDK_INT >= 33 && !canPost()

    companion object {
        const val EXTRA_THREAD_ID = "openmaus.threadId"
        const val EXTRA_BOT_ID = "openmaus.botId"
        const val EXTRA_KIND = "openmaus.kind"

        /** Permission string for the UI pass's launcher contract. Inlined, so safe on any API. */
        @SuppressLint("InlinedApi")
        const val POST_NOTIFICATIONS_PERMISSION = Manifest.permission.POST_NOTIFICATIONS

        /** The channel id [NotificationMapping.CHANNEL_DONE] replaced. See its kdoc. */
        private const val LEGACY_CHANNEL_DONE = "done"

        // Fixed request codes are safe because the decision Intent's data URI
        // differs per thread, and PendingIntent identity includes it.
        private const val REQUEST_APPROVE = 101
        private const val REQUEST_DENY = 102

        /** The shade id for [postActionNeeded] follow-ups; one at a time. */
        private const val ACTION_NEEDED_ID = 1200
    }
}
