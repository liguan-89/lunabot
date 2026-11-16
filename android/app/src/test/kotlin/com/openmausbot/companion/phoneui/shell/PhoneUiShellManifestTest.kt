/*
 * The handoff provider's security posture is mostly declared in the manifest:
 * exported at all only because shell must reach it, gated behind
 * INTERACT_ACROSS_USERS_FULL, single-process, and the authority derived from
 * the application id. These assertions cover the attributes no compiler or
 * unit test would otherwise notice going missing.
 */
package com.openmausbot.companion.phoneui.shell

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import org.w3c.dom.Element

class PhoneUiShellManifestTest {
    private val android = "http://schemas.android.com/apk/res/android"

    private val manifest: Element by lazy {
        val document = DocumentBuilderFactory.newInstance()
            .apply { isNamespaceAware = true }
            .newDocumentBuilder()
            .parse(locateManifest())
        document.documentElement
    }

    private fun locateManifest(): File {
        var directory: File? = File(".").absoluteFile
        while (directory != null) {
            for (candidate in listOf("src/main/AndroidManifest.xml", "app/src/main/AndroidManifest.xml")) {
                val file = File(directory, candidate)
                if (file.isFile) return file
            }
            directory = directory.parentFile
        }
        error("could not find AndroidManifest.xml from ${File(".").absolutePath}")
    }

    private fun provider(): Element {
        val providers = manifest.getElementsByTagName("provider")
        for (index in 0 until providers.length) {
            val element = providers.item(index) as Element
            if (element.getAttributeNS(android, "name") == ".phoneui.shell.PhoneUiHandoffProvider") return element
        }
        error("no <provider android:name=\".phoneui.shell.PhoneUiHandoffProvider\"> in the manifest")
    }

    @Test
    fun `the handoff provider is exported only behind the cross-user permission`() {
        val provider = provider()
        assertEquals("true", provider.getAttributeNS(android, "exported"))
        assertEquals(
            "android.permission.INTERACT_ACROSS_USERS_FULL",
            provider.getAttributeNS(android, "permission"),
            "shell must hold INTERACT_ACROSS_USERS_FULL to reach the provider; ordinary apps must not",
        )
    }

    @Test
    fun `the authority is the application id plus phoneui dot helper`() {
        assertEquals(
            "${'$'}{applicationId}.phoneui.helper",
            provider().getAttributeNS(android, "authorities"),
        )
    }

    @Test
    fun `the provider is single-process`() {
        assertEquals("false", provider().getAttributeNS(android, "multiprocess"))
    }

    @Test
    fun `no application component is exported without a gate`() {
        // The helper deliberately declares no service or receiver; the only new
        // exported component is the permission-gated provider itself.
        val providers = manifest.getElementsByTagName("provider")
        var gated = 0
        var exported = 0
        for (index in 0 until providers.length) {
            val element = providers.item(index) as Element
            if (element.getAttributeNS(android, "exported") == "true") {
                exported++
                if (element.hasAttributeNS(android, "permission")) gated++
            }
        }
        assertEquals(exported, gated, "every exported provider must carry a permission")
    }

    @Test
    fun `the accessibility reader service is bound only by the system`() {
        val services = manifest.getElementsByTagName("service")
        var reader: Element? = null
        for (index in 0 until services.length) {
            val element = services.item(index) as Element
            if (element.getAttributeNS(android, "name") == ".phoneui.PhoneUiAccessibilityService") reader = element
        }
        val service = assertNotNull(reader, "the manifest must declare .phoneui.PhoneUiAccessibilityService")
        // Android's Settings process binds across UIDs; exported=true is required,
        // while the signature-level binding permission keeps ordinary apps out.
        assertEquals("true", service.getAttributeNS(android, "exported"))
        assertEquals(
            "android.permission.BIND_ACCESSIBILITY_SERVICE",
            service.getAttributeNS(android, "permission"),
            "only the system may bind the reader service",
        )
        val actions = service.getElementsByTagName("action")
        var hasFilter = false
        for (index in 0 until actions.length) {
            if ((actions.item(index) as Element).getAttributeNS(android, "name") ==
                "android.accessibilityservice.AccessibilityService"
            ) hasFilter = true
        }
        assertTrue(hasFilter, "the accessibility intent filter is what the system's switch looks for")
        val meta = service.getElementsByTagName("meta-data")
        var hasConfig = false
        for (index in 0 until meta.length) {
            val element = meta.item(index) as Element
            if (element.getAttributeNS(android, "name") == "android.accessibilityservice" &&
                element.getAttributeNS(android, "resource") == "@xml/phoneui_accessibility_service"
            ) hasConfig = true
        }
        assertTrue(hasConfig, "the service must point at @xml/phoneui_accessibility_service")
    }

    @Test
    fun `the accessibility config never widens past window reading`() {
        val file = locateManifest().parentFile
            ?.resolve("res/xml/phoneui_accessibility_service.xml")
        val config = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(assertNotNull(file)).documentElement
        assertEquals(
            "typeWindowStateChanged",
            config.getAttribute("android:accessibilityEventTypes"),
            "window state changes only: content updates are routine and must not invalidate refs between observe and act",
        )
        assertEquals("feedbackGeneric", config.getAttribute("android:accessibilityFeedbackType"))
        assertEquals(
            "flagRetrieveInteractiveWindows|flagReportViewIds",
            config.getAttribute("android:accessibilityFlags"),
        )
        assertEquals("true", config.getAttribute("android:canRetrieveWindowContent"))
        for (forbidden in listOf(
            "canTakeScreenshot",
            "canPerformGestures",
            "canRequestFilterKeyEvents",
            "canRequestTouchExplorationMode",
        )) {
            assertFalse(
                config.hasAttribute("android:$forbidden"),
                "android:$forbidden must stay undeclared; the reader service reads windows only",
            )
        }
    }
}
