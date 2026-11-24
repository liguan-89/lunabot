package com.lunabot.companion.permissions

import android.Manifest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CompanionPermissionsTest {
    @Test
    fun api37RequestsOnlyWhatLocalDiscoveryNeeds() {
        val granted = mutableSetOf<String>()
        val permissions = CompanionPermissions(
            sdkInt = 37,
            granted = { it in granted },
        )
        assertEquals(
            listOf(
                Manifest.permission.NEARBY_WIFI_DEVICES,
                CompanionPermissions.PERMISSION_ACCESS_LOCAL_NETWORK,
            ),
            permissions.discoveryPermissions().toList(),
        )
        assertFalse(
            permissions.discoveryPermissions().contains(Manifest.permission.POST_NOTIFICATIONS),
            "opening the list of nearby computers must not ask for notifications",
        )
        assertTrue(permissions.snapshot.value.discoveryNeedsRequest)
    }

    @Test
    fun api32NeedsNoRuntimeCompanionPermissions() {
        val permissions = CompanionPermissions(
            sdkInt = 32,
            granted = { false },
        )
        assertTrue(permissions.discoveryPermissions().isEmpty())
    }

    @Test
    fun refreshUpdatesObservableDiscoveryStateFromPlatformGrants() {
        val granted = mutableSetOf<String>()
        val permissions = CompanionPermissions(
            sdkInt = 33,
            granted = { it in granted },
        )
        assertTrue(permissions.snapshot.value.discoveryNeedsRequest)
        granted += Manifest.permission.NEARBY_WIFI_DEVICES
        val snap = permissions.refresh()
        assertFalse(snap.discoveryNeedsRequest)
    }

    @Test
    fun recordAudioIsNeverPartOfTheStartupPrompt() {
        var recordAudioGranted = false
        val permissions = CompanionPermissions(
            sdkInt = 37,
            granted = { it == Manifest.permission.RECORD_AUDIO && recordAudioGranted },
        )
        assertFalse(permissions.recordAudioGranted())
        assertFalse(
            permissions.discoveryPermissions().contains(Manifest.permission.RECORD_AUDIO),
            "RECORD_AUDIO must only be asked from the mic button",
        )
        recordAudioGranted = true
        assertTrue(permissions.recordAudioGranted())
    }

    @Test
    fun aRouteToAComputerOnThisWifiNeedsTheLocalNetworkOnlyOnApi37() {
        val refused = CompanionPermissions(sdkInt = 37, granted = { false })
        assertFalse(refused.localNetworkGranted())
        assertEquals(
            listOf(CompanionPermissions.PERMISSION_ACCESS_LOCAL_NETWORK),
            refused.routePermissions().toList(),
            "nothing else is asked on the way to a computer: not discovery, not notifications",
        )

        val legacy = CompanionPermissions(sdkInt = 36, granted = { false })
        assertTrue(legacy.localNetworkGranted(), "before API 37 the platform grants the local network implicitly")
        assertTrue(legacy.routePermissions().isEmpty())
    }

    @Test
    fun theHintNamesPermissionsAsTheSystemDoes() {
        val permissions = CompanionPermissions(sdkInt = 37, granted = { false })
        assertEquals(
            listOf("附近设备", "本地网络"),
            permissions.described(permissions.discoveryPermissions().toList()),
        )
        assertEquals(listOf("附近设备", "android.permission.RECORD_AUDIO"), permissions.described(listOf(Manifest.permission.NEARBY_WIFI_DEVICES, Manifest.permission.RECORD_AUDIO)))
    }

    @Test
    fun theLocalNetworkAnswerMovesOncePerSystemAnswer() {
        val granted = mutableSetOf<String>()
        val permissions = CompanionPermissions(sdkInt = 37, granted = { it in granted })
        assertEquals(0, permissions.localNetworkAnswers.value)

        permissions.onLocalNetworkResult()
        assertEquals(1, permissions.localNetworkAnswers.value, "a refusal is an answer too")
        assertFalse(permissions.localNetworkGranted())

        granted += CompanionPermissions.PERMISSION_ACCESS_LOCAL_NETWORK
        permissions.onLocalNetworkResult()
        assertEquals(2, permissions.localNetworkAnswers.value)
        assertTrue(permissions.localNetworkGranted())
        assertTrue(permissions.routePermissions().isEmpty())
    }
}
