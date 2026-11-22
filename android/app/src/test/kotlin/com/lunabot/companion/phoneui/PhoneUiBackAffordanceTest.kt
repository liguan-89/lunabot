/*
 * Pins the back-control finder: exact names first, then resource ids, then
 * names that contain a back word, then a blank-named top-left icon — and null
 * when nothing is credible, so a caller never taps blindly.
 */
package com.lunabot.companion.phoneui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class PhoneUiBackAffordanceTest {
    private val screen = 1080 to 2400

    private fun element(
        ref: String = "e1",
        text: String? = null,
        description: String? = null,
        viewId: String? = null,
        className: String? = "android.widget.Button",
        bounds: List<Int> = listOf(0, 100, 200, 200),
        clickable: Boolean = true,
    ): PhoneUiElement = PhoneUiElement(
        ref = ref, viewId = viewId, className = className, text = text, description = description,
        bounds = bounds, clickable = clickable, editable = false, scrollable = false, password = false,
    )

    private fun find(vararg elements: PhoneUiElement): PhoneUiElement? =
        PhoneUiBackAffordance.find(elements.toList(), screen.first, screen.second)

    @Test
    fun `an exact back name wins first`() {
        val exact = element(text = "返回", ref = "exact")
        val resourceId = element(viewId = "com.example.app/id/navigate_up", ref = "resource")
        assertEquals("exact", find(resourceId, exact)?.ref)
    }

    @Test
    fun `an english exact name matches whole`() {
        assertEquals("e1", find(element(text = "Back"))?.ref)
        // A label that merely starts with the word is not an exact hit.
        assertNull(find(element(text = "background settings"))?.ref)
    }

    @Test
    fun `a back resource id matches without the package`() {
        assertEquals("e1", find(element(viewId = "com.example.app/id/arrow_back"))?.ref)
        assertEquals("e1", find(element(viewId = "action_bar_up"))?.ref)
        assertNull(find(element(viewId = "com.example.app/id/backdrop"))?.ref)
    }

    @Test
    fun `a name containing a back word matches after resource ids`() {
        val contains = element(text = "navigate up one level", ref = "contains")
        val resource = element(viewId = "com.example.app/id/something_else", ref = "resource")
        assertEquals("contains", find(resource, contains)?.ref)
    }

    @Test
    fun `a blank-named top-left icon is the last resort`() {
        val icon = element(
            text = null, className = "android.widget.ImageButton",
            bounds = listOf(20, 60, 140, 180), ref = "icon",
        )
        assertEquals("icon", find(icon)?.ref)
    }

    @Test
    fun `an icon outside the top-left region is not a back control`() {
        val icon = element(
            text = null, className = "android.widget.ImageButton",
            bounds = listOf(900, 2_200, 1_020, 2_320),
        )
        assertNull(find(icon)?.ref)
    }

    @Test
    fun `a control that is not clickable is never a back control`() {
        assertNull(find(element(text = "返回", clickable = false))?.ref)
    }

    @Test
    fun `a description names the control when the text is blank`() {
        assertEquals("e1", find(element(text = null, description = "navigate up"))?.ref)
    }

    @Test
    fun `nothing credible returns null`() {
        assertNull(find(element(text = "设置", viewId = "com.example.app/id/settings"))?.ref)
        assertNull(find())
        assertNull(PhoneUiBackAffordance.find(listOf(element(text = "返回")), 0, 0))
    }
}
