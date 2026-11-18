/*
 * Pins the probe paths themselves, not the verdicts: the fakes below stand in
 * for the shell helper and the accessibility tree, so a test can make a call
 * throw, a snapshot come back empty, or no browser exist, and then check what
 * the probe did — above all that every display it opened was released, even
 * when the step between opening and closing threw.
 *
 * The waits inside the probes are coroutine timeouts, so `runTest` drives them
 * on its virtual clock: no test here waits on wall time, and a probe that would
 * hang on a phone fails its own bounded wait instead.
 */
package com.openmausbot.companion.phoneui

import android.content.Context
import android.view.Display
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

class PhoneUiProbesProbeTest {
    /** One display the fake shell handed out; [closed] is what the release tests read. */
    private class FakeDisplay(override val displayId: Int) : ProbeDisplay {
        var closed = false
        override val width: Int = PhoneUiRules.DEFAULT_WIDTH
        override val height: Int = PhoneUiRules.DEFAULT_HEIGHT

        override fun close() {
            closed = true
        }
    }

    /**
     * A helper that behaves the way the AIDL describes, with each answer
     * configurable. A launch records its package as the top task of the display,
     * which is what the real helper's task list would show a moment later.
     */
    private class FakeShell(
        private val maxDisplays: Int = 10,
        private val launchCode: Int = LAUNCH_OK,
        private val acceptsInput: Boolean = true,
        private val movesTasks: Boolean = true,
        private val attached: Boolean = true,
        private val launchThrows: Boolean = false,
        private val mainTaskId: Int = 42,
    ) : ProbeShell {
        val displays = mutableListOf<FakeDisplay>()
        var launches = 0
        var injected = 0
        private var nextTaskId = 100
        private val topOf = mutableMapOf<Int, String>()
        private val taskOf = mutableMapOf<Int, Int>()

        val opened: Int get() = displays.size
        val closed: Int get() = displays.count { it.closed }
        val allClosed: Boolean get() = displays.all { it.closed }

        override fun openDisplay(): ProbeDisplay? {
            if (displays.size >= maxDisplays) return null
            return FakeDisplay(displays.size + 1).also { displays += it }
        }

        override fun launchApp(displayId: Int, packageName: String): Int {
            if (launchThrows) throw IllegalStateException("binder died")
            launches++
            if (launchCode == LAUNCH_OK) {
                topOf[displayId] = packageName
                taskOf[displayId] = nextTaskId++
            }
            return launchCode
        }

        override fun topPackage(displayId: Int): String? = topOf[displayId]

        override fun topTaskId(displayId: Int): Int =
            if (displayId == Display.DEFAULT_DISPLAY) mainTaskId else taskOf[displayId] ?: -1

        override fun packageOfTask(taskId: Int): String? =
            taskOf.entries.firstOrNull { it.value == taskId }?.let { topOf[it.key] }

        override fun moveTask(taskId: Int, displayId: Int): Boolean {
            if (!movesTasks) return false
            val source = taskOf.entries.firstOrNull { it.value == taskId } ?: return false
            val packageName = topOf.remove(source.key) ?: return false
            taskOf.remove(source.key)
            topOf[displayId] = packageName
            taskOf[displayId] = taskId
            return true
        }

        override fun injectKey(displayId: Int, keyCode: Int): Boolean {
            injected++
            return acceptsInput
        }

        override fun isAttached(): Boolean = attached
    }

    private fun snapshot(displayId: Int, elements: List<PhoneUiElement>): PhoneUiSnapshot = PhoneUiSnapshot(
        id = "snap-$displayId",
        displayId = displayId,
        takenAtMs = 0L,
        truncated = false,
        elements = elements,
    )

    private fun node(text: String?, viewId: String?): PhoneUiElement = PhoneUiElement(
        ref = "ref-${text ?: viewId}",
        viewId = viewId,
        className = "android.widget.TextView",
        text = text,
        description = null,
        bounds = listOf(0, 0, 100, 100),
        clickable = false,
        editable = false,
        scrollable = false,
        password = false,
    )

    // MARK: - Release

    @Test
    fun `every display probe releases the displays it opened`() = runTest {
        val shell = FakeShell()
        val tree = ProbeTree { displayId -> snapshot(displayId, listOf(node("Settings", "id/title"))) }

        assertEquals(ProbeStatus.Pass, displayProbe(shell).status)
        assertEquals(ProbeStatus.Pass, launchAppProbe(shell, BENIGN_APP_PACKAGE).status)
        assertEquals(ProbeStatus.Pass, readScreenProbe(shell, tree, BENIGN_APP_PACKAGE).status)
        assertEquals(ProbeStatus.Pass, actProbe(shell, BENIGN_APP_PACKAGE).status)
        assertEquals(ProbeStatus.Pass, browserProbe(shell, "com.android.chrome").status)
        assertEquals(ProbeStatus.Pass, sandboxProbe(shell, BENIGN_APP_PACKAGE).status)
        assertEquals(ProbeStatus.Pass, staysAliveProbe(shell).status)

        assertTrue(shell.allClosed, "every display the probes opened was released")
        assertEquals(shell.opened, shell.closed)
    }

