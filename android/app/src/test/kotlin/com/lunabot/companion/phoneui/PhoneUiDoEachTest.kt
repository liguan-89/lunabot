/*
 * Pins the do_each loop: the cursor recognizes items by a stable content key,
 * walks them once each across scrolls, tells scroll from end, honours the
 * failure semantics and the item cap, and substitutes "@item" into the body.
 */
package com.lunabot.companion.phoneui

import com.lunabot.companion.phone.PhoneToolOutcome
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

class PhoneUiDoEachTest {
    private fun element(
        ref: String,
        className: String = "android.widget.TextView",
        text: String? = null,
        description: String? = null,
        viewId: String? = null,
    ): PhoneUiElement = PhoneUiElement(
        ref = ref, viewId = viewId, className = className, text = text, description = description,
        bounds = listOf(0, 0, 100, 100), clickable = false, editable = false, scrollable = false, password = false,
    )

    private fun plan(
        text: String? = null,
        body: JsonArray = JsonArray(emptyList()),
        stopOnError: Boolean = true,
        reveal: Boolean = true,
        maxItems: Int = 20,
    ): PhoneUiDoEach.Parsed.Ready = PhoneUiDoEach.Parsed.Ready(null, text, null, body, stopOnError, reveal, maxItems)

    private fun seen(vararg keys: String) = HashSet(keys.toList())
    private fun done(vararg keys: String) = HashSet(keys.toList())

    private fun loop(
        snapshot: () -> PhoneUiSnapshot?,
        runBody: suspend (JsonObject) -> PhoneToolOutcome,
        scroll: suspend () -> Boolean = { true },
        elementJson: (PhoneUiElement) -> JsonObject = { element -> buildJsonObject { put("ref", element.ref) } },
    ): PhoneUiDoEach = PhoneUiDoEach(snapshot, runBody, scroll, { null }, elementJson)

    @Test
    fun `an item is recognized by its content key role and label`() {
        val walker = loop({ null }, { throw AssertionError("not used") })
        val items = walker.match(
            listOf(element("e1", text = "Buy milk"), element("e2", text = "Buy bread"), element("e3", text = "other")),
            plan(text = "buy"),
        )
        assertEquals(listOf("android.widget.TextView|Buy milk", "android.widget.TextView|Buy bread"), items.map { it.contentKey })
        assertEquals(listOf("e1", "e2"), items.map { it.ref })
    }

    @Test
    fun `the cursor walks one item per round, then scrolls, then ends`() {
        val walker = loop({ null }, { throw AssertionError("not used") })
        val items = listOf(element("e1", text = "one"), element("e2", text = "two"))
        val p = plan()
        // First read: two items, none done. The first goes; the second waits its turn.
        val first = walker.advance(items, p, seen(), done(), justScrolled = false)
        assertIs<PhoneUiDoEach.Step.DoNext>(first)
        assertEquals("android.widget.TextView|one", first.item.contentKey)
        // Both done and nothing new: not yet the end — it must scroll first.
        val second = walker.advance(items, p, seen("android.widget.TextView|one", "android.widget.TextView|two"), done("android.widget.TextView|one", "android.widget.TextView|two"), justScrolled = false)
        assertIs<PhoneUiDoEach.Step.Scroll>(second)
        // A scroll that brought nothing new is the end.
        val third = walker.advance(items, p, seen("android.widget.TextView|one", "android.widget.TextView|two"), done("android.widget.TextView|one", "android.widget.TextView|two"), justScrolled = true)
        assertEquals(PhoneUiDoEach.Step.End, third)
    }

    @Test
    fun `a scroll that brought new items keeps the walk going`() {
        val walker = loop({ null }, { throw AssertionError("not used") })
        val p = plan()
        val page1 = listOf(element("e1", text = "one"), element("e2", text = "two"))
        val after = walker.advance(page1, p, seen(), done(), justScrolled = false)
        assertIs<PhoneUiDoEach.Step.DoNext>(after)
        val key = after.item.contentKey
        // Both seen and done, then the scroll brought a third item: it goes next.
        val page2 = listOf(element("e3", text = "three"))
        val next = walker.advance(page2, p, seen(key), done(key), justScrolled = true)
        assertIs<PhoneUiDoEach.Step.DoNext>(next)
        assertEquals("e3", next.item.ref)
    }

