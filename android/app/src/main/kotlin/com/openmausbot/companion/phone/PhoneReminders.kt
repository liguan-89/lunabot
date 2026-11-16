package com.openmausbot.companion.phone

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.openmausbot.companion.MainActivity
import com.openmausbot.companion.R
import com.openmausbot.companion.core.PhoneCalendarRules
import com.openmausbot.companion.core.PhoneReminderRules
import com.openmausbot.companion.core.PhoneTool
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

/**
 * Reminders for bots: this app's own list, alerted by this app's own alarm.
 *
 * Android has no reminders app, and writing a reminder as a calendar event
 * would put it on the person's real calendar and sync it everywhere. So the
 * list lives in [ReminderStore] and the alert is an AlarmManager notification.
 */
internal class PhoneReminders(
    private val store: ReminderStore,
    private val alarms: ReminderAlarms,
) {
    suspend fun execute(tool: PhoneTool, arguments: JsonObject): PhoneToolOutcome = when (tool) {
        PhoneTool.LIST_REMINDERS -> list(arguments)
        PhoneTool.CREATE_REMINDER -> create(arguments)
        PhoneTool.UPDATE_REMINDER -> update(arguments)
        PhoneTool.COMPLETE_REMINDER -> complete(arguments)
        PhoneTool.DELETE_REMINDER -> delete(arguments)
        else -> PhoneToolOutcome.Failure("这个工具不属于提醒。", "unsupported")
    }

    private suspend fun list(arguments: JsonObject): PhoneToolOutcome {
        val from = arguments.string("from")?.let {
            PhoneCalendarRules.parseInstant(it) ?: return invalidTime("from")
        }
        val to = arguments.string("to")?.let {
            PhoneCalendarRules.parseInstant(it) ?: return invalidTime("to")
        }
        val wantCompleted = arguments.bool("completed")
        val list = arguments.string("list")

        val reminders = store.all()
            .filter { list == null || it.list == list }
            .filter { PhoneReminderRules.matches(it.dueAt, from, to, it.completed, wantCompleted) }
            .sortedWith(compareBy(nullsLast()) { it.dueAt })
            .map(::reminderJson)

        return PhoneToolOutcome.Success(
            buildJsonObject { put("reminders", JsonArray(reminders)) },
        )
    }

    private suspend fun create(arguments: JsonObject): PhoneToolOutcome {
        val title = arguments.string("title")
            ?: return PhoneToolOutcome.Failure("缺少 title。", "unsupported")
        val due = arguments.string("due")?.let {
            PhoneCalendarRules.parseInstant(it) ?: return invalidTime("due")
        }
        val record = store.create(
            title = title,
            dueAt = due,
            notes = arguments.string("notes").orEmpty(),
            list = arguments.string("list").orEmpty(),
        )
        alarms.schedule(record)
        return PhoneToolOutcome.Success(buildJsonObject { put("reminder", reminderJson(record)) })
    }

    private suspend fun update(arguments: JsonObject): PhoneToolOutcome {
        val id = arguments.string("id")
            ?: return PhoneToolOutcome.Failure("缺少 id。", "unsupported")
        val due = when {
            !arguments.containsKey("due") -> null
            arguments.string("due") == null -> return invalidTime("due")
            else -> PhoneCalendarRules.parseInstant(arguments.string("due")) ?: return invalidTime("due")
        }
        val updated = store.update(
            id = id,
            title = arguments.string("title"),
            dueAt = due,
            notes = arguments.string("notes"),
        ) ?: return notFound()

        alarms.cancel(updated.id)
        alarms.schedule(updated)
        return PhoneToolOutcome.Success(buildJsonObject { put("reminder", reminderJson(updated)) })
    }

    private suspend fun complete(arguments: JsonObject): PhoneToolOutcome {
        val id = arguments.string("id")
            ?: return PhoneToolOutcome.Failure("缺少 id。", "unsupported")
        val completed = store.complete(id) ?: return notFound()
        alarms.cancel(id)
        // An alert that already fired is still on the shade; completing the
        // reminder should take it away, not leave a stale one behind.
        alarms.dismiss(id)
        return PhoneToolOutcome.Success(buildJsonObject { put("reminder", reminderJson(completed)) })
    }

    private suspend fun delete(arguments: JsonObject): PhoneToolOutcome {
        val id = arguments.string("id")
            ?: return PhoneToolOutcome.Failure("缺少 id。", "unsupported")
        if (!store.delete(id)) return notFound()
        alarms.cancel(id)
        alarms.dismiss(id)
        return PhoneToolOutcome.Success(buildJsonObject { put("deleted", true) })
    }

    private fun reminderJson(record: ReminderRecord): JsonObject = buildJsonObject {
        put("id", record.id)
        put("title", record.title)
        put("notes", record.notes)
        put("list", record.list)
        put("completed", record.completed)
        put(
            "due",
            record.dueAt?.let { JsonPrimitive(PhoneCalendarRules.formatInstant(it)) } ?: JsonNull,
        )
    }

    private fun invalidTime(field: String) = PhoneToolOutcome.Failure(
        "$field 需要一个带时区偏移的时间，例如 2026-10-24T12:00:00+08:00。",
        "unsupported",
    )

    private fun notFound() = PhoneToolOutcome.Failure("没有找到这条提醒。", "not_found")
}

