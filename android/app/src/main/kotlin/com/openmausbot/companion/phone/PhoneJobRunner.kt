package com.openmausbot.companion.phone

import android.content.Context
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.openmausbot.companion.core.PhoneRegistration
import com.openmausbot.companion.core.PhoneTool
import com.openmausbot.companion.core.PhoneToolCatalog
import com.openmausbot.companion.core.Session
import com.openmausbot.companion.phoneui.PhoneUiAccessibilityService
import com.openmausbot.companion.phoneui.PhoneUiTaskExecutor
import com.openmausbot.companion.phoneui.PhoneUiController
import com.openmausbot.companion.phoneui.PhoneUiStatus
import com.openmausbot.companion.phoneui.OperatingPace
import com.openmausbot.companion.storage.ChatPreferences
import com.openmausbot.companion.storage.PhonePace
import java.time.ZoneId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.isActive
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
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
    private val phoneUi: PhoneUiController,
    private val scope: CoroutineScope,
) {
    private val calendar = PhoneCalendar(context)
    private val contacts = PhoneContacts(context)
    private val location = PhoneLocation(context)
    private val messages = PhoneMessages(context)
    private val reminderStore = ReminderStore(java.io.File(context.filesDir, "phone-reminders.json"))
    private val reminderAlarms = ReminderAlarms(context)
    private val reminders = PhoneReminders(reminderStore, reminderAlarms)
    private val phoneUiExecutor = PhoneUiTaskExecutor(context)
    private val fileStore = PhoneFileStore(context)

    init {
        // The executor starts on FAST; the person's stored choice has to reach
        // it before the first job. The preference is observed separately from
        // the switch combine below: changing the pace must not tear down and
        // re-register the running loop.
        phoneUiExecutor.setPace(preferences.phonePace.value.operatingPace())
        scope.launch {
            preferences.phonePace.collect { phoneUiExecutor.setPace(it.operatingPace()) }
        }
    }

    /** File and notification reads need no helper; each has its own system grant. */
    private fun filesReadable(): Boolean = fileStore.photosGranted() || fileStore.treeUri() != null

    private fun noticesReadable(): Boolean = runCatching {
        NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.packageName)
    }.getOrDefault(false)

    fun start() {
        scope.launch {
            combine(
                combine(
                    preferences.phoneCalendar,
                    preferences.phoneContacts,
                    preferences.phoneReminders,
                    preferences.phoneLocation,
                    preferences.phoneMessages,
                ) { calendar, contacts, reminders, location, messages ->
                    Switches(calendar, contacts, reminders, location, messages)
                },
                preferences.phoneFiles,
                preferences.phoneNotices,
                phoneUi.status,
                PhoneUiAccessibilityService.instance,
            ) { switches, files, notices, phoneUiStatus, accessibilityService ->
                switches.copy(
                    phoneUi = phoneUiStatus == PhoneUiStatus.Ready && accessibilityService != null,
                    files = files && filesReadable(),
                    notices = notices && noticesReadable(),
                )
            }
                .distinctUntilChanged()
                .collectLatest { switches ->
                    if (!switches.phoneUi) phoneUiExecutor.release()
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
        val phoneUi: Boolean = false,
        val files: Boolean = false,
        val notices: Boolean = false,
    ) {
        /** Files and notifications share one capability: read-only, no helper needed. */
        val phoneData: Boolean get() = files || notices

        val any: Boolean get() = calendar || contacts || reminders || location || messages || phoneUi || phoneData
    }

    private suspend fun runWhileEnabled(switches: Switches) {
        val calendarAccess = calendar.access()
        val contactsAccess = contacts.access()
        val locationAccess = location.access()
        // Enabled in Settings but the Android grants were revoked (or never
        // given): nothing to register, and the screen explains each switch.
        if (!calendarAccess.canRead && !contactsAccess.canRead && !switches.reminders &&
            !locationAccess.canRead && !switches.messages && !switches.phoneUi && !switches.phoneData
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
                phoneUi = switches.phoneUi,
                phoneData = switches.files || switches.notices,
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
            // File and notification grants can also be revoked outside the app.
            val filesNow = switches.files && filesReadable()
            val noticesNow = switches.notices && noticesReadable()
            if (!calendarNow.canRead && !contactsNow.canRead && !switches.reminders &&
                !locationNow.canRead && !switches.messages && !switches.phoneUi && !filesNow && !noticesNow
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
                phoneUi = switches.phoneUi,
                phoneData = filesNow || noticesNow,
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
                // A restarted computer may restore a row persisted by an older
                // build, so a successful poll does not prove the stored
                // capabilities match this one. Any poll failure re-claims, and
                // registration is idempotent; checking only for a missing row
                // would leave a stale capability set in place forever.
                if (session.lastPhonePollError != null) {
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
            // A stuck executor would stall this serial poll until the server marks
            // the phone offline. Blocking calls ignore cancellation, so the run
            // sits on the runner scope and the bound only stops awaiting it.
            val run = scope.async {
                when {
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
                    tool.capability == "phoneUi" -> phoneUiExecutor.execute(tool, job.arguments)
                    else -> PhoneToolOutcome.Failure("这个工具不属于已开启的应用。", "unsupported")
                }
            }
            val outcome = try {
                withTimeoutOrNull(JOB_RUN_TIMEOUT_MILLIS) { run.await() }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                Log.w(TAG, "job=${job.id} executor threw", error)
                null
            } ?: PhoneToolOutcome.Failure("手机端执行超时，请稍后再试。", "timeout")
            val posted = session.completePhoneJob(job.id, outcome.toJson())
            Log.d(TAG, "job=${job.id} outcome posted=$posted")
        }
    }

    private companion object {
        const val TAG = "PhoneJobs"
        const val REGISTRATION_RETRY_MILLIS = 5_000L
        /** Only after a failure; a poll that timed out normally returns null too. */
        const val POLL_RETRY_MILLIS = 3_000L
        // Below the server's phone-job timeout so the result still posts in time.
        const val JOB_RUN_TIMEOUT_MILLIS = 40_000L
    }
}

/** The executor's own name for the same three levels. */
private fun PhonePace.operatingPace(): OperatingPace = when (this) {
    PhonePace.FAST -> OperatingPace.FAST
    PhonePace.STANDARD -> OperatingPace.STANDARD
    PhonePace.HUMAN -> OperatingPace.HUMAN
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
