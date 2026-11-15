# mika

The local wireless-debugging ADB protocol in
`android/core/src/main/kotlin/com/dexbot/companion/core/phoneui/adb/`
(`AdbHosts`, `AdbMessage`, `AdbConnection`, `AdbIdentity`, `Ed25519`, `AdbTls`,
`PairingAuth`, `Spake2`, `AdbPairing` and the tests + SPAKE2 golden vectors
under `android/core/src/test/`) is ported from
[Mika](https://github.com/wangzan101/Mika)'s
`core/src/main/kotlin/com/wangzan101/mika/core/adb/` and its tests
(Apache-2.0, see `LICENSE`; Copyright 2026 wangzan101). Each ported file keeps
the original copyright and an Apache §4(b) notice of the changes made.

Modified: repackaged under `com.dexbot.companion.core.phoneui.adb`, comments
translated into English, assertions moved from JUnit 4 to kotlin.test; the
storage glue (`AdbIdentitySource`, `AdbKeyState`, `AdbKeyStore`,
`WrappedKeyFile`) and the mDNS discovery types (`AdbServiceTypes`,
`AdbServiceFinder`) are intentionally not ported, that stays app-side.
