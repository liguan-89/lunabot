package com.lunabot.companion.permissions

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import android.annotation.SuppressLint

/** Platform permissions used by local discovery, the routes to a computer on this phone's Wi-Fi, and composer dictation. */
class CompanionPermissions(
    private val sdkInt: Int = Build.VERSION.SDK_INT,
    private val granted: (String) -> Boolean,
) {
    constructor(
        context: Context,
        sdkInt: Int = Build.VERSION.SDK_INT,
    ) : this(
        sdkInt = sdkInt,
        granted = { permission ->
            ContextCompat.checkSelfPermission(context.applicationContext, permission) ==
                PackageManager.PERMISSION_GRANTED
        },
    )

    data class Snapshot(val missingDiscovery: List<String>) {
        val discoveryNeedsRequest: Boolean get() = missingDiscovery.isNotEmpty()
    }

    private val _snapshot = MutableStateFlow(read())
    val snapshot: StateFlow<Snapshot> = _snapshot.asStateFlow()

    private val _localNetworkAnswers = MutableStateFlow(0)

    /** How many times the system has answered the local-network prompt, whichever way; a screen waiting on one resumes when it moves. */
    val localNetworkAnswers: StateFlow<Int> = _localNetworkAnswers.asStateFlow()

    fun refresh(): Snapshot {
        val next = read()
        _snapshot.value = next
        return next
    }

    /**
     * What a local browse needs. Called when someone opens the list of nearby
     * computers, never on the way to the QR scanner, which needs none of it;
     * the confirmation after a scan asks for [routePermissions] on its own.
     */
    fun discoveryPermissions(): Array<String> = refresh().missingDiscovery.toTypedArray()

    /** The names these permissions go by where the person meets them: the system's prompt and its Settings page. */
    fun described(permissions: List<String>): List<String> = permissions.map { permission ->
        when (permission) {
            Manifest.permission.NEARBY_WIFI_DEVICES -> "附近设备"
            PERMISSION_ACCESS_LOCAL_NETWORK -> "本地网络"
            else -> permission
        }
    }

    /** Whether this phone may open a socket on its own network: what every route to a computer on its Wi-Fi needs on API 37. */
    fun localNetworkGranted(): Boolean = sdkInt < LOCAL_NETWORK_SDK || granted(PERMISSION_ACCESS_LOCAL_NETWORK)

    /** What connecting to a computer on this Wi-Fi still needs before its address may be dialled. */
    fun routePermissions(): Array<String> =
        if (localNetworkGranted()) emptyArray() else arrayOf(PERMISSION_ACCESS_LOCAL_NETWORK)

    /** The system answered the local-network prompt, whichever way it went. */
    fun onLocalNetworkResult() {
        refresh()
        _localNetworkAnswers.value += 1
    }

    /** Composer mic — checked at the button, never at cold start. */
    fun recordAudioGranted(): Boolean = granted(Manifest.permission.RECORD_AUDIO)

    // NEARBY_WIFI_DEVICES is referenced only when sdkInt already allows it.
    @SuppressLint("InlinedApi")
    private fun read(): Snapshot {
        val missingDiscovery = buildList {
            if (sdkInt >= 33 && !granted(Manifest.permission.NEARBY_WIFI_DEVICES)) {
                add(Manifest.permission.NEARBY_WIFI_DEVICES)
            }
            if (sdkInt >= LOCAL_NETWORK_SDK && !granted(PERMISSION_ACCESS_LOCAL_NETWORK)) {
                add(PERMISSION_ACCESS_LOCAL_NETWORK)
            }
        }
        return Snapshot(missingDiscovery)
    }

    companion object {
        /** Android 17 / API 37 — local-network runtime permission. */
        const val LOCAL_NETWORK_SDK = 37

        /**
         * Literal keeps compiling against older stub jars in unit tests while
         * still matching `Manifest.permission.ACCESS_LOCAL_NETWORK` on device.
         */
        const val PERMISSION_ACCESS_LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK"
    }
}
