package com.lunabot.companion.phoneui

/**
 * The effects half of the two phone-UI self-repairs: [PhoneUiSelfRepair] and
 * [PhoneUiAccessibilityRepair] decide, and this class turns one decision into
 * at most one action per [step].
 *
 * Why the app may now turn a developer switch back on. PhoneUiController's
 * docstring used to say that nothing there auto-enables wireless debugging,
 * and for the pairing flow that is still true. The switch is different because
 * the person turned the phoneUi capability on: the shell helper is the only
 * reason this app needs wireless debugging, the helper starts over that
 * switch, and after a reboot, a Wi-Fi change or a battery saver the switch is
 * off while the helper is gone — leaving the person to hunt for a system page
 * the app already knows about. The write therefore happens only while the
 * helper is absent ([helperAttached] is false) and only after the capability
 * is on; a person who never enables phone control never reaches this code. It
 * is still Android that decides: on a network that is not allowed to use
 * wireless debugging the system flips the switch back and pops its own
 * per-network dialog, and that flip-back is
 * [PhoneUiSelfRepair.Stop.NotAllowedHere] — the loop stops instead of fighting
 * the dialog, and the person still makes the call.
 *
 * The write needs `WRITE_SECURE_SETTINGS`, which an ordinary app does not have.
 * The person opts in from Settings (a switch that is off by default); while a
 * helper is attached, it grants the app that permission once, and the app
 * writes the switch from then on. [wirelessWriter] is what keeps that honest:
 * until one of the two writers exists, this half does nothing at all and folds
 * no event, so a reboot with no helper leaves no refusal behind and the loop is
 * ready the moment the person plugs the phone in again.
 *
 * The accessibility half rewrites `enabled_accessibility_services` only to
 * append or remove *our* component: [PhoneUiAccessibilityRepair.settingWith]
 * and [PhoneUiAccessibilityRepair.settingWithout] leave every other service in
 * the list exactly where it was, and that module is the only source of the
 * string this class writes. When the person has turned the service off the
 * decision is [PhoneUiAccessibilityRepair.Decision.NeedsPerson] and no write
 * happens at all; a switch the person flipped is never overridden.
 *
 * Everything the class touches is injected — the clock, both reads, both
 * writes and [sleep] — so it holds no Android type and no coroutine machinery
 * of its own, and the rules are pinned by JVM tests without a device. [step]
 * performs at most one action and returns how long to wait before the next
 * call; the caller applies its own floor, so the loop can never spin.
 */
