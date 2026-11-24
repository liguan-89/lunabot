package com.lunabot.companion.phone

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.telephony.SmsMessage
import android.util.Log
import com.lunabot.companion.OpenMausApp
import com.lunabot.companion.RECEIVER_CONNECT_BUDGET_MS
import com.lunabot.companion.core.PhoneSmsEvent
import com.lunabot.companion.core.Session
import com.lunabot.companion.storage.ChatPreferences
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** How long after its arrival a text may still reach the computer: past that, its answer would be out of time. */
internal const val SMS_DELIVER_WITHIN_MS = 2 * 60_000L

/**
 * The inbound half of SMS relay: a text arriving on this phone becomes a
 * `POST /api/phones/self/events` on the paired computer, which answers it
 * through the channels bot and hands back a PHONE_REPLY_SMS job.
 *
 * The receiver fires only while the RECEIVE_SMS grant holds. The messages
 * switch is checked again here rather than trusted from manifest-time: a
 * revoked switch leaves inbound texts on the phone untouched, exactly where a
 * messenger's own SMS handling would leave them.
 */
class SmsRelayReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        if (!ChatPreferences(context).phoneMessages.value) {
            Log.i(TAG, "sms arrived while messages switch off; ignored")
            return
        }
        val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        val app = context.applicationContext as? OpenMausApp ?: return
        val events = inboundSmsEvents(parts)
        if (events.isEmpty()) return
        val pending = goAsync()
        // The delivery is the app's, not the broadcast's: a computer that takes longer to reach than a receiver
        // may be held still gets its text, and the text is not lost with the process.
        val delivery = app.appScope.async(Dispatchers.IO) {
            val delivered = try {
                deliverInboundSms(
                    events = events,
                    deliverWithinMs = SMS_DELIVER_WITHIN_MS,
                    connect = app.session::connect,
                    live = { app.session.status.first { it is Session.Status.Live } },
                    post = app.session::postPhoneEvent,
                )
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                Log.w(TAG, "inbound sms not delivered: ${error::class.simpleName}")
                0
            }
            Log.i(TAG, "inbound sms delivered=$delivered of=${events.size}")
            delivered
        }
        app.appScope.launch { holdBroadcastWhile(delivery, pending::finish) }
    }

    private companion object {
        const val TAG = "SmsRelay"
    }
}

/** Holds a receiver's broadcast for [delivery] only as long as the system allows a receiver to be held. */
internal suspend fun holdBroadcastWhile(delivery: Deferred<*>, finish: () -> Unit) {
    withTimeoutOrNull(RECEIVER_CONNECT_BUDGET_MS) { delivery.await() }
    finish()
}

/**
 * Tells the computer about each text, once a session is live, and says how many it took.
 *
 * The whole delivery gives up after [deliverWithinMs]. A text is never handed over twice: whichever path reaches
 * a live session first — this one, or the text's notification through [com.lunabot.companion.phone.SmsNotificationRelay] — is the one that delivers it.
 */
internal suspend fun deliverInboundSms(
    events: Collection<PhoneSmsEvent>,
    deliverWithinMs: Long,
    connect: () -> Unit,
    live: suspend () -> Unit,
    post: suspend (PhoneSmsEvent) -> Boolean,
    note: (from: String, text: String) -> Boolean = SmsEventDedup::note,
): Int {
    var delivered = 0
    withTimeoutOrNull(deliverWithinMs) {
        for (event in events) {
            connect()
            live()
            if (!note(event.from, event.text)) continue
            // A request already on its way is finished: cut off halfway, neither side could say whether it arrived.
            if (withContext(NonCancellable) { post(event) }) delivered += 1
        }
    }
    return delivered
}

/**
 * PDUs → channel events: parts of one text share a sender and a service-centre
 * timestamp, so grouping on `(from, timestamp)` reassembles a multipart SMS and
 * `sendId` dedupes a re-broadcast of the same message on the server side.
 */
internal fun inboundSmsEvents(parts: Array<SmsMessage>): List<PhoneSmsEvent> =
    parts.groupBy { (it.originatingAddress ?: "") to it.timestampMillis }
        .mapNotNull { (key, group) ->
            val (from, at) = key
            if (from.isBlank()) return@mapNotNull null
            val text = group.joinToString("") { it.messageBody.orEmpty() }.trim()
            if (text.isEmpty()) return@mapNotNull null
            PhoneSmsEvent(sendId = "$from:$at".take(120), from = from.take(64), text = text.take(4000))
        }
