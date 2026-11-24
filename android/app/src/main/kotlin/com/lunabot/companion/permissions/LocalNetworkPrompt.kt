package com.lunabot.companion.permissions

import com.lunabot.companion.core.Connection

/**
 * Whether this return to the app is the one that asks to be let onto the phone's own network for the computer it is
 * paired with. Once an install: after a refusal the way back is Settings, which the connection banner names, so
 * the app never asks again on its own.
 */
internal fun asksLocalNetworkOnce(
    connection: Connection?,
    missing: Array<String>,
    askedBefore: Boolean,
): Boolean = connection?.usesLocalNetwork == true && missing.isNotEmpty() && !askedBefore
