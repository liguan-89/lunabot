/*
 * Ported from Mika (https://github.com/wangzan101/Mika), file
 * core/src/main/kotlin/com/wangzan101/mika/core/cap/phone/PhoneAdvancedTools.kt
 * (PhoneFind, the phone_find tool).
 * Copyright 2026 wangzan101. The original is licensed under the Apache License,
 * Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 OpenMausBot contributors. Changes from the
 * original: repackaged under com.openmausbot.companion.phoneui, comments
 * translated into English, and reduced to this app's plain accessibility-tree
 * reader and tool surface. Mika scrolls by a fixed amount of 3 in one
 * sub-action; PHONE_UI_SCROLL here takes one step, so each iteration scrolls
 * one step and maxScrolls is the whole budget. Mika's protected/readable
 * screen verdicts are not ported because our snapshot has no protection flag:
 * a null snapshot stops as read_failed, and an empty tree or a screen whose
 * package cannot be read stops as screen_needs_review. The fingerprint hashes
 * the visible element tuples instead of window or element hash codes, and two
 * identical readings in a row stop the loop where Mika needs three, because
 * our scroll already waits for the screen to change. A whole-call time budget
 * stops the loop before the server's job timeout and reports scroll_limit,
 * the same "the call's own budget ran out" answer the scroll count gives. The
 * snapshot, the package in front, the query, the scroll and the clock are
 * lambdas handed in by the executor rather than sub-actions of the tool.
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
 * PHONE_UI_FIND: scroll the current screen until a target is found or the
 * content stops changing, and return the matches with their refs so the bot
 * can tap them. It replaces the observe → query → scroll → observe chain a bot
 * would otherwise spend several calls on.
 *
 * The loop reads the screen, asks the injected query whether the target is
 * there, and scrolls one step when it is not. It stops as found, at the
 * scroll budget, when two readings in a row are identical (the list ended, or
 * the screen ignores scrolling), when another app comes in front, when the
 * snapshot is empty or its package cannot be read, when a scroll does not
 * happen, or when the call's time budget runs out.
 *
 * The effectful pieces are lambdas handed in by [PhoneUiTaskExecutor], the
 * same model [PhoneUiRun] and [PhoneUiCollect] follow. The pure halves — the
 * argument parsing, the fingerprint and the stop words — are plain functions
 * over data, so they are pinned by JVM tests without a device.
 */
