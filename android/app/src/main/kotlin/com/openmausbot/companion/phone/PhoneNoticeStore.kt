package com.openmausbot.companion.phone

import android.app.Notification
import android.service.notification.StatusBarNotification

/**
 * The last few notifications other apps posted, for one bot tool.
 *
 * Bound on purpose: the newest [MAX_KEPT] entries, each title and text cut at
 * [MAX_TEXT]. This store is memory only — it is written by [NoticeRelay] in
 * this process and cleared when the process ends — because notification text
 * is the most sensitive thing this app touches (one-time codes, bank alerts,
 * private messages). Nothing here is uploaded or persisted; a bot sees an
 * entry only when it calls the list tool, and that call is recorded in the
 * chat like any other phone read.
 */
internal object PhoneNoticeStore {
    data class Notice(
        val packageName: String,
        val title: String?,
        val text: String?,
        val postedAt: Long,
    )

    const val MAX_KEPT = 60
    const val MAX_TEXT = 500

    private val lock = Any()
    private val notices = ArrayDeque<Notice>()

    fun record(sbn: StatusBarNotification) {
        if (sbn.packageName.isNullOrEmpty()) return
        val notification = sbn.notification ?: return
        // A group summary repeats its children; the individual posts are kept.
        if (notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
        val extras = runCatching { notification.extras }.getOrNull() ?: return
        val title = runCatching { extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() }
            .getOrNull()?.trim()?.take(MAX_TEXT)?.takeIf { it.isNotEmpty() }
        val text = runCatching {
            (extras.getCharSequence(Notification.EXTRA_TEXT)
                ?: extras.getCharSequence(Notification.EXTRA_BIG_TEXT))?.toString()
        }.getOrNull()?.trim()?.take(MAX_TEXT)?.takeIf { it.isNotEmpty() }
        if (title == null && text == null) return
        val notice = Notice(sbn.packageName, title, text, sbn.postTime)
        synchronized(lock) {
            // An app that updates the same notification (a progress line, a
            // message edited in place) must not fill the list with copies.
            notices.removeAll {
                it.packageName == notice.packageName && it.title == notice.title && it.text == notice.text
            }
            notices.addLast(notice)
            while (notices.size > MAX_KEPT) notices.removeFirst()
        }
    }

    /** Newest first, filtered by package and posting time. */
    fun recent(packageName: String?, sinceMs: Long, limit: Int): List<Notice> = synchronized(lock) {
        notices.asReversed()
            .asSequence()
            .filter { packageName == null || it.packageName == packageName }
            .filter { it.postedAt >= sinceMs }
            .take(limit)
            .toList()
    }
}