    @Test
    fun `items named identically collapse into one walk`() {
        val walker = loop({ null }, { throw AssertionError("not used") })
        val items = listOf(element("e1", text = "same"), element("e2", text = "same"))
        val next = walker.advance(items, plan(), seen(), done(), justScrolled = false)
        assertIs<PhoneUiDoEach.Step.DoNext>(next)
        // Both carry one content key, so finishing it ends the list.
        val after = walker.advance(items, plan(), seen(next.item.contentKey), done(next.item.contentKey), justScrolled = true)
        assertEquals(PhoneUiDoEach.Step.End, after)
    }

    @Test
    fun `the parse refuses a bare item selector, an empty body, a long one and an out-of-range cap`() {
        val walker = loop({ null }, { throw AssertionError("not used") })
        assertIs<PhoneUiDoEach.Parsed.Refused>(walker.parse(buildJsonObject { put("body", JsonArray(emptyList())) }))
        assertIs<PhoneUiDoEach.Parsed.Refused>(walker.parse(buildJsonObject {
            put("item", buildJsonObject {})
            put("body", JsonArray(emptyList()))
        }))
        assertIs<PhoneUiDoEach.Parsed.Ready>(walker.parse(buildJsonObject {
            put("item", buildJsonObject { put("text", "row") })
            put("body", JsonArray(listOf(buildJsonObject { put("op", "back") })))
        }))
        assertIs<PhoneUiDoEach.Parsed.Refused>(walker.parse(buildJsonObject {
            put("item", buildJsonObject { put("text", "row") })
            put("body", JsonArray(List(31) { buildJsonObject { put("op", "back") } }))
        }))
        assertIs<PhoneUiDoEach.Parsed.Refused>(walker.parse(buildJsonObject {
            put("item", buildJsonObject { put("text", "row") })
            put("body", JsonArray(listOf(buildJsonObject { put("op", "back") })))
            put("max_items", 51)
        }))
        assertIs<PhoneUiDoEach.Parsed.Refused>(walker.parse(buildJsonObject {
            put("item", buildJsonObject { put("text", "row") })
            put("body", JsonArray(listOf(buildJsonObject { put("op", "back") })))
            put("on_error", "ignore")
        }))
    }

    @Test
    fun `the run walks the list, substitutes at-item, and answers one summary`() = runBlocking {
        val page = listOf(element("r1", text = "Alice"), element("r2", text = "Bob"), element("r3", text = "Carol"))
        val bodies: MutableList<List<String?>> = mutableListOf()
        val walker = loop(
            snapshot = { PhoneUiSnapshot("s", 42, 1L, false, page) },
            runBody = { args ->
                val commands = args["commands"] as JsonArray
                bodies += commands.map { ((it as JsonObject)["text"] as? JsonPrimitive)?.content }
                PhoneToolOutcome.Success(buildJsonObject { put("stopped", "done") })
            },
            scroll = { true },
        )
        val answer = walker.execute(buildJsonObject {
            put("item", buildJsonObject { put("role", "TextView") })
            put("body", JsonArray(listOf(
                buildJsonObject { put("op", "tap"); put("text", "@item") },
                buildJsonObject { put("op", "back") },
            )))
        })
        val result = assertIs<PhoneToolOutcome.Success>(answer).result
        assertEquals(3, (result["done"] as JsonPrimitive).content.toInt())
        assertEquals("done", (result["stopped"] as JsonPrimitive).content)
        assertEquals(3, bodies.size)
        // Every body's tap named the item it ran on, by label; the back step carried no text.
        assertEquals("Alice", bodies[0][0])
        assertEquals("Bob", bodies[1][0])
        assertEquals("Carol", bodies[2][0])
        val perItem = result["perItem"] as JsonArray
        assertTrue(perItem.all { ((it as JsonObject)["ok"] as JsonPrimitive) == JsonPrimitive(true) })
    }

