package com.openmausbot.companion.phoneui

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import com.dexbot.companion.core.phoneui.adb.AdbConnectionException
import com.openmausbot.companion.permissions.CompanionPermissions
import com.openmausbot.companion.phoneui.shell.PhoneUiShellBridge
import com.openmausbot.companion.storage.ChatPreferences
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * Where the phone-UI shell is in its user-visible lifecycle. The order is the
 * order a person walks through it: enable the capability, open developer
 * options, enable wireless debugging, pair once with the system pairing code,
 * then the helper attaches over the ADB exec stream.
 */
enum class PhoneUiStatus {
    /** The person turned the capability off; the phoneUi capability must stay unregistered. */
    Disabled,

    /** Per-display accessibility windows require Android 11 or later. */
    UnsupportedAndroidVersion,

    /** Developer options are off, so the wireless debugging page cannot be reached. */
    NeedsDeveloperOptions,

    /** Developer options are on but wireless debugging itself is off. */
    NeedsWirelessDebugging,

    /** Wireless debugging is on, but Android has not granted local service discovery permission. */
    NeedsLocalNetworkPermission,

    /** Wireless debugging is on but this app has no usable paired identity. */
    NotPaired,

    /** A pairing exchange against the system dialog's port and six-digit code is in flight. */
    Pairing,

    /** Paired, but adbd's TLS connect port is not known yet. */
    Paired,

    /** The helper process is being launched over the wireless-debugging exec stream. */
    HelperConnecting,

    /** Paired helper is running, but screen-tree access is not enabled in system settings. */
    NeedsAccessibility,

    /** The helper's binder is attached and Android screen-tree access is enabled. */
    Ready,

    /** The last operation failed. Re-checking the system pages or re-pairing may fix it. */
    Failed,
}

/**
 * Process-level glue for controlling this phone's UI from the paired computer:
 * the ADB pairing identity, mDNS discovery of adbd's TLS ports, and the shell
 * helper's launch. One instance is built by [com.openmausbot.companion.OpenMausApp]
 * and shared with Settings through `CompanionEnvironment`.
 *
 * Security shape: developer options are still never turned on here, and
 * pairing happens only when the person enters the port and code the system
 * pairing dialog shows. Wireless debugging is the one developer switch this
 * class may turn back on, and only for a phone whose person turned the
 * phoneUi capability on, only while the helper is absent, and only through
 * [PhoneUiRepairLoop]: the helper is the sole reason the switch is needed, and
 * a network Android does not allow still stops the loop at the system's own
 * per-network dialog. The switch is also the one place the app may hold a
 * system-write permission, and only when the person turns the separate repair
 * switch on: the helper then grants `WRITE_SECURE_SETTINGS` once, because an
 * ordinary app cannot write a global setting and the helper is exactly what
 * the switch is needed to start. Both ADB endpoints are
 * always the loopback literal — mDNS services for this device resolve on local
 * interfaces only, and [PhoneUiPairingInput] never accepts a host from input.
 * A successful pairing persists only a flag; the port, the pairing code and the
 * key material are never logged.
 */