internal class PhoneUiRepairLoop(
    /** Our component exactly as the system lists it: `applicationId/full.ClassName`. */
    private val component: String,
    private val now: () -> Long,
    private val switchOff: () -> Boolean,
    private val helperAttached: () -> Boolean,
    /** Must write `adb_wifi_enabled = 1` and report whether the system took it. */
    private val wirelessWrite: () -> Boolean,
    /**
     * Whether a write is possible at all right now: the app holds
     * `WRITE_SECURE_SETTINGS`, or a helper is attached that can be asked for
     * it. Without this, an absent writer would be recorded as the system's
     * refusal and spend the episode's write budget on a write that never
     * happened.
     */
    private val wirelessWriter: () -> Boolean = { true },
    private val a11yEnabled: () -> Boolean,
    private val a11yConnected: () -> Boolean,
    /** The raw `enabled_accessibility_services` value; null when unset. */
    private val a11ySetting: () -> String?,
    private val a11yWrite: (String?) -> Boolean,
    private val sleep: suspend (Long) -> Unit,
) {
    /**
     * The two episode states. [step] runs on the repair coroutine, but the
     * controller calls [cleared] and reads [wirelessStop] from whichever thread
     * handled a refresh; volatile keeps those reads honest without a lock
     * across the blocking binder write. A clear that races a write in flight is
     * simply lost, which only delays a retry — it can never add a write.
     */
    @Volatile private var wireless = PhoneUiSelfRepair.State()
    @Volatile private var a11y = PhoneUiAccessibilityRepair.RepairState()

    /**
     * The helper's state on the previous observation, so the helper-attached
     * trigger fires once per attach rather than on every step.
     */
    private var helperWasAttached = false

    /**
     * The recorded wireless stop, or null while writing may continue. The
     * controller reads this to decide whether a refresh is an explicit retry;
     * a repair that is still running has no stop and keeps its write count.
     */
    val wirelessStop: PhoneUiSelfRepair.Stop? get() = PhoneUiSelfRepair.stop(wireless)

    /** Failed accessibility attempts in the current episode; read by the tests. */
    val a11yFailures: Int get() = a11y.failures

    /**
     * Fold one [PhoneUiSelfRepair.Trigger] in: the person toggled the switch,
     * the phone changed Wi-Fi, Settings offered a retry, or the helper came up.
     * The next [step] may write again.
     *
     * The helper-attached trigger is applied by [step] itself, and the
     * controller calls this with [PhoneUiSelfRepair.Trigger.RetryRequested]
     * when the person re-opens Settings. Nothing here polls for a hand toggle
     * or a Wi-Fi change: detecting either would mean watching a setting this
     * class already reads for a different reason, and a wrong guess would pop
     * Android's per-network dialog again. Those two triggers stay available
     * for a caller that observes them for free.
     */
    fun cleared(trigger: PhoneUiSelfRepair.Trigger) {
        wireless = PhoneUiSelfRepair.next(wireless, PhoneUiSelfRepair.Event.Cleared(trigger))
    }

    /**
     * Perform at most one action and return how long to wait before the next
     * call (0 means "again now"; the caller adds its own floor). The wireless
     * half goes first because the helper is what the capability is for; the
     * accessibility half runs only when the wireless half did nothing, which
     * is what keeps one call to one action.
     */
    suspend fun step(): Long {
        val wirelessWait = stepWireless()
        if (wirelessWait != null) return wirelessWait
        return stepAccessibility()
    }

    /**
     * The wireless half. Returns the wait to honour, or null when nothing was
     * done and the accessibility half may run. The settle read is what turns
     * an accepted write into either "the switch stayed on" or
     * [PhoneUiSelfRepair.Stop.NotAllowedHere]; the latter must not be retried,
     * because Android is already asking the person about this network.
     */
    private suspend fun stepWireless(): Long? {
        if (helperAttached()) {
            // The helper is up, so the switch is no longer needed: this clears
            // any recorded stop (and the write count) exactly once per attach.
            if (!helperWasAttached) cleared(PhoneUiSelfRepair.Trigger.HelperAttached)
            helperWasAttached = true
            return null
        }
        helperWasAttached = false
        // No writer, no attempt. A helper that is gone cannot be asked for the
        // grant, and the app without the grant cannot write the switch. That is
        // a missing sender, not the system refusing: folding it in would record
        // Refused and burn the write budget, and this half of the loop would
        // never try again after a reboot without a manual retry.
        if (!wirelessWriter()) return null
        return when (
            val decision = PhoneUiSelfRepair.shouldWrite(
                off = switchOff(),
                helperAttached = false,
                state = wireless,
                nowMs = now(),
            )
        ) {
            is PhoneUiSelfRepair.Decision.Wait -> decision.ms
            is PhoneUiSelfRepair.Decision.Skip -> null
            PhoneUiSelfRepair.Decision.Write -> {
                wireless = PhoneUiSelfRepair.attemptWrite(wireless, now(), wirelessWrite)
                sleep(PhoneUiSelfRepair.SETTLE_MS)
                wireless = PhoneUiSelfRepair.next(
                    wireless,
                    PhoneUiSelfRepair.Event.Settled(stillOff = switchOff()),
                )
                // The gap belongs to the next shouldWrite call, so this step
                // asks for no extra wait of its own.
                0L
            }
        }
    }

    /**
     * The accessibility half. Returns the wait the decision asks for, or 0
     * after an attempt (the connect timeout has already passed, and the next
     * decision either backs off or gives up).
     *
     * Nothing runs without the helper: the write goes through its allow-listed
     * settings endpoint, so with no helper there is no way to repair anything.
     * Attempting anyway would spend the episode's attempt budget on a write
     * that cannot land and leave [PhoneUiAccessibilityRepair.Decision.GaveUp]
     * behind, which only a bound service clears — so a helper that came back
     * later would find the service still dead and the budget spent. The
     * episode state is reset instead, so the grace period starts when the
     * helper returns.
     */
    private suspend fun stepAccessibility(): Long {
        if (!helperAttached()) {
            a11y = PhoneUiAccessibilityRepair.RepairState()
            return 0L
        }
        val observation = PhoneUiAccessibilityRepair.A11yObservation(
            enabled = a11yEnabled(),
            connected = a11yConnected(),
        )
        a11y = PhoneUiAccessibilityRepair.observe(a11y, observation, now())
        return when (
            val decision = PhoneUiAccessibilityRepair.decide(
                observation = observation,
                currentSetting = a11ySetting(),
                component = component,
                state = a11y,
                nowMs = now(),
            )
        ) {
            // Healthy, a service the person disabled, and an exhausted episode
            // all mean the same thing here: write nothing.
            PhoneUiAccessibilityRepair.Decision.Healthy,
            PhoneUiAccessibilityRepair.Decision.NeedsPerson,
            PhoneUiAccessibilityRepair.Decision.GaveUp -> 0L
            is PhoneUiAccessibilityRepair.Decision.Wait -> decision.ms
            is PhoneUiAccessibilityRepair.Decision.Write -> {
                val remove = decision.remove
                if (remove != null) {
                    // Two writes the system can tell apart: our component
                    // disappears (an empty value deletes the setting, because
                    // ours was the only entry) and then comes back.
                    writeA11y(remove.ifEmpty { null })
                    sleep(PhoneUiAccessibilityRepair.GAP_MS)
                }
                writeA11y(decision.setting)
                sleep(PhoneUiAccessibilityRepair.CONNECT_TIMEOUT_MS)
                // The write's return value is not the truth here: settings
                // writes can land while the system still does not bind, so the
                // outcome is measured by re-reading the connection.
                a11y = PhoneUiAccessibilityRepair.attempted(
                    a11y,
                    now(),
                    restored = a11yConnected(),
                )
                0L
            }
        }
    }

    /**
     * Write one accessibility setting value, treating a throw (the helper's
     * binder can die between the decision and the write) as a write that did
     * not happen. The loop must not die with it; the next decision reads the
     * connection and backs off like any other failure.
     */
    private fun writeA11y(value: String?): Boolean =
        runCatching { a11yWrite(value) }.getOrDefault(false)
}
