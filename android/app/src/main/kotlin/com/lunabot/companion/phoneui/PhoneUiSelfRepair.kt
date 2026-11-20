/*
 * Ported from Mika (https://github.com/wangzan101/Mika), file
 * core/src/main/kotlin/com/wangzan101/mika/core/shell/WirelessDebuggingAutoOn.kt.
 * Copyright 2026 wangzan101. The original is licensed under the Apache License,
 * Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 OpenMausBot contributors. Changes from the
 * original: repackaged under com.lunabot.companion.phoneui, comments
 * translated into English, the StateFlow and coroutine plumbing replaced by an
 * immutable State with pure transitions, and the write plus the clock supplied
 * by the caller. Wiring into PhoneUiController is a separate change.
 */
package com.lunabot.companion.phoneui

/**
 * Turning wireless debugging back on when the shell helper needs it, as a pure
 * decision object.
 *
 * The helper starts over wireless debugging, so while the switch is off there
 * is no paired connection to run a command through: the app has to write the
 * `adb_wifi_enabled` secure setting itself. Android turns that switch off after
 * a reboot, a Wi-Fi change or a battery saver; the pairing flow today only
 * reads it and tells the person to turn it on by hand.
 *
 * Android's own handling of the setting is what shapes this module
 * (AdbDebuggingManager):
 * - Writing 1 makes the system check the current Wi-Fi. With no Wi-Fi, or on a
 *   network that is not in its "always allow" list, it writes 0 straight back
 *   and asks the person whether to allow wireless debugging here. Every write
 *   pops that dialog, so a write that gets flipped back has to stop the loop
 *   ([Stop.NotAllowedHere]) rather than retry.
 * - On an allowed network the switch stays 1 and the debugging service comes
 *   up; the port is found by the pairing step as usual.
 *
 * A write is therefore only the first half: the caller writes, waits
 * [SETTLE_MS], and reports whether the switch was flipped back off. The caller
 * also owns the write lambda, where a throw and a false return both mean
 * [Stop.Refused]. The state is immutable and every transition is a pure
 * function, so the rules are pinned by JVM tests without a device.
 */
internal object PhoneUiSelfRepair {
    /**
     * How many times we will turn the switch on for one episode. Mika's value;
     * provisional until tuned against real devices.
     */
    const val MAX_WRITES = 3

    /** How long a write gets to survive before the system's flip-back counts. */
    const val SETTLE_MS = 3_000L

    /** Gap after the first write; doubles with each write, capped by [MAX_GAP_MS]. */
    const val BASE_GAP_MS = 10_000L
    const val MAX_GAP_MS = 5 * 60_000L

    /** Why writing stopped. Nothing resumes until one of [Trigger] fires. */
    enum class Stop {
        /**
         * We wrote the switch on and the system flipped it back off: this
         * network is not allowed to use wireless debugging yet. The system is
         * also asking the person whether to allow it.
         */
        NotAllowedHere,

        /** The system would not take the write (it threw or returned false). */
        Refused,

        /** We turned it on [MAX_WRITES] times and the helper still is not up. */
        GaveUp,
    }

    /** The four things that clear a stop and start the count from zero. */
    enum class Trigger {
        /** The phone moved to a different Wi-Fi network. */
        WifiChanged,

        /** The person toggled wireless debugging by hand. */
        ToggledByHand,

        /** The person asked for a retry. */
        RetryRequested,

        /** The shell helper came up, so the switch is no longer needed. */
        HelperAttached,
    }

    /** Everything the decision needs to remember between observations. */
    data class State(
        /** Writes attempted in this episode, accepted or not. */
        val writes: Int = 0,
        /** When the last write was attempted; 0 before the first one. */
        val lastWriteAtMs: Long = 0L,
        /** Why the loop stopped, or null while it is still running. */
        val stopped: Stop? = null,
    )

    /** What to do with the current observation. */
    sealed interface Decision {
        /** Write the switch on now. */
        data object Write : Decision

        /** Too soon after the last write: come back in [ms]. */
        data class Wait(val ms: Long) : Decision

        /** Do nothing; [reason] says why. */
        data class Skip(val reason: SkipReason) : Decision
    }

    enum class SkipReason {
        /** The switch is already on. */
        AlreadyOn,

        /** The helper is attached, so wireless debugging is no longer needed. */
        HelperAttached,

