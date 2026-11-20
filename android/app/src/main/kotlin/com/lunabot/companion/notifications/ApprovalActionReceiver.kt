package com.lunabot.companion.notifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import com.lunabot.companion.OpenMausApp
import com.lunabot.companion.core.Session
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The shade's 允许 / 拒绝 buttons.
 *
 * A broadcast is the only thing a notification action can run without opening
 * the app, so this is the one place a decision is made outside the UI. The
 * session it needs is the same process-wide one the always-on service uses —
 * if the process was dead, starting it here restores the pairing before the
 * answer is sent.
 *
 * The card itself is not in the frame (notifications carry identity, not
 * payload), so the newest pending card is fetched from the thread first. That
 * is also what makes a skill proposal and a structured question safe to
 * refuse: [Session.decideApprovalFromNotification] declines to answer them
 * without the full card on screen.
 */
class ApprovalActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val allow = when (intent.action) {
            NotificationIntents.ACTION_APPROVE -> true
            NotificationIntents.ACTION_DENY -> false
            else -> return
        }
        val threadId = intent.getStringExtra(LocalNotificationPoster.EXTRA_THREAD_ID) ?: return
        val app = context.applicationContext as? OpenMausApp ?: return
        val pending = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                app.session.connect()
                // A cold start has to finish pairing and open the stream; past
                // this the tap is old news and the notification still opens.
                val live = withTimeoutOrNull(CONNECT_TIMEOUT_MS) {
                    app.session.status.first { it is Session.Status.Live }
                }
                val decided = live != null &&
                    app.session.decideApprovalFromNotification(threadId, allow)
                if (!decided) {
                    handBackToApp(context, app)
                }
            } finally {
                pending.finish()
            }
        }
    }

    /**
     * The answer could not be sent from the shade — the card needs its full
     * body on screen. The old system toast was gone in two seconds and looked
     * like nothing this app made; hand the person a notice that belongs to the
     * app and waits for them instead of racing their eyes.
     */
    private fun handBackToApp(context: Context, app: OpenMausApp) {
        // The process-lifecycle owner and Session's flows are main-confined, so
        // the foreground check happens on the main looper even though the
        // broadcast work ran on IO.
        Handler(context.mainLooper).post {
            try {
                val foreground = ProcessLifecycleOwner.get().lifecycle
                    .currentState.isAtLeast(Lifecycle.State.STARTED)
                if (foreground) {
                    // The app is on screen: surface its own glass notice over
                    // whatever screen is up.
                    app.session.actionError = NEEDS_APP_MESSAGE
                } else {
                    // Nobody is watching: a tappable notification survives the
                    // two seconds a toast gets, so the follow-up waits in the
                    // shade until it is opened.
                    app.notifications.postActionNeeded(
                        title = NEEDS_APP_TITLE,
                        text = NEEDS_APP_MESSAGE,
                    )
                }
            } catch (_: Exception) {
                // Best-effort: the process may have been restarted into a state
                // where the session or the poster is not wired yet. A dropped
                // follow-up is safer than crashing the receiver.
            }
        }
    }

    private companion object {
        const val CONNECT_TIMEOUT_MS = 10_000L
        const val NEEDS_APP_TITLE = "需要打开 App"
        const val NEEDS_APP_MESSAGE = "这条审批需要在 App 中查看。"
    }
}
