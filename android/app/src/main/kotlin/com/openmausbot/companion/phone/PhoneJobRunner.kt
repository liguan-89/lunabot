package com.openmausbot.companion.phone

import android.content.Context
import android.os.Build
import android.util.Log
import com.openmausbot.companion.core.PhoneRegistration
import com.openmausbot.companion.core.PhoneTool
import com.openmausbot.companion.core.PhoneToolCatalog
import com.openmausbot.companion.core.Session
import com.openmausbot.companion.storage.ChatPreferences
import java.time.ZoneId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Runs the phone's half of "phone apps as bot tools" while the app is alive.
 *
 * Off unless the person turns calendar access on in Settings (and grants the
 * Android permission). While it is on: register this phone's capabilities, then
 * poll the paired computer for one job at a time, lease it, run it, answer it.
 * The poll is the server's own long poll; a `device.job` frame only tells an
 * app that is not polling yet to start, which this loop already does.
 *
 * Nothing here survives the process: the computer marks the phone offline when
 * polls stop, and a job it had queued fails with `offline` rather than running
 * twice.
 */
internal class PhoneJobRunner(
    private val context: Context,
    private val session: Session,
    private val preferences: ChatPreferences,
    private val appVersion: String,
    private val scope: CoroutineScope,
) {
    private val calendar = PhoneCalendar(context)
    private val contacts = PhoneContacts(context)
    private val location = PhoneLocation(context)
    private val messages = PhoneMessages(context)
    private val reminderStore = ReminderStore(java.io.File(context.filesDir, "phone-reminders.json"))
    private val reminderAlarms = ReminderAlarms(context)
    private val reminders = PhoneReminders(reminderStore, reminderAlarms)

    fun start() {
        scope.launch {
            // Every switch feeds one decision. Observing only the calendar's
            // meant turning contacts on with calendar off looked like "all
            // off", and the phone never registered at all.
            combine(
                preferences.phoneCalendar,
                preferences.phoneContacts,
                preferences.phoneReminders,
                preferences.phoneLocation,
                preferences.phoneMessages,
            ) { calendar, contacts, reminders, location, messages ->
                Switches(calendar, contacts, reminders, location, messages)
            }
                .distinctUntilChanged()
                .collectLatest { switches ->
                    if (!switches.any) {
                        session.unregisterPhone()
                        session.reportPhoneTools(Session.PhoneToolsStatus.Idle)
                        return@collectLatest
                    }
                    runWhileEnabled(switches)
                }
        }
    }

    private data class Switches(
        val calendar: Boolean = false,
        val contacts: Boolean = false,
        val reminders: Boolean = false,
        val location: Boolean = false,
        val messages: Boolean = false,
    ) {
        val any: Boolean get() = calendar || contacts || reminders || location || messages
    }

    private suspend fun runWhileEnabled(switches: Switches) {
        val calendarAccess = calendar.access()
        val contactsAccess = contacts.access()
        val locationAccess = location.access()
        // Enabled in Settings but the Android grants were revoked (or never
        // given): nothing to register, and the screen explains each switch.
        if (!calendarAccess.canRead && !contactsAccess.canRead && !switches.reminders &&
            !locationAccess.canRead && !switches.messages
        ) {
            session.reportPhoneTools(
                Session.PhoneToolsStatus.Failed("系统权限尚未授予，请在系统设置中允许日历、联系人或定位。"),
            )
            return
        }

        val registration = PhoneRegistration(
            installId = preferences.phoneInstallId(),
            name = Build.MODEL?.takeIf { it.isNotBlank() } ?: "Android 手机",
            platform = "android",
            appVersion = appVersion,
            timeZone = ZoneId.systemDefault().id,
            capabilities = PhoneToolCatalog.capabilities(
                calendar = calendarAccess,
                contacts = contactsAccess,
                reminders = switches.reminders,
                location = locationAccess,
                // The switch asked for both SMS grants; without them the phone can
                // neither relay inbound texts nor answer replies, so it claims nothing.
                messages = switches.messages && messages.canRelay(),
            ),
        )
        // Registration is retried instead of ending the run: the computer is
        // often asleep at the moment the switch is turned on.
        while (currentCoroutineContext().isActive) {
            val failure = session.registerPhone(registration)
            Log.d(TAG, "register capabilities=${registration.capabilities} result=${failure ?: "ok"}")
            if (failure == null) {
                session.reportPhoneTools(Session.PhoneToolsStatus.Registered)
                break
            }
            session.reportPhoneTools(Session.PhoneToolsStatus.Failed(failure))
            delay(REGISTRATION_RETRY_MILLIS)
        }

        var claimed = registration.capabilities
        while (currentCoroutineContext().isActive) {
            val calendarNow = calendar.access()
            val contactsNow = contacts.access()
            val locationNow = location.access()
            if (!calendarNow.canRead && !contactsNow.canRead && !switches.reminders &&
                !locationNow.canRead && !switches.messages
            ) {
                // Every permission was revoked under us; don't offer apps we
                // can no longer read.
                session.unregisterPhone()
                session.reportPhoneTools(Session.PhoneToolsStatus.Idle)
                return
            }
            // A system-sheet grant lands after the first registration: the
            // claimed set has to track the grants as they actually are, or the
            // computer keeps routing jobs the phone cannot answer (or never
            // learns it now can).
            val current = PhoneToolCatalog.capabilities(
                calendar = calendarNow,
                contacts = contactsNow,
                reminders = switches.reminders,
                location = locationNow,
                messages = switches.messages && messages.canRelay(),
            )
            if (current != claimed && session.registerPhone(registration.copy(capabilities = current)) == null) {
                claimed = current
            }
            val job = try {
                session.pollPhoneJob()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Throwable) {
                null
            }
            if (job != null) Log.d(TAG, "job=${job.id} tool=${job.tool}")
            if (job == null) {
                // A restarted computer drops its phone list; the failed poll is
                // the only sign, so verify once and re-claim rather than poll
                // a registry that no longer knows this phone.
                if (session.lastPhonePollError != null && session.myPhoneRegistered() == false) {
                    session.registerPhone(registration.copy(capabilities = claimed))
                }
                // A 20 s poll that found nothing is the normal case; one that
                // failed returns immediately, so a short pause keeps a broken
                // connection from becoming a hot loop.
                delay(if (session.status.value == Session.Status.Live) 200 else POLL_RETRY_MILLIS)
                continue
            }
            if (!session.leasePhoneJob(job.id)) continue

            val tool = PhoneTool.fromWire(job.tool)
            val outcome = when {
                tool == null -> PhoneToolOutcome.Failure(
                    "这台 Android 手机目前只接了日历、联系人、提醒、定位和消息；" +
                        "${PhoneToolCatalog.capabilityOf(job.tool) ?: "这个应用"} 还不支持。",
                    code = "unsupported",
                )
                tool.capability == "calendar" -> calendar.execute(tool, job.arguments)
                tool.capability == "contacts" -> contacts.execute(tool, job.arguments)
                tool.capability == "reminders" -> reminders.execute(tool, job.arguments)
                tool.capability == "location" -> location.current()
                tool.capability == "messages" -> messages.execute(tool, job.arguments)
                else -> PhoneToolOutcome.Failure("这个工具不属于已开启的应用。", "unsupported")
            }
            session.completePhoneJob(job.id, outcome.toJson())
        }
    }

    private companion object {
        const val TAG = "PhoneJobs"
        const val REGISTRATION_RETRY_MILLIS = 5_000L
        /** Only after a failure; a poll that timed out normally returns null too. */
        const val POLL_RETRY_MILLIS = 3_000L
    }
}

internal fun PhoneToolOutcome.toJson(): JsonObject = when (this) {
    is PhoneToolOutcome.Success -> buildJsonObject {
        put("ok", true)
        put("result", result)
    }
    is PhoneToolOutcome.Failure -> buildJsonObject {
        put("ok", false)
        put("error", error)
        code?.let { put("code", it) }
    }
}
