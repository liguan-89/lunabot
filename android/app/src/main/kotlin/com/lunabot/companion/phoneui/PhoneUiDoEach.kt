/*
 * Ported from Mika (https://github.com/wangzan101/Mika), files
 * core/src/main/kotlin/com/wangzan101/mika/core/cap/phone/DoEach.kt and
 * core/src/main/kotlin/com/wangzan101/mika/core/agent/EachRunner.kt,
 * EachCursor.kt and ScrollCursor.kt (the do_each loop).
 * Copyright 2026 wangzan101. The original is licensed under the Apache License,
 * Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 OpenMausBot contributors. Changes from the
 * original: repackaged under com.lunabot.companion.phoneui, comments translated
 * into English, and reshaped for this app's PhoneUiRun step runner — the body
 * is one PHONE_UI_RUN call per item (its per-step re-finding and conditional
 * waits carry over), so the cursor here only matches items, keeps the
 * content-key ledger, and decides scroll versus end. "@item" names the current
 * item by the ref the loop's own snapshot issued, which PhoneUiRun re-finds by
 * identity after its first snapshot rotates the registry. Mika's role-exact
 * matching becomes this app's contains semantics, the summary carries the
 * body's own stop reason, and there is no EachLoopDetector here.
 */
package com.lunabot.companion.phoneui

import com.lunabot.companion.phone.PhoneToolOutcome
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * PHONE_UI_DO_EACH: run the same body of steps for every item of a list —
 * open it, act on it, come back — one item per round, without the model
 * thinking about each one. The loop engine (find the next undone item, skip
 * the done ones, scroll for more, stop at the end) lives here; the body runs
 * through [runBody] exactly as a PHONE_UI_RUN call does. Each round answers
 * with one compact summary, so N rounds collapse into one instead of one
 * screenshot per item.
 *
 * The identity that survives snapshots and scrolling is the content key
 * `role|name`: refs are reissued by every snapshot, and a list's rows share
 * one resource id, so neither can recognize "the same item" across a scroll.
 * Items named identically collapse into one — the elements themselves carry no
 * more than their label to go by.
 */
