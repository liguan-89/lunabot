package com.lunabot.companion.phone

import com.lunabot.companion.core.PhonePlace
import com.lunabot.companion.core.PhonePlacesAnswer
import com.lunabot.companion.core.PhonePlacesLookup
import com.lunabot.companion.core.PhonePlacesOrigin
import com.lunabot.companion.core.PhonePlacesRequest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

class PhonePlacesTest {
    private val fix = PhoneLocationReading.Fix(
        latitude = 31.2,
        longitude = 121.5,
        accuracyMeters = 12.0,
        provider = "gps",
        at = 1_760_000_000_000,
        mock = false,
    )

    private fun arguments(vararg pairs: Pair<String, Any>): JsonObject = JsonObject(
        pairs.associate { (key, value) ->
            key to when (value) {
                is String -> JsonPrimitive(value)
                is Int -> JsonPrimitive(value)
                else -> JsonPrimitive(value.toString())
            }
        },
    )

    @Test
    fun `bad arguments stop before location or the computer is asked`() = runBlocking {
        var reads = 0
        var lookups = 0
        val places = PhonePlaces(
            readLocation = { reads += 1; fix },
            lookup = { lookups += 1; PhonePlacesLookup.Failure("should not run", "test") },
        )
        for (args in listOf(
            arguments(),
            arguments("query" to ""),
            arguments("query" to "coffee", "radiusMeters" to 10),
        )) {
            val failure = assertIs<PhoneToolOutcome.Failure>(places.execute(args))
            assertEquals("unsupported", failure.code)
        }
        assertEquals(0, reads)
        assertEquals(0, lookups)
    }

    @Test
    fun `a missing fix is the location failure and no search is made`() = runBlocking {
        var lookups = 0
        val places = PhonePlaces(
            readLocation = { PhoneLocationReading.Unavailable("没有位置权限，请在设置里允许定位。", "unsupported") },
            lookup = { lookups += 1; PhonePlacesLookup.Failure("should not run", "test") },
        )
        val failure = assertIs<PhoneToolOutcome.Failure>(places.execute(arguments("query" to "coffee")))
        assertEquals("没有位置权限，请在设置里允许定位。", failure.error)
        assertEquals("unsupported", failure.code)
        assertEquals(0, lookups)
    }

    @Test
    fun `the phone fix and query become the computer request and its answer becomes the job result`() = runBlocking {
        var request: PhonePlacesRequest? = null
        val answer = PhonePlacesAnswer(
            provider = "google",
            query = "coffee",
            radiusMeters = 1_000,
            origin = PhonePlacesOrigin(latitude = 31.2, longitude = 121.5),
            places = listOf(
                PhonePlace(
                    name = "Cafe",
                    address = "1 Road",
                    latitude = 31.201,
                    longitude = 121.501,
                    distanceMeters = 120,
                    types = listOf("cafe"),
                    rating = 4.5,
                    openNow = true,
                ),
            ),
        )
        val places = PhonePlaces(
            readLocation = { fix },
            lookup = {
                request = it
                PhonePlacesLookup.Success(answer)
            },
        )
        val success = assertIs<PhoneToolOutcome.Success>(
            places.execute(arguments("query" to " coffee ", "radiusMeters" to 1_000)),
        )
        assertEquals(PhonePlacesRequest(query = "coffee", radiusMeters = 1_000, latitude = 31.2, longitude = 121.5), request)
        assertEquals("google", success.result.getValue("provider").jsonPrimitive.content)
        assertEquals("coffee", success.result.getValue("query").jsonPrimitive.content)
        val place = success.result.getValue("places").jsonArray[0] as JsonObject
        assertEquals("Cafe", place.getValue("name").jsonPrimitive.content)
        assertEquals("1 Road", place.getValue("address").jsonPrimitive.content)
    }

    @Test
    fun `the computer's refusal stays explicit instead of becoming an empty result`() = runBlocking {
        val places = PhonePlaces(
            readLocation = { fix },
            lookup = { PhonePlacesLookup.Failure("Places search is not configured on this computer", "unconfigured") },
        )
        val failure = assertIs<PhoneToolOutcome.Failure>(places.execute(arguments("query" to "coffee")))
        assertEquals("Places search is not configured on this computer", failure.error)
        assertEquals("unconfigured", failure.code)
    }
}
