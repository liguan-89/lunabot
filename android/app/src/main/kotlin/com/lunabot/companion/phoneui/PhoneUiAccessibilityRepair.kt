/*
 * Ported from Mika (https://github.com/wangzan101/Mika), files
 * core/src/main/kotlin/com/wangzan101/mika/core/shell/AccessibilityRepair.kt and
 * core/src/main/kotlin/com/wangzan101/mika/core/shell/RecoveryPermissions.kt
 * (AccessibilityList). Copyright 2026 wangzan101. The original is licensed
 * under the Apache License, Version 2.0 (third_party/mika/LICENSE in this
 * repository).
 *
 * Modifications Copyright 2026 LunaBot contributors. Changes from the
 * original: repackaged under com.lunabot.companion.phoneui, comments
 * translated into English, the flows and coroutines replaced by immutable
 * state and pure transitions, the clock taken as a parameter, and the shell
 * command execution left to the caller. Wiring into a service is a separate
 * change.
 */
package com.lunabot.companion.phoneui

/**
 * Re-binding the accessibility service when the system lists it but does not
 * run it.
 *
 * Android keeps `enabled_accessibility_services` in secure settings and binds
 * whatever it lists. After a process kill it can treat the service as crashed:
 * the entry stays in the list, the person still sees the toggle as on, and
 * nothing is bound. Rewriting the list is the only way to make the system
 * bind it again. Rewriting means writing the setting back with our component
 * still in it, and for the listed-but-dead case writing it twice with a short
 * pause in between, because two writes too close together may only be seen as
 * the last one.
 *
 * The rules that matter:
 * - `enabled && !connected` is the repair case.
 * - `!enabled` means the person turned the service off. Never write it back
 *   silently; report that they have to enable it.
 * - A service that flaps is not rewritten in a loop: wait [GRACE_MS] first,
 *   then allow at most [MAX_ATTEMPTS] attempts, backing off [BACKOFF_MS]
 *   between them.
 *
 * The list parsing is the dangerous part: `enabled_accessibility_services` is
 * a colon-separated list shared with every other accessibility service on the
 * phone. Replacing the whole string would switch all of them off, so
 * [settingWith] only ever appends our component and [settingWithout] removes
 * nothing else. Entries can be written as `pkg/.Class` or `pkg/full.Class`,
 * and both forms mean the same component.
 */
internal object PhoneUiAccessibilityRepair {
    /** Wait this long after first seeing the service stuck; the system often binds it a moment later. */
    const val GRACE_MS = 3_000L

    /** Attempts per stuck episode before giving up and leaving the manual path to the UI. */
    const val MAX_ATTEMPTS = 2

    /** Pause before a second (or later) attempt, multiplied by the number of failures so far. */
    const val BACKOFF_MS = 5_000L

    /** Pause between removing and re-adding our component, so the system sees two distinct writes. */
    const val GAP_MS = 1_000L

    /** How long to wait for the service to bind after a write. */
    const val CONNECT_TIMEOUT_MS = 8_000L

    /** What the app can see: the system lists us ([enabled]) and our service instance is bound ([connected]). */
    data class A11yObservation(val enabled: Boolean, val connected: Boolean) {
        /** Not running: either listed but unbound, or gone from the list. */
        val stuck: Boolean get() = !connected
    }

    /**
     * One repair episode: when the service was first seen stuck, when the last
     * attempt was written, and how many consecutive attempts have failed.
     * Immutable, so a caller can snapshot it and compare.
     */
    data class RepairState(
        /** First observation of the stuck episode; null when no episode is running. */
        val stuckSinceMs: Long? = null,
        /** When the last repair write was attempted; 0 before the first attempt. */
        val lastWriteAtMs: Long = 0L,
        /** Attempts since the service was last connected. */
        val failures: Int = 0,
    )

    /** What to do with the current observation. */
    sealed interface Decision {
        /** The service is bound; nothing to do. */
        data object Healthy : Decision

        /** The person turned the service off; they have to enable it in system settings. */
        data object NeedsPerson : Decision

        /** Too early: after the grace period or the backoff. Come back in [ms]. */
        data class Wait(val ms: Long) : Decision

        /** [MAX_ATTEMPTS] attempts did not bind the service; stop until the person acts. */
        data object GaveUp : Decision

        /**
         * Write [setting] to `enabled_accessibility_services` now.
         *
         * When [remove] is not null the service is listed but dead: write
         * [remove] first, wait [GAP_MS], then write [setting], so the system
         * sees the component disappear and come back and rebinds it. An empty
         * [remove] means ours was the only entry, and the caller should delete
         * the setting for that first write rather than store an empty string.
         */
        data class Write(val setting: String, val remove: String? = null) : Decision
    }