        /** A stop is recorded, or the write budget is exhausted. */
        Stopped,
    }

    /** One thing that happened, folded into [State] by [next]. */
    sealed interface Event {
        /** One of the four triggers; clears the stop and the write count. */
        data class Cleared(val trigger: Trigger) : Event

        /** A write was attempted and the system accepted it. */
        data class Wrote(val atMs: Long) : Event

        /** A write threw or returned false. */
        data class WriteRefused(val atMs: Long) : Event

        /** The switch was read after [SETTLE_MS]; true means it was flipped back off. */
        data class Settled(val stillOff: Boolean) : Event
    }

    /**
     * The stop that applies to [state], or null while writing may continue.
     * Reaching [MAX_WRITES] is itself [Stop.GaveUp]: Mika records the stop the
     * moment the gate sees the budget spent, whether or not the last write was
     * flipped back.
     */
    fun stop(state: State): Stop? =
        state.stopped ?: if (state.writes >= MAX_WRITES) Stop.GaveUp else null

    /**
     * Whether to write right now. Pure: [state] carries the write count and the
     * recorded stop, and [nowMs] is the caller's clock. [clearedBy] is the
     * trigger that cleared a stop, if one fired since the last call; passing it
     * is the same as folding [Event.Cleared] in with [next] first, but it keeps
     * the whole gate a single call for a caller that just observed something.
     *
     * [off] is the current value of the switch, [helperAttached] whether the
     * shell helper is up.
     */
    fun shouldWrite(
        off: Boolean,
        helperAttached: Boolean,
        state: State,
        nowMs: Long,
        clearedBy: Trigger? = null,
    ): Decision {
        val current = if (clearedBy != null) next(state, Event.Cleared(clearedBy)) else state
        if (helperAttached) return Decision.Skip(SkipReason.HelperAttached)
        if (stop(current) != null) return Decision.Skip(SkipReason.Stopped)
        if (!off) return Decision.Skip(SkipReason.AlreadyOn)
        val gap = gapAfter(current.writes)
        // A clock that moved backwards is treated as no time having passed:
        // waiting the full gap is safer than writing again immediately.
        val sinceLast = (nowMs - current.lastWriteAtMs).coerceAtLeast(0L)
        return if (sinceLast < gap) Decision.Wait(gap - sinceLast) else Decision.Write
    }

    /** Fold one event into the state. Every transition is total and immutable. */
    fun next(state: State, event: Event): State = when (event) {
        is Event.Cleared -> State()
        is Event.Wrote -> state.copy(writes = state.writes + 1, lastWriteAtMs = event.atMs)
        is Event.WriteRefused ->
            state.copy(writes = state.writes + 1, lastWriteAtMs = event.atMs, stopped = Stop.Refused)
        is Event.Settled ->
            // Keep an earlier stop: a refusal and a flip-back cannot both come
            // from the same write, but the first reason is the true one. A
            // spent write budget is not recorded here; [stop] derives GaveUp
            // from the count so the state never needs a synthetic event.
            if (event.stillOff && state.stopped == null) state.copy(stopped = Stop.NotAllowedHere) else state
    }

    /**
     * Attempt one write and fold the outcome in. [write] is the caller's job:
     * it must set `adb_wifi_enabled` to 1 and return whether the system took
     * the write. A throw is caught and treated exactly like a false return:
     * [Stop.Refused].
     *
     * Writing that setting needs WRITE_SECURE_SETTINGS, which the shell helper
     * holds. A locked-down device, a missing helper or a vendor build that
     * guards the setting will throw or return false here; that is an expected
     * answer, not a crash, and it is why the pairing flow still keeps a manual
     * path.
     */
    fun attemptWrite(state: State, atMs: Long, write: () -> Boolean): State =
        if (runCatching(write).getOrDefault(false)) next(state, Event.Wrote(atMs))
        else next(state, Event.WriteRefused(atMs))

    /**
     * Gap after [writes] writes: none before the first, then 10 s, 20 s, 40 s
     * ... capped at [MAX_GAP_MS]. The growth keeps a phone that keeps losing
     * the switch from being written to in a tight loop.
     */
    fun gapAfter(writes: Int): Long =
        if (writes <= 0) 0L else (BASE_GAP_MS shl (writes - 1).coerceAtMost(20)).coerceAtMost(MAX_GAP_MS)
}
