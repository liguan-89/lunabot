/*
 * Ported from Mika (https://github.com/wangzan101/Mika), file
 * core/src/main/kotlin/com/wangzan101/mika/core/cap/phone/PhoneAutomationTools.kt
 * (PhoneCollect, the phone_collect tool).
 * Copyright 2026 wangzan101. The original is licensed under the Apache License,
 * Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 OpenMausBot contributors. Changes from the
 * original: repackaged under com.openmausbot.companion.phoneui, comments
 * translated into English, and reduced to this app's plain accessibility-tree
 * reader and tool surface. The band keeps a line only when it lies wholly
 * inside it, and pages merge through a line-level dedup in reading order
 * instead of Mika's page-overlap append/prepend, so direction only picks the
 * scroll. Mika's OCR text merging, protected/readable/imageReason screen
 * checks, tree-with-children reading, `no_app_open` verdict and wrapped `text`
 * answer are not ported; pages are capped at 20 rather than 30, the line bound
 * is `maxLines` rather than Mika's `maxItems`, the stop reasons are this app's
 * own words, and the scroll and settle steps are lambdas handed in by the
 * executor rather than sub-actions of the tool.
 */
package com.openmausbot.companion.phoneui

import com.openmausbot.companion.phone.PhoneToolOutcome
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

/**
 * PHONE_UI_COLLECT: several screens read by one job, for a long list or a chat
 * history. The loop reads the band, scrolls one step, waits for the screen to
 * settle and reads again, so a bot that would otherwise observe and scroll
 * screen by screen pays one round-trip instead of one per screen.
 *
 * A line counts only when it lay wholly inside the band on the screen it came
 * from, so a line cut by the edge is not returned half read and then again; a
 * line already returned is never repeated. The loop stops at the requested page
 * count, at the end of the list (two scrolls that brought nothing new), when
 * another app comes in front, when the screen stops changing, or when a scroll
 * fails.
 *
 * The effectful pieces are lambdas handed in by [PhoneUiTaskExecutor], the
 * model [PhoneUiRun] follows: a snapshot reader, the scroll performer, the
 * settle waiter, the package in front, the display height the band is read
 * against, and the element shape. The pure halves — the band filter, the dedup
 * and the parsing — are plain functions over data, so they are pinned by JVM
 * tests without a device.
 */
