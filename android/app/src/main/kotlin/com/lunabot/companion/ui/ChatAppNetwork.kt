package com.lunabot.companion.ui

import com.lunabot.companion.core.AppNetwork

/** The host-side network gate below the frame's CSP. */
object ChatAppNetwork {
    const val HOST_ORIGIN = "https://appassets.androidplatform.net"
    const val HOST_PAGE = "$HOST_ORIGIN/app/app-host.html"

    fun allows(rawUrl: String, network: AppNetwork?): Boolean {
        if (rawUrl.startsWith("data:", ignoreCase = true) ||
            rawUrl.startsWith("blob:", ignoreCase = true) ||
            rawUrl.startsWith("about:", ignoreCase = true)
        ) return true
        val url = parse(rawUrl, request = true) ?: return false
        if (url.scheme != "http" && url.scheme != "https" && url.scheme != "ws" && url.scheme != "wss") return false
        val entries = (network?.connect.orEmpty() + network?.resources.orEmpty())
        return entries.any { entry -> matches(url, parse(entry, request = false) ?: return@any false) }
    }

    private data class Parts(
        val scheme: String,
        val host: String,
        val port: Int,
        val path: String,
        val wildcard: Boolean = false,
    )

    private val sourcePattern = Regex("^(https?|wss?)://([^/?#@]+?)(?::([0-9]+))?(/[^?#]*)?$", RegexOption.IGNORE_CASE)
    private val requestPattern = Regex("^(https?|wss?)://([^/?#@]+?)(?::([0-9]+))?(/[^?#]*)?(?:[?#].*)?$", RegexOption.IGNORE_CASE)

    private fun parse(raw: String, request: Boolean): Parts? {
        if (raw.length > 500 || raw.any(Char::isWhitespace)) return null
        val match = (if (request) requestPattern else sourcePattern).matchEntire(raw) ?: return null
        val scheme = match.groupValues[1].lowercase()
        val host = match.groupValues[2].lowercase()
        if (host.isEmpty()) return null
        val wildcard = host.startsWith("*.")
        val normalizedHost = if (wildcard) host.drop(2) else host
        if (normalizedHost.isEmpty() || normalizedHost.any { it.isWhitespace() || it == '@' }) return null
        val explicitPort = match.groupValues[3].toIntOrNull()
        if (match.groupValues[3].isNotEmpty() && explicitPort == null) return null
        return Parts(
            scheme = scheme,
            host = normalizedHost,
            port = explicitPort ?: defaultPort(scheme),
            path = match.groupValues[4],
            wildcard = wildcard,
        )
    }

    private fun defaultPort(scheme: String): Int = when (scheme) {
        "http", "ws" -> 80
        else -> 443
    }

    private fun matches(url: Parts, source: Parts): Boolean {
        if (url.scheme != source.scheme || url.port != source.port) return false
        val hostMatches = if (source.wildcard) {
            url.host.endsWith(".${source.host}") && url.host.length > source.host.length + 1
        } else {
            url.host == source.host
        }
        if (!hostMatches) return false
        val sourcePath = source.path
        return sourcePath.isEmpty() || sourcePath == "/" || url.path.startsWith(sourcePath)
    }
}