internal class PhoneUiDoEach(
    private val snapshot: () -> PhoneUiSnapshot?,
    /** One item's body, already substituted, run exactly as a PHONE_UI_RUN call. */
    private val runBody: suspend (JsonObject) -> PhoneToolOutcome,
    /** One scroll step; true when the screen moved. */
    private val scroll: suspend () -> Boolean,
    private val topPackage: () -> String?,
    private val elementJson: (PhoneUiElement) -> JsonObject,
) {
    /** One matched item: its stable content key and the ref its snapshot issued. */
    internal data class Item(val contentKey: String, val ref: String, val label: String)

    /** The parsed arguments, or the sentence saying why they cannot run. */
    internal sealed interface Parsed {
        data class Ready(
            val role: String?,
            val text: String?,
            val resourceId: String?,
            val body: JsonArray,
            val stopOnError: Boolean,
            val reveal: Boolean,
            val maxItems: Int,
        ) : Parsed

        data class Refused(val message: String) : Parsed
    }

    /** What the cursor wants next. */
    internal sealed interface Step {
        data class DoNext(val item: Item) : Step
        data object Scroll : Step
        data object End : Step
    }

    /** One round's outcome, before it becomes JSON. */
    internal class Round(val contentKey: String, val ok: Boolean, val stopped: String?, val error: String?)

    suspend fun execute(arguments: JsonObject): PhoneToolOutcome {
        val parsed = parse(arguments)
        if (parsed is Parsed.Refused) return PhoneToolOutcome.Failure(parsed.message, CODE_UNSUPPORTED)
        val plan = parsed as Parsed.Ready
        val seen = HashSet<String>()
        val done = HashSet<String>()
        val rounds = ArrayList<Round>()
        var justScrolled = false
        var scrolls = 0
        while (true) {
            val current = snapshot() ?: return PhoneToolOutcome.Failure(NO_SNAPSHOT, CODE_UNSUPPORTED)
            when (val next = advance(current.elements, plan, seen, done, justScrolled)) {
                is Step.DoNext -> {
                    if (rounds.size >= plan.maxItems) {
                        // The item cap, said with the screen in hand: the list may carry more.
                        return answer(rounds, "capped", null, null, current)
                    }
                    seen += next.item.contentKey
                    val round = runItem(next.item, plan)
                    rounds += round
                    if (round.ok || !plan.stopOnError) {
                        done += next.item.contentKey
                        justScrolled = false
                    } else {
                        return answer(rounds, "failed", next.item.contentKey, round.error, current)
                    }
                }
                is Step.Scroll -> {
                    if (!plan.reveal || !scroll()) return answer(rounds, STOP_DONE, null, null, current)
                    scrolls += 1
                    if (scrolls > MAX_SCROLLS) return answer(rounds, STOP_DONE, null, null, current)
                    justScrolled = true
                }
                is Step.End -> return answer(rounds, STOP_DONE, null, null, current)
            }
        }
    }

    // MARK: - The cursor

    /**
     * The next undone item on this screen, or scroll, or end. End needs the
     * scroll to have just brought nothing new: a screen whose list is longer
     * than one page says Scroll until the scroll stops paying.
     */
    internal fun advance(
        elements: List<PhoneUiElement>,
        plan: Parsed.Ready,
        seen: MutableSet<String>,
        done: MutableSet<String>,
        justScrolled: Boolean,
    ): Step {
        val items = match(elements, plan)
        val fresh = items.map { it.contentKey }.filter { it !in seen }
        seen.addAll(items.map { it.contentKey })
        val next = items.firstOrNull { it.contentKey !in done }
        if (next != null) return Step.DoNext(next)
        return if (justScrolled && fresh.isEmpty()) Step.End else Step.Scroll
    }

    /** Every element the item selector names, as [Item]s with their stable keys. */
    internal fun match(elements: List<PhoneUiElement>, plan: Parsed.Ready): List<Item> {
        val out = ArrayList<Item>()
        for (element in elements) {
            val role = element.className ?: ""
            val label = element.text ?: element.description ?: ""
            if (plan.role != null && !role.contains(plan.role, ignoreCase = true)) continue
            if (plan.text != null && !label.contains(plan.text, ignoreCase = true)) continue
            if (plan.resourceId != null && element.viewId?.contains(plan.resourceId, ignoreCase = true) != true) continue
            out += Item(contentKey = "$role|$label", ref = element.ref, label = label.ifEmpty { element.viewId ?: "" })
        }
        return out
    }

    // MARK: - One item

    private suspend fun runItem(item: Item, plan: Parsed.Ready): Round {
        val body = buildJsonObject {
            put("commands", substituted(plan.body, item.label, item.ref))
        }
        return when (val outcome = runBody(body)) {
            is PhoneToolOutcome.Success -> {
                val stopped = (outcome.result["stopped"] as? JsonPrimitive)?.contentOrNull ?: STOP_DONE
                Round(item.contentKey, stopped == STOP_DONE, stopped.takeIf { it != STOP_DONE }, null)
            }
            is PhoneToolOutcome.Failure -> Round(item.contentKey, false, STOP_FAILED, outcome.error)
        }
    }

    /**
     * The body with every `@item` resolved: a step's `text` of exactly `@item`
     * names the current item — the target for a tap, the content for a type —
     * and a tap so named carries the ref this round's snapshot issued, which
     * [runBody]'s own runner re-finds by identity on its fresh snapshot.
     */
    private fun substituted(body: JsonArray, label: String, ref: String): JsonArray = JsonArray(body.map { step ->
        val source = step as? JsonObject ?: return@map step
        val out = LinkedHashMap<String, kotlinx.serialization.json.JsonElement>()
        for ((key, value) in source) {
            if (key == "text" && value is JsonPrimitive && value.contentOrNull == ITEM) {
                val isTarget = (source["op"] as? JsonPrimitive)?.contentOrNull == "tap"
                out[key] = JsonPrimitive(label)
                if (isTarget) out["ref"] = JsonPrimitive(ref)
            } else {
                out[key] = value
            }
        }
        JsonObject(out)
    })

    // MARK: - Arguments

    fun parse(arguments: JsonObject): Parsed {
        val item = arguments["item"] as? JsonObject ?: return Parsed.Refused("缺少参数 item。")
        val role = item.stringArg("role")
        val text = item.stringArg("text")
        val resourceId = item.stringArg("resourceId")
        tooLong("role", role, PhoneUiRules.MAX_QUERY_ROLE)?.let { return Parsed.Refused(it) }
        tooLong("text", text, PhoneUiRules.MAX_QUERY_TEXT)?.let { return Parsed.Refused(it) }
        tooLong("resourceId", resourceId, PhoneUiRules.MAX_QUERY_RESOURCE_ID)?.let { return Parsed.Refused(it) }
        if (role == null && text == null && resourceId == null) {
            return Parsed.Refused("item 需要 role、text 或 resourceId 中的至少一个。")
        }
        val body = arguments["body"] as? JsonArray ?: return Parsed.Refused("缺少参数 body。")
        if (body.isEmpty()) return Parsed.Refused("body 至少要有一条步骤。")
        if (body.size > MAX_BODY) return Parsed.Refused("body 最多 $MAX_BODY 条步骤。")
        val onError = arguments.stringArg("on_error") ?: "stop"
        if (onError != "stop" && onError != "skip") return Parsed.Refused("on_error 可选：stop、skip。")
        val reveal = arguments.stringArg("reveal") ?: "scroll"
        if (reveal != "scroll" && reveal != "none") return Parsed.Refused("reveal 可选：scroll、none。")
        val maxItems = (arguments["max_items"] as? JsonPrimitive)?.longOrNull?.toInt() ?: DEFAULT_MAX_ITEMS
        if (maxItems < 1 || maxItems > MAX_ITEMS) return Parsed.Refused("max_items 取 1 到 $MAX_ITEMS。")
        return Parsed.Ready(role, text, resourceId, body, onError == "stop", reveal == "scroll", maxItems)
    }

    // MARK: - The answer

    private fun answer(rounds: List<Round>, stopped: String, stoppedAt: String?, error: String?, current: PhoneUiSnapshot): PhoneToolOutcome =
        PhoneToolOutcome.Success(
            buildJsonObject {
                put("done", rounds.count { it.ok })
                put("failed", rounds.count { !it.ok })
                put("stopped", stopped)
                stoppedAt?.let { put("stoppedAt", it) }
                error?.let { put("error", it) }
                put("perItem", JsonArray(rounds.map { round ->
                    buildJsonObject {
                        put("key", round.contentKey)
                        put("ok", round.ok)
                        round.stopped?.let { put("stopped", it) }
                    }
                }))
                put("screen", buildJsonObject {
                    put("snapshot", current.id)
                    topPackage()?.let { put("topPackage", it) }
                    put("truncated", current.truncated)
                    put("elements", JsonArray(current.elements.map(elementJson)))
                })
            },
        )

    private fun tooLong(name: String, value: String?, max: Int): String? =
        if ((value?.length ?: 0) > max) "item 的 $name 过长。" else null

    private companion object {
        const val CODE_UNSUPPORTED = "unsupported"
        const val NO_SNAPSHOT = "此 Android 版本无法按显示器读取窗口。"
        const val STOP_DONE = "done"
        const val STOP_FAILED = "failed"
        const val ITEM = "@item"

        /** The same bounds the server's schema advertises, checked again here. */
        const val MAX_BODY = 30
        const val DEFAULT_MAX_ITEMS = 20
        const val MAX_ITEMS = 50

        /** A screen that scrolls but never ends cannot run the cap out one scroll at a time. */
        const val MAX_SCROLLS = 200
    }
}

private fun JsonObject.stringArg(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