internal class PhoneUiCollect(
    private val snapshot: () -> PhoneUiSnapshot?,
    /** Scrolls one step; false when the scroll did not happen at all. */
    private val scroll: suspend (String) -> Boolean,
    /** Waits for the screen to settle and says whether it changed since the scroll. */
    private val settle: suspend () -> Boolean,
    private val topPackage: () -> String?,
    /** The controlled display's height, in the pixels element bounds use. */
    private val height: Int,
    private val elementJson: (PhoneUiElement) -> JsonObject,
) {
    /** One line of text and where it sat, so several screens sort into one reading order. */
    data class Line(val text: String, val top: Int, val left: Int)

    /** The call, already validated. */
    data class Options(
        val direction: String,
        val pages: Int,
        val maxLines: Int,
        val fromY: Int,
        val toY: Int,
    )

    /** The parsed call, or the sentence saying why it cannot run. */
    internal sealed interface Parsed {
        data class Ready(val options: Options) : Parsed
        data class Refused(val message: String) : Parsed
    }

    suspend fun execute(arguments: JsonObject): PhoneToolOutcome {
        val parsed = parse(arguments)
        if (parsed is Parsed.Refused) return PhoneToolOutcome.Failure(parsed.message, CODE_UNSUPPORTED)
        val options = (parsed as Parsed.Ready).options
        var screen: PhoneUiSnapshot? = snapshot()
            ?: return PhoneToolOutcome.Failure(NO_SNAPSHOT, CODE_UNSUPPORTED)
        // The app the read started in: a scroll that lands in another one ends
        // the read rather than mixing two apps' text.
        val startPackage = topPackage()
        var lines = emptyList<String>()
        var scrolled = 0
        var emptyScrolls = 0
        var stopped = STOP_PAGE_LIMIT
        for (page in 0 until options.pages) {
            // Only a read that failed below leaves this null, and that read ends
            // the loop in the same pass.
            val current = screen ?: break
            val before = lines.size
            lines = merge(lines, linesIn(current.elements, options.fromY, options.toY, height).map(Line::text))
            if (page > 0) {
                // Two scrolls in a row that brought no new line mean the list
                // ended: one alone may only have landed between two lines.
                emptyScrolls = if (lines.size == before) emptyScrolls + 1 else 0
                if (emptyScrolls >= EMPTY_SCROLLS) {
                    stopped = STOP_END
                    break
                }
            }
            if (page == options.pages - 1 || lines.size >= options.maxLines) {
                // The call's own bounds ended the read rather than the list;
                // `truncated` below says whether lines were left out.
                stopped = STOP_PAGE_LIMIT
                break
            }
            if (!scroll(options.direction)) {
                stopped = STOP_FAILED
                break
            }
            scrolled++
            if (!settle()) {
                stopped = STOP_NO_CHANGE
                break
            }
            // A scroll that lands in another app ends the read rather than
            // mixing two apps' text. The screen answered with is the one it
            // landed on, so the bot sees where the read stopped.
            val next = snapshot()
            if (next == null) {
                screen = null
                stopped = STOP_FAILED
                break
            }
            screen = next
            val now = topPackage()
            if (startPackage != null && now != null && now != startPackage) {
                stopped = STOP_APP_CHANGED
                break
            }
        }
        val kept = lines.take(options.maxLines)
        return PhoneToolOutcome.Success(
            buildJsonObject {
                put("direction", options.direction)
                put("pages", options.pages)
                put("scrolled", scrolled)
                put("stopped", stopped)
                put("lines", JsonArray(kept.map { JsonPrimitive(it) }))
                put("count", kept.size)
                put("truncated", lines.size > kept.size)
                topPackage()?.let { put("package", it) }
                screen?.let { put("screen", screenJson(it)) }
            },
        )
    }

    /**
     * The call as options, or the first reason it is not one. The server checks
     * the same shape; this is what a phone may trust when a newer server sends
     * more than this build knows.
     */
    fun parse(arguments: JsonObject): Parsed {
        val direction = arguments.stringArg("direction")?.lowercase()
            ?: return Parsed.Refused("缺少参数 direction。")
        if (direction != "up" && direction != "down") return Parsed.Refused("direction 只支持 up 或 down。")
        val fromY = (arguments.intArg("fromY") ?: DEFAULT_FROM_Y).coerceIn(BAND_MIN, BAND_MAX)
        val toY = (arguments.intArg("toY") ?: DEFAULT_TO_Y).coerceIn(BAND_MIN, BAND_MAX)
        if (fromY >= toY) return Parsed.Refused("fromY 必须小于 toY。")
        return Parsed.Ready(
            Options(
                direction = direction,
                pages = (arguments.intArg("pages") ?: DEFAULT_PAGES).coerceIn(1, MAX_PAGES),
                maxLines = (arguments.intArg("maxLines") ?: DEFAULT_LINES).coerceIn(1, MAX_LINES),
                fromY = fromY,
                toY = toY,
            ),
        )
    }

    /** The screen the read ended on, in the shape PHONE_UI_OBSERVE answers with. */
    private fun screenJson(current: PhoneUiSnapshot): JsonObject = buildJsonObject {
        put("snapshot", current.id)
        topPackage()?.let { put("topPackage", it) }
        put("truncated", current.truncated)
        put("elements", JsonArray(current.elements.map(elementJson)))
    }

    companion object {
        const val MAX_PAGES = 20
        const val DEFAULT_PAGES = 8
        const val MAX_LINES = 1_000
        const val DEFAULT_LINES = 300

        /** The band's edges when the call names none: most of the screen, below the title and the tabs. */
        const val DEFAULT_FROM_Y = 50
        const val DEFAULT_TO_Y = 950

        /** The band runs from 0 at the display's top edge to [BAND_MAX] at its bottom; [BAND_SCALE] turns it into pixels. */
        const val BAND_MIN = 0
        const val BAND_MAX = 999
        const val BAND_SCALE = 1_000

        /** Consecutive scrolls with nothing new that mean the list ended. */
        private const val EMPTY_SCROLLS = 2

        private const val CODE_UNSUPPORTED = "unsupported"
        private const val NO_SNAPSHOT = "此 Android 版本无法按显示器读取窗口。"

        private const val STOP_PAGE_LIMIT = "page-limit"
        private const val STOP_END = "end"
        private const val STOP_APP_CHANGED = "app-changed"
        private const val STOP_NO_CHANGE = "no-change"
        private const val STOP_FAILED = "failed"

        /**
         * The lines of one screen whose centre lies in the band, top to bottom
         * and then left to right. A line that straddles an edge is left for the
         * next screen, where it will be whole: a half-read line would come back
         * cut and then again in full.
         */
        fun linesIn(elements: List<PhoneUiElement>, fromY: Int, toY: Int, height: Int): List<Line> {
            if (height <= 0) return emptyList()
            val top = fromY.coerceIn(BAND_MIN, BAND_MAX) * height / BAND_SCALE
            val bottom = toY.coerceIn(BAND_MIN, BAND_MAX) * height / BAND_SCALE
            if (bottom <= top) return emptyList()
            return elements.mapNotNull { element ->
                val bounds = element.bounds
                if (bounds.size != 4) return@mapNotNull null
                val label = (element.text ?: element.description)?.trim()
                if (label.isNullOrEmpty()) return@mapNotNull null
                val centre = (bounds[1] + bounds[3]) / 2
                if (centre < top || centre > bottom) return@mapNotNull null
                if (bounds[1] < top || bounds[3] > bottom) return@mapNotNull null
                Line(label, bounds[1], bounds[0])
            }.sortedWith(compareBy(Line::top, Line::left))
        }

        /** [seen] followed by the lines of [next] it does not hold yet, each in the order it was first read. */
        fun merge(seen: List<String>, next: List<String>): List<String> {
            val out = ArrayList<String>(seen.size + next.size)
            val known = HashSet<String>(seen.size + next.size)
            for (line in seen) if (known.add(line)) out += line
            for (line in next) if (known.add(line)) out += line
            return out
        }
    }
}

private fun JsonObject.stringArg(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }

private fun JsonObject.intArg(key: String): Int? =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.intOrNull
