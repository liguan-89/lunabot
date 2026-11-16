/*
 * Pins the helper's secure-setting endpoint, which exists for exactly two
 * writes: the wireless-debugging switch the self-repair turns back on, and the
 * accessibility service list the accessibility repair rewrites (or deletes when
 * our service was the only entry). The allow-list is the security boundary, so
 * these tests drive both the pure validator and a real write through
 * Robolectric's Settings shadow, and check that a refused name leaves the
 * setting table untouched.
 */
package com.openmausbot.companion.phoneui.shell

import android.content.Context
import android.provider.Settings
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PhoneUiSecureSettingTest {

    private val context: Context = RuntimeEnvironment.getApplication()

    private val resolver get() = context.contentResolver

    private fun write(name: String, value: String?): Boolean =
        PhoneUiShellService.writeSecureSetting(resolver, name, value)

    @Test
    fun `the allow-list is exactly the two repair keys`() {
        assertTrue(PhoneUiShellService.secureSettingAllowed("adb_wifi_enabled"))
        assertTrue(PhoneUiShellService.secureSettingAllowed("enabled_accessibility_services"))
    }

    @Test
    fun `every other name is refused and nothing is written`() {
        // The caller's own name for a generic writer, another secure key, the
        // global debugging switch (a different setting from adb_wifi_enabled),
        // the empty name and a name with a namespace prefix.
        for (name in listOf(
            "secure_settings",
            "enabled_notification_listeners",
            "adb_enabled",
            "",
            "global/adb_wifi_enabled",
            "secure/enabled_accessibility_services",
        )) {
            assertFalse(write(name, "1"), "name '$name' must be refused")
            assertFalse(PhoneUiShellService.secureSettingAllowed(name), "'$name' must not be allow-listed")
            assertNull(Settings.Global.getString(resolver, name), "'$name' must not reach the global table")
            assertNull(Settings.Secure.getString(resolver, name), "'$name' must not reach the secure table")
        }
    }

    @Test
    fun `the wireless debugging switch goes to the global table`() {
        assertTrue(write("adb_wifi_enabled", "1"))
        assertEquals("1", Settings.Global.getString(resolver, "adb_wifi_enabled"))
        // Not a secure setting: the namespaces are mapped per key, not shared.
        assertNull(Settings.Secure.getString(resolver, "adb_wifi_enabled"))
    }

    @Test
    fun `the accessibility list goes to the secure table`() {
        val list = "com.lunabot.companion/com.lunabot.companion.phoneui.PhoneUiAccessibilityService"
        assertTrue(write("enabled_accessibility_services", list))
        assertEquals(list, Settings.Secure.getString(resolver, "enabled_accessibility_services"))
        assertNull(Settings.Global.getString(resolver, "enabled_accessibility_services"))
    }

    @Test
    fun `a colon separated list is accepted and keeps its other services`() {
        val list = "com.other/.Service:com.lunabot.companion/.phoneui.PhoneUiAccessibilityService"
        assertTrue(write("enabled_accessibility_services", list))
        assertEquals(list, Settings.Secure.getString(resolver, "enabled_accessibility_services"))
    }

    @Test
    fun `a null value deletes the setting`() {
        assertTrue(write("enabled_accessibility_services", "com.lunabot.companion/.phoneui.PhoneUiAccessibilityService"))
        assertEquals(
            "com.lunabot.companion/.phoneui.PhoneUiAccessibilityService",
            Settings.Secure.getString(resolver, "enabled_accessibility_services"),
        )
        // Decision.Write(remove = "") applies as a delete, not as an empty string.
        assertTrue(write("enabled_accessibility_services", null))
        assertNull(Settings.Secure.getString(resolver, "enabled_accessibility_services"))

        assertTrue(write("adb_wifi_enabled", "1"))
        assertTrue(write("adb_wifi_enabled", null))
        assertNull(Settings.Global.getString(resolver, "adb_wifi_enabled"))
    }

    @Test
    fun `a value over the bound is refused and leaves the old value`() {
        assertTrue(write("enabled_accessibility_services", "com.a/.B"))
        val tooLong = "a".repeat(PhoneUiShellService.MAX_SECURE_SETTING_CHARS + 1)
        assertFalse(write("enabled_accessibility_services", tooLong))
        assertEquals("com.a/.B", Settings.Secure.getString(resolver, "enabled_accessibility_services"))
        // Exactly at the bound is still a setting a repair could mean.
        val atBound = "a".repeat(PhoneUiShellService.MAX_SECURE_SETTING_CHARS)
        assertTrue(write("enabled_accessibility_services", atBound))
        assertEquals(atBound, Settings.Secure.getString(resolver, "enabled_accessibility_services"))
    }

    @Test
    fun `a control character is refused and leaves the old value`() {
        assertTrue(write("enabled_accessibility_services", "com.a/.B"))
        for (bad in listOf("com.a/.B\n", "com.a/.B\u0000", "com.a/.B\u0007", "com.a/.B\t", "com.a/.B\u001b")) {
            assertFalse(write("enabled_accessibility_services", bad), "value with a control character must be refused")
        }
        // Whitespace is not a component character either, so a space is refused too.
        assertFalse(write("enabled_accessibility_services", "com.a .B"))
        assertEquals("com.a/.B", Settings.Secure.getString(resolver, "enabled_accessibility_services"))
    }

    @Test
    fun `the validator refuses shapes no repair writes`() {
        assertTrue(PhoneUiShellService.secureSettingValueAllowed(null))
        assertTrue(PhoneUiShellService.secureSettingValueAllowed("1"))
        assertTrue(PhoneUiShellService.secureSettingValueAllowed("com.a/.B:com.c/.D,com.e/.F"))
        assertFalse(PhoneUiShellService.secureSettingValueAllowed("a".repeat(PhoneUiShellService.MAX_SECURE_SETTING_CHARS + 1)))
        assertFalse(PhoneUiShellService.secureSettingValueAllowed("has space"))
        assertFalse(PhoneUiShellService.secureSettingValueAllowed("has\ttab"))
        assertFalse(PhoneUiShellService.secureSettingValueAllowed("has\nnewline"))
        assertFalse(PhoneUiShellService.secureSettingValueAllowed("semi;colon"))
        assertFalse(PhoneUiShellService.secureSettingValueAllowed("quote'"))
        // Component names are ASCII; a non-ASCII letter is not a name either.
        assertFalse(PhoneUiShellService.secureSettingValueAllowed("com.\u00e9/.B"))
    }
}