    /**
     * Fold one observation into the state before asking [decide]. A connected
     * service ends the episode; a service the person disabled ends it too, so
     * turning it back on starts a fresh count rather than inheriting old
     * failures.
     */
    fun observe(state: RepairState, observation: A11yObservation, nowMs: Long): RepairState = when {
        observation.connected -> RepairState()
        !observation.enabled -> RepairState()
        state.stuckSinceMs != null -> state
        else -> state.copy(stuckSinceMs = nowMs)
    }

    /**
     * Record one repair attempt written at [atMs]. [restored] says the service
     * bound within [CONNECT_TIMEOUT_MS]; then the episode is over, otherwise
     * the failure count grows and the next attempt backs off.
     */
    fun attempted(state: RepairState, atMs: Long, restored: Boolean): RepairState =
        if (restored) RepairState()
        else state.copy(lastWriteAtMs = atMs, failures = state.failures + 1)

    /**
     * Decide what to do now. Pure over the observation, the current setting
     * value, the episode state and the clock; call [observe] first so
     * [RepairState.stuckSinceMs] is set.
     *
     * [currentSetting] is the raw `settings get secure
     * enabled_accessibility_services` output, [component] is our component
     * exactly as the system lists it (applicationId and namespace can differ,
     * so pass the flattened ComponentName rather than deriving it).
     */
    fun decide(
        observation: A11yObservation,
        currentSetting: String?,
        component: String,
        state: RepairState,
        nowMs: Long,
    ): Decision {
        if (observation.connected) return Decision.Healthy
        if (!observation.enabled) return Decision.NeedsPerson
        val stuckSince = state.stuckSinceMs ?: return Decision.Wait(GRACE_MS)
        val graceLeft = GRACE_MS - (nowMs - stuckSince).coerceAtLeast(0L)
        if (graceLeft > 0L) return Decision.Wait(graceLeft)
        if (state.failures >= MAX_ATTEMPTS) return Decision.GaveUp
        if (state.failures > 0) {
            val backoff = BACKOFF_MS * state.failures
            val sinceWrite = (nowMs - state.lastWriteAtMs).coerceAtLeast(0L)
            if (sinceWrite < backoff) return Decision.Wait(backoff - sinceWrite)
        }
        val setting = settingWith(currentSetting, component)
        return if (contains(currentSetting, component)) {
            Decision.Write(setting = setting, remove = settingWithout(currentSetting, component))
        } else {
            Decision.Write(setting = setting)
        }
    }

    /**
     * The value to write so the list includes [component], or null when
     * nothing should change: the service is bound, or the person turned it
     * off and must not be overridden.
     *
     * The returned list may equal [current] when [component] is already in it;
     * that rewrite is the repair for a listed-but-dead service. [decide] asks
     * the caller to remove the component first in that case.
     */
    fun settingToWrite(observation: A11yObservation, current: String?, component: String): String? = when {
        observation.connected -> null
        !observation.enabled -> null
        else -> settingWith(current, component)
    }

    /**
     * The list with [component] appended when absent. Every other service is
     * kept, order is preserved, and the result is idempotent: a list that
     * already contains [component] (in either `pkg/.Class` or
     * `pkg/full.Class` form) comes back unchanged in content, with no
     * duplicate.
     */
    fun settingWith(current: String?, component: String): String {
        val list = entries(current)
        return (if (list.any { same(it, component) }) list else list + component).joinToString(":")
    }

    /**
     * The list without [component]. Only our component is removed; this is
     * the first half of the remove-and-re-add repair, never a way to disable
     * anything else.
     */
    fun settingWithout(current: String?, component: String): String =
        entries(current).filterNot { same(it, component) }.joinToString(":")

    /** True when [component] is already listed, in either class-name form. */
    fun contains(current: String?, component: String): Boolean = entries(current).any { same(it, component) }

    /**
     * Split the raw setting value. `settings get` prints `null` for a setting
     * that was never written, and an empty value means no services; both are
     * an empty list. Entries are trimmed and empty entries dropped, which
     * also repairs stray separators without touching any real component.
     */
    fun entries(raw: String?): List<String> {
        val value = raw?.trim().orEmpty()
        if (value == "null") return emptyList()
        return value.split(':').map { it.trim() }.filter { it.isNotEmpty() }
    }

    private fun same(a: String, b: String): Boolean = expand(a) == expand(b)

    /** `pkg/.Class` and `pkg/pkg.Class` name the same component; compare the expanded forms. */
    private fun expand(component: String): String {
        if ('/' !in component) return component
        val pkg = component.substringBefore('/')
        val cls = component.substringAfter('/')
        return if (cls.startsWith('.')) "$pkg/$pkg$cls" else component
    }
}