    @Test
    fun `a launch that throws still releases the display and fails with the helper's error code`() = runTest {
        val shell = FakeShell(launchThrows = true)

        val outcome = launchAppProbe(shell, BENIGN_APP_PACKAGE)

        assertEquals(ProbeStatus.Fail, outcome.status)
        assertTrue(outcome.detail.contains("code $LAUNCH_ERROR"), outcome.detail)
        assertEquals(1, shell.opened)
        assertEquals(1, shell.closed)
    }

    @Test
    fun `a second display that cannot be opened releases the first`() = runTest {
        val shell = FakeShell(maxDisplays = 1)

        val outcome = sandboxProbe(shell, BENIGN_APP_PACKAGE)

        assertEquals(ProbeStatus.Fail, outcome.status)
        assertTrue(outcome.detail.contains("two displays"), outcome.detail)
        assertEquals(1, shell.opened)
        assertEquals(1, shell.closed)
    }

    @Test
    fun `withProbeDisplay closes on a throw from the body`() = runTest {
        val shell = FakeShell()

        assertFailsWith<IllegalStateException> {
            withProbeDisplay(shell) { throw IllegalStateException("step failed") }
        }

        assertEquals(1, shell.opened)
        assertTrue(shell.displays.single().closed)
    }

    // MARK: - Helper absent

    @Test
    fun `every display probe fails, not skips, when the helper is absent`() = runTest {
        val tree = ProbeTree { snapshot(it, listOf(node("x", null))) }
        val outcomes = listOf(
            displayProbe(null),
            launchAppProbe(null, BENIGN_APP_PACKAGE),
            readScreenProbe(null, tree, BENIGN_APP_PACKAGE),
            actProbe(null, BENIGN_APP_PACKAGE),
            browserProbe(null, "com.android.chrome"),
            sandboxProbe(null, BENIGN_APP_PACKAGE),
            staysAliveProbe(null),
        )
        for (outcome in outcomes) {
            assertEquals(ProbeStatus.Fail, outcome.status, outcome.detail)
            assertTrue(outcome.detail.contains("helper is not attached"), outcome.detail)
            assertNotNull(outcome.fix, "a failure always says what to do")
        }
    }

    // MARK: - No browser

    @Test
    fun `no browser installed fails without opening a display`() = runTest {
        val shell = FakeShell()

        val outcome = browserProbe(shell, browser = null)

        assertEquals(ProbeStatus.Fail, outcome.status)
        assertEquals("no browser is installed on this phone", outcome.detail)
        assertEquals(0, shell.opened, "nothing was created, so nothing needed releasing")
    }

    // MARK: - Empty tree

    @Test
    fun `an empty snapshot fails screen reading and the display is released`() = runTest {
        val shell = FakeShell()
        val empty = ProbeTree { displayId -> snapshot(displayId, emptyList()) }

        val outcome = readScreenProbe(shell, empty, BENIGN_APP_PACKAGE)

        assertEquals(ProbeStatus.Fail, outcome.status)
        assertTrue(outcome.detail.contains("no readable application window"), outcome.detail)
        assertEquals(1, shell.opened)
        assertEquals(1, shell.closed)
    }

    @Test
    fun `a snapshot that cannot be taken fails as an Android version problem`() = runTest {
        val shell = FakeShell()
        val unsupported = ProbeTree { null }

        val outcome = readScreenProbe(shell, unsupported, BENIGN_APP_PACKAGE)

        assertEquals(ProbeStatus.Fail, outcome.status)
        assertTrue(outcome.detail.contains("per display"), outcome.detail)
        assertEquals(1, shell.closed)
    }

    @Test
    fun `a tree that only ever has unlabelled nodes still fails and is released`() = runTest {
        val shell = FakeShell()
        val bare = ProbeTree { displayId -> snapshot(displayId, listOf(node(null, null))) }

        val outcome = readScreenProbe(shell, bare, BENIGN_APP_PACKAGE)

        assertEquals(ProbeStatus.Fail, outcome.status)
        assertTrue(outcome.detail.contains("carries text or a resource id"), outcome.detail)
        assertEquals(1, shell.closed)
    }

    // MARK: - The action and sandbox observations

