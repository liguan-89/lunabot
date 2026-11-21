package com.lunabot.companion.phone

import android.content.Context
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.lunabot.companion.core.PhoneRegistration
import com.lunabot.companion.core.PhoneJob
import com.lunabot.companion.core.PhoneTool
import com.lunabot.companion.core.PhoneToolCatalog
import com.lunabot.companion.core.Session
import com.lunabot.companion.phoneui.PhoneUiAccessibilityService
import com.lunabot.companion.phoneui.PhoneUiTaskExecutor
import com.lunabot.companion.phoneui.PhoneUiController
import com.lunabot.companion.phoneui.PhoneUiStatus
import com.lunabot.companion.phoneui.UnlockOutcome
import com.lunabot.companion.phoneui.OperatingPace
import com.lunabot.companion.storage.ChatPreferences
import com.lunabot.companion.storage.PhonePace
import com.lunabot.companion.wechat.WechatConnectionState
import com.lunabot.companion.wechat.WechatRuntimeHost
import com.lunabot.companion.wechat.answerWechatReply
import java.time.ZoneId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
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

    /**
     * The WeChat channel's own state. Read through [WechatRuntimeHost] so the
     * runner and the settings card observe one instance.
     *
     * `by lazy` on purpose: building the runtime reads preferences and asks the
     * Keystore to unwrap the token, which is IPC and disk I/O — and this class
     * is constructed on the main thread in `OpenMausApp.onCreate`. The flow is
     * first read from [start]'s coroutine, so only a phone that has bound
     * WeChat ever reaches the Keystore.
     */
    private val wechatState: StateFlow<WechatConnectionState> by lazy {
        runCatching { WechatRuntimeHost.of(context).state }
            .getOrElse { MutableStateFlow<WechatConnectionState>(WechatConnectionState.Off) }
    }

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

    /** The share-declared whitelist; empty while sharing is off so the server learns nothing. */
    private fun noticeAppsToShare(): List<String> =
        if (preferences.phoneNoticeShare.value) preferences.phoneNoticeApps.value.sorted() else emptyList()

    fun start() {
        scope.launch {
            // The WeChat relay, if the person left it on. Its service is
            // START_STICKY, so this only matters for a process that was never
            // running (an update, or the app reopened after a force-stop).
            // Idempotent, and a no-op with no binding. Inside the coroutine
            // because building the runtime reads preferences.
            runCatching { WechatRuntimeHost.startIfEnabled(context) }
            combine(
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
                },
                wechatState,
            ) { switches, wechat ->
                // A bound, listening WeChat channel claims `messages` on its own:
                // it needs no SMS grant, and without the claim the computer would
                // never route PHONE_REPLY_WECHAT to this phone.
                switches.copy(
                    wechat = wechat is WechatConnectionState.Connected ||
                        wechat is WechatConnectionState.Connecting,
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
        /**
         * A bound WeChat channel that is listening. It is its own transport for
         * `PHONE_REPLY_WECHAT` and needs no SMS grant, but it rides the same
         * `messages` capability — so it counts as a reason to stay registered
         * and poll, even when every other switch is off.
         */
        val wechat: Boolean = false,
    ) {
        /** Files and notifications share one capability: read-only, no helper needed. */
        val phoneData: Boolean get() = files || notices

        val any: Boolean
            get() = calendar || contacts || reminders || location || messages || phoneUi || phoneData || wechat
    }

    private suspend fun runWhileEnabled(switches: Switches) {
        val calendarAccess = calendar.access()
        val contactsAccess = contacts.access()
        val locationAccess = location.access()
        // Enabled in Settings but the Android grants were revoked (or never
        // given): nothing to register, and the screen explains each switch.
        if (!calendarAccess.canRead && !contactsAccess.canRead && !switches.reminders &&
            !locationAccess.canRead && !switches.messages && !switches.phoneUi && !switches.phoneData &&
            !switches.wechat
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
                // Two transports claim `messages`: the SMS relay (which needs
                // both SMS grants) and a bound, listening WeChat channel (which
                // needs no grant at all — its credential is the scan).
                messages = (switches.messages && messages.canRelay()) || switches.wechat,
                phoneUi = switches.phoneUi,
                phoneData = switches.files || switches.notices,
            ),
            noticeApps = noticeAppsToShare(),
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
        var claimedApps = registration.noticeApps
        while (currentCoroutineContext().isActive) {
            val calendarNow = calendar.access()
            val contactsNow = contacts.access()
            val locationNow = location.access()
            // File and notification grants can also be revoked outside the app.
            val filesNow = switches.files && filesReadable()
            val noticesNow = switches.notices && noticesReadable()
            if (!calendarNow.canRead && !contactsNow.canRead && !switches.reminders &&
                !locationNow.canRead && !switches.messages && !switches.phoneUi && !filesNow && !noticesNow &&
                !switches.wechat
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
                messages = (switches.messages && messages.canRelay()) || switches.wechat,
                phoneUi = switches.phoneUi,
                phoneData = filesNow || noticesNow,
            )
            val appsNow = noticeAppsToShare()
            if ((current != claimed || appsNow != claimedApps) &&
                session.registerPhone(registration.copy(capabilities = current, noticeApps = appsNow)) == null
            ) {
                claimed = current
                claimedApps = appsNow
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
                    session.registerPhone(registration.copy(capabilities = claimed, noticeApps = claimedApps))
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
            //
            // The WeChat reply answers a *different* frozen shape — exactly
            // `{ "ok": true }` or `{ "ok": false, "error": "<short code>" }` —
            // so it builds its own JSON instead of going through toJson().
            val run = scope.async {
                if (tool == PhoneTool.REPLY_WECHAT) {
                    return@async wechatReplyJson(job)
                }
                when {
                    tool == null -> PhoneToolOutcome.Failure(
                        "这台 Android 手机目前只接了日历、联系人、提醒、定位、消息、受控屏、文件和通知；" +
                            "${PhoneToolCatalog.capabilityOf(job.tool) ?: "这个应用"} 还不支持。",
                        code = "unsupported",
                    )
                    else -> dispatch(tool, job)
                }.toJson()
            }
            val outcome = try {
                withTimeoutOrNull(JOB_RUN_TIMEOUT_MILLIS) { run.await() }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                Log.w(TAG, "job=${job.id} executor threw", error)
                null
            } ?: PhoneToolOutcome.Failure("手机端执行超时，请稍后再试。", "timeout").toJson()
            val posted = session.completePhoneJob(job.id, outcome)
            Log.d(TAG, "job=${job.id} outcome posted=$posted")
        }
    }

    /**
     * The job's own executor by [JobTarget]. Reads that need no screen stand
     * on their own grants, so they do not borrow the display session the UI
     * slice keeps.
     */
    private suspend fun dispatch(tool: PhoneTool, job: PhoneJob): PhoneToolOutcome =
        when (JobTarget.of(tool)) {
            JobTarget.CALENDAR -> calendar.execute(tool, job.arguments)
            JobTarget.CONTACTS -> contacts.execute(tool, job.arguments)
            JobTarget.REMINDERS -> reminders.execute(tool, job.arguments)
            JobTarget.LOCATION -> location.current()
            JobTarget.MESSAGES -> messages.execute(tool, job.arguments)
            JobTarget.UI -> {
                // A locked phone cannot show anything to the person and
                // some ROMs refuse to start an app at all, so a screen
                // job unlocks first when the person allowed it. A
                // refusal is not fatal: the executor still runs and
                // reports whatever the screen gives it.
                val unlocked = phoneUi.unlocker.unlock()
                if (unlocked != UnlockOutcome.Unlocked && unlocked != UnlockOutcome.AlreadyUnlocked) {
                    Log.d(TAG, "job=${job.id} unlock skipped: ${unlocked.name}")
                }
                phoneUiExecutor.execute(tool, job.arguments)
            }
            JobTarget.DATA -> phoneUiExecutor.execute(tool, job.arguments)
            null -> PhoneToolOutcome.Failure("这个工具不属于已开启的应用。", "unsupported")
        }

    /**
     * `PHONE_REPLY_WECHAT` — `{ to, text }` over iLink.
     *
     * The answer is the frozen pair, `{ "ok": true }` or
     * `{ "ok": false, "error": "<short code>" }`, built by the same helper the
     * tests pin. An absent runtime or an absent binding is `not_bound`; the job
     * id doubles as the iLink client id, so a retried job cannot double-send.
     */
    private suspend fun wechatReplyJson(job: PhoneJob): JsonObject =
        answerWechatReply(
            runtime = runCatching { WechatRuntimeHost.of(context) }.getOrNull(),
            jobId = job.id,
            arguments = job.arguments,
        )

    private companion object {
        const val TAG = "PhoneJobs"
        const val REGISTRATION_RETRY_MILLIS = 5_000L
        /** Only after a failure; a poll that timed out normally returns null too. */
        const val POLL_RETRY_MILLIS = 3_000L
        // Below the server's phone-job timeout so the result still posts in time.
        const val JOB_RUN_TIMEOUT_MILLIS = 40_000L
    }
}

/**
 * Which of this phone's executors answers a job, by the tool's registered
 * capability. A catalogued capability with no entry here is the runner's
 * unsupported answer, so the dispatch table and the registration claim can
 * never drift apart without a test noticing.
 */
internal enum class JobTarget(val capability: String) {
    CALENDAR("calendar"),
    CONTACTS("contacts"),
    REMINDERS("reminders"),
    LOCATION("location"),
    MESSAGES("messages"),
    UI("phoneUi"),
    DATA("phoneData"),
    ;

    internal companion object {
        fun of(tool: PhoneTool): JobTarget? = entries.firstOrNull { it.capability == tool.capability }
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
