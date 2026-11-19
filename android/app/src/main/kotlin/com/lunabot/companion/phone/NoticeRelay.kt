package com.openmausbot.companion.phone

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Records every notification other apps post into [PhoneNoticeStore], so a
 * bot can answer "did anything arrive?" without the person reading their
 * shade for it.
 *
 * This service does not relay anything upstream and posts nothing itself. The
 * system binds it only while the person has granted notification access; the
 * list tool checks that grant before answering, so a missing grant reads as a
 * refusal instead of an empty list.
 */
class NoticeRelay : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn == null) return
        if (sbn.packageName == packageName) return
        runCatching { PhoneNoticeStore.record(sbn) }
    }
}