/** Schedules and cancels the alert for a reminder's due time. */
internal class ReminderAlarms(private val context: Context) {
    fun schedule(record: ReminderRecord) {
        val due = record.dueAt
        if (record.completed || due == null || due <= System.currentTimeMillis()) {
            cancel(record.id)
            return
        }
        val manager = context.getSystemService(AlarmManager::class.java) ?: return
        // Inexact but wake-up-capable: an exact alarm needs a user-granted
        // permission on Android 12+, and a reminder is not a stopwatch.
        manager.setAndAllowWhileIdle(
            AlarmManager.RTC_WAKEUP,
            due,
            pendingIntent(record, PendingIntent.FLAG_UPDATE_CURRENT),
        )
    }

    fun cancel(id: String) {
        val manager = context.getSystemService(AlarmManager::class.java) ?: return
        val intent = Intent(context, ReminderReceiver::class.java).setAction(action(id))
        val pending = PendingIntent.getBroadcast(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        manager.cancel(pending)
        pending.cancel()
    }

    suspend fun rescheduleUpcoming(store: ReminderStore) {
        val now = System.currentTimeMillis()
        store.all()
            .filter { !it.completed && (it.dueAt ?: 0) > now }
            .forEach(::schedule)
    }

    /** Take back an alert that already reached the shade. */
    fun dismiss(id: String) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.cancel(id.hashCode())
    }

    private fun pendingIntent(record: ReminderRecord, flags: Int): PendingIntent {
        val intent = Intent(context, ReminderReceiver::class.java)
            .setAction(action(record.id))
            .putExtra(ReminderReceiver.EXTRA_ID, record.id)
            .putExtra(ReminderReceiver.EXTRA_TITLE, record.title)
            .putExtra(ReminderReceiver.EXTRA_TEXT, record.notes.ifBlank { record.list })
        return PendingIntent.getBroadcast(
            context,
            0,
            intent,
            flags or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun action(id: String) = "com.openmausbot.companion.REMINDER.$id"
}

/** Posts the reminder when its alarm fires. */
class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra(EXTRA_ID) ?: return
        val title = intent.getStringExtra(EXTRA_TITLE).orEmpty().ifBlank { "提醒" }
        val text = intent.getStringExtra(EXTRA_TEXT).orEmpty()

        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "手机提醒",
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply { description = "智能体在这台手机上创建的提醒" },
            )
        }
        val open = PendingIntent.getActivity(
            context,
            id.hashCode(),
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_dexbot_mark)
            .setContentTitle(title)
            .apply { if (text.isNotBlank()) setContentText(text) }
            .setAutoCancel(true)
            .setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        runCatching { manager.notify(id.hashCode(), notification) }
    }

    companion object {
        const val CHANNEL_ID = "phone_reminders"
        const val EXTRA_ID = "reminder_id"
        const val EXTRA_TITLE = "reminder_title"
        const val EXTRA_TEXT = "reminder_text"
    }
}

/** A reboot clears AlarmManager; put the upcoming reminders back. */
class ReminderBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val store = ReminderStore(java.io.File(context.filesDir, "phone-reminders.json"))
                ReminderAlarms(context).rescheduleUpcoming(store)
            } finally {
                pending.finish()
            }
        }
    }
}

private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf(String::isNotEmpty)

private fun JsonObject.bool(key: String): Boolean? =
    (this[key] as? JsonPrimitive)?.booleanOrNull
