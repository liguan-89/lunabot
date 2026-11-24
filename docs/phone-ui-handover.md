# Phone UI execution: handover

> **Stale snapshot (2026-11-24 note):** this file describes branch
> `lunabot-install-fix` at `29fa9953c`, before the Mika wiring landed. For the
> current wiring state — intent gate, route replay, pacing, notice learning,
> DO_EACH and the audit fixes — see the "Status update" section at the top of
> `docs/mika-gap-analysis.md`.

Where the phone-UI work stands, what is deliberately left, and what each
remaining item is waiting on. The gap analysis against Mika is
`docs/mika-gap-analysis.md`; this file is the state of the branch and the
handoff.

Branch `lunabot-install-fix`. HEAD before this document landed: `29fa9953c`. The working tree is
**not** clean: several other sessions are editing `android/app/.../ui/`,
`server/workspace.ts`, `server/phones/host.ts`, the settings modals and new
`wechat/` sources at the same time. Nothing in this document depends on those
files being quiet, but see "Hazards" before running Gradle.

## What this work delivered

Phone-UI tools, end to end (server schema, capability, read/write class, prompt
prose, activity row, locale, job fixture, Android catalog, executor, tests):

- `PHONE_UI_QUERY`, `PHONE_LIST_APPS`, `PHONE_UI_RUN`, `PHONE_UI_COLLECT`,
  `PHONE_UI_FIND`, `PHONE_UI_AFTER_TASK`, `PHONE_SET_ALARM`, `PHONE_SET_TIMER`,
  `PHONE_OPEN_LINK`, `PHONE_SHARE_TEXT`.
- `PHONE_UI_FIND` answers with the match list **and** the whole screen it stopped
  on, and is in `confirm.ts`'s `SCREEN_ANSWERS`, so a ref it hands out is judged
  by the irreversible gate against the screen it came from.
- `PHONE_UI_WAIT` gained `appear` and `disappear`, polled at 150 ms up to
  `timeoutMs`; `activity` is deliberately not offered because a snapshot carries
  no activity class name.

Gates and safety rails (`shared/irreversible.ts`, `server/phones/confirm.ts`,
`server/phone-guards.ts`, `server/phones/host.ts`):

- The irreversible detector and one-shot grant: pay is refused outright, delete
  and order need the card that names them, a spent grant does not cross a turn
  (the grant is keyed by turn generation).
- The loop guard: a repeated action, an unchanged screen or a cycle is warned on
  the early rungs of its ladder and refused at the last one (`PHONE_GUARD_LIMITS`
  in `server/phone-guards.ts` holds the ladders).

Phone self-repair and self-check (`PhoneUiSelfRepair.kt`,
`PhoneUiAccessibilityRepair.kt`, `PhoneUiRepairLoop.kt`,
`PhoneUiController.kt`, `PhoneUiSelfCheck.kt`, `PhoneUiProbes.kt`):

- A repair loop that starts and stops with the `phoneUi` capability and performs
  one action per pass.
- The accessibility repair rewrites `enabled_accessibility_services` through the
  helper's two-key settings endpoint, appending or removing only our component,
  and never when the person turned the service off.
