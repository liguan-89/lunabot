/*
 * The baseline-profile generator.
 *
 * A `com.android.test` module that targets :app, instruments it as a real user
 * would, and writes the ART method/class list the app starts with. The output is
 * copied into `app/src/main/baseline-prof.txt`, which AGP packages into every
 * build; `ProfileInstaller` (declared by :app) installs it on devices below
 * Android 12. Refreshing it is a deliberate manual step:
 *
 *   ./gradlew :baselineprofile:connectedDebugAndroidTest
 *
 * and then copy the `baseline-prof.txt` the run prints the path of. The module
 * is not part of `assemble` or CI: a profile generated on an emulator is a
 * starting point, not evidence about a phone.
 */
plugins {
    // AGP's test-module plugin: same Android version catalogue, no APK of its
    // own to publish. Kotlin support is built into AGP 9 — applying
    // `org.jetbrains.kotlin.android` here is an error on this AGP.
    id("com.android.test")
}

android {
    namespace = "com.lunabot.companion.baselineprofile"
    compileSdk = 37

    defaultConfig {
        // BaselineProfileRule needs API 28; the app itself starts at 26.
        minSdk = 28
        targetSdk = 37
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    targetProjectPath = ":app"
    // The test runs in its own process against the installed target APK, which
    // is what lets `startActivityAndWait` measure a real cold start.
    experimentalProperties["android.experimental.self-instrumenting"] = true
}

dependencies {
    implementation("androidx.test.ext:junit:1.3.0")
    implementation("androidx.test:runner:1.7.0")
    implementation("androidx.test.uiautomator:uiautomator:2.3.0")
    implementation("androidx.benchmark:benchmark-macro-junit4:1.4.1")
}
