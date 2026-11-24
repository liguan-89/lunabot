package com.lunabot.companion

/**
 * How long a receiver may hold its broadcast while it waits for a live session.
 *
 * Android 17 (API 37) gives a receiver 10 s for an ordered broadcast and counts `goAsync()` inside it: at the limit
 * `BroadcastQueue` logs "Timeout receiver" and the process is killed. A wait as long as the limit is that kill
 * whenever the computer is slow to reach, and it takes whatever the receiver was doing with it.
 */
internal const val RECEIVER_CONNECT_BUDGET_MS = 5_000L
