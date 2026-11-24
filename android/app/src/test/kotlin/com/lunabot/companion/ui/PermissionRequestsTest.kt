package com.lunabot.companion.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The one launcher, and where each permission's result is routed. */
class PermissionRequestsTest {
    private val asked = mutableSetOf<String>()
    private val multiple = mutableListOf<List<String>>()
    private val single = mutableListOf<String>()
    private var localNetworkAnswers = 0

    private val requests = PermissionRequests(
        markAsked = { asked += it },
        launchMultiple = { multiple += it.toList() },
        launchSingle = { single += it },
        onNotificationResult = {},
        onLocalNetworkResult = { localNetworkAnswers += 1 },
    )

    @Test
    fun askingForTheLocalNetworkRecordsThatItWasAsked() {
        requests.request(PermissionPreferences.ACCESS_LOCAL_NETWORK)
        requests.request(arrayOf(PermissionPreferences.ACCESS_LOCAL_NETWORK))

        assertEquals(listOf(PermissionPreferences.ACCESS_LOCAL_NETWORK), single)
        assertEquals(listOf(listOf(PermissionPreferences.ACCESS_LOCAL_NETWORK)), multiple)
        assertTrue(PermissionPreferences.ACCESS_LOCAL_NETWORK in asked, "if a prompt was shown, the flag is set")
    }

    @Test
    fun onlyAnAnswerAboutTheLocalNetworkReachesTheOneWaitingForIt() {
        requests.onResults(mapOf(PermissionPreferences.POST_NOTIFICATIONS to true))
        requests.onResults(mapOf(PermissionPreferences.RECORD_AUDIO to false))
        assertEquals(0, localNetworkAnswers)

        requests.onResults(mapOf(PermissionPreferences.ACCESS_LOCAL_NETWORK to false))
        requests.onResults(
            mapOf(
                "android.permission.NEARBY_WIFI_DEVICES" to true,
                PermissionPreferences.ACCESS_LOCAL_NETWORK to true,
            ),
        )
        assertEquals(2, localNetworkAnswers)
    }

    @Test
    fun aLaunchOfNothingPromptsNoOne() {
        requests.request(emptyArray())

        assertTrue(multiple.isEmpty())
        assertTrue(single.isEmpty())
        assertFalse(PermissionPreferences.ACCESS_LOCAL_NETWORK in asked)
    }
}