class PhoneUiController(
    context: Context,
    private val scope: CoroutineScope,
    private val preferences: ChatPreferences,
    private val permissions: CompanionPermissions,
) {
    private val app = context.applicationContext
    private val adb = PhoneUiAdb(app)
    private val bridge = PhoneUiShellBridge.of(app)
    private val pairingNotification = PhoneUiPairingNotification(app)

    private val _status = MutableStateFlow(PhoneUiStatus.Disabled)

    /** Derive [PhoneUiStatus] from this flow. */
    val status: StateFlow<PhoneUiStatus> = _status.asStateFlow()

    private val _autoPairing = MutableStateFlow(false)

    /** True while [beginAutoPairing] is watching the system pairing dialog. */
    val autoPairing: StateFlow<Boolean> = _autoPairing.asStateFlow()

    /** Guards the one-shot exec stream that launches the helper; written on caller and IO threads. */
    @Volatile private var connecting: Boolean = false

    /** A pairing exchange is running; its outcome owns the status until it lands. */
    @Volatile private var pairing: Boolean = false

    /** One auto-read loop at a time; a second sheet opening replaces it. */
    private var autoPairingJob: Job? = null

    /**
     * The background repair loop, or null while the capability is off. Only
     * [reconcileRepair] starts it, so the person's switch is the one
     * authorization every effect in this class depends on.
     */
    private var repairJob: Job? = null

    /**
     * Our component exactly as the system lists it. The applicationId and the
     * namespace differ in this app, so the flattened name is built from the
     * package name the system sees, not from the source package.
     */
    private val accessibilityComponent = "${app.packageName}/${PhoneUiAccessibilityService::class.java.name}"

    /**
     * The two self-repairs, built once so their states survive a recompute.
     * The effects are this class's: the accessibility write goes through the
     * shell helper's allow-listed `putSecureSetting`, and the wireless switch
     * is written by the app itself once the person's repair switch has had the
     * helper grant it `WRITE_SECURE_SETTINGS`.
     */
    private val repair: PhoneUiRepairLoop by lazy {
        PhoneUiRepairLoop(
            component = accessibilityComponent,
            now = System::currentTimeMillis,
            switchOff = ::wirelessDebuggingOff,
            helperAttached = { bridge.shell.value != null },
            wirelessWrite = ::wirelessWriteNow,
            wirelessWriter = ::wirelessWriterAvailable,
            a11yEnabled = ::accessibilityEnabled,
            a11yConnected = { PhoneUiAccessibilityService.instance.value != null },
            a11ySetting = ::accessibilityServices,
            a11yWrite = { value ->
                bridge.shell.value?.putSecureSetting("enabled_accessibility_services", value) == true
            },
            sleep = { delay(it) },
        )
    }

    private val recomputeMutex = Mutex()

    init {
        bridge.setLaunchCallback { command, nonce -> launchHelper(command, nonce) }
        scope.launch {
            bridge.shell.collect { attached ->
                if (attached != null) {
                    _status.value = readyStatus()
                } else {
                    refresh()
                }
            }
        }
        scope.launch {
            preferences.phoneUi.collect {
                // The capability switch is the authorization for the repair
                // loop too: on starts it, off cancels it.
                reconcileRepair()
                refresh()
            }
        }
        permissions.refresh()
        scope.launch { recompute() }
    }

    /**
     * Re-derive the status from system state. Called when the capability switch
     * moves, when the helper attaches or dies, and when Settings reopens — the
     * system pages may have changed while the person was out of the app.
     *
     * A refresh is also the person's explicit retry for the wireless repair:
     * re-opening Settings after allowing this network in Android's dialog
     * clears a recorded stop, so the switch is tried once more. Only a stopped
     * episode is cleared; a repair in progress keeps its write count and gap.
     */
    fun refresh() {
        if (_status.value == PhoneUiStatus.NeedsWirelessDebugging && repair.wirelessStop != null) {
            repair.cleared(PhoneUiSelfRepair.Trigger.RetryRequested)
        }
        scope.launch { recompute() }
    }

    /**
     * Pair against the system wireless-debugging dialog's port and six-digit
     * code. The exchange runs against the loopback literal; the pairing flag is
     * persisted only after the SPAKE2 exchange succeeded, and nothing about the
     * inputs or the new identity is logged.
     */
    fun pair(portText: String, code: String) {
        val input = PhoneUiPairingInput.parse(portText, code) ?: return
        startPairing(input.code) { input.port }
    }

    private fun startPairing(code: String, port: suspend () -> Int?) {
        if (pairing) return
        pairing = true
        _status.value = PhoneUiStatus.Pairing
        scope.launch(Dispatchers.IO) {
            val resolved = port()
            val result: Result<Unit> = if (resolved == null) {
                Result.failure(IllegalStateException("Pairing service is not advertised."))
            } else {
                runCatching { adb.pair(PhoneUiPairingInput.HOST, resolved, code) }
            }
            pairing = false
            if (result.isSuccess) {
                // The pair marker exists only after the SPAKE2 exchange landed;
                // it never reflects key state alone.
                adb.markPaired(true)
                // A fresh pairing is a fresh authorization: forget() stopped
                // the repair loop because there was no shell to write through,
                // and the capability switch may not have moved since.
                reconcileRepair()
                recompute()
                dismissPairingNotification()
            } else {
                _status.value = PhoneUiStatus.Failed
            }
        }
    }

    /**
     * Post the shade reply that carries just the six-digit code. It exists
     * because the system pairing listener closes as soon as Settings pauses on
     * MIUI; while the notification shade is open, the dialog keeps running.
     */
    fun showPairingNotification() = pairingNotification.show()

    /**
     * Watch the system pairing dialog and pair without the person typing
     * anything, adapted from Mika's accessibility reader: Settings shows the
     * six digits and the pairing port, so this reads them from the dialog's own
     * window. Only the Settings package on the default display is read, only
     * while this window is open, and the code never leaves the pairing call.
     * The notification reply remains the fallback when accessibility is off.
     */
    fun beginAutoPairing() {
        if (!preferences.phoneUi.value) return
        if (PhoneUiAccessibilityService.instance.value == null) return
        autoPairingJob?.cancel()
        _autoPairing.value = true
        autoPairingJob = scope.launch(Dispatchers.IO) {
            try {
                val deadline = System.currentTimeMillis() + AUTO_PAIR_WINDOW_MS
                val tried = HashSet<String>()
                while (System.currentTimeMillis() < deadline) {
                    when (_status.value) {
                        PhoneUiStatus.Ready,
                        PhoneUiStatus.Paired,
                        PhoneUiStatus.HelperConnecting -> return@launch
                        else -> Unit
                    }
                    if (pairing) {
                        delay(AUTO_PAIR_POLL_MS)
                        continue
                    }
                    val reading = PhoneUiAccessibilityService.instance.value?.readPairingCode()
                    if (reading != null && tried.size < MAX_AUTO_PAIR_ATTEMPTS) {
                        // A failed attempt leaves the old code in the list so a
                        // reopen with a rotated code is tried, not the dead one.
                        if (tried.add("${reading.port}:${reading.code}")) {
                            startPairing(reading.code) { reading.port }
                        }
                    }
                    delay(AUTO_PAIR_POLL_MS)
                }
            } finally {
                _autoPairing.value = false
            }
        }
    }

    /**
     * Pair from the notification shade: the code arrived through a RemoteInput
     * while the system pairing dialog stayed resumed, and the pairing port is
     * discovered over NSD instead of typed. The lookup keeps retrying for a
     * short window because the dialog may be opened after the code is sent.
     */
    fun pairFromNotification(code: String) {
        if (code.length != CODE_LENGTH || !code.all(Char::isDigit)) return
        startPairing(code) { awaitPairingPort() }
    }

    /**
     * Cancel the shade form, then cancel again once the direct-reply session
     * that carried the code has fully ended. MIUI ignores the first cancel
     * while SystemUI still holds the reply, leaving a stale notification that
     * still offers to pair.
     */
    private fun dismissPairingNotification() {
        pairingNotification.showSucceeded()
        scope.launch {
            delay(NOTIFICATION_CANCEL_RETRY_MS)
            pairingNotification.cancel()
        }
    }

    private suspend fun awaitPairingPort(): Int? {
        val deadline = System.currentTimeMillis() + PAIRING_PORT_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            adb.findPairingPort(PAIRING_PORT_LOOKUP_MS)?.let { return it }
        }
        return null
    }

    /**
     * Drop the paired identity, void every helper nonce, and forget the flag.
     * A later pairing generates a fresh key; the old ciphertext is unreadable
     * once the AndroidKeyStore wrapper is deleted.
     */
    fun forget() {
        autoPairingJob?.cancel()
        _autoPairing.value = false
        // No helper identity means no shell to write through, so nothing is
        // left to repair; a fresh pairing starts a fresh loop.
        repairJob?.cancel()
        repairJob = null
        scope.launch(Dispatchers.IO) {
            // Clears the pair marker and the encrypted identity together.
            adb.forget()
            pairingNotification.cancel()
            bridge.detach()
            recompute()
        }
    }

    /**
     * Deliberate Off from Settings: detach the helper and void its nonces.
     * Recomputes that merely observe the switch off do not tear anything down —
     * a transient navigation must not kill a running helper.
     */
    fun disable() {
        autoPairingJob?.cancel()
        _autoPairing.value = false
        repairJob?.cancel()
        repairJob = null
        _status.value = PhoneUiStatus.Disabled
        scope.launch(Dispatchers.IO) { bridge.detach() }
    }

    /**
     * Start or stop the repair loop to match the capability switch. Called from
     * the preference collector and nowhere else, so the person's switch is the
     * only thing that can start it; a recompute must not, because tearing the
     * loop down on every status change would reset its backoff.
     */
    private fun reconcileRepair() {
        if (preferences.phoneUi.value) {
            if (repairJob?.isActive == true) return
            repairJob = scope.launch(Dispatchers.IO) {
                // The preference is checked again on every pass: a stop that
                // races the collector must not leave one write running.
                var switchWasOn = !wirelessDebuggingOff()
                while (isActive && preferences.phoneUi.value) {
                    val wait = repair.step()
                    // Only the off→on edge recomputes, so a switch the repair
                    // just turned on moves the status off
                    // NeedsWirelessDebugging without this loop writing status
                    // on every pass.
                    val switchOn = !wirelessDebuggingOff()
                    if (switchOn && !switchWasOn && _status.value == PhoneUiStatus.NeedsWirelessDebugging) {
                        refresh()
                    }
                    switchWasOn = switchOn
                    delay(wait.coerceAtLeast(REPAIR_POLL_MS))
                }
            }
        } else {
            repairJob?.cancel()
            repairJob = null
        }
    }

    private suspend fun recompute() = recomputeMutex.withLock {
        if (!preferences.phoneUi.value) {
            _status.value = PhoneUiStatus.Disabled
            return@withLock
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            _status.value = PhoneUiStatus.UnsupportedAndroidVersion
            return@withLock
        }
        if (developerOptionsOff()) {
            _status.value = PhoneUiStatus.NeedsDeveloperOptions
            return@withLock
        }
        if (wirelessDebuggingOff()) {
            _status.value = PhoneUiStatus.NeedsWirelessDebugging
            return@withLock
        }
        if (!localNetworkPermissionGranted()) {
            _status.value = PhoneUiStatus.NeedsLocalNetworkPermission
            return@withLock
        }
        if (pairing) {
            // The pairing exchange owns the status; do not race it.
            return@withLock
        }
        if (bridge.shell.value != null) {
            _status.value = readyStatus()
            return@withLock
        }
        withContext(Dispatchers.IO) {
            when {
                !adb.isPaired() || !adb.hasIdentity() ->
                    PhoneUiStatus.NotPaired
                connecting -> PhoneUiStatus.HelperConnecting
                else -> {
                    val port = adb.findConnectPort()
                    if (port == null) {
                        PhoneUiStatus.Paired
                    } else {
                        // Key material on this side is not enough: adbd must
                        // actually accept it. The probe is a full TLS+CNXN
                        // handshake, so UNAUTHORIZED here means the stored pair
                        // is dead and the person has to re-pair.
                        val authorized = runCatching { adb.connect(port).use { true } }
                        val failure = authorized.exceptionOrNull()
                        when {
                            authorized.isSuccess && bridge.ensureHelper() -> PhoneUiStatus.HelperConnecting
                            authorized.isSuccess -> PhoneUiStatus.Failed
                            failure is AdbConnectionException &&
                                failure.reason == AdbConnectionException.Reason.UNAUTHORIZED ->
                                PhoneUiStatus.NotPaired
                            else -> PhoneUiStatus.Paired
                        }
                    }
                }
            }.also { _status.value = it }
        }
    }

    /**
     * The launch callback the bridge hands the app_process command and one-time
     * nonce to. The exec stream runs on Dispatchers.IO and blocks until the
     * helper's binder arrives through the handoff provider or the wait times
     * out; failure lands in [PhoneUiStatus.Failed] unless the helper attached
     * in spite of it.
     */
    private fun launchHelper(command: String, nonce: String) {
        if (connecting) return
        connecting = true
        scope.launch(Dispatchers.IO) {
            val outcome = runCatching {
                val port = adb.findConnectPort()
                    ?: throw IllegalStateException("Wireless debugging connect port not found.")
                adb.exec(port, command, nonce, ::awaitHandoff)
            }
            connecting = false
            if (_status.value == PhoneUiStatus.Ready) return@launch
            _status.value = when {
                outcome.isSuccess && bridge.shell.value != null -> readyStatus()
                // Only a launch that was actually connecting may report failure;
                // a recompute that started a fresh attempt keeps its state.
                _status.value == PhoneUiStatus.HelperConnecting -> PhoneUiStatus.Failed
                else -> _status.value
            }
        }
    }

    /** Poll the bridge on this (already background) thread until the helper's binder is in hand. */
    private fun awaitHandoff(): Boolean {
        val deadline = System.currentTimeMillis() + HANDOFF_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            if (bridge.shell.value != null) return true
            Thread.sleep(HANDOFF_POLL_MS)
        }
        return bridge.shell.value != null
    }

    private fun readyStatus(): PhoneUiStatus =
        if (com.openmausbot.companion.phoneui.PhoneUiAccessibilityService.instance.value == null) {
            PhoneUiStatus.NeedsAccessibility
        } else {
            PhoneUiStatus.Ready
        }

    fun localNetworkPermissions(): Array<String> = permissions.discoveryPermissions()

    private fun localNetworkPermissionGranted(): Boolean = !permissions.refresh().discoveryNeedsRequest

    private fun developerOptionsOff(): Boolean =
        Settings.Global.getInt(app.contentResolver, "development_settings_enabled", 0) == 0

    private fun wirelessDebuggingOff(): Boolean =
        Settings.Global.getInt(app.contentResolver, "adb_wifi_enabled", 0) == 0

    /**
     * Whether the repair may write the wireless switch at all. Two writers are
     * possible, and the person's switch gates both: with the repair switch on,
     * either the app already holds `WRITE_SECURE_SETTINGS`, or a helper is
     * attached and can grant it. With the switch off this is false, so the
     * repair loop folds no event and reports nothing — no permission is asked
     * for, and no refusal is recorded.
     */
    private fun wirelessWriterAvailable(): Boolean =
        preferences.phoneRepairWireless.value &&
            (writeSecureSettingsGranted() || bridge.shell.value != null)

    /** Whether the app, not the helper, may write system settings itself. */
    private fun writeSecureSettingsGranted(): Boolean =
        app.checkSelfPermission(WRITE_SECURE_SETTINGS) == PackageManager.PERMISSION_GRANTED

    /**
     * Turn the wireless-debugging switch back on. The app writes it directly
     * once it holds `WRITE_SECURE_SETTINGS`; before that, and only while the
     * person's repair switch is on, the attached helper is asked for the grant
     * (it can only grant that one permission, to the caller's own package).
     * A false return is the honest answer for a ROM that refuses either step,
     * and [PhoneUiRepairLoop] folds it into [PhoneUiSelfRepair.Stop.Refused].
     */
    private fun wirelessWriteNow(): Boolean {
        if (!preferences.phoneRepairWireless.value) return false
        if (!writeSecureSettingsGranted()) {
            val shell = bridge.shell.value ?: return false
            if (!shell.grantOwnWriteSecureSettings(app.packageName)) return false
        }
        // Checked by the write itself rather than by a second permission read:
        // a fresh grant can land while this process keeps its cached answer.
        return runCatching {
            Settings.Global.putInt(app.contentResolver, "adb_wifi_enabled", 1)
        }.getOrDefault(false)
    }

    /**
     * The system's accessibility master switch and our entry in the service
     * list, read exactly as PhoneUiProbes reads them. `enabled` alone is not
     * enough: the repair needs to know that our component is listed, which is
     * what the accessibility repair's `contains` check answers.
     */
    private fun accessibilityEnabled(): Boolean = runCatching {
        Settings.Secure.getInt(app.contentResolver, Settings.Secure.ACCESSIBILITY_ENABLED, 0) == 1 &&
            PhoneUiAccessibilityRepair.contains(accessibilityServices(), accessibilityComponent)
    }.getOrDefault(false)

    /** The raw `enabled_accessibility_services` value; null when it was never written. */
    private fun accessibilityServices(): String? =
        runCatching {
            Settings.Secure.getString(app.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
        }.getOrNull()

    private companion object {
        const val WRITE_SECURE_SETTINGS = "android.permission.WRITE_SECURE_SETTINGS"
        const val HANDOFF_TIMEOUT_MS = 20_000L
        const val HANDOFF_POLL_MS = 200L
        const val CODE_LENGTH = 6
        const val PAIRING_PORT_TIMEOUT_MS = 20_000L
        const val PAIRING_PORT_LOOKUP_MS = 2_500L
        const val NOTIFICATION_CANCEL_RETRY_MS = 2_000L
        // The system dialog's code lives for two minutes; the window covers a
        // reopen without letting a forgotten sheet read Settings all day.
        const val AUTO_PAIR_WINDOW_MS = 180_000L
        const val AUTO_PAIR_POLL_MS = 500L
        const val MAX_AUTO_PAIR_ATTEMPTS = 3
        // Floor between repair steps. The loop's own waits are longer when it
        // is backing off; this only keeps a "nothing to do" answer from
        // spinning the coroutine.
        const val REPAIR_POLL_MS = 2_000L
    }
}
