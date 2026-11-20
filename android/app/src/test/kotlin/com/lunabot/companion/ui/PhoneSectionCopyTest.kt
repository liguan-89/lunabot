package com.lunabot.companion.ui

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The desktop app's companion area is called **手机和设备** — the harness's own
 * `settings.section.phoneDevices`. Every instruction that sends a person there
 * has to use that name, or the first step of setup points at a screen that does
 * not exist. The two names used before this pass ("手机设置", "手机访问") are
 * retired below.
 *
 * The copy pinned here lives inside `@Composable` bodies and a private
 * `failureMessage`, so no JVM unit test can call it — a source pin, in the
 * spirit of [com.lunabot.companion.PairingLinkManifestTest] and
 * [com.lunabot.companion.lifecycle.SessionLingerWiringTest], is what is
 * available. It is a text assertion, not a runtime proof: it says the sentence
 * is written in the file, not that the screen renders it. The constants that
 * *are* reachable are pinned where they live —
 * [SettingsPolicyTest], [ComputerPolicyTest] and, in `:core`,
 * `FailoverTest.refusedConnectionPointsAtThePhoneSection`.
 */
class PhoneSectionCopyTest {

    /** Names of the desktop area as it was called before the rename. */
    private val retiredSectionNames = listOf(
        "Settings → Companion",
        "Companion panel",
        "shown by Companion",
        "companion settings",
        "Companion settings",
        "手机设置",
        "「手机访问」",
    )

    @Test
    fun `pairing sends the person to Settings then Phone`() {
        val source = sourceFile("ui/PairingScreen.kt").readText()

        // Step one of setup, and the action that opens the pairing code.
        assertTrue(
            source.contains("1.  打开 Luna Bot → 设置 → 手机和设备"),
            "the setup steps must name the Phone section",
        )
        assertTrue(
            source.contains("2.  选择「配对设备」"),
            "the setup steps must name the button that shows the code",
        )
        // A discovered computer that answered without an address.
        assertTrue(
            source.contains("该电脑未返回可用地址。请改用「手机和设备」中显示的地址手动输入。"),
            "the discovery fallback must name Phone settings",
        )
        // The tailnet hint, and the manual-address footnote.
        assertTrue(
            source.contains("同一账号——电脑端的「手机和设备」将显示以 .ts.net 结尾的地址"),
            "the Tailscale hint must name Phone settings",
        )
        assertTrue(
            source.contains("输入电脑端「手机和设备」中显示的地址——"),
            "the manual-address footnote must name Phone settings",
        )
    }

    @Test
    fun `every discovery failure points at Phone settings`() {
        val source = sourceFile("discovery/NsdDiscovery.kt").readText()

        // Four exits — permission refused, an unexpected throw, an internal NSD
        // failure and the spent-retries one — and a person who cannot browse has
        // nowhere else to read the address from.
        assertEquals(
            4,
            countOf(source, "请在下方输入电脑「手机和设备」中显示的地址。"),
            "every discovery failure must send the person to Phone settings",
        )
    }

    @Test
    fun `a revoked phone is told which desktop section removed it`() {
        val source = sourceFile("ui/RootScreen.kt").readText()

        assertTrue(
            source.contains(
                "此手机已从电脑的「手机和设备」中移除，或配对已被重置。",
            ),
            "the unpaired screen must name Phone settings",
        )
    }

    @Test
    fun `no instruction still teaches the retired section name`() {
        for (name in listOf(
            "ui/PairingScreen.kt",
            "discovery/NsdDiscovery.kt",
            "ui/RootScreen.kt",
            "ui/SettingsPolicy.kt",
            "ui/SettingsScreen.kt",
            "ui/ComputerPolicy.kt",
        )) {
            val source = sourceFile(name).readText()
            for (retired in retiredSectionNames) {
                assertFalse(
                    source.contains(retired),
                    "$name still names \"$retired\" — the desktop section is called Phone",
                )
            }
        }
    }

    private fun countOf(source: String, needle: String): Int =
        source.split(needle).size - 1

    private fun sourceFile(name: String): File =
        locate("src/main/kotlin/com/lunabot/companion/$name")

    private fun locate(relative: String): File {
        var directory: File? = File(".").absoluteFile
        while (directory != null) {
            for (prefix in listOf("", "app/")) {
                val file = File(directory, prefix + relative)
                if (file.isFile) return file
            }
            directory = directory.parentFile
        }
        error("could not find $relative from ${File(".").absolutePath}")
    }
}
