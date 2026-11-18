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

The app-side screen automation adaptations are in
`android/app/src/main/kotlin/com/openmausbot/companion/phoneui/`:
`PhoneUiStability` (from `cap/phone/a11y/ChangeWait.kt`),
`PhoneUiClickFallback` (`ClickFallback.kt`), `PhoneUiSpill`
(`MainScreenSpill.kt` and `cap/phone/shell/MainScreenWatch.kt`),
`PhoneUiSystemPickers` (`SystemPickers.kt`), `PhoneUiDisplayAwake`
(`cap/phone/shell/DisplayAwake.kt`), and the key/text rules in `PhoneUiKeys`
plus `PhoneUiShellService.typeText` (`cap/phone/shell/AsciiTextKeys.kt`).
They were rewritten for this app's plain accessibility-tree reader and tool
surface: Mika's frame-brightness change channel, task-stack listener, audio
ledger and multi-heuristic task moving are not ported. A spill is detected by
polling the main display's top task and corrected with one bounded
`moveRootTaskToDisplay` call.

The Mika paths below are Mika source paths, not paths in this repository, and
are abbreviated to the subtree that identifies them: a `cap/` path is under
`app/src/main/java/com/wangzan101/mika/`, everything else under
`core/src/main/kotlin/com/wangzan101/mika/core/`, unless the full path is
given. Four further modules in the same `phoneui/` directory port Mika's
pacing, shell-repair and self-check code; each is data-in/data-out code with
its effects handed in by the caller, and none of them is wired into the
executor or a service yet.

`PhoneUiPacing` comes from `cap/phone/OperatingPace.kt`, `TypingPacing.kt`,
`GesturePacing.kt`, `AppPacing.kt` and `uistate/Pace.kt`: repackaged, comments
translated, no coroutines or Android types, gestures emit integer arrays ready
for `PhoneUiShell.injectStroke`, and the app-knowledge verdict is a small map
rather than a site-knowledge record. Everything is pure — randomness and the
clock arrive as parameters, nothing sleeps, and every duration is clamped by a
`PhoneUiPaceLimits` value.

`PhoneUiSelfRepair` (`shell/WirelessDebuggingAutoOn.kt`) is repackaged and
translated, with the StateFlow and coroutine plumbing replaced by an immutable
`State` and pure transitions, and the settings write plus the clock supplied by
the caller.

`PhoneUiAccessibilityRepair` (`shell/AccessibilityRepair.kt` and the
`AccessibilityList` half of `shell/RecoveryPermissions.kt`) is likewise
repackaged and translated, with flows and coroutines replaced by immutable
state and pure transitions, the clock taken as a parameter, and the shell
command execution left to the caller.

`PhoneUiSelfCheck` (`selfcheck/SelfCheck.kt`, `SelfCheckRunner.kt` and
`SelfCheckReport.kt`) is repackaged and translated into English, with no
Android imports, no StateFlow and no progress stream. Probes arrive as a map,
the clock as a parameter, and the whole run is one suspend call returning a
report, which is what makes its order, skips, timeouts and budget testable on
the JVM. Its divergences are named: Pass/Partial/Fail becomes
Pass/Fail/Skipped with the caveat in the detail, Mika's localized `Advice` enum
becomes one optional fix sentence per probe, its release hook is gone because
nothing here owns a resource, and the floor is Android 11 (SDK 30) where Mika's
phone control starts at 12.

