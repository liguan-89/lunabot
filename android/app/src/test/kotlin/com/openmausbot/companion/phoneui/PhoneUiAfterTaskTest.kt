/*
 * Pins the after-task decision: keeping is the default and finishes nothing,
 * closing needs a package the bot may name, and the app's own package, the
 * system UI and the shell helper are never finished.
 */
package com.openmausbot.companion.phoneui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class PhoneUiAfterTaskTest {
    private val self = "com.openmausbot.companion"
    private val app = "com.tencent.mm"

    @Test
    fun `no choice recorded keeps the app, as release always did`() {
        val after = PhoneUiAfterTask()
        assertNull(after.choice)
        assertEquals(PhoneUiAfterTask.Decision.Keep, after.decide(app, self))
        assertEquals(
            PhoneUiAfterTask.Decision.Keep,
            PhoneUiAfterTask.whatToDo(null, app, self, PhoneUiAfterTask.SYSTEM_UI_PACKAGES),
        )
    }

    @Test
    fun `keep leaves the app running even when a package was named`() {
        val after = PhoneUiAfterTask()
        after.record(PhoneUiAfterTask.Choice.KEEP, app)
        assertEquals(PhoneUiAfterTask.Choice.KEEP, after.choice)
        assertEquals(PhoneUiAfterTask.Decision.Keep, after.decide(app, self))
    }

    @Test
    fun `close finishes the recorded package`() {
        val after = PhoneUiAfterTask()
        after.record(PhoneUiAfterTask.Choice.CLOSE, app)
        assertEquals(PhoneUiAfterTask.Decision.Close(app), after.decide(null, self))
    }

    @Test
    fun `close without a package names the app the task drove last`() {
        val after = PhoneUiAfterTask()
        after.record(PhoneUiAfterTask.Choice.CLOSE)
        assertEquals(PhoneUiAfterTask.Decision.Close(app), after.decide(app, self))
    }

    @Test
    fun `close with no package anywhere has nothing to finish`() {
        assertEquals(
            PhoneUiAfterTask.Decision.Nothing,
            PhoneUiAfterTask.whatToDo(PhoneUiAfterTask.Choice.CLOSE, null, self, PhoneUiAfterTask.SYSTEM_UI_PACKAGES),
        )
    }

    @Test
    fun `close refuses our own package, the system ui and the shell helper`() {
        for (pkg in listOf(self, "android", "com.android.systemui", "com.android.shell")) {
            assertEquals(
                PhoneUiAfterTask.Decision.Nothing,
                PhoneUiAfterTask.whatToDo(PhoneUiAfterTask.Choice.CLOSE, pkg, self, PhoneUiAfterTask.SYSTEM_UI_PACKAGES),
                pkg,
            )
        }
        // A home app the caller did not name is still closable when the phone reports it as the last one driven.
        assertEquals(
            PhoneUiAfterTask.Decision.Close("com.miui.home"),
            PhoneUiAfterTask.whatToDo(PhoneUiAfterTask.Choice.CLOSE, "com.miui.home", self, PhoneUiAfterTask.SYSTEM_UI_PACKAGES),
        )
    }

    @Test
    fun `close refuses a package that is not a package name`() {
        for (pkg in listOf("", "com", "com.example;rm", "com.exa mple")) {
            assertEquals(
                PhoneUiAfterTask.Decision.Nothing,
                PhoneUiAfterTask.whatToDo(PhoneUiAfterTask.Choice.CLOSE, pkg, self, PhoneUiAfterTask.SYSTEM_UI_PACKAGES),
                pkg,
            )
        }
    }

    @Test
    fun `the wire words parse case insensitively and nothing else does`() {
        assertEquals(PhoneUiAfterTask.Choice.KEEP, PhoneUiAfterTask.Choice.parse("keep"))
        assertEquals(PhoneUiAfterTask.Choice.CLOSE, PhoneUiAfterTask.Choice.parse(" Close "))
        assertNull(PhoneUiAfterTask.Choice.parse("background"))
        assertNull(PhoneUiAfterTask.Choice.parse(null))
    }

    @Test
    fun `clear returns the task to the default`() {
        val after = PhoneUiAfterTask()
        after.record(PhoneUiAfterTask.Choice.CLOSE, app)
        after.clear()
        assertNull(after.choice)
        assertNull(after.packageName)
        assertEquals(PhoneUiAfterTask.Decision.Keep, after.decide(app, self))
    }
}
