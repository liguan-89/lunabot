package com.openmausbot.companion.ui

import androidx.compose.material3.Text
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import com.openmausbot.companion.core.ConfigFlag
import com.openmausbot.companion.core.ConfigStatus
import kotlin.test.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Which sentence the Voice section puts in which slot, read off the mounted
 * composition in the order the composition built it.
 *
 * This is the one thing about [VoiceSection] no pure function can answer. The
 * rules were already right and pinned when the screen drew a correct sentence
 * in the wrong place: two public `(ConfigStatus?) -> String` selectors were
 * interchangeable to the compiler, and swapping them left the suite green
 * while the user read *"ElevenLabs is not configured"* as the footer of a
 * working voice picker.
 *
 * The order matters, and asserting presence does not capture it. An earlier
 * version of this file asked only that both sentences exist somewhere in the
 * tree, which a *mutual* swap survives untouched — footer and notice trade
 * places, both strings stay present, and the user reads the state where the
 * explanation belongs and the explanation where the state belongs. So each
 * case pins the whole sequence, the way [TableReadingOrderTest] pins the
 * table: `FormSection` emits its header, then its content, then its footer
 * (`AgentProfileSheet`), so a slot swap moves a sentence in this list and the
 * comparison fails on position rather than on existence.
 *
 * Known limit, measured rather than assumed: this reads the order of the
 * text in the tree, not which parameter of `FormSection` carried it. Passing
 * `footer = null` and emitting the same sentence as the content's last child
 * — duplicating the footer's `13.sp` and `secondaryTint` by hand — keeps this
 * sequence identical and survives. That is a deliberate reimplementation of a
 * component that already has a `footer` parameter rather than a slip anyone
 * makes, so it is left open knowingly; the swap of two arguments, which is
 * the regression that does happen, is what these assertions kill.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class VoiceSectionWiringTest {

    @get:Rule
    val compose = createComposeRule()

    /** Stands in for the picker, so "the section can speak" is observable. */
    private val pickerSlot = "voice-picker-slot"

    private val elevenLabsNotice = "ElevenLabs 尚未配置"
    private val elevenLabsFooter =
        "请在电脑端该智能体的资料中添加共享 ElevenLabs 密钥。密钥绝不会发送到本手机。"
    private val readyFooter =
        "音色设置仅对此智能体生效。“工作区默认”将使用电脑上所选的共享音色。"
    private val systemNotice = "电脑内置语音不可用"
    private val systemFooter =
        "电脑内置语音无需密钥，但当前电脑未报告任何可用语音。请在电脑端 Luna Bot 中切换语音引擎以启用语音朗读。"
    private val chatterboxNotice = "Chatterbox 服务器未连接"
    private val chatterboxFooter =
        "请在电脑端 Luna Bot 中添加 Chatterbox 服务器地址以启用语音朗读。"

    /**
     * The engine picker rides above the branch, so its row leads every
     * sequence: the picker's label, then the selected engine's label the
     * collapsed field now reports.
     */
    private fun engineRow(selected: String) = listOf("语音引擎", selected)

    /** Everything the merged tree carries, in the order the tree carries it. */
    private fun spoken(node: SemanticsNode): List<String> = buildList {
        node.config.getOrNull(SemanticsProperties.Text)?.forEach { add(it.text) }
        node.children.forEach { addAll(spoken(it)) }
    }

    private fun sectionFor(config: ConfigStatus?): List<String> {
        compose.setContent {
            CompanionTheme(darkTheme = false) {
                VoiceSection(config = config) { Text(pickerSlot) }
            }
        }
        return spoken(compose.onRoot().fetchSemanticsNode())
    }

    @Test
    fun `the unconfigured section states the engine, then explains the remedy`() {
        assertEquals(
            listOf("语音通话") + engineRow("ElevenLabs") + listOf(elevenLabsNotice, elevenLabsFooter),
            sectionFor(ConfigStatus(tts = ConfigFlag(configured = false))),
            "the short state stands in for the picker; the remedy is the footer under it",
        )
    }

    @Test
    fun `a section that can speak draws the picker under the ready footer`() {
        assertEquals(
            listOf("语音通话") + engineRow("ElevenLabs") + listOf(pickerSlot, readyFooter),
            sectionFor(ConfigStatus(tts = ConfigFlag(configured = true, voice = "shared-voice"))),
        )
    }

    @Test
    fun `the built-in provider's section names no brand in either slot`() {
        val drawn = sectionFor(ConfigStatus(tts = ConfigFlag(configured = false, provider = "system")))

        assertEquals(listOf("语音通话") + engineRow("Mac 内置语音") + listOf(systemNotice, systemFooter), drawn)
        drawn.forEach { line ->
            assertEquals(false, line.contains("ElevenLabs"), "no brand reaches the screen: $line")
        }
    }

    @Test
    fun `the built-in provider keeps the picker and the shared footer when it can speak`() {
        assertEquals(
            listOf("语音通话") + engineRow("Mac 内置语音") + listOf(pickerSlot, readyFooter),
            sectionFor(
                ConfigStatus(tts = ConfigFlag(configured = true, voice = "Albert", provider = "system")),
            ),
        )
    }

    @Test
    fun `the chatterbox section offers the switch that repairs it`() {
        assertEquals(
            listOf("语音通话") + engineRow("Chatterbox（本地）") + listOf(chatterboxNotice, chatterboxFooter),
            sectionFor(ConfigStatus(tts = ConfigFlag(configured = false, provider = "chatterbox"))),
            "an engine whose credential is missing is exactly when switching engines matters",
        )
    }
}
