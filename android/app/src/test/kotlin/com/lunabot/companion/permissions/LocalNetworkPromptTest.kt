package com.lunabot.companion.permissions

import com.lunabot.companion.core.CompanionEndpoint
import com.lunabot.companion.core.CompanionEndpointKind
import com.lunabot.companion.core.Connection
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class LocalNetworkPromptTest {
    private val lan = requireNotNull(CompanionEndpoint.create("http://192.168.1.20:8810", CompanionEndpointKind.LAN, 0))
    private val hosted = requireNotNull(
        CompanionEndpoint.create("https://mac.companion.example", CompanionEndpointKind.HOSTED, 50),
    )
    private val missing = arrayOf(CompanionPermissions.PERMISSION_ACCESS_LOCAL_NETWORK)

    private fun connection(endpoint: CompanionEndpoint) = Connection(
        name = "Mac", host = endpoint.host, port = endpoint.port, activeEndpoint = endpoint, endpoints = listOf(endpoint),
    )

    @Test
    fun aPairedComputerOnThisWifiIsAskedForOnce() {
        assertTrue(asksLocalNetworkOnce(connection(lan), missing, askedBefore = false))
        assertFalse(asksLocalNetworkOnce(connection(lan), missing, askedBefore = true), "a refusal is final until Settings")
        assertFalse(asksLocalNetworkOnce(connection(lan), emptyArray(), askedBefore = false), "already allowed")
    }

    @Test
    fun nothingIsAskedBeforeThereIsAComputerToReach() {
        assertFalse(asksLocalNetworkOnce(null, missing, askedBefore = false))
        assertFalse(
            asksLocalNetworkOnce(connection(hosted), missing, askedBefore = false),
            "a computer reached over the internet does not need this phone's network",
        )
    }
}
