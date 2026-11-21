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
     * post carrying the keys still on the shade for the ticked packages.
     * [removedKey] is excluded explicitly — on some builds the removed entry
     * still shows in the active list while this callback runs.
     */
    private fun queueShade(removedKey: String?) {
        shadeJob?.cancel()
        shadeJob = scope.launch {
            delay(SHADE_DEBOUNCE_MS)
            postShade(removedKey)
        }
    }

    private suspend fun postShade(removedKey: String?) {
        val prefs = ChatPreferences(this)
        if (!prefs.phoneNoticeShare.value) return
        val ticked = prefs.phoneNoticeApps.value
        if (ticked.isEmpty()) return
        val keys = shadeKeys(activeNotifications.orEmpty(), ticked, packageName, removedKey)
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
        val app = applicationContext as? OpenMausApp ?: return
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            app.session.connect()
            val live = withTimeoutOrNull(CONNECT_TIMEOUT_MS) {
                app.session.status.first { it is Session.Status.Live }
            } ?: run { Log.i(TAG, "drop: session not live"); return@launch }
            Log.i(TAG, "posting pkg=${event.packageName}")
            if (!app.session.postPhoneNotice(event)) {
                Log.i(TAG, "notice post failed pkg=${event.packageName}")
            }
        }
    }

    /** Notifications repost on every update; identical content is one event, not a stream. */
    private object NoticePostDedup {
        private const val MAX_ENTRIES = 200
        private val recent = LinkedHashMap<String, Boolean>()

        @Synchronized
        fun note(event: com.lunabot.companion.core.PhoneNoticeEvent): Boolean {
            val signature = "${event.key}　${event.title}　${event.text}　${event.messages.lastOrNull()?.text.orEmpty()}"
            if (recent.remove(signature) != null) {
                recent[signature] = true
                return false
            }
            recent[signature] = true
            if (recent.size > MAX_ENTRIES) recent.remove(recent.keys.first())
            return true
        }
    }

    private companion object {
        const val TAG = "NoticeRelay"
        const val CONNECT_TIMEOUT_MS = 10_000L
        const val SHADE_DEBOUNCE_MS = 750L
    }
}

/** The keys the shade event carries: ticked packages only, never this app, and the just-removed key out. */
internal fun shadeKeys(
    active: Array<out StatusBarNotification>,
    ticked: Set<String>,
    selfPackage: String,
    removedKey: String?,
): List<String> = active.asSequence()
    .filter { it.packageName in ticked && it.packageName != selfPackage && it.key != removedKey }
    .map { it.key.take(300) }
    .toList()