    @Test
    fun `a body failure in stop mode ends the run at that item, and skip marks it done and carries on`() = runBlocking {
        val page = listOf(element("r1", text = "one"), element("r2", text = "two"), element("r3", text = "three"))
        val body = JsonArray(listOf(buildJsonObject { put("op", "tap"); put("text", "@item") }))
        var calls = 0
        val stopMode = loop(
            snapshot = { PhoneUiSnapshot("s", 42, 1L, false, page) },
            runBody = { _ -> if (calls++ == 1) PhoneToolOutcome.Failure("第 1 步没有成功。", "failed") else PhoneToolOutcome.Success(buildJsonObject { put("stopped", "done") }) },
            scroll = { true },
        )
        val stopped = assertIs<PhoneToolOutcome.Success>(stopMode.execute(buildJsonObject {
            put("item", buildJsonObject { put("role", "TextView") })
            put("body", body)
        })).result
        assertEquals(1, (stopped["done"] as JsonPrimitive).content.toInt())
        assertEquals("failed", (stopped["stopped"] as JsonPrimitive).content)
        assertEquals("android.widget.TextView|two", (stopped["stoppedAt"] as JsonPrimitive).content)

        calls = 0
        val skipMode = loop(
            snapshot = { PhoneUiSnapshot("s", 42, 1L, false, page) },
            runBody = { _ -> if (calls++ % 3 == 1) PhoneToolOutcome.Failure("第 1 步没有成功。", "failed") else PhoneToolOutcome.Success(buildJsonObject { put("stopped", "done") }) },
            scroll = { false },
        )
        val answer = assertIs<PhoneToolOutcome.Success>(skipMode.execute(buildJsonObject {
            put("item", buildJsonObject { put("role", "TextView") })
            put("body", body)
            put("on_error", "skip")
        })).result
        assertEquals(2, (answer["done"] as JsonPrimitive).content.toInt())
        assertEquals(1, (answer["failed"] as JsonPrimitive).content.toInt())
        assertEquals("done", (answer["stopped"] as JsonPrimitive).content)
    }

    @Test
    fun `a body that needs the person stops the whole walk with the same word`() = runBlocking {
        val page = listOf(element("r1", text = "one"), element("r2", text = "two"))
        val walker = loop(
            snapshot = { PhoneUiSnapshot("s", 42, 1L, false, page) },
            runBody = { _ -> PhoneToolOutcome.Success(buildJsonObject {
                put("stopped", "needs_user")
                put("error", "「com.android.intentresolver」在用户的屏幕上问要用哪个应用。")
            }) },
        )
        val answer = assertIs<PhoneToolOutcome.Success>(walker.execute(buildJsonObject {
            put("item", buildJsonObject { put("role", "TextView") })
            put("body", JsonArray(listOf(buildJsonObject { put("op", "tap"); put("text", "@item") })))
        })).result
        assertEquals("needs_user", (answer["stopped"] as JsonPrimitive).content)
        assertEquals("android.widget.TextView|one", (answer["stoppedAt"] as JsonPrimitive).content)
        assertEquals("「com.android.intentresolver」在用户的屏幕上问要用哪个应用。", (answer["error"] as JsonPrimitive).content)
    }

    @Test
    fun `the item cap answers capped with the screen it ended on`() = runBlocking {
        val page = (1..30).map { index -> element("r$index", text = "row $index") }
        val walker = loop(
            snapshot = { PhoneUiSnapshot("s", 42, 1L, false, page) },
            runBody = { _ -> PhoneToolOutcome.Success(buildJsonObject { put("stopped", "done") }) },
            scroll = { true },
            elementJson = { element -> buildJsonObject { put("ref", element.ref) } },
        )
        val answer = assertIs<PhoneToolOutcome.Success>(walker.execute(buildJsonObject {
            put("item", buildJsonObject { put("text", "row") })
            put("body", JsonArray(listOf(buildJsonObject { put("op", "back") })))
            put("max_items", 3)
        })).result
        assertEquals(3, (answer["done"] as JsonPrimitive).content.toInt())
        assertEquals("capped", (answer["stopped"] as JsonPrimitive).content)
        val screen = answer["screen"] as JsonObject
        assertEquals("s", (screen["snapshot"] as JsonPrimitive).content)
        assertEquals(30, (screen["elements"] as JsonArray).size)
    }
}
