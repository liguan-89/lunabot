// Adapted from Mika's WechatApi and WechatRuntime (Apache-2.0).
package com.lunabot.companion.wechat

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import com.lunabot.companion.OpenMausApp
import com.lunabot.companion.R

/**
 * Hosts the WeChat long poll.
 *
 * A foreground service for one reason: Android only keeps a socket long poll
 * alive in the background for a process the system considers foreground, and
 * the whole point of this channel is that a WeChat message arriving while the
 * app is closed still reaches the computer. The persistent, silent notification
 * is the cost, and it is not hidden.
 *
 * `START_STICKY`: if the OS still kills the process, the service comes back
 * with a null Intent and re-asserts the same state. `sync()` is idempotent.
 *
 * The stop action turns listening **off** and keeps the token: a person who
 * pauses the channel does not have to scan again. Only "unbind" wipes the
 * binding, and that is a different row.
 */
class WechatService : Service() {

    /** Only for the start-up work that must not block the main thread. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val turnOff = intent?.action == ACTION_TURN_OFF
        val foreground = runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                startForeground(NOTIFICATION_ID, notification())
            }
        }.onFailure { Log.w(TAG, "wechat service could not enter the foreground: ${it::class.simpleName}") }.isSuccess

        if (!foreground) {
            stopSelf()
            return START_NOT_STICKY
        }

        // Everything below touches the store, which unwraps the token through
        // the Keystore: IPC plus disk I/O, never on the main thread. The
        // notification is already up, so a few milliseconds of setup are fine.
        scope.launch {
            val runtime = runCatching { WechatRuntimeHost.of(this@WechatService) }.getOrNull()
            if (turnOff) runtime?.setEnabled(false)
            if (runtime == null || !runtime.sync()) {
                runtime?.stop()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        runCatching { WechatRuntimeHost.of(this) }.getOrNull()?.stop()
        super.onDestroy()
    }

    private fun notification(): Notification {
        val turnOff = PendingIntent.getService(
            this,
            1,
            Intent(this, WechatService::class.java).setAction(ACTION_TURN_OFF),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_chat_bubbles)
            .setContentTitle(getString(R.string.wechat_notification_title))
            .setContentText(getString(R.string.wechat_notification_text))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .addAction(0, getString(R.string.wechat_notification_turn_off), turnOff)
            .build()
    }

    private fun ensureChannel() {
        val system = getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel_wechat),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.notification_channel_wechat_desc)
            setShowBadge(false)
        }
        system.createNotificationChannel(channel)
    }

    companion object {
        const val ACTION_TURN_OFF = "com.lunabot.companion.wechat.TURN_OFF"
        const val CHANNEL_ID = "wechat_relay"
        private const val NOTIFICATION_ID = 30_002
        private const val TAG = "WechatService"

        /** Idempotent: safe to call while the service is already running. */
        fun start(context: Context) {
            runCatching {
                ContextCompat.startForegroundService(context, Intent(context, WechatService::class.java))
            }.onFailure { Log.w(TAG, "wechat service could not start: ${it::class.simpleName}") }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, WechatService::class.java))
        }
    }
}
