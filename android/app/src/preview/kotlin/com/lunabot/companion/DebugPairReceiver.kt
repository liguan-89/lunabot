package com.lunabot.companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo

/**
 * Preview-build only: pairs the phone-UI ADB identity from a shell broadcast.
 *
 * The system wireless-debugging pairing listener lives only while its dialog's
 * activity is resumed — it closes the pairing port as soon as Settings pauses —
 * so the in-app pairing sheet cannot stay foreground while the code dialog
 * does. Device tests drive the same [PhoneUiController] entry point from here
 * instead of the sheet. Declared only in the preview source set, refuses
 * non-debuggable builds, and is protected by android.permission.DUMP, which
 * only shell and the system hold.
 */
class DebugPairReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        if (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0) return
        val app = context.applicationContext as? OpenMausApp ?: return
        val port = intent.getStringExtra(EXTRA_PORT) ?: return
        val code = intent.getStringExtra(EXTRA_CODE) ?: return
        app.phoneUi.pair(port, code)
    }

    companion object {
        const val ACTION = "com.lunabot.companion.DEBUG_PAIR"
        const val EXTRA_PORT = "port"
        const val EXTRA_CODE = "code"
    }
}