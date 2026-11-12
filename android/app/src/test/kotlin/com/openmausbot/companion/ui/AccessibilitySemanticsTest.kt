package com.openmausbot.companion.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.assertTrue

/**
 * The two accessibility promises the shared chrome makes, read off the tree
 * TalkBack actually walks.
 *
 * Both are properties of composition, not of a pure function: a caption gains
 * `Heading` from the modifier the screen passes, and a 20 dp glyph gets its
 * 48 dp reach from [TouchTarget]. A test over either component's parameters
 * would stay green if the modifier were dropped, so this mounts the real
 * composition under Robolectric and reads the semantics.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AccessibilitySemanticsTest {

    @get:Rule
    val compose = createComposeRule()

    @Test
    fun `a section caption is a heading`() {
        compose.setContent {
            CompanionTheme(darkTheme = false) { MinisSectionHeader("电脑") }
        }
        compose.onNode(
            SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading),
        ).assertExists()
        compose.onNodeWithText("电脑").assertExists()
    }

    /**
     * The version arrows in a message are drawn at 20 dp. Without the target
     * wrapper their hit box was 20 dp, the smallest control in the app; the
     * wrapper must expose a button role, the accessible name, and Android's
     * 48 dp floor.
     */
    @Test
    fun `a small glyph is still a named 48 dp button`() {
        compose.setContent {
            CompanionTheme(darkTheme = false) {
                TouchTarget(
                    onClick = {},
                    size = 20.dp,
                    contentDescription = "上一版本",
                ) {
                    Box(Modifier.size(20.dp))
                }
            }
        }

        val node = compose.onNodeWithContentDescription("上一版本")
        node.assertExists()
        node.assert(
            SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button),
        )
        val bounds = node.getBoundsInRoot()
        assertTrue(bounds.height >= 48.dp, "touch height was ${bounds.height}")
        assertTrue(bounds.width >= 48.dp, "touch width was ${bounds.width}")
    }
}
