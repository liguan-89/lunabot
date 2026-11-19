package com.lunabot.companion.phoneui

import kotlin.math.hypot

/**
 * When a node click does nothing, tapping the same spot by coordinates is the
 * second channel; this is the pure judgement of when that retry is safe.
 *
 * Adapted from Mika's ClickFallback (app/src/main/java/com/wangzan101/mika/cap/phone/a11y/
 * ClickFallback.kt), Copyright 2026 wangzan101, Apache License 2.0
 * (third_party/mika/LICENSE). Changes: the outward-action word list is this
 * app's own, the detector is self-contained, and the webview candidate flag is
 * kept so a retry inside a page is never chosen by coordinates.
 *
 * Two rules, both conservative:
 * - A control whose label or view id looks like an outward or irreversible
 *   action (send, pay, delete, confirm) is never retried: a second tap could
 *   send twice. Toggle-like controls (follow, like, mute, answer) are also
 *   excluded because a retry turns the state back off.
 * - A coordinate retry picks the smallest clickable target under the point,
 *   not the whole screen or a scrolling container, and only when it is
 *   smaller than [MAX_AREA_SHARE] of the screen.
 */
object PhoneUiClickFallback {
    /** The retried target may cover at most this share of the screen. */
    const val MAX_AREA_SHARE = 0.35

    /** ...and at most this share of its height. */
    const val MAX_HEIGHT_SHARE = 0.50

    private const val MAX_LABEL_LEN = 24

    private val OUTWARD_CJK = setOf(
        "发送", "提交", "支付", "付款", "下单", "购买", "删除", "确认",
        "转账", "发布", "回复", "同意", "允许", "举报", "注销",
    )
    private val STATE_CJK = setOf(
        "关注", "订阅", "收藏", "点赞", "喜欢", "静音", "接听", "拨打", "挂断", "删除",
    )
    private val CONFIRM_CJK = setOf("确定", "完成", "好的", "好", "知道了", "继续")
    private val OUTWARD_EN = setOf(
        "send", "submit", "pay", "payment", "checkout", "order", "buy",
        "delete", "remove", "confirm", "post", "publish", "reply", "report",
        "allow", "agree", "accept",
    )
    private val STATE_EN = setOf(
        "follow", "following", "unfollow", "like", "liked", "favorite", "favourite",
        "subscribe", "subscribed", "mute", "muted", "call", "answer", "block",
    )
    private val CONFIRM_EN = setOf("ok", "okay", "confirm", "done", "yes", "allow", "continue")
    private val VIEW_ID_SPLIT = Regex("(?=[A-Z])|[/_\\-.:]+")
    private val WORD_SPLIT = Regex("[^a-z]+")

    /** A clickable target under a point, clipped to the screen. */
    data class Candidate<T>(
        val item: T,
        val left: Int,
        val top: Int,
        val right: Int,
        val bottom: Int,
        val label: String? = null,
        val viewId: String? = null,
        val scrollable: Boolean = false,
    ) {
        val width: Int get() = (right - left).coerceAtLeast(0)
        val height: Int get() = (bottom - top).coerceAtLeast(0)
        val area: Long get() = width.toLong() * height
        val centerX: Int get() = (left + right) / 2
        val centerY: Int get() = (top + bottom) / 2

        fun contains(x: Int, y: Int): Boolean = x in left until right && y in top until bottom
    }

    /**
     * True when the text or view id of a clickable control says the action is
     * outward, irreversible or a state toggle, so it must never be retried.
     */
    fun mayBeOutward(label: String?, viewId: String?): Boolean {
        val text = label?.trim().orEmpty()
        if (text.isNotEmpty()) {
            val norm = text.filterNot(Char::isWhitespace).lowercase()
                .trimEnd { !it.isLetterOrDigit() }
            if (norm.length <= MAX_LABEL_LEN) {
                if (norm in CONFIRM_CJK || norm in CONFIRM_EN) return true
                if (STATE_CJK.any { it in norm } || norm in STATE_EN) return true
                if (OUTWARD_CJK.any { it in norm } || norm in OUTWARD_EN) return true
            }
            // English buttons carry their object ("Send message to Alice"), so
            // the words are checked separately from the whole-label match.
            val words = text.lowercase().split(WORD_SPLIT).filter { it.isNotEmpty() }
            if (words.any { it in OUTWARD_EN || it in STATE_EN || it in CONFIRM_EN }) return true
            if (OUTWARD_CJK.any { it in text } || STATE_CJK.any { it in text }) return true
        }
        if (!viewId.isNullOrBlank()) {
            val words = viewId.substringAfterLast('/').split(VIEW_ID_SPLIT)
                .map { it.lowercase() }
                .filter { it.isNotEmpty() }
            if (words.any { it in OUTWARD_EN || it in STATE_EN }) return true
        }
        return false
    }

    /**
     * The smallest non-scrolling clickable target containing ([x], [y]) that
     * is not an outward control; ties go to the one whose centre is closest to
     * the point. Null when nothing qualifies.
     */
    fun <T> pickTarget(
        x: Int,
        y: Int,
        screenWidth: Int,
        screenHeight: Int,
        candidates: Iterable<Candidate<T>>,
    ): T? {
        if (screenWidth <= 0 || screenHeight <= 0) return null
        val maxArea = (screenWidth.toLong() * screenHeight * MAX_AREA_SHARE).toLong()
        val maxHeight = (screenHeight * MAX_HEIGHT_SHARE).toInt()
        return candidates
            .filter { candidate ->
                !candidate.scrollable &&
                    candidate.width > 0 && candidate.height in 1..maxHeight &&
                    candidate.area in 1..maxArea &&
                    candidate.contains(x, y) &&
                    !mayBeOutward(candidate.label, candidate.viewId)
            }
            .minWithOrNull(
                compareBy<Candidate<T>> { it.area }
                    .thenBy { hypot((it.centerX - x).toDouble(), (it.centerY - y).toDouble()) },
            )?.item
    }
}