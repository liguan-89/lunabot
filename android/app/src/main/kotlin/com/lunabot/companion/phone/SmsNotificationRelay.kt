package com.lunabot.companion.phone

import android.Manifest
import android.app.Notification
import android.content.pm.PackageManager
import android.provider.ContactsContract
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import androidx.core.content.ContextCompat
import com.lunabot.companion.OpenMausApp
import com.lunabot.companion.core.PhoneSmsEvent
import com.lunabot.companion.core.Session
import com.lunabot.companion.storage.ChatPreferences
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The RCS/5G half of inbound relay: those messages never fire SMS_RECEIVED —
 * they land only in the designated messaging app — so the only readable signal
 * is the notification that app posts. This listener mirrors it upstream as the
 * same `POST /api/phones/self/events`; replies still go out as carrier SMS.
 * The messaging app's title is a contact name when it knows one, so the number
 * is resolved through the address book before posting (replies need a number).
 */
class SmsNotificationRelay : NotificationListenerService() {

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName !in MESSAGING_PACKAGES) return
        if (sbn.notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
        val prefs = ChatPreferences(this)
        if (!prefs.phoneMessages.value || !prefs.phoneNotifyRelay.value) return
        val extras = sbn.notification.extras
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim()
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim()
        if (title.isNullOrEmpty() || text.isNullOrEmpty()) return
        val from = if (NUMBERISH.matches(title)) title else lookupNumber(title) ?: title
        if (!SmsEventDedup.note(from, text)) return
        val app = applicationContext as? OpenMausApp ?: return
        val event = PhoneSmsEvent(sendId = "notif:${sbn.postTime}".take(120), from = from.take(64), text = text.take(4000))
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            app.session.connect()
            val live = withTimeoutOrNull(CONNECT_TIMEOUT_MS) {
                app.session.status.first { it is Session.Status.Live }
            } ?: return@launch
            Log.i(TAG, "posting notification sms event from=$from title=$title")
            Log.i(TAG, "post result=${app.session.postPhoneEvent(event)}")
        }
    }

    /** The notification title is a display name for known senders; replies need the number behind it. */
    private fun lookupNumber(name: String): String? {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) return null
        return try {
            contentResolver.query(
                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER),
                "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} = ?",
                arrayOf(name),
                null,
            )?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
        } catch (error: Exception) {
            Log.w(TAG, "contact lookup failed: ${error.message}")
            null
        }
    }

    private companion object {
        const val TAG = "SmsRelay"
        const val CONNECT_TIMEOUT_MS = 10_000L
        val NUMBERISH = Regex("^[+0-9 ()*#-]{3,}$")
        // The messaging apps that can be the system's SMS handler, incl. carrier 5G-message inboxes.
        val MESSAGING_PACKAGES = setOf(
            "com.android.mms",
            "com.android.messaging",
            "com.google.android.apps.messaging",
            "com.samsung.android.messaging",
            "com.miui.smsextra",
        )
    }
}