internal class PhoneUiFind(
    private val snapshot: () -> PhoneUiSnapshot?,
    /** The package in front on the controlled display, or null when it cannot be told. */
    private val topPackage: () -> String?,
    /**
     * The elements of the screen that match [Target]. The executor hands in the
     * same rule PHONE_UI_QUERY applies, so find and query can never disagree
     * about what a target is.
     */
    private val query: (Target, List<PhoneUiElement>) -> List<PhoneUiElement>,
    /** Scrolls one step in the direction the content moves; false when the step did not happen at all. */
    private val scroll: suspend (String) -> Boolean,
    /** The clock the time budget is measured against. */
    private val now: () -> Long,
    /**
     * The visible element tuples in reading order, so two readings of the same
     * content compare equal even when the screen was re-read. The scroll
     * position is not part of it: only the elements themselves are.
     */
    private val fingerprint: (List<PhoneUiElement>) -> String,
    private val elementJson: (PhoneUiElement) -> JsonObject,
    /** Longest the whole call may take; a phone that is slow to settle still answers before the job times out. */
    private val budgetMs: Long = TIME_BUDGET_MS,
) {
    /** What to look for; at least one of the three is set, as PHONE_UI_QUERY requires. */
    data class Target(val text: String? = null, val resourceId: String? = null, val role: String? = null)

    /** The call, already validated. */
    data class Options(
        val target: Target,
        val direction: String,
        val maxScrolls: Int,
        val limit: Int,
    )

    /** What the loop found and why it stopped. */
    data class Outcome(
        val found: Boolean,
        val stoppedBecause: String,
        val scrolls: Int,
        /** Every element that matched on the screen the loop stopped on, before `limit`. */
        val total: Int,
        val elements: List<PhoneUiElement>,
        val packageName: String?,
        val snapshotId: String?,
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
        val outcome = run(options)
        return PhoneToolOutcome.Success(
            buildJsonObject {
                put("ok", outcome.found)
                put("found", outcome.found)
                put("stoppedBecause", outcome.stoppedBecause)
                put("scrolls", outcome.scrolls)
                put("direction", options.direction)
                put("maxScrolls", options.maxScrolls)
                put(
                    // Only the selectors that actually narrowed the answer, as PHONE_UI_QUERY reports them.
                    "query",
                    buildJsonObject {
                        options.target.text?.let { put("text", it) }
                        options.target.resourceId?.let { put("resourceId", it) }
                        options.target.role?.let { put("role", it) }
                    },
                )
                put("total", outcome.total)
                put("truncated", outcome.total > options.limit)
                put("elements", JsonArray(outcome.elements.map(elementJson)))
                outcome.snapshotId?.let { put("snapshot", it) }
                outcome.packageName?.let { put("topPackage", it) }
            },
        )
    }

    /**
     * The call as options, or the first reason it is not one. The server checks
     * the same shape; this is what a phone may trust when a newer server sends
     * more than this build knows.
     */
    fun parse(arguments: JsonObject): Parsed {
        val text = arguments.stringArg("text")
        val resourceId = arguments.stringArg("resourceId")
        val role = arguments.stringArg("role")
        if (text == null && resourceId == null && role == null) {
            return Parsed.Refused("至少要给 text、resourceId 或 role 中的一个。")
        }
        if ((text?.length ?: 0) > PhoneUiRules.MAX_QUERY_TEXT ||
            (resourceId?.length ?: 0) > PhoneUiRules.MAX_QUERY_RESOURCE_ID ||
            (role?.length ?: 0) > PhoneUiRules.MAX_QUERY_ROLE
        ) {
            return Parsed.Refused("查询条件过长。")
        }
        val direction = arguments.stringArg("direction")?.lowercase()
            ?: return Parsed.Refused("缺少参数 direction。")
        if (direction != "up" && direction != "down") return Parsed.Refused("direction 只支持 up 或 down。")
        return Parsed.Ready(
            Options(
                target = Target(text = text, resourceId = resourceId, role = role),
                direction = direction,
                maxScrolls = (arguments.intArg("maxScrolls") ?: DEFAULT_MAX_SCROLLS).coerceIn(1, MAX_SCROLLS),
                limit = PhoneUiRules.clampedLimit(
                    arguments.intArg("limit"),
                    PhoneUiRules.DEFAULT_QUERY_LIMIT,
                    PhoneUiRules.MAX_QUERY_LIMIT,
                ),
            ),
        )
    }

    /**
     * The loop itself. One read per iteration, then at most one scroll, so the
     * number of scrolls never exceeds [Options.maxScrolls] and a screen that
     * already holds the target costs no scroll at all.
     */
    suspend fun run(options: Options): Outcome {
        var previous: String? = null
        var scrolled = 0
        var reason = STOP_SCROLL_LIMIT
        var matches: List<PhoneUiElement> = emptyList()
        var total = 0
        var app: String? = null
        var snapshotId: String? = null
        var packageName: String? = null
        val deadline = now() + budgetMs
        while (true) {
            val screen = snapshot()
            // Mika stops on a null screen as read_failed; nothing was read at all here.
            if (screen == null) {
                reason = STOP_READ_FAILED
                break
            }
            snapshotId = screen.id
            // Our snapshot carries no protected/readable flag. An empty tree is what
            // an unreadable screen looks like here: the read worked, there is just
            // nothing in it we may act on, so the loop stops rather than scrolling
            // a screen it cannot see (Mika's screen_needs_review).
            if (screen.elements.isEmpty()) {
                reason = STOP_SCREEN_NEEDS_REVIEW
                break
            }
            val front = topPackage()
            packageName = front
            // Mika reads the package from the snapshot; ours comes from the display,
            // and without it an app switch could not be told from the same app.
            if (front == null) {
                reason = STOP_SCREEN_NEEDS_REVIEW
                break
            }
            if (app == null) app = front else if (app != front) {
                reason = STOP_APP_SWITCHED
                break
            }
            val found = query(options.target, screen.elements)
            total = found.size
            matches = found.take(options.limit)
            if (found.isNotEmpty()) {
                reason = STOP_FOUND
                break
            }
            val current = fingerprint(screen.elements)
            // Mika counts two equal comparisons after the first reading, so it needs
            // three identical screens. Our scroll already waits for the screen to
            // change, so one equal comparison is a real answer and the second
            // identical reading ends the loop.
            if (current == previous) {
                reason = STOP_CONTENT_UNCHANGED
                break
            }
            previous = current
            if (scrolled >= options.maxScrolls) {
                reason = STOP_SCROLL_LIMIT
                break
            }
            // The scroll budget is counted in steps, not seconds; a screen that takes
            // long to settle would otherwise run past the server's job timeout and
            // return nothing at all.
            if (now() >= deadline) {
                reason = STOP_SCROLL_LIMIT
                break
            }
            if (!scroll(options.direction)) {
                reason = STOP_SCROLL_FAILED
                break
            }
            scrolled++
        }
        return Outcome(
            found = reason == STOP_FOUND,
            stoppedBecause = reason,
            scrolls = scrolled,
            total = total,
            elements = matches,
            packageName = packageName,
            snapshotId = snapshotId,
        )
    }

    companion object {
        const val MAX_SCROLLS = 200
        const val DEFAULT_MAX_SCROLLS = 30

        /** Under the server's 45 s phone-job timeout, so a slow screen still answers instead of failing. */
        const val TIME_BUDGET_MS = 30_000L

        /** The stop words PHONE_UI_FIND reports; Mika's names, kept so a reader of either tool sees the same words. */
        const val STOP_FOUND = "found"
        const val STOP_SCROLL_LIMIT = "scroll_limit"
        const val STOP_READ_FAILED = "read_failed"
        const val STOP_SCREEN_NEEDS_REVIEW = "screen_needs_review"
        const val STOP_APP_SWITCHED = "app_switched"
        const val STOP_CONTENT_UNCHANGED = "content_unchanged"
        const val STOP_SCROLL_FAILED = "scroll_failed"

        private const val CODE_UNSUPPORTED = "unsupported"

        /** FNV-1a, the same cheap hash the service uses for its screen readings. */
        private const val FNV_OFFSET = -3750763034362895579L
        private const val FNV_PRIME = 1099511628211L

        /**
         * The visible element tuples of one reading, in the order the snapshot
         * lists them (reading order): class, text, description, view id and
         * bounds — the same fields PHONE_UI_QUERY returns, so two readings that
         * differ only by a ref or a snapshot id still compare equal. Bounds are
         * included because a row that moved is a screen that changed; what is
         * left out is any scroll offset of its own.
         */
        fun fingerprint(elements: List<PhoneUiElement>): String {
            var hash = FNV_OFFSET
            fun feed(value: String) {
                for (ch in value) hash = (hash xor ch.code.toLong()) * FNV_PRIME
                hash = (hash xor FIELD_SEPARATOR.code.toLong()) * FNV_PRIME
            }
            for (element in elements) {
                feed(element.className ?: "")
                feed(element.text ?: "")
                feed(element.description ?: "")
                feed(element.viewId ?: "")
                feed(element.bounds.joinToString(","))
                hash = (hash xor ROW_SEPARATOR.code.toLong()) * FNV_PRIME
            }
            return java.lang.Long.toHexString(hash)
        }

        private const val FIELD_SEPARATOR = '\u0001'
        private const val ROW_SEPARATOR = '\u0002'
    }
}

private fun JsonObject.stringArg(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }

private fun JsonObject.intArg(key: String): Int? =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.intOrNull
