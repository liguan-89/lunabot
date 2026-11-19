pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        // sherpa-onnx 的 Android AAR 不在 Maven Central，上游只发 Jitpack 坐标。
        maven("https://jitpack.io")
    }
}

rootProject.name = "lunabot-android"
include(":core")
include(":app")
// The generator for app/src/main/baseline-prof.txt. It is a test-only module:
// nothing from it ships, and it is run by hand when the profile is refreshed.
include(":baselineprofile")
