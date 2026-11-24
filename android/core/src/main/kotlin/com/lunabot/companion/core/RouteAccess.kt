package com.lunabot.companion.core

/**
 * Whether this phone may open a socket to a route right now.
 *
 * A route the platform refuses is left out of the walk instead of being dialled. Android 17 (API 37) blocks an app's
 * LAN sockets until the person grants `ACCESS_LOCAL_NETWORK`, and a blocked TCP connect does not fail: it times out,
 * so dialling one costs the whole handshake deadline before the next route is tried.
 */
fun interface RouteAccess {
    fun allows(endpoint: CompanionEndpoint): Boolean

    companion object {
        /** Every route this phone consented to. */
        val ALL = RouteAccess { true }

        /** A phone that must be let onto its own network first; [granted] is the platform's answer, read each time. */
        fun localNetwork(granted: () -> Boolean): RouteAccess = RouteAccess { endpoint ->
            !endpoint.isOnLocalNetwork || granted()
        }
    }
}
