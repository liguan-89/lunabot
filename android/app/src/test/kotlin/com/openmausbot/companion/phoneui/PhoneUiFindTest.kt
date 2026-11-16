/*
 * Pins PHONE_UI_FIND's pure halves: the argument parsing, the element
 * fingerprint, and the loop's stopping rules. No Android: the snapshot, the
 * package in front, the query, the scroll and the clock are plain lambdas here.
 */
package com.openmausbot.companion.phoneui

import com.openmausbot.companion.phone.PhoneToolOutcome
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PhoneUiFindTest {
    private fun element(
        ref: String = "e1",
        text: String? = null,
        description: String? = null,
        viewId: String? = null,
        className: String? = "android.widget.TextView",
        left: Int = 0,
        top: Int = 0,
        right: Int = 100,
        bottom: Int = 100,
    ) = PhoneUiElement(
        ref = ref,
        viewId = viewId,
        className = className,
        text = text,
        description = description,
        bounds = listOf(left, top, right, bottom),
        clickable = false,
        editable = false,
        scrollable = false,
        password = false,
    )

    private fun arguments(
        text: String? = "目标",
        resourceId: String? = null,
        role: String? = null,
        direction: String? = "down",
        maxScrolls: Int? = null,
        limit: Int? = null,
    ): JsonObject = buildJsonObject {
        text?.let { put("text", it) }
        resourceId?.let { put("resourceId", it) }
        role?.let { put("role", it) }
        direction?.let { put("direction", it) }
        maxScrolls?.let { put("maxScrolls", it) }
        limit?.let { put("limit", it) }
    }

    /** The same rule the executor hands in: every selector that arrived must hold, as a case-insensitive substring. */
    private fun query(target: PhoneUiFind.Target, elements: List<PhoneUiElement>): List<PhoneUiElement> =
        elements.filter { element ->
            (target.text == null || listOfNotNull(element.text, element.description).any { it.contains(target.text, ignoreCase = true) }) &&
                (target.resourceId == null || element.viewId?.contains(target.resourceId, ignoreCase = true) == true) &&
                (target.role == null || element.className?.contains(target.role, ignoreCase = true) == true)
        }

    /** Screens handed out one per read, with the package in front and the scroll's answer under the test's control. */
    private class Screens(
        private val pages: List<List<PhoneUiElement>?>,
        private val packages: List<String?> = emptyList(),
        private val scrolls: (Int) -> Boolean = { true },
    ) {
        var reads = 0
            private set
        val directions = ArrayList<String>()

        fun snapshot(): PhoneUiSnapshot? =
            pages.getOrNull(reads++)?.let { PhoneUiSnapshot("s$reads", 3, 0L, false, it) }

        fun topPackage(): String? =
            if (reads - 1 < packages.size) packages[reads - 1] else "com.example.app"

        fun scroll(direction: String): Boolean {
            directions += direction
            return scrolls(directions.size - 1)
        }
    }

    private fun find(
        screens: Screens,
        now: () -> Long = { 0L },
    ) = PhoneUiFind(
        snapshot = screens::snapshot,
        topPackage = screens::topPackage,
        query = ::query,
        scroll = screens::scroll,
        now = now,
        fingerprint = { elements -> PhoneUiFind.fingerprint(elements) },
        elementJson = { element ->
            buildJsonObject {
                put("ref", element.ref)
                element.text?.let { put("text", it) }
            }
        },
    )

    private fun answer(outcome: PhoneToolOutcome): JsonObject =
        (outcome as PhoneToolOutcome.Success).result

    private fun refs(result: JsonObject): List<String> =
        (result["elements"] as? JsonArray ?: JsonArray(emptyList()))
            .map { it.jsonObject.getValue("ref").jsonPrimitive.content }

    @Test
    fun `a target on the first screen is found with no scroll`() = runBlocking {
        val screens = Screens(listOf(listOf(element(text = "设置"), element(text = "目标"))))
        val result = answer(find(screens).execute(arguments()))
        assertEquals(true, result["ok"]!!.jsonPrimitive.boolean)
        assertEquals(true, result["found"]!!.jsonPrimitive.boolean)
        assertEquals("found", result["stoppedBecause"]!!.jsonPrimitive.content)
        assertEquals(0, result["scrolls"]!!.jsonPrimitive.int)
        assertEquals(1, result["total"]!!.jsonPrimitive.int)
        assertEquals(listOf("e1"), refs(result))
        // The refs of the snapshot the loop stopped on travel with the answer.
        assertEquals("s1", result["snapshot"]!!.jsonPrimitive.content)
        assertEquals("com.example.app", result["topPackage"]!!.jsonPrimitive.content)
        assertTrue(screens.directions.isEmpty())
    }

    @Test
    fun `the loop scrolls until the target appears and counts the steps`() = runBlocking {
        val screens = Screens(
            listOf(
                listOf(element("a", text = "第一屏")),
                listOf(element("b", text = "第二屏")),
                listOf(element("c", text = "目标")),
            ),
        )
        val result = answer(find(screens).execute(arguments(direction = "up")))
        assertEquals("found", result["stoppedBecause"]!!.jsonPrimitive.content)
        assertEquals(2, result["scrolls"]!!.jsonPrimitive.int)
        assertEquals(listOf("up", "up"), screens.directions)
        assertEquals("c", refs(result).single())
    }

    @Test
    fun `the scroll budget ends the loop as scroll_limit`() = runBlocking {
        val pages = (1..5).map { index -> listOf(element("e$index", text = "第 $index 屏", top = index * 100)) }
        val screens = Screens(pages)
        val result = answer(find(screens).execute(arguments(maxScrolls = 2)))
        assertEquals("scroll_limit", result["stoppedBecause"]!!.jsonPrimitive.content)
        assertEquals(2, result["scrolls"]!!.jsonPrimitive.int)
        assertEquals(0, result["total"]!!.jsonPrimitive.int)
        assertEquals(JsonArray(emptyList()), result["elements"])
    }

    @Test
    fun `two identical readings stop as content_unchanged`() = runBlocking {
        val same = listOf(element("a", text = "只剩这一屏"))
        val screens = Screens(listOf(same, same, same))
        val result = answer(find(screens).execute(arguments(maxScrolls = 10)))
        assertEquals("content_unchanged", result["stoppedBecause"]!!.jsonPrimitive.content)
        // The first scroll happened; the identical reading after it ended the loop.
        assertEquals(1, result["scrolls"]!!.jsonPrimitive.int)
    }

    @Test
    fun `a list whose content moved but did not change still reads as unchanged`() = runBlocking {
        // The same rows on the second reading; only their refs differ, which the fingerprint ignores.
        val first = listOf(element("e1", text = "一", top = 100), element("e2", text = "二", top = 200))
        val second = listOf(element("x1", text = "一", top = 100), element("x2", text = "二", top = 200))
        val screens = Screens(listOf(first, second, second))
        val result = answer(find(screens).execute(arguments(maxScrolls = 10)))
        assertEquals("content_unchanged", result["stoppedBecause"]!!.jsonPrimitive.content)
        assertEquals(1, result["scrolls"]!!.jsonPrimitive.int)
    }

    @Test
    fun `a null snapshot stops as read_failed`() = runBlocking {
        val screens = Screens(listOf(null))
        val result = answer(find(screens).execute(arguments()))
        assertEquals("read_failed", result["stoppedBecause"]!!.jsonPrimitive.content)
        assertEquals(0, result["scrolls"]!!.jsonPrimitive.int)
    }

    @Test
    fun `an empty screen stops as screen_needs_review, since our snapshot has no protection flag`() = runBlocking {
        val screens = Screens(listOf(emptyList(), emptyList()))
        val result = answer(find(screens).execute(arguments()))
        assertEquals("screen_needs_review", result["stoppedBecause"]!!.jsonPrimitive.content)
        // Nothing was scrolled: a screen we cannot read is not a screen to search.
        assertTrue(screens.directions.isEmpty())
    }

    @Test
    fun `a screen whose package cannot be read stops as screen_needs_review`() = runBlocking {
        val screens = Screens(listOf(listOf(element(text = "一"))), packages = listOf(null))
        val result = answer(find(screens).execute(arguments()))
        assertEquals("screen_needs_review", result["stoppedBecause"]!!.jsonPrimitive.content)
    }

    @Test
    fun `another app in front stops as app_switched`() = runBlocking {
        val screens = Screens(
            listOf(listOf(element("a", text = "一")), listOf(element("b", text = "二"))),
            packages = listOf("com.tencent.mm", "com.android.settings"),
        )
        val result = answer(find(screens).execute(arguments(maxScrolls = 10)))
        assertEquals("app_switched", result["stoppedBecause"]!!.jsonPrimitive.content)
        assertEquals("com.android.settings", result["topPackage"]!!.jsonPrimitive.content)
    }

    @Test
    fun `a scroll that does not happen stops as scroll_failed`() = runBlocking {
        val screens = Screens(listOf(listOf(element("a", text = "一"))), scrolls = { false })
        val result = answer(find(screens).execute(arguments(maxScrolls = 10)))
        assertEquals("scroll_failed", result["stoppedBecause"]!!.jsonPrimitive.content)
        assertEquals(0, result["scrolls"]!!.jsonPrimitive.int)
    }

    @Test
    fun `the time budget ends the loop as scroll_limit before the job times out`() = runBlocking {
        var now = 0L
        val pages = (1..5).map { index -> listOf(element("e$index", text = "第 $index 屏", top = index * 100)) }
        val screens = Screens(pages)
        val find = find(screens, now = {
            now += PhoneUiFind.TIME_BUDGET_MS
            now
        })
        val result = answer(find.execute(arguments(maxScrolls = 100)))
        assertEquals("scroll_limit", result["stoppedBecause"]!!.jsonPrimitive.content)
        assertEquals(0, result["scrolls"]!!.jsonPrimitive.int)
    }

    @Test
    fun `more matches than limit are cut and reported as truncated`() = runBlocking {
        val screen = listOf(
            element("a", text = "目标 一", top = 100),
            element("b", text = "目标 二", top = 200),
            element("c", text = "目标 三", top = 300),
        )
        val result = answer(find(Screens(listOf(screen))).execute(arguments(limit = 2)))
        assertEquals(3, result["total"]!!.jsonPrimitive.int)
        assertEquals(2, refs(result).size)
        assertTrue(result["truncated"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun `a selector may be a view id or a role, alone or together`() = runBlocking {
        val screen = listOf(
            element("a", viewId = "com.example:id/search", className = "android.widget.Button"),
            element("b", text = "别的", className = "android.widget.TextView"),
        )
        val byId = answer(find(Screens(listOf(screen))).execute(arguments(text = null, resourceId = "search")))
        assertEquals(listOf("a"), refs(byId))
        val byRole = answer(find(Screens(listOf(screen))).execute(arguments(text = null, role = "Button")))
        assertEquals(listOf("a"), refs(byRole))
        // Every selector that arrived has to hold, as PHONE_UI_QUERY applies them.
        val both = answer(find(Screens(listOf(screen))).execute(arguments(text = null, resourceId = "search", role = "Button")))
        assertEquals(listOf("a"), refs(both))
        val neither = answer(find(Screens(listOf(screen))).execute(arguments(text = null, resourceId = "search", role = "EditText")))
        assertEquals(0, neither["total"]!!.jsonPrimitive.int)
    }

    @Test
    fun `the call is refused without a target or a direction, and its counts are clamped`() {
        val find = find(Screens(emptyList()))
        assertTrue(find.parse(arguments(text = null)) is PhoneUiFind.Parsed.Refused)
        assertTrue(find.parse(arguments(direction = null)) is PhoneUiFind.Parsed.Refused)
        assertTrue(find.parse(arguments(direction = "sideways")) is PhoneUiFind.Parsed.Refused)
        assertTrue(find.parse(arguments(text = "x".repeat(201))) is PhoneUiFind.Parsed.Refused)
        val upper = (find.parse(arguments(direction = "UP", maxScrolls = 500, limit = 500)) as PhoneUiFind.Parsed.Ready).options
        assertEquals("up", upper.direction)
        assertEquals(PhoneUiFind.MAX_SCROLLS, upper.maxScrolls)
        assertEquals(PhoneUiRules.MAX_QUERY_LIMIT, upper.limit)
        val lower = (find.parse(arguments(maxScrolls = 0)) as PhoneUiFind.Parsed.Ready).options
        assertEquals(1, lower.maxScrolls)
        val defaults = (find.parse(arguments()) as PhoneUiFind.Parsed.Ready).options
        assertEquals(PhoneUiFind.DEFAULT_MAX_SCROLLS, defaults.maxScrolls)
        assertEquals(PhoneUiRules.DEFAULT_QUERY_LIMIT, defaults.limit)
    }

    @Test
    fun `the fingerprint covers the visible tuples and nothing else`() {
        val rows = listOf(
            element("e1", text = "一", top = 100, bottom = 140),
            element("e2", text = "二", top = 200, bottom = 240),
        )
        // A re-read with new refs and a new snapshot id is the same content.
        val reread = rows.mapIndexed { index, element -> element.copy(ref = "n$index") }
        assertEquals(PhoneUiFind.fingerprint(rows), PhoneUiFind.fingerprint(reread))
        // A changed label, a changed place or a changed row count is not.
        assertFalse(PhoneUiFind.fingerprint(rows) == PhoneUiFind.fingerprint(listOf(rows[0].copy(text = "一改"), rows[1])))
        assertFalse(PhoneUiFind.fingerprint(rows) == PhoneUiFind.fingerprint(listOf(rows[0].copy(bounds = listOf(0, 0, 100, 40)), rows[1])))
        assertFalse(PhoneUiFind.fingerprint(rows) == PhoneUiFind.fingerprint(listOf(rows[0])))
        // Order is reading order: the same rows swapped are a different screen.
        assertFalse(PhoneUiFind.fingerprint(rows) == PhoneUiFind.fingerprint(rows.reversed()))
    }

    @Test
    fun `a call that never finds anything answers ok false with the reason`() = runBlocking {
        val screens = Screens(
            listOf(
                listOf(element("a", text = "别的内容", top = 100)),
                listOf(element("b", text = "还是别的内容", top = 200)),
            ),
        )
        val result = answer(find(screens).execute(arguments(maxScrolls = 1)))
        assertEquals(false, result["ok"]!!.jsonPrimitive.boolean)
        assertEquals(false, result["found"]!!.jsonPrimitive.boolean)
        assertEquals("scroll_limit", result["stoppedBecause"]!!.jsonPrimitive.content)
        assertEquals(1, result["scrolls"]!!.jsonPrimitive.int)
    }
}
