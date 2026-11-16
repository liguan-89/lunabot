package com.openmausbot.companion.phoneui

/**
 * Deciding when an action has actually taken effect on the screen.
 *
 * Adapted from Mika's ChangeWait (app/src/main/java/com/wangzan101/mika/cap/phone/a11y/
 * ChangeWait.kt), Copyright 2026 wangzan101, Apache License 2.0
 * (third_party/mika/LICENSE). Changes: this slice has no frame channel, so a
 * change is judged from the accessibility tree fingerprint and event quiet
 * time only; the fallback probe is left to the caller as a second action.
 *
 * Why waiting on event quiet alone is not enough: a slow page can be quiet
 * before it starts painting. A change is reported as soon as the tree differs
 * *and* the screen has been quiet for [QUIET_MS]; a page that keeps emitting
 * events (timers, progress bars) cannot hold an action past [CAP_MS].
 *
 * Clock and sleep are injected so the state machine is pinned by JVM tests.
 */
object PhoneUiStability {
    const val POLL_MS = 150L

    /** The screen counts as quiet after this long without an accessibility event. */
    const val QUIET_MS = 400L

    /** Upper bound on waiting for a change after one action. */
    const val CAP_MS = 2_500L

    /** Upper bound on waiting for the tree to stop changing. */
    const val SETTLE_CAP_MS = 1_500L

    private const val MIN_SLEEP_MS = 10L

    /** One reading of the screen: the tree fingerprint and how long it has been quiet. */
    data class Reading(val fingerprint: String, val quietForMs: Long)

    /**
     * True when the tree differs from [before] and the screen has gone quiet
     * (a reply that came, a screen that switched). False at [capMs] when
     * nothing changed. A change that arrives without quiet is reported once
     * the cap passes, so a busy page still yields the right answer.
     */
    suspend fun awaitChange(
        now: () -> Long,
        sleep: suspend (Long) -> Unit,
        read: () -> Reading,
        before: String,
        capMs: Long = CAP_MS,
    ): Boolean {
        val deadline = now() + capMs
        while (true) {
            val reading = read()
            val changed = reading.fingerprint != before
            if (changed && reading.quietForMs >= QUIET_MS) return true
            val atDeadline = now() >= deadline
            if (atDeadline) return changed
            val remaining = (deadline - now()).coerceAtLeast(0)
            val wait = if (changed) {
                minOf(POLL_MS, remaining)
            } else {
                minOf(QUIET_MS - reading.quietForMs, POLL_MS).coerceAtLeast(MIN_SLEEP_MS)
            }
            sleep(minOf(wait, remaining))
        }
    }

    /**
     * Wait until the tree has held the same fingerprint for [QUIET_MS], or
     * until [timeoutMs]. Returns the last fingerprint, which is what a caller
     * hands to [awaitChange] as `before`.
     */
    suspend fun awaitSettled(
        now: () -> Long,
        sleep: suspend (Long) -> Unit,
        read: () -> Reading,
        timeoutMs: Long = SETTLE_CAP_MS,
    ): String {
        val deadline = now() + timeoutMs
        var previous: String? = null
        var stableSince = 0L
        while (true) {
            val reading = read()
            if (reading.fingerprint == previous) {
                if (reading.quietForMs >= QUIET_MS && now() - stableSince >= QUIET_MS) {
                    return reading.fingerprint
                }
            } else {
                previous = reading.fingerprint
                stableSince = now()
            }
            if (now() >= deadline) return reading.fingerprint
            sleep(minOf(POLL_MS, (deadline - now()).coerceAtLeast(0)))
        }
    }
}