package com.openmausbot.companion.baselineprofile

import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Until
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The path the generator walks, which becomes `baseline-prof.txt`.
 *
 * It is deliberately short and tolerant: the app's first screen depends on
 * whether this installation has paired before, and the profile is about what a
 * cold start loads (Compose, the theme, the roster/pairing screen, the network
 * stack), not about a scripted tour. Anything past the first screen would make
 * the generator fail on an unpaired device and buy little.
 */
@RunWith(AndroidJUnit4::class)
class BaselineProfileGenerator {

    @get:Rule
    val rule = BaselineProfileRule()

    @Test
    fun generate() {
        rule.collect(
            packageName = PACKAGE,
            includeInStartupProfile = true,
        ) {
            pressHome()
            startActivityAndWait()
            // Let the first frame and the session's initial hydrate land; the
            // measured work is still the cold start that precedes them.
            device.wait(Until.hasObject(By.pkg(PACKAGE).depth(0)), 5_000)
            device.waitForIdle(2_000)
        }
    }

    private companion object {
        const val PACKAGE = "com.lunabot.companion"
    }
}
