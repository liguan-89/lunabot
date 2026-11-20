package com.lunabot.companion.phoneui

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import com.lunabot.companion.R

/**
 * The MIUI-safe pairing form.
 *
 * The system wireless-debugging pairing listener lives only while the pairing
 * dialog's activity is resumed: on MIUI, switching back to this app closes the
 * pairing port, so the in-app port/code sheet cannot finish there. The
 * notification shade is a system overlay and does not stop Settings, so a
 * RemoteInput action can carry the six-digit code while the dialog stays up.
 * The port is discovered over NSD by the controller — the person only types
 * the code.
 */
class PhoneUiPairingNotification(context: Context) {
    private val app = context.applicationContext

    /** True while this installer's shade form is on screen; guards the success update. */
    @Volatile private var posted = false

    fun show() {
        if (!canPost()) return
        ensureChannel()
        val reply = RemoteInput.Builder(PhoneUiPairingReplyReceiver.KEY_CODE)
            .setLabel("6 位配对码")
            .build()
        val intent = Intent(app, PhoneUiPairingReplyReceiver::class.java)
            .setAction(PhoneUiPairingReplyReceiver.ACTION_PAIR)
        // RemoteInput results are filled in by the system, so this PendingIntent
        // must stay mutable; it targets an unexported receiver by name.
        val pending = PendingIntent.getBroadcast(
            app,
            REQUEST_CODE,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
        val action = NotificationCompat.Action.Builder(
            R.drawable.ic_lunabot_mark,
            "输入配对码",
            pending,
        )
            .addRemoteInput(reply)
            .setAllowGeneratedReplies(true)
            .build()
        val collapsed = "保持系统配对窗口打开，下拉通知栏输入 6 位配对码。"
        // The expanded text is deliberately longer than the collapsed body:
        // a notification whose big text fits the collapsed layout is not
        // expandable, and MIUI only reveals the RemoteInput action in the
        // expanded state.
        val expanded = "保持系统「使用配对码配对设备」窗口打开。下拉通知栏并展开这条通知，" +
            "点「输入配对码」，填入系统窗口显示的 6 位数字即可。配对端口由本机自动发现，" +
            "不需要手动填写；配对成功后这条通知会自动消失。"
        val notification = NotificationCompat.Builder(app, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_lunabot_mark)
            .setContentTitle("配对无线调试")
            .setContentText(collapsed)
            .setStyle(NotificationCompat.BigTextStyle().bigText(expanded))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .addAction(action)
            .build()
        posted = runCatching {
            NotificationManagerCompat.from(app).notify(NOTIFICATION_ID, notification)
        }.isSuccess
    }

    /**
     * Replace the reply form with a plain success note that expires on its own.
     * Replacing the notification ends SystemUI's direct-reply session (MIUI
     * ignores a cancel while that session still holds the card), and the
     * timeout is the fallback for shells that ignore explicit cancels too.
     */
    fun showSucceeded() {
        // The process may have been restarted between posting and replying,
        // so fall back to the live notification list.
        if (!posted && !isActive()) return
        val text = "手机界面已连接，可以关闭系统配对窗口了。"
        val notification = NotificationCompat.Builder(app, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_lunabot_mark)
            .setContentTitle("配对成功")
            .setContentText(text)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setTimeoutAfter(SUCCESS_TIMEOUT_MS)
            .build()
        runCatching { NotificationManagerCompat.from(app).notify(NOTIFICATION_ID, notification) }
        posted = false
    }

    fun cancel() {
        posted = false
        runCatching { NotificationManagerCompat.from(app).cancel(NOTIFICATION_ID) }
    }

    private fun canPost(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(
                app,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED

    private fun isActive(): Boolean = runCatching {
        NotificationManagerCompat.from(app).activeNotifications.any { it.id == NOTIFICATION_ID }
    }.getOrDefault(false)

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = app.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "手机界面配对", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "输入无线调试配对码"
            },
        )
    }

    private companion object {
        const val CHANNEL_ID = "phoneui_pairing"
        const val NOTIFICATION_ID = 0x9A11
        const val REQUEST_CODE = 0x9A12
        const val SUCCESS_TIMEOUT_MS = 5_000L
    }
}