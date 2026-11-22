package com.lunabot.companion.phoneui

/**
 * Finding the on-screen back control among one snapshot's elements, for the
 * degraded path when a back key injection did nothing.
 *
 * Ported from Mika's BackAffordance
 * (core/src/main/kotlin/com/wangzan101/mika/core/uistate/BackAffordance.kt),
 * Copyright 2026 wangzan101, Apache License 2.0 (third_party/mika/LICENSE).
 * Changes: repackaged for this app's [PhoneUiElement] (name reads text, then
 * description; the role reads the class name), comments translated into
 * English. The recognition order is unchanged, most credible first: a name
 * that exactly names back, a resource id that names back, a name that contains
 * a back word, a blank-named icon in the top-left corner. Null when nothing
 * matches — the caller decides what a failed back is worth, this never taps
 * blindly.
 */
object PhoneUiBackAffordance {
    private val EXACT = setOf(
        "返回", "后退", "回退", "返回键", "向上导航",
        "back", "navigate up", "previous",
        "←", "↩", "‹", "＜",
    )

    // No bare "back": its substring would catch feedback/backup/background.
    private val CONTAINS = listOf("返回", "后退", "回退", "向上导航", "previous", "navigate up")

    private val ICON_ROLES = setOf("ImageButton", "AppCompatImageButton", "ImageView", "Image")

    /** Last segment of a back control's resource id, after the package and `/id/`. */
    private val RESOURCE_SEGMENTS = setOf("back", "navigate_up", "arrow_back", "btn_back", "toolbar_back", "action_bar_up")

    fun find(elements: List<PhoneUiElement>, screenWidth: Int, screenHeight: Int): PhoneUiElement? {
        if (screenWidth <= 0 || screenHeight <= 0) return null
        val clickable = elements.filter { it.clickable }
        clickable.firstOrNull { isExact(nameOf(it)) }?.let { return it }
        clickable.firstOrNull { isBackResource(it.viewId) }?.let { return it }
        clickable.firstOrNull { isBackLike(nameOf(it)) }?.let { return it }
        return clickable.firstOrNull { nameOf(it).isBlank() && isTopLeftIcon(it, screenWidth, screenHeight) }
    }

    private fun nameOf(element: PhoneUiElement): String =
        element.text?.takeIf { it.isNotBlank() } ?: element.description ?: ""

    private fun isExact(name: String): Boolean {
        val n = name.trim().lowercase()
        return n.isNotEmpty() && n in EXACT
    }

    private fun isBackLike(name: String): Boolean {
        val n = name.trim().lowercase()
        return n.isNotEmpty() && CONTAINS.any { n.contains(it) }
    }

    private fun isBackResource(id: String?): Boolean {
        if (id == null) return false
        return id.substringAfterLast('/').lowercase() in RESOURCE_SEGMENTS
    }

    private fun isTopLeftIcon(element: PhoneUiElement, screenWidth: Int, screenHeight: Int): Boolean {
        val bounds = element.bounds
        if (bounds.size < 4) return false
        val centerX = (bounds[0] + bounds[2]) / 2
        val centerY = (bounds[1] + bounds[3]) / 2
        // Our className carries the full package ("android.widget.ImageButton");
        // the role names Mika matches are its last segment.
        val role = element.className?.substringAfterLast('.')
        return role in ICON_ROLES &&
            centerX <= screenWidth * TOP_LEFT_X &&
            centerY <= screenHeight * TOP_LEFT_Y
    }

    private const val TOP_LEFT_X = 0.2
    private const val TOP_LEFT_Y = 0.15
}