`shared/irreversible.ts` rewrites the closed word lists of
`gate/IrreversibleDetector.kt` and the one-shot approval grant of
`gate/ConfirmationGate.kt`, with `IrrevAction` from `risk/Irreversible.kt`,
Kotlin→TypeScript. The fold is its own, limited to the Traditional characters
its lists actually use, following the rule Mika's Hant applies. Deliberate
divergences: the English table matches a whole label only, so "Send message to
Alice" is no longer a send, and the Chinese prefix words are ported for send
alone, because Mika's delete half needs its `editsField` guard and our flat
element list has no field-to-button containment. `SUBMIT_WORDS`, the
contact/application and booking tables, `EXACT_PAY`, `RED_PACKET`,
`PUNCT_WORDS`, the financial-job exemption, key-combo and drag/select handling
and the payment-page amount rules are not ported, and a pay hit is never
approvable here because the gate refuses pay by name. The grant covers order,
delete and send, survives typing only (Mika also keeps it through clearing a
field), and is voided by any other write or by `MAX_STEPS` steps.

`shared/route-replay.ts` is the pure core of `replay/Route.kt`, `RouteSlots.kt`,
`RouteMatcher.kt` and `RouteRecorder.kt` plus `agent/LearnGate.kt` — template
extraction, matching, anchors, effective-write, what a run may save, and a path
fingerprint of our own that keeps `samePath`'s idea of identity — again
Kotlin→TypeScript. Left to the storage and replay layers: the route codec and
`app/src/main/java/com/wangzan101/mika/replay/FileRouteStore.kt`,
`withCurrentToolNames`, `replacing`/`samePath` (`replay/RouteStore.kt`), the
share envelope of `replay/RouteShare.kt`, `RouteAnchors.elementAt`, and
everything that calls a model; a caller that must choose between several
fitting routes gets `needsDecision` and supplies its own classifier.

`server/phone-notices.ts` ports the learning layer of
`proactive/NoticeInbox.kt`, `NoticeFilter.kt`, `NoticeDedup.kt`,
`TriagePlanner.kt`, `LearnLevel.kt`, `LearnTuning.kt` and `NoticeRecord.kt` as
pure in-memory logic with no HTTP, model client or storage; `NoticeShapes`
(splitting a chat notification into conversation, speaker and line),
`LiveUpdates`, `CatchUp` and the shade reconcile, the dedup codec and journal,
`LearnBuffer`/`TopicPool`/`ContactPool`, prompt building and reply parsing stay
out, and `planTriage` only says whether a request may be sent.

`server/intent-gate.ts` (`agent/IntentGate.kt`) keeps only the question, its
parsing and the fallback rule — no decider, no HTTP, no config — and carries
Mika's thresholds and option meanings unchanged, its instructions with the
product name replaced by "the assistant", and the 0.85 probability and 10 s
budget flagged as not yet re-validated against our providers. One deliberate
divergence: neither callback is caught, so an ordinary failure has to arrive as
`{ ok: false }` or a null reply rather than a throw, where Mika swallowed every
failure except a cancellation.

`server/phone-guards.ts` ports
`guard/OperationGuards.kt`, `GuardRules.kt` and `Fingerprints.kt`
Kotlin→TypeScript: each action is fingerprinted, a tap's x and y are floored
onto a 50-pixel grid before comparison, and a repeated action, an unchanged
screen or a state cycle yields a warning with concrete ways out or a stop. The
off-screen guard and its quotas (`guard/OffScreenGuard.kt`), the read-loop
guard, the tool-failure ladder, the separate same-state visit counter, the
diagnostic-tool repeat ladder and the budget-scaled stops are not ported: only
a run of consecutive identical actions counts, and the thresholds are Mika's,
not measured against our tools.

Deliberately left behind across all of the above: Mika's storage glue (its ADB
key store, the route codec and file store, the notification journal and
`app/src/main/java/com/wangzan101/mika/record/RunStore.kt`), its model client
(`agent/ModelCaller.kt` and `ModelRouter.kt`), its Android
notification-format parsing (`proactive/NoticeShapes.kt`), its screen-port and
snapshot plumbing (`uistate/ScreenPort.kt`, `ScreenSession.kt`,
`AppAccessScreenPort.kt`) and its Compose UI
(`app/src/main/java/com/wangzan101/mika/ui/`). Each of the new ports takes its
effects as parameters or callbacks; the wiring that supplies them is ours.
