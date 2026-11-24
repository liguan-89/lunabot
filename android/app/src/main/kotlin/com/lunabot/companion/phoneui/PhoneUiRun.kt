/*
 * Ported from Mika (https://github.com/wangzan101/Mika), file
 * core/src/main/kotlin/com/wangzan101/mika/core/cap/phone/PhoneRun.kt
 * (PhoneRun, the phone_run tool).
 * Copyright 2026 wangzan101. The original is licensed under the Apache License,
 * Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 LunaBot contributors. Changes from the
 * original: repackaged under com.lunabot.companion.phoneui, comments
 * translated into English, and reduced to this app's plain accessibility-tree
 * reader and tool surface. A step resolves its selector against the snapshot
 * already in hand rather than calling phone_query, and a ref is found again
 * through the identity read before the first snapshot (bounds plus view id,
 * text or description). pressEnter sends an extra enter key action after the
 * type action, `wait` waits for the screen to change rather than for text to
 * appear or disappear, and `assert` checks the snapshot already read. Mika's
 * `clear` operation, coordinate taps, `whenText` conditional skip, `cold`
 * launch, scroll amount, swipe coordinates and duration, OCR and
 * frame-capture checks, and interruptible text wait are not ported; stop
 * codes come from the single actions' own outcomes instead of Mika's
 * app_switched, display_capture_unavailable and screen_needs_review
 * verdicts, the list is capped at 20 steps rather than Mika's 30, and the
 * answer reports stopped, stoppedAt and the ending screen instead of Mika's
 * completed/total counts.
 */
package com.lunabot.companion.phoneui

import com.lunabot.companion.core.PhoneTool
import com.lunabot.companion.phone.PhoneToolOutcome
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * PHONE_UI_RUN: an ordered list of screen commands answered by one job. Each
 * step takes a fresh snapshot first and finds its target again on the current
 * screen, so a ref from an earlier observe is a hint, never a promise; the run
 * stops at the first step that fails rather than carrying on with a stale
 * target.
 *
 * The loop lives here, apart from [PhoneUiTaskExecutor], which hands it the
 * pieces it needs: a fresh snapshot, the identity behind a ref (read before
 * that snapshot rotates the registry), the single-action paths every other
 * PHONE_UI tool takes, the package in front, and the element shape. The pure
 * halves — parsing the arguments, resolving a selector against a snapshot's
 * elements, and assembling the answer — are plain functions over data, so they
 * are pinned by JVM tests without a device.
 */
