/*
 * Pins PHONE_UI_RUN's pure halves: the command list it accepts, how a selector
 * resolves against one snapshot's elements (a stale ref falls back, an
 * ambiguous match is refused), and the answer a run builds when a step fails.
 * No Android: the snapshot and the single-action call are plain lambdas here.
 */
package com.lunabot.companion.phoneui

import com.lunabot.companion.core.PhoneTool
import com.lunabot.companion.phone.PhoneToolOutcome
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PhoneUiRunTest {
    private fun element(
        ref: String,
        text: String? = null,
        description: String? = null,
        viewId: String? = null,
        className: String? = null,
        clickable: Boolean = false,
        editable: Boolean = false,
    ) = PhoneUiElement(
        ref = ref,
        viewId = viewId,
        className = className,
        text = text,
        description = description,
        bounds = listOf(0, 0, 100, 100),
        clickable = clickable,
        editable = editable,
        scrollable = false,
        password = false,
    )

    private fun run(
        snapshot: () -> PhoneUiSnapshot? = { PhoneUiSnapshot("s1", 3, 0L, false, emptyList()) },
        identify: (String) -> PhoneUiRun.Identity? = { null },
        perform: suspend (PhoneTool, JsonObject) -> PhoneToolOutcome = { _, _ -> PhoneToolOutcome.Success(buildJsonObject { put("changed", true) }) },
    ) = PhoneUiRun(
        snapshot = snapshot,
        identify = identify,
        perform = perform,
        topPackage = { "com.example.app" },
        elementJson = { element ->
            buildJsonObject {
                put("ref", element.ref)
                element.text?.let { put("text", it) }
            }
        },
    )

    private fun commands(vararg steps: JsonObject): JsonObject = buildJsonObject { put("commands", JsonArray(steps.toList())) }

    private fun step(vararg fields: Pair<String, Any>): JsonObject = buildJsonObject {
        for ((key, value) in fields) {
            when (value) {
                is String -> put(key, value)
                is Boolean -> put(key, value)
                is Int -> put(key, value)
                else -> error("unsupported test value for $key")
            }
        }
    }

    private fun parsed(arguments: JsonObject): List<PhoneUiRun.Command> =
        (run().parse(arguments) as PhoneUiRun.Parsed.Ready).commands

    private fun refusal(arguments: JsonObject): String =
        (run().parse(arguments) as PhoneUiRun.Parsed.Refused).message

    @Test
    fun `a well formed list becomes commands with their own place`() {
        val list = parsed(
            commands(
                step("op" to "launch", "app" to "com.miui.calculator"),
                step("op" to "tap", "text" to "7"),
                step("op" to "type", "resourceId" to "com.miui.calculator:id/result", "text" to "12", "pressEnter" to true),
                step("op" to "wait", "timeoutMs" to 1_000),
                step("op" to "observe"),
            ),
        )
        assertEquals(listOf(0, 1, 2, 3, 4), list.map { it.index })
        assertEquals(PhoneUiRun.Op.LAUNCH, list[0].op)
        assertEquals("com.miui.calculator", list[0].app)
        assertEquals("12", list[2].text)
        assertTrue(list[2].pressEnter)
        assertEquals(1_000L, list[3].timeoutMs)
        assertEquals(1_000L, (list[3].actionArguments(null)["timeoutMs"] as JsonPrimitive).content.toLong())
        // A wait always has a bound: this build's default when none came.
        val unbounded = parsed(commands(step("op" to "wait"))).single()
        assertEquals(
            PhoneUiRules.DEFAULT_RUN_WAIT_MS,
            (unbounded.actionArguments(null)["timeoutMs"] as JsonPrimitive).content.toLong(),
        )
    }

    @Test
    fun `a list that cannot run is refused with the step that broke it`() {
        assertTrue(refusal(JsonObject(emptyMap())).contains("commands"))
        assertTrue(refusal(commands()).contains("至少要有一条"))
        assertTrue(refusal(commands(*(0 until 21).map { step("op" to "observe") }.toTypedArray())).contains("最多"))
        assertTrue(refusal(commands(step("op" to "pinch"))).contains("op 不支持"))
        assertTrue(refusal(commands(step("op" to "launch"))).contains("第 1 步缺少 app"))
        assertTrue(refusal(commands(step("op" to "tap", "text" to "发送"), step("op" to "launch", "app" to "not a package"))).contains("第 2 步"))
        assertTrue(refusal(commands(step("op" to "tap"))).contains("没有给出要点的目标"))
        assertTrue(refusal(commands(step("op" to "type", "text" to "12"))).contains("没有给出要输入的输入框"))
        assertTrue(refusal(commands(step("op" to "type", "ref" to "e1"))).contains("缺少要输入的 text"))
        assertTrue(refusal(commands(step("op" to "swipe"))).contains("缺少 direction"))
        assertTrue(refusal(commands(step("op" to "key"))).contains("缺少 key"))
        assertTrue(refusal(commands(step("op" to "assert"))).contains("缺少要核对的 text"))
        assertTrue(refusal(commands(step("op" to "tap", "text" to "x".repeat(PhoneUiRules.MAX_RUN_TEXT + 1)))).contains("过长"))
        assertTrue(refusal(commands(step("op" to "tap", "ref" to "e".repeat(65)))).contains("过长"))
    }

    @Test
    fun `a ref still on the screen wins over every other selector`() {
        val elements = listOf(
            element("e1", text = "搜索", clickable = true),
            element("e2", text = "发送", viewId = "com.example:id/send", clickable = true),
        )
        val command = parsed(commands(step("op" to "tap", "ref" to "e2", "text" to "搜索"))).single()
        val found = run().resolve(command, elements) as PhoneUiRun.Resolution.Found
        assertEquals("e2", found.element.ref)
        assertEquals("发送", found.matched)
    }

    @Test
    fun `a stale ref falls back to the next selector`() {
        val elements = listOf(element("e9", text = "发送", clickable = true))
        val command = parsed(commands(step("op" to "tap", "ref" to "gone", "text" to "发送"))).single()
        val found = run().resolve(command, elements) as PhoneUiRun.Resolution.Found
        assertEquals("e9", found.element.ref)
    }

    @Test
    fun `a stale ref is found again by what it looked like, not by its token`() {
        val fresh = element("n7", text = "发送", viewId = "com.example:id/send", clickable = true)
        val identity = PhoneUiRun.Identity(
            text = "发送",
            description = null,
            viewId = "com.example:id/send",
            bounds = fresh.bounds,
        )
        val command = parsed(commands(step("op" to "tap", "ref" to "old"))).single()
        // The snapshot rotated, so the old token is gone; the element is still there.
        assertEquals("n7", (run().resolve(command, listOf(fresh), identity) as PhoneUiRun.Resolution.Found).element.ref)
        // The same place with a different id and a different label is not the target.
        val replaced = fresh.copy(text = "草稿", viewId = "com.example:id/draft")
        assertTrue(run().resolve(command, listOf(replaced), identity) is PhoneUiRun.Resolution.Missing)
        // A field keeps its id while its text changes, so a type step's target survives.
        assertTrue(identity.matches(fresh.copy(text = "已输入")))
        // Nothing to look for means the step cannot act at all.
        val bare = command.copy(ref = "old", text = null)
        assertTrue(run().resolve(bare, emptyList()) is PhoneUiRun.Resolution.Missing)
    }

    @Test
    fun `resourceId and role narrow before text, as the contract orders them`() {
        val elements = listOf(
            element("e1", text = "发送", viewId = "com.example:id/draft", clickable = true),
            element("e2", text = "发送", viewId = "com.example:id/send", className = "android.widget.Button", clickable = true),
        )
        val byId = parsed(commands(step("op" to "tap", "resourceId" to "id/send", "text" to "发送"))).single()
        assertEquals("e2", (run().resolve(byId, elements) as PhoneUiRun.Resolution.Found).element.ref)
        val byRole = parsed(commands(step("op" to "tap", "role" to "Button", "text" to "发送"))).single()
        assertEquals("e2", (run().resolve(byRole, elements) as PhoneUiRun.Resolution.Found).element.ref)
    }

    @Test
    fun `an exact label is chosen before a substring one`() {
        val elements = listOf(
            element("e1", text = "Send message", clickable = true),
            element("e2", text = "Send", clickable = true),
        )
        val command = parsed(commands(step("op" to "tap", "text" to "send"))).single()
        assertEquals("e2", (run().resolve(command, elements) as PhoneUiRun.Resolution.Found).element.ref)
        // A description is a label too, the way a person hears it.
        val described = listOf(element("e3", description = "返回", clickable = true))
        assertEquals("e3", (run().resolve(command.copy(text = "返回"), described) as PhoneUiRun.Resolution.Found).element.ref)
    }

    @Test
    fun `several matches are only allowed when exactly one is clickable`() {
        val command = parsed(commands(step("op" to "tap", "text" to "发送"))).single()
        val oneClickable = listOf(
            element("e1", text = "发送", clickable = false),
            element("e2", text = "发送", clickable = true),
        )
        assertEquals("e2", (run().resolve(command, oneClickable) as PhoneUiRun.Resolution.Found).element.ref)
        val bothClickable = listOf(
            element("e1", text = "发送", clickable = true),
            element("e2", text = "发送", clickable = true),
        )
        val ambiguous = run().resolve(command, bothClickable) as PhoneUiRun.Resolution.Missing
        assertTrue(ambiguous.message.contains("不止一个"))
        val none = run().resolve(command, emptyList()) as PhoneUiRun.Resolution.Missing
        assertTrue(none.message.contains("没有找到"))
    }

    @Test
    fun `the single-action call receives the fresh ref and only the fields its step uses`() {
        val command = parsed(
            commands(step("op" to "type", "ref" to "old", "resourceId" to "id/field", "text" to "12", "pressEnter" to true)),
        ).single()
        val target = element("e7", viewId = "com.example:id/field", editable = true)
        val arguments = command.actionArguments(target)
        assertEquals("e7", arguments["ref"]?.jsonPrimitive?.content)
        assertEquals("12", arguments["text"]?.jsonPrimitive?.content)
        assertEquals(setOf("ref", "text"), arguments.keys)
    }

    @Test
    fun `a step's answer carries only what it measured`() {
        val command = parsed(commands(step("op" to "tap", "text" to "发送"))).single()
        val acted = run().stepJson(command, PhoneUiRun.StepResult(ok = true, changed = true, matched = "发送"))
        assertEquals(setOf("index", "op", "ok", "changed", "matched"), acted.keys)
        assertEquals(0, acted["index"]?.jsonPrimitive?.int)
        assertEquals("tap", acted["op"]?.jsonPrimitive?.content)
        // A step that only looked changed nothing, so it says nothing about a change.
        val looked = run().stepJson(command, PhoneUiRun.StepResult(ok = true))
        assertEquals(setOf("index", "op", "ok"), looked.keys)
    }

    @Test
    fun `a run stops at the first failed step and still answers the screen`() = runBlocking {
        val screen = PhoneUiSnapshot("s2", 3, 0L, false, listOf(element("e1", text = "结果")))
        val calls = ArrayList<Pair<String, JsonObject>>()
        val runner = run(
            snapshot = { screen },
            perform = { tool, arguments ->
                calls += tool.wire to arguments
                if (tool == PhoneTool.UI_TYPE) {
                    PhoneToolOutcome.Failure("不能写入密码字段。", "denied")
                } else {
                    PhoneToolOutcome.Success(buildJsonObject { put("changed", true) })
                }
            },
        )
        val outcome = runner.execute(
            commands(
                step("op" to "launch", "app" to "com.miui.calculator"),
                step("op" to "tap", "text" to "结果"),
                step("op" to "type", "ref" to "e1", "text" to "12"),
                step("op" to "back"),
            ),
        )
        val result = (outcome as PhoneToolOutcome.Success).result
        assertEquals("failed", result["stopped"]?.jsonPrimitive?.content)
        assertEquals(2, result["stoppedAt"]?.jsonPrimitive?.int)
        assertEquals("不能写入密码字段。", result["error"]?.jsonPrimitive?.content)
        val steps = result["steps"]?.jsonArray ?: error("no steps")
        assertEquals(3, steps.size)
        assertEquals(listOf(true, true, false), steps.map { it.jsonObject["ok"]?.jsonPrimitive?.boolean })
        assertEquals(listOf("launch", "tap", "type"), steps.map { it.jsonObject["op"]?.jsonPrimitive?.content })
        // The fourth step never ran, and nothing was retried.
        assertEquals(listOf("PHONE_UI_LAUNCH", "PHONE_UI_TAP", "PHONE_UI_TYPE"), calls.map { it.first })
        // The screen travels with the answer, in the same shape observe uses.
        assertEquals("s2", result["screen"]?.jsonObject?.get("snapshot")?.jsonPrimitive?.content)
        assertEquals("com.example.app", result["screen"]?.jsonObject?.get("topPackage")?.jsonPrimitive?.content)
    }

    @Test
    fun `a step that needs the person stops the run with its own word`() = runBlocking {
        val screen = PhoneUiSnapshot("s1", 3, 0L, false, listOf(element("e1", text = "分享", clickable = true)))
        val runner = run(
            snapshot = { screen },
            perform = { _, _ -> PhoneToolOutcome.Failure("「com.android.intentresolver」在用户的屏幕上问要用哪个应用。", "needs_user") },
        )
        val outcome = runner.execute(commands(step("op" to "tap", "text" to "分享"), step("op" to "observe")))
        val result = (outcome as PhoneToolOutcome.Success).result
        assertEquals("needs_user", result["stopped"]?.jsonPrimitive?.content)
        assertEquals(0, result["stoppedAt"]?.jsonPrimitive?.int)
        assertEquals(1, result["steps"]?.jsonArray?.size)
    }

    @Test
    fun `assert and observe never act, and a failed assert stops the run`() = runBlocking {
        val screen = PhoneUiSnapshot("s1", 3, 0L, false, listOf(element("e1", text = "已发送")))
        val calls = ArrayList<String>()
        val runner = run(
            snapshot = { screen },
            perform = { tool, _ -> calls += tool.wire; PhoneToolOutcome.Success(buildJsonObject { put("changed", true) }) },
        )
        val ok = (runner.execute(
            commands(
                step("op" to "assert", "text" to "发送"),
                step("op" to "assert", "text" to "草稿", "present" to false),
                step("op" to "observe"),
            ),
        ) as PhoneToolOutcome.Success).result
        assertEquals("done", ok["stopped"]?.jsonPrimitive?.content)
        assertNull(ok["stoppedAt"])
        assertNull(ok["error"])
        assertEquals(3, ok["steps"]?.jsonArray?.size)
        assertTrue(calls.isEmpty())

        val failed = (runner.execute(commands(step("op" to "assert", "text" to "草稿"))).let {
            (it as PhoneToolOutcome.Success).result
        })
        assertEquals("failed", failed["stopped"]?.jsonPrimitive?.content)
        assertFalse(failed["steps"]?.jsonArray?.first()?.jsonObject?.get("ok")?.jsonPrimitive?.boolean ?: true)
    }

    @Test
    fun `a scroll without a target becomes the finger stroke swipe runs`() = runBlocking {
        val screen = PhoneUiSnapshot("s1", 3, 0L, false, emptyList())
        val calls = ArrayList<Pair<String, JsonObject>>()
        val runner = run(
            snapshot = { screen },
            perform = { tool, arguments -> calls += tool.wire to arguments; PhoneToolOutcome.Success(buildJsonObject { put("changed", true) }) },
        )
        val result = (runner.execute(commands(step("op" to "scroll", "direction" to "up"))).let {
            (it as PhoneToolOutcome.Success).result
        })
        assertEquals("done", result["stopped"]?.jsonPrimitive?.content)
        // No element to scroll: the content moves up, so the finger travels down.
        assertEquals("PHONE_UI_SWIPE", calls.single().first)
        assertEquals("down", calls.single().second["direction"]?.jsonPrimitive?.content)
    }

    @Test
    fun `a vertical scroll of an element goes through the scroll action`() = runBlocking {
        val screen = PhoneUiSnapshot("s1", 3, 0L, false, listOf(element("e1", viewId = "com.example:id/list", text = "收件箱")))
        val calls = ArrayList<Pair<String, JsonObject>>()
        val runner = run(
            snapshot = { screen },
            perform = { tool, arguments -> calls += tool.wire to arguments; PhoneToolOutcome.Success(buildJsonObject { put("changed", true) }) },
        )
        val result = (runner.execute(commands(step("op" to "scroll", "direction" to "down", "resourceId" to "id/list"))).let {
            (it as PhoneToolOutcome.Success).result
        })
        assertEquals("done", result["stopped"]?.jsonPrimitive?.content)
        assertEquals("PHONE_UI_SCROLL", calls.single().first)
        assertEquals("e1", calls.single().second["ref"]?.jsonPrimitive?.content)
        assertEquals("down", calls.single().second["direction"]?.jsonPrimitive?.content)
    }

    @Test
    fun `a run whose final snapshot cannot be read still answers its steps`() = runBlocking {
        var reads = 0
        val runner = run(snapshot = { if (reads++ == 0) PhoneUiSnapshot("s1", 3, 0L, false, emptyList()) else null })
        val result = (runner.execute(commands(step("op" to "observe"))).let { (it as PhoneToolOutcome.Success).result })
        assertEquals("done", result["stopped"]?.jsonPrimitive?.content)
        assertNull(result["screen"])
    }
}
