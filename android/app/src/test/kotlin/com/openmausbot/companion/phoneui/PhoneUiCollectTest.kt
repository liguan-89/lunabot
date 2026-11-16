/*
 * Pins PHONE_UI_COLLECT's pure halves: the band filter and its ordering, the
 * dedup across screens, and the loop's stopping rules. No Android: the
 * snapshot, the scroll, the settle wait and the package in front are plain
 * lambdas here.
 */
package com.openmausbot.companion.phoneui

import com.openmausbot.companion.phone.PhoneToolOutcome
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
import kotlin.test.assertTrue

class PhoneUiCollectTest {
    private fun element(
        ref: String,
        text: String? = null,
        description: String? = null,
        left: Int = 0,
        top: Int = 0,
        right: Int = 100,
        bottom: Int = 100,
    ) = PhoneUiElement(
        ref = ref,
        viewId = null,
        className = null,
        text = text,
        description = description,
        bounds = listOf(left, top, right, bottom),
        clickable = false,
        editable = false,
        scrollable = false,
        password = false,
    )

    private fun arguments(
        direction: String = "down",
        pages: Int? = null,
        maxLines: Int? = null,
        fromY: Int? = null,
        toY: Int? = null,
    ): JsonObject = buildJsonObject {
        put("direction", direction)
        pages?.let { put("pages", it) }
        maxLines?.let { put("maxLines", it) }
        fromY?.let { put("fromY", it) }
        toY?.let { put("toY", it) }
    }

    /** Screens handed out one per read, with the app in front and the scroll's own answer under the test's control. */
    private class Screens(
        private val pages: List<List<PhoneUiElement>>,
        private val packages: List<String?> = emptyList(),
        private val scrolls: (Int) -> Boolean = { true },
        private val settles: (Int) -> Boolean = { true },
    ) {
        var reads = 0
            private set
        var scrollsDone = 0
            private set
        val directions = ArrayList<String>()

        fun snapshot(): PhoneUiSnapshot? =
            pages.getOrNull(reads++)?.let { PhoneUiSnapshot("s$reads", 3, 0L, false, it) }

        fun scroll(direction: String): Boolean {
            directions += direction
            return scrolls(scrollsDone++)
        }

        fun settle(): Boolean = settles(scrollsDone)

        fun topPackage(): String? = packages.getOrNull(reads - 1) ?: "com.example.app"
    }

    private fun collect(
        screens: Screens,
        height: Int = 1_000,
    ) = PhoneUiCollect(
        snapshot = screens::snapshot,
        scroll = screens::scroll,
        settle = screens::settle,
        topPackage = screens::topPackage,
        height = height,
        elementJson = { element ->
            buildJsonObject {
                put("ref", element.ref)
                element.text?.let { put("text", it) }
            }
        },
    )

    private fun answer(outcome: PhoneToolOutcome): JsonObject =
        (outcome as PhoneToolOutcome.Success).result

