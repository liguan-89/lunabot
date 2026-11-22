package com.lunabot.companion.phoneui

/**
 * Judging whether one of our actions made an app open on the person's own
 * screen instead of ours.
 *
 * Adapted from Mika's MainScreenSpill (app/src/main/java/com/wangzan101/mika/cap/phone/a11y/
 * MainScreenSpill.kt), Copyright 2026 wangzan101, Apache License 2.0
 * (third_party/mika/LICENSE). Changes: this app observes the main display by
 * polling its top task between actions rather than with a task-stack listener,
 * so there is no `from` display or same-task tracking; a task that was already
 * on top before the action is skipped, which covers the cases that mattered.
 *
 * Background: an app on our display can start another app from a background
 * context (a service, a notification jump, the system chooser). Android puts
 * that app on the person's main display, our display shows no change, and a
 * bot that only watches its own display concludes the tap did nothing and taps
 * again. Recognising the arrival lets us move that task back to our display,
 * or stop and leave a system picker to the person.
 */
object PhoneUiSpill {
    /** Look at arrivals for this long after an action started. */
    const val WINDOW_MS = 6_000L

    data class Arrival(val taskId: Int, val packageName: String?, val at: Long)

    enum class Verdict {
        /** Nothing that came from our action; keep going. */
        None,

        /** A normal app page arrived on the main display: move it to ours. */
        PullBack,

        /** The system asks which app to use: leave it to the person. */
        LeaveForUser,
    }

    data class Decision(val verdict: Verdict, val arrival: Arrival? = null)

    /**
     * [arrivals] are main-display tasks seen at the top since [since];
     * [topBefore] was the top task when the action started; [userTouchedAt] is
     * the last moment the person touched the main screen; [userActiveBefore]
     * says the person touched the main screen between this and the previous
     * action — only the touch count moved, so the exact moment is unknown. A
     * normal app page that is not the person's own doing is pulled back;
     * anything resolved by a system picker is left on their screen; an arrival
     * whose ownership is unclear (the person was active just before the action)
     * is left alone rather than pulled out from under them.
     */
    fun decide(
        arrivals: List<Arrival>,
        since: Long,
        topBefore: Int,
        userTouchedAt: Long?,
        excludedPackages: Set<String>,
        pickerPackages: Set<String>,
        homePackages: Set<String> = emptySet(),
        windowMs: Long = WINDOW_MS,
        userActiveBefore: Boolean = false,
    ): Decision {
        val relevant = arrivals
            .filter { it.at in since..(since + windowMs) }
            .filter { it.packageName != null }
            .filter { it.packageName !in excludedPackages && it.packageName !in homePackages }
            .sortedBy { it.at }
        val arrival = relevant.lastOrNull() ?: return Decision(Verdict.None)
        val pkg = arrival.packageName ?: return Decision(Verdict.None)
        // The person touched their own screen in this window: they are driving.
        if (userTouchedAt != null && userTouchedAt in since..arrival.at) {
            return Decision(Verdict.None, arrival)
        }
        // The person was active on their screen just before the action started
        // (the touch count moved between actions, with no timestamp to cite):
        // this arrival may be their doing, so leave it alone instead of pulling
        // the app they are using off their display (Mika's #798).
        if (userActiveBefore) return Decision(Verdict.None, arrival)
        // The task that was already on top came back up after another was moved.
        if (arrival.taskId == topBefore) return Decision(Verdict.None, arrival)
        if (pkg in pickerPackages) return Decision(Verdict.LeaveForUser, arrival)
        return Decision(Verdict.PullBack, arrival)
    }
}