- Wireless-debugging auto-on is **opt-in**: a Settings switch that is off by
  default. When on, the helper grants the app `WRITE_SECURE_SETTINGS` once (a
  fixed `pm grant` argv for the caller's own package), and the app writes
  `adb_wifi_enabled` itself. With no grant and no helper the loop folds no event,
  so a reboot does not record a fake refusal and block itself.
- Twelve real self-check probes, reachable from the Settings 自检 row.

Pacing (`PhoneUiPacing.kt`): FAST / STANDARD / HUMAN behind a preference whose
default is FAST, which is byte-for-byte the old behaviour.

Activity rows: every phone write that posts one has a locale key; a test in
`server/phones/summary.test.ts` fails if a future write does not.

## What is deliberately not built

`docs/mika-gap-analysis.md` carries the full table and the reasoning. The
short version: `phone_system_command`, `phone_sms_login`, `phone_find_visually`,
`phone_extract`, `phone_dialog`, `phone_event`, `phone_gesture`, `phone_set_wheel`,
`teach`, `settings_list`/`settings_set`, the vision locator, the on-device Linux
sandbox and Mika's eval suite are out of scope or need a surface this app does
not have. `phone_list_elements` is not ported because `PHONE_UI_OBSERVE` is the
same read.

## Waiting on a decision

- **Notification learning** (`server/phone-notices.ts`). The module is tested and
  unwired, and it is not one caller away: the phone would have to push each
  notification as it arrives, which nothing in this protocol does, and reading
  every notification is broader consent than the `phoneData` reads already
  granted. Building it needs a new authenticated ingress, a retention rule and a
  person-facing switch (default off).
- **Intent gate** (`server/intent-gate.ts`). Tested, unwired. Wiring needs a
  product answer about what ACT means in a split where one request may be a chat
  answer, a phone job or a delegation — and a decision about whether its cheap
  fallbacks are acceptable in front of screen writes (the approval card is shown
  either way).

## Waiting on a device or another owner

- **A real phone run**: pair the MIUI phone, let the helper attach, and run one
  read and one write through a bot turn. Nothing in this branch has been
  exercised on hardware; every Android claim here is from unit tests with fakes.
- **`android/core/.../Session.kt:825-833`**: the duplex-call work launches an
  unsolicited `GET /api/config` on every restore, which shifts request ordering
  for every MockWebServer test. That is the cause of the `SessionP1Test`,
  `PortP104IntegratedTest`, `ServerSessionPairingTest`, `ConnectedAppsClientTest`
  and `ProfileRoutineWireTest` failures. It needs its owner to choose between
  loading that probe lazily and updating the harnesses.
- **Packaging from HEAD** (`pnpm package:mac`, with the speech/cua rebuilds):
  wait until the UI sessions settle.
- **The branch is local**: not pushed.

## Verification, and what "green" means here

```sh
# The phone subset: 26 files, 502 tests.
node_modules/.bin/vitest run \
  server/phones/{access,confirm,fixture,host-revocation,host,jobs,owner,registry,rpc,sends,steer,tools,summary}.test.ts \
  shared/{irreversible,route-replay,untrusted,sensitive,verify-grounding,phone-apps}.test.ts \
  server/{phone-guards,phone-notices,intent-gate,phone-risk,phone-routes,answer-verify,chat-notices}.test.ts

# The Android phone-UI suite: 27 classes, 305 tests.
cd android && ./gradlew :app:testDebugUnitTest \
  --tests 'com.lunabot.companion.phoneui.*' --offline

# The job catalogue: 16 tests.
cd android && ./gradlew :core:test \
  --tests 'com.lunabot.companion.core.PhoneJobsTest' --offline

npx tsc -b && npx tsc -p tsconfig.server.json --noEmit
pnpm i18n:check    # 16 languages, 10552 English strings
```

The full non-e2e TypeScript suite is 2153 files / 29400 tests; five files fail on
this checkout for reasons outside this work: `enterprise/` is absent
(`verification-docs`, `worker-port`), the shard weights still name an enterprise
test (`duration-sequencer`, two tests), `build-npm-package.mjs` copies a `NOTICE`
its temp tree does not have, and `service-cli.test.ts` expects the pre-rename
`LunaBot.app` path.

The full `:app:testDebugUnitTest` last measured 1382 tests with 25 failures, all
in the `Session.kt` family above. That run also reported
`NoSuchFileException: app/build/test-results/.../in-progress-results-generic.bin`
because another session was running Gradle in the same module at the same time.

## Hazards

- **`git commit` without a pathspec commits other sessions' staged files.**
  Everything above was committed with `git commit --only -- <paths>`. Do the
  same: a plain `git commit` swept sixteen of another session's files into one
  commit during this work before it was rewound.
- **Two Gradle builds on this module clobber each other.** The test-result
  directory is shared, and a concurrent build produced the `NoSuchFileException`
  above. Check `ps -o pcpu -p $(pgrep -f GradleDaemon)` before a long run.
- **The Mimosa commit gate is not deterministic**, and it scans beyond the diff.
  It has blocked commits over `android/core/.../adb/AdbIdentity.kt` (RSA-2048,
  which the ADB wire format fixes at a 64-word modulus) and over untracked
  `android/app/.../wechat/WechatImages.kt` (AES-128-ECB and MD5, which the WeChat
  image format may dictate). `mimosa policy init` writes a policy file that has no
  per-finding waiver, and `mimosa ledger` has no "accepted" state, so there is no
  sanctioned way to record such an exception; the gate sometimes proceeds with
  `scanner_no_output` instead. Nothing here was committed by editing ADB or
  WeChat code, and no commit claims the project is safe.
- **`.mimosa/` is gitignored.** The policy file created during this work is local
  to this machine and is not part of the branch.