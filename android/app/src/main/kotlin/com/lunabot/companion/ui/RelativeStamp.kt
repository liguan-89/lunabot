package com.lunabot.companion.ui

import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/**
 * Timestamps the way a messaging app writes them — the port of
 * `RelativeStamp` in `ios/App/ChatListView.swift`.
 *
 * Every function takes "now" rather than reading the clock, so the branching —
 * which is the actual spec — is unit-testable without a fake clock.
 */
object RelativeStamp {

    /** Roster: time today, "Yesterday", weekday within the week, date beyond that. */
    fun list(
        atMillis: Double,
        nowMillis: Long,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.SIMPLIFIED_CHINESE,
    ): String {
        if (atMillis <= 0) return ""
        val at = zoned(atMillis, zone)
        val now = zoned(nowMillis.toDouble(), zone)
        return when {
            at.toLocalDate() == now.toLocalDate() -> time(atMillis, zone, locale)
            at.toLocalDate() == now.toLocalDate().minusDays(1) -> yesterday(locale)
            at.isAfter(now.minusDays(6)) -> weekdayFormatter(locale).format(at)
            else -> dateFormatter(locale).format(at)
        }
    }

    /** In a transcript: enough to place a gap in the conversation. */
    fun separator(
        atMillis: Double,
        nowMillis: Long,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.SIMPLIFIED_CHINESE,
    ): String {
        val at = zoned(atMillis, zone)
        val now = zoned(nowMillis.toDouble(), zone)
        val clock = time(atMillis, zone, locale)
        return when {
            at.toLocalDate() == now.toLocalDate() -> "${today(locale)} $clock"
            at.toLocalDate() == now.toLocalDate().minusDays(1) -> "${yesterday(locale)} $clock"
            else -> "${dateFormatter(locale).format(at)} $clock"
        }
    }

    /** Thread row: short date and short time. The default zone is the OS zone. */
    fun updated(
        atMillis: Double,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
        nowMillis: Long = System.currentTimeMillis(),
    ): String {
        if (atMillis <= 0.0 || !atMillis.isFinite()) return ""
        val at = zoned(atMillis, zone)
        if (locale.language == "zh") {
            val now = zoned(nowMillis.toDouble(), zone)
            val clock = time(atMillis, zone, locale)
            return when {
                at.toLocalDate() == now.toLocalDate() -> "今天 $clock"
                at.toLocalDate() == now.toLocalDate().minusDays(1) -> "昨天 $clock"
                at.year == now.year -> "${DateTimeFormatter.ofPattern("M月d日", locale).format(at)} $clock"
                else -> "${DateTimeFormatter.ofPattern("yyyy年M月d日", locale).format(at)} $clock"
            }
        }
        return DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT, FormatStyle.SHORT)
            .withLocale(locale)
            .format(at)
    }

    fun time(
        atMillis: Double,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.SIMPLIFIED_CHINESE,
    ): String = if (locale.language == "zh") {
        // Chinese phone UI reads clock times as 24-hour. `ofLocalizedTime`
        // follows the device's 12/24 preference, which on an English emulator
        // produced "3:35 AM" in the middle of a Chinese screen.
        DateTimeFormatter.ofPattern("HH:mm", locale).format(zoned(atMillis, zone))
    } else {
        DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)
            .withLocale(locale)
            .format(zoned(atMillis, zone))
    }

    /**
     * A schedule's instant, spelled out — Swift's
     * `.formatted(date: .abbreviated, time: .shortened)`, which is a medium
     * date beside a short time in the reader's locale.
     */
    fun dateAndTime(
        atMillis: Double,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.SIMPLIFIED_CHINESE,
    ): String = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)
        .withLocale(locale)
        .format(zoned(atMillis, zone))

    private fun zoned(millis: Double, zone: ZoneId): ZonedDateTime =
        ZonedDateTime.ofInstant(Instant.ofEpochMilli(millis.toLong()), zone)

    private fun weekdayFormatter(locale: Locale) = DateTimeFormatter.ofPattern("EEEE", locale)

    // These two words are copy, not a date pattern: the formatter that follows
    // them speaks the locale, and a hardcoded Chinese word in front of
    // "3:35 PM" was the one mixed-script line on an English phone.
    private fun today(locale: Locale) = if (locale.language == "zh") "今天" else "Today"

    private fun yesterday(locale: Locale) = if (locale.language == "zh") "昨天" else "Yesterday"

    private fun dateFormatter(locale: Locale) = if (locale.language == "zh") {
        DateTimeFormatter.ofPattern("M月d日", locale)
    } else {
        DateTimeFormatter.ofPattern("MMM d", locale)
    }
}
