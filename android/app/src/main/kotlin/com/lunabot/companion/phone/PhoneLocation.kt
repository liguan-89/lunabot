package com.lunabot.companion.phone

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Geocoder
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Looper
import androidx.core.content.ContextCompat
import com.lunabot.companion.core.LocationAccess
import java.util.Locale
import kotlin.coroutines.resume
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Where the phone is, read only.
 *
 * The permission is the grant: coarse location registers the capability as
 * `limited`, precise as `full`. The reading prefers a fresh fix and falls back
 * to the last known one, because a bot asking "where am I" cares more about an
 * answer than about a second of GPS warm-up. The place name is best effort:
 * Geocoder needs a network and can return nothing, and coordinates are still a
 * useful answer without it.
 */
internal class PhoneLocation(private val context: Context) {
    fun access(): LocationAccess {
        val fine = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.ACCESS_FINE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED
        val coarse = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED
        return when {
            fine -> LocationAccess.PRECISE
            coarse -> LocationAccess.COARSE
            else -> LocationAccess.NONE
        }
    }

    @SuppressLint("MissingPermission") // access() checked above; lint cannot follow it.
    suspend fun current(): PhoneToolOutcome = withContext(Dispatchers.IO) {
        if (!access().canRead) {
            return@withContext PhoneToolOutcome.Failure(
                "没有位置权限，请在设置里允许定位。",
                "unsupported",
            )
        }
        val manager = context.getSystemService(LocationManager::class.java)
            ?: return@withContext PhoneToolOutcome.Failure("这台手机没有定位服务。", "unsupported")
        val location = try {
            withTimeoutOrNull(FRESH_FIX_TIMEOUT_MILLIS) { freshFix(manager) }
                ?: lastKnown(manager)
        } catch (_: SecurityException) {
            return@withContext PhoneToolOutcome.Failure(
                "系统拒绝了位置读取，请重新允许定位权限。",
                "unsupported",
            )
        } ?: return@withContext PhoneToolOutcome.Failure(
            "读不到位置：请确认系统定位已打开，并稍后再试。",
            "unsupported",
        )

        // Geocoder's synchronous lookup blocks on a backend that may be unreachable.
        // A blocking call ignores coroutine cancellation, so it runs on its own
        // coroutine and the timeout only stops awaiting it.
        val lookup = CoroutineScope(Dispatchers.IO).async {
            runCatching {
                Geocoder(context, Locale.getDefault())
                    .getFromLocation(location.latitude, location.longitude, 1)
                    ?.firstOrNull()
                    ?.let { address ->
                        address.locality ?: address.subAdminArea ?: address.adminArea
                            ?: address.getAddressLine(0)
                    }
            }.getOrNull()
        }
        val place = runCatching { withTimeoutOrNull(GEOCODE_TIMEOUT_MILLIS) { lookup.await() } }.getOrNull()

        PhoneToolOutcome.Success(
            buildJsonObject {
                put("latitude", location.latitude)
                put("longitude", location.longitude)
                put("accuracyMeters", location.accuracy.toDouble())
                put("provider", location.provider.orEmpty())
                put("at", if (location.time > 0) location.time else System.currentTimeMillis())
                @Suppress("DEPRECATION")
                put("mock", if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    location.isMock
                } else {
                    location.isFromMockProvider
                })
                place?.takeIf { it.isNotBlank() }?.let { put("place", it) }
            },
        )
    }

    @SuppressLint("MissingPermission")
    private suspend fun freshFix(manager: LocationManager): Location? {
        val provider = listOf(
            LocationManager.GPS_PROVIDER,
            LocationManager.NETWORK_PROVIDER,
            LocationManager.PASSIVE_PROVIDER,
        ).firstOrNull { runCatching { manager.isProviderEnabled(it) }.getOrDefault(false) }
            ?: return null

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return suspendCancellableCoroutine { continuation ->
                val signal = CancellationSignal()
                continuation.invokeOnCancellation { signal.cancel() }
                manager.getCurrentLocation(
                    provider,
                    signal,
                    context.mainExecutor,
                ) { location -> if (continuation.isActive) continuation.resume(location) }
            }
        }

        @Suppress("DEPRECATION")
        return suspendCancellableCoroutine { continuation ->
            val listener = object : LocationListener {
                override fun onLocationChanged(location: Location) {
                    if (continuation.isActive) continuation.resume(location)
                }

                @Deprecated("Required by the pre-30 interface")
                override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

                override fun onProviderEnabled(provider: String) = Unit
                override fun onProviderDisabled(provider: String) = Unit
            }
            @Suppress("DEPRECATION")
            manager.requestSingleUpdate(provider, listener, Looper.getMainLooper())
            continuation.invokeOnCancellation {
                @Suppress("DEPRECATION")
                manager.removeUpdates(listener)
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun lastKnown(manager: LocationManager): Location? =
        manager.allProviders
            .mapNotNull { provider ->
                runCatching { manager.getLastKnownLocation(provider) }.getOrNull()
            }
            .maxByOrNull(Location::getTime)

    private companion object {
        const val FRESH_FIX_TIMEOUT_MILLIS = 8_000L
        const val GEOCODE_TIMEOUT_MILLIS = 5_000L
    }
}
