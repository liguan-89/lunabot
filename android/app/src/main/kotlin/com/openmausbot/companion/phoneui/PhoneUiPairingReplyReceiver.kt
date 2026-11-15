package com.openmausbot.companion.phoneui

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import com.openmausbot.companion.OpenMausApp

/**
 * Receives the six-digit code typed into [PhoneUiPairingNotification]'s shade
 * reply while the system pairing dialog stayed resumed. The action arrives only
 * through the notification's explicit, unexported PendingIntent.
 */
class PhoneUiPairingReplyReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_PAIR) return
        val results = RemoteInput.getResultsFromIntent(intent) ?: return
        val code = results.getCharSequence(KEY_CODE)?.toString()?.trim().orEmpty()
        if (code.length != CODE_LENGTH || !code.all(Char::isDigit)) return
        val app = context.applicationContext as? OpenMausApp ?: return
        app.phoneUi.pairFromNotification(code)
    }

    companion object {
        const val ACTION_PAIR = "com.openmausbot.companion.phoneui.PAIR_CODE"
        const val KEY_CODE = "code"
        private const val CODE_LENGTH = 6
    }
}