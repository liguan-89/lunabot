package com.lunabot.companion.phone

import com.lunabot.companion.core.CompanionJson
import com.lunabot.companion.core.PhonePlacesLookup
import com.lunabot.companion.core.PhonePlacesRequest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject

/**
 * Nearby places through the paired computer. The phone supplies only its own
 * fix and the query; the provider key and upstream response stay on the computer.
 */
internal class PhonePlaces(
    private val readLocation: suspend () -> PhoneLocationReading,
    private val lookup: suspend (PhonePlacesRequest) -> PhonePlacesLookup,
) {
    suspend fun execute(arguments: JsonObject): PhoneToolOutcome {
        val query = (arguments["query"] as? JsonPrimitive)?.contentOrNull?.trim().orEmpty()
        val radius = (arguments["radiusMeters"] as? JsonPrimitive)?.intOrNull ?: DEFAULT_RADIUS_METERS
        if (query.isEmpty() || query.length > 200 || radius !in MIN_RADIUS_METERS..MAX_RADIUS_METERS) {
            return PhoneToolOutcome.Failure("地点搜索参数不正确。", "unsupported")
        }
        val reading = readLocation()
        if (reading is PhoneLocationReading.Unavailable) {
            return PhoneToolOutcome.Failure(reading.error, reading.code)
        }
        val fix = reading as PhoneLocationReading.Fix
        return when (
            val outcome = lookup(
                PhonePlacesRequest(
                    query = query,
                    radiusMeters = radius,
                    latitude = fix.latitude,
                    longitude = fix.longitude,
                ),
            )
        ) {
            is PhonePlacesLookup.Failure -> PhoneToolOutcome.Failure(outcome.error, outcome.code)
            is PhonePlacesLookup.Success -> PhoneToolOutcome.Success(
                CompanionJson.encodeToJsonElement(outcome.answer).jsonObject,
            )
        }
    }

    private companion object {
        const val DEFAULT_RADIUS_METERS = 5_000
        const val MIN_RADIUS_METERS = 50
        const val MAX_RADIUS_METERS = 50_000
    }
}