    private fun lines(result: JsonObject): List<String> =
        result["lines"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList()

    @Test
    fun `the band keeps only lines whose bounds lie wholly inside it, in reading order`() {
        val elements = listOf(
            element("e1", text = "标题", top = 0, bottom = 40),
            element("e2", text = "第一行", top = 100, bottom = 140),
            element("e3", text = "第二行", top = 200, bottom = 240, left = 400, right = 500),
            element("e4", text = "第三行", top = 200, bottom = 240, left = 10, right = 200),
            element("e5", text = "末尾", top = 960, bottom = 1_000),
        )
        val found = PhoneUiCollect.linesIn(elements, fromY = 50, toY = 950, height = 1_000)
        // Top to bottom, then left to right: the two rows at 200 sort by their left edge.
        assertEquals(listOf("第一行", "第三行", "第二行"), found.map { it.text })
    }

    @Test
    fun `a line outside the band or straddling its edge is left for another screen`() {
        val elements = listOf(
            element("e1", text = "上面", top = 0, bottom = 40),
            element("e2", text = "跨上沿", top = 30, bottom = 90),
            element("e3", text = "完整", top = 200, bottom = 240),
            element("e4", text = "跨下沿", top = 900, bottom = 980),
            element("e5", text = "下面", top = 960, bottom = 1_000),
        )
        val found = PhoneUiCollect.linesIn(elements, fromY = 50, toY = 950, height = 1_000)
        assertEquals(listOf("完整"), found.map { it.text })
    }

    @Test
    fun `a description stands in for text, and an element without either is no line`() {
        val elements = listOf(
            element("e1", description = "返回", top = 100, bottom = 140),
            element("e2", top = 200, bottom = 240),
            element("e3", text = "   ", top = 300, bottom = 340),
        )
        assertEquals(listOf("返回"), PhoneUiCollect.linesIn(elements, 50, 950, 1_000).map { it.text })
    }

    @Test
    fun `merge drops what was already read and keeps the first occurrence's order`() {
        val merged = PhoneUiCollect.merge(
            listOf("a", "b", "c"),
            listOf("c", "d", "a", "e"),
        )
        assertEquals(listOf("a", "b", "c", "d", "e"), merged)
        assertEquals(listOf("a", "b"), PhoneUiCollect.merge(listOf("a", "b"), emptyList()))
        assertEquals(listOf("a"), PhoneUiCollect.merge(emptyList(), listOf("a", "a")))
    }

    @Test
    fun `the read stops at the page count`() = runBlocking {
        val screens = Screens((1..5).map { index -> listOf(element("e$index", text = "第 $index 屏", top = 100, bottom = 140)) })
        val result = answer(collect(screens).execute(arguments(pages = 3)))
        assertEquals("page-limit", result["stopped"]?.jsonPrimitive?.content)
        // Three screens read need two scrolls between them.
        assertEquals(2, result["scrolled"]?.jsonPrimitive?.int)
        assertEquals(listOf("第 1 屏", "第 2 屏", "第 3 屏"), lines(result))
        assertEquals(3, result["count"]?.jsonPrimitive?.int)
        assertFalse(result["truncated"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun `a line seen on an earlier screen is not repeated`() = runBlocking {
        // The second screen still shows the first screen's last row at the top.
        val screens = Screens(
            listOf(
                listOf(element("a", text = "一", top = 100, bottom = 140), element("b", text = "二", top = 200, bottom = 240)),
                listOf(element("b2", text = "二", top = 100, bottom = 140), element("c", text = "三", top = 200, bottom = 240)),
            ),
        )
        val result = answer(collect(screens).execute(arguments(pages = 2)))
        assertEquals(listOf("一", "二", "三"), lines(result))
        assertEquals(3, result["count"]?.jsonPrimitive?.int)
    }

    @Test
    fun `two scrolls with nothing new mean the list ended`() = runBlocking {
        val same = listOf(element("a", text = "只剩这一行", top = 100, bottom = 140))
        val screens = Screens(listOf(same, same, same, same))
        val result = answer(collect(screens).execute(arguments(pages = 8)))
        assertEquals("end", result["stopped"]?.jsonPrimitive?.content)
        assertEquals(listOf("只剩这一行"), lines(result))
        // One empty scroll may only have landed between two lines; the second ends the read.
        assertEquals(2, result["scrolled"]?.jsonPrimitive?.int)
    }

    @Test
    fun `a scroll that lands in another app ends the read`() = runBlocking {
        val screens = Screens(
            listOf(
                listOf(element("a", text = "聊天", top = 100, bottom = 140)),
                listOf(element("b", text = "设置", top = 100, bottom = 140)),
            ),
            packages = listOf("com.tencent.mm", "com.android.settings"),
        )
        val result = answer(collect(screens).execute(arguments(pages = 8)))
        assertEquals("app-changed", result["stopped"]?.jsonPrimitive?.content)
        assertEquals("com.android.settings", result["package"]?.jsonPrimitive?.content)
        // The screen it landed on travels with the answer.
        assertEquals("s2", result["screen"]?.jsonObject?.get("snapshot")?.jsonPrimitive?.content)
    }

    @Test
    fun `a failed scroll stops the read as failed`() = runBlocking {
        val screens = Screens(
            listOf(listOf(element("a", text = "一", top = 100, bottom = 140))),
            scrolls = { false },
        )
        val result = answer(collect(screens).execute(arguments(pages = 8)))
        assertEquals("failed", result["stopped"]?.jsonPrimitive?.content)
        assertEquals(0, result["scrolled"]?.jsonPrimitive?.int)
        assertEquals(listOf("一"), lines(result))
    }

    @Test
    fun `a screen that stops changing ends the read`() = runBlocking {
        val screens = Screens(
            listOf(listOf(element("a", text = "一", top = 100, bottom = 140))),
            settles = { false },
        )
        val result = answer(collect(screens).execute(arguments(pages = 8)))
        assertEquals("no-change", result["stopped"]?.jsonPrimitive?.content)
        assertEquals(1, result["scrolled"]?.jsonPrimitive?.int)
    }

    @Test
    fun `more lines than maxLines are cut and reported as truncated`() = runBlocking {
        val elements = (1..5).map { index -> element("e$index", text = "第 $index 行", top = index * 100, bottom = index * 100 + 40) }
        val screens = Screens(listOf(elements))
        val result = answer(collect(screens).execute(arguments(pages = 1, maxLines = 2)))
        assertEquals(listOf("第 1 行", "第 2 行"), lines(result))
        assertEquals(2, result["count"]?.jsonPrimitive?.int)
        assertTrue(result["truncated"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun `the band is read in the same 0 to 999 units the schema advertises`() = runBlocking {
        // On a 2 000-pixel-tall display the default band is 100..1900 pixels.
        val elements = listOf(
            element("e1", text = "太靠上", top = 0, bottom = 80),
            element("e2", text = "带内", top = 200, bottom = 300),
            element("e3", text = "太靠下", top = 1_950, bottom = 2_000),
        )
        val screens = Screens(listOf(elements))
        val result = answer(collect(screens, height = 2_000).execute(arguments(pages = 1)))
        assertEquals(listOf("带内"), lines(result))
    }

    @Test
    fun `a call with a direction and a backwards band is refused`() {
        val screens = Screens(emptyList())
        val collect = collect(screens)
        assertEquals("up", (collect.parse(arguments(direction = "UP")) as PhoneUiCollect.Parsed.Ready).options.direction)
        assertTrue(collect.parse(arguments(direction = "sideways")) is PhoneUiCollect.Parsed.Refused)
        assertTrue(collect.parse(arguments(fromY = 900, toY = 100)) is PhoneUiCollect.Parsed.Refused)
        // Absent or out-of-range counts fall back into the schema's own bounds.
        val clamped = (collect.parse(arguments(pages = 0, maxLines = 5_000)) as PhoneUiCollect.Parsed.Ready).options
        assertEquals(1, clamped.pages)
        assertEquals(PhoneUiCollect.MAX_LINES, clamped.maxLines)
        val defaults = (collect.parse(arguments()) as PhoneUiCollect.Parsed.Ready).options
        assertEquals(PhoneUiCollect.DEFAULT_PAGES, defaults.pages)
        assertEquals(PhoneUiCollect.DEFAULT_LINES, defaults.maxLines)
    }
}
