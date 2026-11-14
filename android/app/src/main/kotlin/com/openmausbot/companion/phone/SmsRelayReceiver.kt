package com.openmausbot.companion.phone

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.telephony.SmsMessage
import com.openmausbot.companion.OpenMausApp
import com.openmausbot.companion.core.PhoneSmsEvent
import com.openmausbot.companion.core.Session
import com.openmausbot.companion.storage.ChatPreferences
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

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
        if (!ChatPreferences(context).phoneMessages.value) return
        val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        val app = context.applicationContext as? OpenMausApp ?: return
        val pending = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                for (event in inboundSmsEvents(parts)) {
                    app.session.connect()
                    val live = withTimeoutOrNull(CONNECT_TIMEOUT_MS) {
                        app.session.status.first { it is Session.Status.Live }
                    } ?: break
                    app.session.postPhoneEvent(event)
                }
            } finally {
                pending.finish()
            }
        }
    }

    private companion object {
        const val CONNECT_TIMEOUT_MS = 10_000L
    }
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