internal class PhoneUiRun(
    private val snapshot: () -> PhoneUiSnapshot?,
    /** What the element behind a ref looked like, read before the fresh snapshot replaces its refs. */
    private val identify: (String) -> Identity?,
    private val perform: suspend (PhoneTool, JsonObject) -> PhoneToolOutcome,
    private val topPackage: () -> String?,
    private val elementJson: (PhoneUiElement) -> JsonObject,
) {
    /**
     * The parts of an element that outlive its ref: a snapshot issues new refs
     * every time, so the target is found again by what it looked like, never by
     * the old token.
     */
    internal data class Identity(
        val text: String?,
        val description: String?,
        val viewId: String?,
        val bounds: List<Int>,
    ) {
        /**
         * The same element on the new screen: the same place, still carrying one
         * of the labels it carried before. A view id is the strongest; text and
         * description follow, so a field whose text changed after a type still
         * matches by its id. A bare class name is never enough to act on.
         */
        fun matches(element: PhoneUiElement): Boolean =
            bounds == element.bounds && (
                (viewId != null && viewId == element.viewId) ||
                    (text != null && text == element.text) ||
                    (description != null && description == element.description)
                )
    }

    /** What one step does on the screen. */
    internal enum class Op(val wire: String) {
        LAUNCH("launch"),
        TAP("tap"),
        TYPE("type"),
        SCROLL("scroll"),
        SWIPE("swipe"),
        KEY("key"),
        BACK("back"),
        WAIT("wait"),
        ASSERT("assert"),
        OBSERVE("observe"),
        ;

        companion object {
            private val byWire = entries.associateBy(Op::wire)

            fun of(value: String?): Op? = byWire[value]
        }
    }

    /** One step of the list, already validated. [index] is its place in the list, from 0. */
    internal data class Command(
        val index: Int,
        val op: Op,
        val app: String? = null,
        val ref: String? = null,
        val text: String? = null,
        val resourceId: String? = null,
        val role: String? = null,
        val direction: String? = null,
        val key: String? = null,
        val timeoutMs: Long? = null,
        val present: Boolean? = null,
        val pressEnter: Boolean = false,
    ) {
        /** Whether the step needs an element to act on. For type, text is what to type, never the target. */
        val needsTarget: Boolean get() = op == Op.TAP || op == Op.TYPE

        /** Text names the target for tap; for type and assert it is the text itself. */
        val usesTextAsSelector: Boolean get() = op == Op.TAP

        /** Whether a selector arrived at all. */
        val hasSelector: Boolean
            get() = ref != null || resourceId != null || role != null || (usesTextAsSelector && text != null)

        /**
         * The arguments the single-action tool takes, with [target]'s fresh ref
         * where the step needs one. A field this step does not use stays out, so
         * the action sees exactly what it would have seen alone.
         */
        fun actionArguments(target: PhoneUiElement?): JsonObject = buildJsonObject {
            when (op) {
                Op.LAUNCH -> app?.let { put("app", it) }
                Op.TAP -> target?.let { put("ref", it.ref) }
                Op.TYPE -> {
                    target?.let { put("ref", it.ref) }
                    text?.let { put("text", it) }
                }
                Op.SCROLL -> {
                    direction?.let { put("direction", it) }
                    target?.let { put("ref", it.ref) }
                }
                Op.SWIPE -> direction?.let { put("direction", it) }
                Op.KEY -> key?.let { put("key", it) }
                Op.WAIT -> {
                    put("mode", "change")
                    put("timeoutMs", timeoutMs ?: PhoneUiRules.DEFAULT_RUN_WAIT_MS)
                }
                Op.BACK, Op.ASSERT, Op.OBSERVE -> Unit
            }
        }
    }

    /** The parsed list, or the sentence saying why it cannot run. */
    internal sealed interface Parsed {
        data class Ready(val commands: List<Command>) : Parsed
        data class Refused(val message: String) : Parsed
    }

    /** Where a step's target came from, or why it has none. */
    internal sealed interface Resolution {
        data class Found(val element: PhoneUiElement, val matched: String) : Resolution
        data class Missing(val message: String) : Resolution
    }

    /** One step's outcome, before it becomes JSON. */
    internal class StepResult(
        val ok: Boolean,
        val changed: Boolean? = null,
        val matched: String? = null,
        val stopped: String? = null,
        val error: String? = null,
    )

    suspend fun execute(arguments: JsonObject): PhoneToolOutcome {
        val parsed = parse(arguments)
        if (parsed is Parsed.Refused) return PhoneToolOutcome.Failure(parsed.message, CODE_UNSUPPORTED)
        val commands = (parsed as Parsed.Ready).commands
        // What each ref pointed at is read before the first snapshot, because
        // taking one rotates the registry and every ref from the observe before
        // this run stops resolving.
        val known = commands.map { command -> command.ref?.let(identify) }
        val steps = ArrayList<JsonObject>()
        var stopped = STOP_DONE
        var stoppedAt: Int? = null
        var error: String? = null
        for ((at, command) in commands.withIndex()) {
            // A fresh snapshot per step: the screen may have moved since the last
            // action, and the refs it issues are the only ones an action may use.
            val current = snapshot()
                ?: return PhoneToolOutcome.Failure(NO_SNAPSHOT, CODE_UNSUPPORTED)
            val result = evaluate(command, current.elements, known[at])
            steps += stepJson(command, result)
            if (!result.ok) {
                stopped = result.stopped ?: STOP_FAILED
                stoppedAt = command.index
                error = result.error ?: "第 ${command.index + 1} 步没有成功。"
                break
            }
        }
        return PhoneToolOutcome.Success(
            buildJsonObject {
                put("steps", JsonArray(steps))
                put("stopped", stopped)
                stoppedAt?.let { put("stoppedAt", it) }
                error?.let { put("error", it) }
                screenJson()?.let { put("screen", it) }
            },
        )
    }

    // MARK: - Arguments

    /**
     * The list as commands, or the first reason it is not one. The schema the
     * server checks is the same shape; this is what a phone may trust when a
     * newer server sends more than this build knows.
     */
    fun parse(arguments: JsonObject): Parsed {
        val list = arguments["commands"] as? JsonArray
            ?: return Parsed.Refused("缺少参数 commands。")
        if (list.isEmpty()) return Parsed.Refused("commands 至少要有一条。")
        if (list.size > PhoneUiRules.MAX_RUN_COMMANDS) {
            return Parsed.Refused("commands 最多 ${PhoneUiRules.MAX_RUN_COMMANDS} 条。")
        }
        val commands = ArrayList<Command>(list.size)
        for ((index, element) in list.withIndex()) {
            val step = element as? JsonObject ?: return Parsed.Refused(stepMessage(index, "不是对象。"))
            val op = Op.of(step.stringArg("op"))
                ?: return Parsed.Refused(stepMessage(index, "op 不支持，可选：${Op.entries.joinToString("、") { it.wire }}。"))
            val app = step.stringArg("app")
            val ref = step.stringArg("ref")
            val text = step.stringArg("text")
            val resourceId = step.stringArg("resourceId")
            val role = step.stringArg("role")
            val direction = step.stringArg("direction")
            val key = step.stringArg("key")
            tooLong(index, "app", app, MAX_APP_NAME)?.let { return Parsed.Refused(it) }
            tooLong(index, "ref", ref, MAX_REF)?.let { return Parsed.Refused(it) }
            tooLong(index, "text", text, PhoneUiRules.MAX_RUN_TEXT)?.let { return Parsed.Refused(it) }
            tooLong(index, "resourceId", resourceId, PhoneUiRules.MAX_QUERY_RESOURCE_ID)?.let { return Parsed.Refused(it) }
            tooLong(index, "role", role, PhoneUiRules.MAX_QUERY_ROLE)?.let { return Parsed.Refused(it) }
            when (op) {
                Op.LAUNCH -> {
                    if (app == null) return Parsed.Refused(stepMessage(index, "缺少 app。"))
                    if (!PhoneUiRules.isValidPackageName(app)) return Parsed.Refused(stepMessage(index, "包名不合法。"))
                }
                Op.TAP -> if (ref == null && text == null && resourceId == null && role == null) {
                    return Parsed.Refused(stepMessage(index, "没有给出要点的目标。"))
                }
                Op.TYPE -> {
                    if (text == null) return Parsed.Refused(stepMessage(index, "缺少要输入的 text。"))
                    if (ref == null && resourceId == null && role == null) {
                        return Parsed.Refused(stepMessage(index, "没有给出要输入的输入框。"))
                    }
                }
                Op.SWIPE -> if (direction == null) return Parsed.Refused(stepMessage(index, "缺少 direction。"))
                Op.KEY -> if (key == null) return Parsed.Refused(stepMessage(index, "缺少 key。"))
                Op.ASSERT -> if (text == null) return Parsed.Refused(stepMessage(index, "缺少要核对的 text。"))
                Op.SCROLL, Op.BACK, Op.OBSERVE, Op.WAIT -> Unit
            }
            commands += Command(
                index = index,
                op = op,
                app = app,
                ref = ref,
                text = text,
                resourceId = resourceId,
                role = role,
                direction = direction?.lowercase(),
                key = key?.lowercase(),
                timeoutMs = step.longArg("timeoutMs")?.coerceIn(MIN_WAIT_MS, MAX_WAIT_MS),
                present = step.booleanArg("present"),
                pressEnter = step.booleanArg("pressEnter") == true,
            )
        }
        return Parsed.Ready(commands)
    }

    // MARK: - Target resolution

    /**
     * The element this step should act on, found in the fresh snapshot. A ref
     * wins while its element is still there: the same token when the snapshot
     * did not rotate, else what the ref described. Then the first selector
     * supplied narrows the list, in the contract's order. Several matches are
     * only acceptable when exactly one of them is clickable, so a step never
     * taps a guess.
     *
     * This is deliberately not the executor's `matches`: that one ANDs every
     * filter it is given, for a query that wants all of them to hold, while a
     * step carries one target selector and needs a single answer. It also has no
     * exact-before-substring rule and no ambiguity verdict.
     */
    fun resolve(command: Command, elements: List<PhoneUiElement>, known: Identity? = null): Resolution {
        if (command.ref != null) {
            val byRef = elements.firstOrNull { it.ref == command.ref }
                ?: known?.let { identity -> elements.firstOrNull(identity::matches) }
            if (byRef != null) return Resolution.Found(byRef, labelOf(byRef))
        }
        val matches = when {
            command.resourceId != null ->
                elements.filter { it.viewId?.contains(command.resourceId, ignoreCase = true) == true }
            command.role != null ->
                elements.filter { it.className?.contains(command.role, ignoreCase = true) == true }
            command.usesTextAsSelector && command.text != null -> textMatches(elements, command.text)
            command.ref != null -> return Resolution.Missing(
                stepMessage(command.index, "原来的 ref 已不在这一屏上，也没有别的定位条件。"),
            )
            else -> return Resolution.Missing(stepMessage(command.index, "没有可以用来定位目标的选择条件。"))
        }
        if (matches.isEmpty()) {
            val what = command.ref?.let { "原来的 ref 已不在这一屏上，" } ?: ""
            return Resolution.Missing(stepMessage(command.index, "${what}没有找到匹配的元素。"))
        }
        val chosen = if (matches.size == 1) matches.single() else matches.filter { it.clickable }.singleOrNull()
        if (chosen == null) {
            return Resolution.Missing(stepMessage(command.index, "匹配到不止一个元素，请换一个更准确的条件。"))
        }
        return Resolution.Found(chosen, labelOf(chosen))
    }

    /** An exact label first, then a substring one, both case-insensitive. */
    private fun textMatches(elements: List<PhoneUiElement>, text: String): List<PhoneUiElement> {
        val exact = elements.filter { it.text.equals(text, ignoreCase = true) || it.description.equals(text, ignoreCase = true) }
        return exact.ifEmpty {
            elements.filter { element ->
                listOfNotNull(element.text, element.description).any { it.contains(text, ignoreCase = true) }
            }
        }
    }

    private fun labelOf(element: PhoneUiElement): String =
        element.text ?: element.description ?: element.viewId ?: element.className ?: ""

    // MARK: - One step

    private suspend fun evaluate(command: Command, elements: List<PhoneUiElement>, known: Identity?): StepResult =
        when (command.op) {
            Op.OBSERVE -> StepResult(ok = true)
            Op.ASSERT -> {
                if (assertionHolds(command, elements)) {
                    StepResult(ok = true, matched = command.text)
                } else {
                    StepResult(ok = false, stopped = STOP_FAILED, error = stepMessage(command.index, "要核对的内容和这一屏不符。"))
                }
            }
            Op.WAIT -> {
                val outcome = perform(PhoneTool.UI_WAIT, command.actionArguments(null))
                if (outcome is PhoneToolOutcome.Failure) {
                    StepResult(ok = false, stopped = stopOf(outcome.code), error = outcome.error)
                } else {
                    StepResult(ok = true, changed = (outcome as PhoneToolOutcome.Success).result.booleanArg("changed"))
                }
            }
            else -> act(command, elements, known)
        }

    private suspend fun act(command: Command, elements: List<PhoneUiElement>, known: Identity?): StepResult {
        val target = if (command.needsTarget || (command.op == Op.SCROLL && command.hasSelector)) {
            when (val found = resolve(command, elements, known)) {
                is Resolution.Found -> found.element
                is Resolution.Missing -> return StepResult(ok = false, stopped = STOP_FAILED, error = found.message)
            }
        } else {
            null
        }
        // The scroll action is vertical only, and it takes where the content
        // moves; the finger travels the other way. A horizontal scroll, or one
        // with no element to scroll, is the same stroke swipe runs, which takes
        // the finger's own direction.
        if (command.op == Op.SCROLL) {
            val content = command.direction ?: "down"
            if (target == null || content == "left" || content == "right") {
                val finger = when (content) {
                    "up" -> "down"
                    "down" -> "up"
                    "left" -> "right"
                    else -> "left"
                }
                return stepResult(perform(PhoneTool.UI_SWIPE, buildJsonObject { put("direction", finger) }), target)
            }
        }
        val first = stepResult(perform(toolOf(command.op), command.actionArguments(target)), target)
        if (!first.ok || !command.pressEnter || command.op != Op.TYPE) return first
        // Enter is part of the type step, not a step of its own: a keyboard's
        // search key is how a form submits, and its failure is the step's.
        val enter = stepResult(perform(PhoneTool.UI_KEY, buildJsonObject { put("key", "enter") }), target)
        return StepResult(
            ok = enter.ok,
            changed = first.changed == true || enter.changed == true,
            matched = first.matched,
            stopped = enter.stopped,
            error = enter.error,
        )
    }

    private fun stepResult(outcome: PhoneToolOutcome, target: PhoneUiElement?): StepResult = when (outcome) {
        is PhoneToolOutcome.Success -> StepResult(
            ok = true,
            changed = outcome.result.booleanArg("changed"),
            matched = target?.let(::labelOf),
        )
        is PhoneToolOutcome.Failure -> StepResult(
            ok = false,
            matched = target?.let(::labelOf),
            stopped = stopOf(outcome.code),
            error = outcome.error,
        )
    }

    private fun toolOf(op: Op): PhoneTool = when (op) {
        Op.LAUNCH -> PhoneTool.UI_LAUNCH
        Op.TAP -> PhoneTool.UI_TAP
        Op.TYPE -> PhoneTool.UI_TYPE
        Op.SCROLL -> PhoneTool.UI_SCROLL
        Op.SWIPE -> PhoneTool.UI_SWIPE
        Op.KEY -> PhoneTool.UI_KEY
        Op.BACK -> PhoneTool.UI_BACK
        Op.WAIT -> PhoneTool.UI_WAIT
        // Neither acts; the loop answers these from the snapshot it already took.
        Op.ASSERT, Op.OBSERVE -> PhoneTool.UI_OBSERVE
    }

    private fun assertionHolds(command: Command, elements: List<PhoneUiElement>): Boolean {
        val text = command.text ?: return false
        val present = elements.any { element ->
            listOfNotNull(element.text, element.description).any { it.contains(text, ignoreCase = true) }
        }
        return present == (command.present ?: true)
    }

    // MARK: - The answer

    internal fun stepJson(command: Command, result: StepResult): JsonObject = buildJsonObject {
        put("index", command.index)
        put("op", command.op.wire)
        put("ok", result.ok)
        result.changed?.let { put("changed", it) }
        result.matched?.let { put("matched", it) }
    }

    /** The fresh screen the run ended on, so the bot needs no follow-up observe. */
    private fun screenJson(): JsonObject? {
        val current = snapshot() ?: return null
        return buildJsonObject {
            put("snapshot", current.id)
            topPackage()?.let { put("topPackage", it) }
            put("truncated", current.truncated)
            put("elements", JsonArray(current.elements.map(elementJson)))
        }
    }

    private fun stopOf(code: String?): String = when (code) {
        CODE_NEEDS_USER -> STOP_NEEDS_USER
        CODE_OPENED_ELSEWHERE -> STOP_OPENED_ELSEWHERE
        else -> STOP_FAILED
    }

    private fun stepMessage(index: Int, message: String): String = "第 ${index + 1} 步$message"

    private fun tooLong(index: Int, name: String, value: String?, max: Int): String? =
        if ((value?.length ?: 0) > max) stepMessage(index, "的 $name 过长。") else null

    private companion object {
        /** The executor's own words for a step that must not be retried; the same codes travel on the wire. */
        const val CODE_NEEDS_USER = "needs_user"
        const val CODE_OPENED_ELSEWHERE = "opened_elsewhere"
        const val CODE_UNSUPPORTED = "unsupported"
        const val NO_SNAPSHOT = "此 Android 版本无法按显示器读取窗口。"

        const val STOP_DONE = "done"
        const val STOP_FAILED = "failed"
        const val STOP_NEEDS_USER = "needs_user"
        const val STOP_OPENED_ELSEWHERE = "opened_elsewhere"

        const val MIN_WAIT_MS = 300L
        const val MAX_WAIT_MS = 6_000L

        /** The same bounds the server's schema advertises, checked again here. */
        const val MAX_APP_NAME = 200
        const val MAX_REF = 64
    }
}

private fun JsonObject.stringArg(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }

private fun JsonObject.booleanArg(key: String): Boolean? =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.booleanOrNull

private fun JsonObject.longArg(key: String): Long? =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.longOrNull
