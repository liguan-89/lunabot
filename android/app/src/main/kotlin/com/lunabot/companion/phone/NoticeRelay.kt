package com.lunabot.companion.phone

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import com.lunabot.companion.OpenMausApp
import com.lunabot.companion.core.PhoneShadeEvent
import com.lunabot.companion.core.Session
import com.lunabot.companion.storage.ChatPreferences
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Records every notification other apps post into [PhoneNoticeStore], so a
 * bot can answer "did anything arrive?" without the person reading their
 * shade for it.
 *
 * The same callback also pushes upstream — `POST /api/phones/self/events`
 * with kind `notice` — but only for packages the person ticked in Settings
 * while the share switch is on. The allow-list is read fresh per notification,
 * so unticking an app stops its flow immediately; everything the phone sends
 * is re-filtered server-side before it is learned.
 */
class NoticeRelay : NotificationListenerService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val removedKeys = ShadeRemovalTracker()
    private var shadeJob: Job? = null

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        Log.i(TAG, "posted pkg=${sbn?.packageName}")
        if (sbn == null) return
        if (sbn.packageName == packageName) return
        runCatching { PhoneNoticeStore.record(sbn) }
        runCatching { relay(sbn) }
    }

    /** Binding re-reads the shade: a restart on either side reconciles back to what is actually posted. */
    override fun onListenerConnected() {
        queueShade(null)
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        queueShade(sbn?.key)
    }

    /**
     * Removals arrive in bursts (clear-all fires one per key): debounce into one
     * post carrying the keys still on the shade for the ticked packages. Every
     * key remembered since the last shade read is excluded explicitly — on some
     * builds the removed entry still shows in the active list while its callback runs.
     */
    private fun queueShade(removedKey: String?) {
        removedKeys.add(removedKey)
        shadeJob?.cancel()
        shadeJob = scope.launch {
            delay(SHADE_DEBOUNCE_MS)
            postShade()
        }
    }

    private suspend fun postShade() {
        val prefs = ChatPreferences(this)
        if (!prefs.phoneNoticeShare.value) return
        val ticked = prefs.phoneNoticeApps.value
        if (ticked.isEmpty()) return
        val keys = shadeKeys(activeNotifications.orEmpty(), ticked, packageName, removedKeys.drain())
        val app = applicationContext as? OpenMausApp ?: return
        app.session.connect()
        val live = withTimeoutOrNull(CONNECT_TIMEOUT_MS) {
            app.session.status.first { it is Session.Status.Live }
        } ?: run { Log.i(TAG, "shade: session not live"); return }
        if (!app.session.postPhoneShade(PhoneShadeEvent(keys = keys))) {
            Log.i(TAG, "shade post failed")
        }
    }

    private fun relay(sbn: StatusBarNotification) {
        val prefs = ChatPreferences(this)
        if (!prefs.phoneNoticeShare.value) { Log.i(TAG, "drop: share off"); return }
        if (sbn.packageName !in prefs.phoneNoticeApps.value) { Log.i(TAG, "drop: ${sbn.packageName} not ticked in ${prefs.phoneNoticeApps.value}"); return }
        val event = NoticeEvent.of(this, sbn) ?: run { Log.i(TAG, "drop: event null ${sbn.packageName}"); return }
        if (!NoticePostDedup.note(event)) { Log.i(TAG, "drop: dedup ${event.key}"); return }
        val app = applicationContext as? OpenMausApp ?: run {
            NoticePostDedup.forget(event)
            return
        }
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            app.session.connect()
            val live = withTimeoutOrNull(CONNECT_TIMEOUT_MS) {
                app.session.status.first { it is Session.Status.Live }
            } ?: run {
                Log.i(TAG, "drop: session not live; claim withdrawn")
                NoticePostDedup.forget(event)
                return@launch
            }
            Log.i(TAG, "posting pkg=${event.packageName}")
            if (!app.session.postPhoneNotice(event)) {
                Log.i(TAG, "notice post failed pkg=${event.packageName}; claim withdrawn")
                NoticePostDedup.forget(event)
            }
        }
    }

    /** Notifications repost on every update; identical content inside the window is one event, not a stream. */
    internal object NoticePostDedup {
        private const val WINDOW_MS = 120_000L
        private const val MAX_ENTRIES = 200
        private val recent = LinkedHashMap<String, Long>()

        fun note(event: com.lunabot.companion.core.PhoneNoticeEvent): Boolean = noteAt(event, System.currentTimeMillis())

        @Synchronized
        internal fun noteAt(event: com.lunabot.companion.core.PhoneNoticeEvent, now: Long): Boolean {
            val signature = signatureOf(event)
            recent.entries.removeIf { now - it.value > WINDOW_MS }
            if (recent.containsKey(signature)) return false
            if (recent.size >= MAX_ENTRIES) recent.remove(recent.keys.first())
            recent[signature] = now
            return true
        }

        /** Withdraws a claim [note] made: the post it guarded never landed, so the next repost still delivers. */
        @Synchronized
        fun forget(event: com.lunabot.companion.core.PhoneNoticeEvent) {
            recent.remove(signatureOf(event))
        }

        private fun signatureOf(event: com.lunabot.companion.core.PhoneNoticeEvent): String =
            "${event.key}　${event.title}　${event.text}　${event.messages.lastOrNull()?.text.orEmpty()}"
    }

    private companion object {
        const val TAG = "NoticeRelay"
        const val CONNECT_TIMEOUT_MS = 10_000L
        const val SHADE_DEBOUNCE_MS = 750L
    }
}

/** The keys a cancelled debounce had not read yet. They drain only when the shade itself is read. */
internal class ShadeRemovalTracker {
    private val lock = Any()
    private val keys = mutableSetOf<String>()

    fun add(key: String?) {
        if (key == null) return
        synchronized(lock) { keys += key }
    }

    fun drain(): Set<String> = synchronized(lock) {
        val out = keys.toSet()
        keys.clear()
        out
    }
}

/** The keys the shade event carries: ticked packages only, never this app, and the just-removed keys out. */
internal fun shadeKeys(
    active: Array<out StatusBarNotification>,
    ticked: Set<String>,
    selfPackage: String,
    removedKeys: Set<String>,
): List<String> = active.asSequence()
    .filter { it.packageName in ticked && it.packageName != selfPackage && it.key !in removedKeys }
    .map { it.key.take(300) }
    .toList()