    @Test
    fun `actions sends exactly one back key to the helper's own display`() = runTest {
        val shell = FakeShell()

        val outcome = actProbe(shell, BENIGN_APP_PACKAGE)

        assertEquals(ProbeStatus.Pass, outcome.status)
        assertEquals(1, shell.injected)
        assertEquals(1, shell.closed)
    }

    @Test
    fun `a refused back key fails actions`() = runTest {
        val outcome = actProbe(FakeShell(acceptsInput = false), BENIGN_APP_PACKAGE)
        assertEquals(ProbeStatus.Fail, outcome.status)
        assertTrue(outcome.detail.contains("refused a back key"), outcome.detail)
    }

    @Test
    fun `the sandbox check leaves the person's top task alone`() = runTest {
        val shell = FakeShell()

        val outcome = sandboxProbe(shell, BENIGN_APP_PACKAGE)

        assertEquals(ProbeStatus.Pass, outcome.status)
        assertEquals(42, shell.topTaskId(Display.DEFAULT_DISPLAY), "the person's screen is unchanged")
        assertTrue(shell.displays.all { it.displayId != Display.DEFAULT_DISPLAY })
        assertEquals(2, shell.closed)
    }

    @Test
    fun `a helper that will not move a task fails the sandbox`() = runTest {
        val outcome = sandboxProbe(FakeShell(movesTasks = false), BENIGN_APP_PACKAGE)
        assertEquals(ProbeStatus.Fail, outcome.status)
        assertTrue(outcome.detail.contains("could not move a task"), outcome.detail)
    }

    @Test
    fun `stays alive detaches its answer from a helper that already went away`() = runTest {
        val outcome = staysAliveProbe(FakeShell(attached = false))
        assertEquals(ProbeStatus.Fail, outcome.status)
        assertTrue(outcome.detail.contains("detached"), outcome.detail)
    }

    @Test
    fun `stays alive fails when the helper stops handing out displays`() = runTest {
        val outcome = staysAliveProbe(FakeShell(maxDisplays = 1))
        assertEquals(ProbeStatus.Fail, outcome.status)
        assertTrue(outcome.detail.contains("second display"), outcome.detail)
    }

    // MARK: - No app to drive

    @Test
    fun `with no launchable app the display probes fail before opening anything`() = runTest {
        val shell = FakeShell()
        val tree = ProbeTree { snapshot(it, listOf(node("x", null))) }

        assertEquals(ProbeStatus.Fail, launchAppProbe(shell, null).status)
        assertEquals(ProbeStatus.Fail, readScreenProbe(shell, tree, null).status)
        assertEquals(ProbeStatus.Fail, actProbe(shell, null).status)
        assertEquals(ProbeStatus.Fail, sandboxProbe(shell, null).status)
        assertEquals(0, shell.opened)
    }
}

/**
 * The two package-resolution reads, on a bare Robolectric phone: nothing is
 * installed but the app under test, so no browser resolves and no settings
 * package exists. That is the "no browser installed" branch at its source.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PhoneUiProbesPackagesTest {
    private val context: Context = RuntimeEnvironment.getApplication()

    @Test
    fun `a phone with no browser resolves to no browser package`() {
        assertNull(PhoneUiProbesPackagesTestAccess.browserPackage(context))
    }

    @Test
    fun `the benign app falls back when system settings is not installed`() {
        // Robolectric's phone has no com.android.settings, so the fallback list
        // decides; with no launchable app at all the answer is null rather than
        // a package the helper would then refuse.
        val benign = PhoneUiProbesPackagesTestAccess.benignApp(context)
        assertTrue(benign == null || benign != BENIGN_APP_PACKAGE)
    }

    @Test
    fun `the probe map answers every check`() {
        val probes = phoneUiProbes(
            context,
            shell = { null },
            accessibility = { null },
        )
        assertEquals(PhoneUiCheck.entries.toSet(), probes.keys)
    }

    @Test
    fun `the app list judge never turns an empty answer into a pass`() {
        // Whatever Robolectric's package manager enumerates, the mapping is the
        // one the phone relies on: nothing visible fails, something visible
        // passes with its count.
        val launchable = launchablePackages(context.packageManager)
        val outcome = judgeAppCopies(launchable)
        if (launchable.isNullOrEmpty()) {
            assertEquals(ProbeStatus.Fail, outcome.status)
        } else {
            assertEquals(ProbeStatus.Pass, outcome.status)
            assertTrue(outcome.detail.contains("${launchable.size} launchable apps"), outcome.detail)
        }
    }
}

/** Test-only access to the internal package reads, which take the app's PackageManager. */
private object PhoneUiProbesPackagesTestAccess {
    fun browserPackage(context: Context): String? = browserPackageOf(context.packageManager)

    fun benignApp(context: Context): String? =
        benignAppPackage(context.packageManager, launchablePackages(context.packageManager))
}
