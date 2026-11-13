# The pi end-to-end fixture

The product runs pi as its only agent. New end-to-end recipes drive the real
server and the real `PiDriver` against `server/testing/fake-pi-cli.ts`, not the
retired Claude/Codex fixtures.

```sh
pnpm test:e2e:pi
```

Run one recipe:

```sh
pnpm vitest run server/main-thread.e2e.test.ts
```

## What the fixture covers

- `launchRestartableServer({ engine: "pi" })` starts a disposable home with one
  `pi` instance whose CLI is the fake, prints its URL, and can stop and restart
  it on the same data.
- `launchVerificationServer({ ...process.env, OMB_TEST_FIXTURE_ENGINE: "pi" })`
  adds a pi instance to the control-omb fixture and the startup migration keeps
  only that instance. With `{ scripted: true }` the pi instance receives
  `FAKE_PI_ROOM_PLAN`, the same `room-plan.json` the retired Claude fixture used.
- A scripted pi turn mounts its MCP servers through the **real**
  `pi-mcp-extension.ts`, then runs the plan's `steps` through those mounted
  tools (`start_thread`, `coordinate_bots`, `request_sign_in`, and so on). Tests
  keep reading `${planPath}.evidence.jsonl` for the calls it made. A plan's
  `ask_user` step runs the extension's native question tool, whose
  `extension_ui_request` the driver turns into the person's card; the fake
  answers only when the driver sends `extension_ui_response`.
- The fixture splits pi's single message at the turn-clock line: the system
  prompt is remembered from a session's first turn, and the evidence keeps the
  system prompt and the user turn apart as the Claude fixture did.
- The driver passes `OMB_BOT_ID` and `OMB_THREAD_ID` to the pi child, so the
  plan runner knows whose turn it is and which thread to record.
- `FAKE_PI_HOLD_ON`, `FAKE_PI_STALL_ON` and `FAKE_PI_DELAY_ON` /
  `FAKE_PI_DELAY_MS` script held, half-spoken and delayed turns for Stop and
  queue recipes. `FAKE_PI_STEER_REFUSE=1` forces the queued path.
- The fake still accepts the older `FAKE_CLAUDE_REPLIES`,
  `FAKE_CLAUDE_TOOL_CALLS` and `FAKE_CLAUDE_MODE=hang|exit-early` knobs through
  `FAKE_PI_CLAUDE_COMPAT=1`. These emit pi RPC events, not Claude stream-json.

## Migrated recipes

- `server/pi-turn.e2e.test.ts` — plain turn and a scripted `start_thread` plan.
- `server/main-thread.e2e.test.ts` — person-only `askedAt`, main-thread moves,
  review/webhook unread marks.
- `server/handoff-wake.e2e.test.ts` — a hand-off starts on a just-woken Cloud.
- `server/sign-in-request.e2e.test.ts` — a browser sign-in card, Done resume, and
  a reply that answers the card.
- `server/person-stop.e2e.test.ts` — one quiet stop, a queued message that keeps
  running, and a half answer kept on Stop.
- `server/person-waits.e2e.test.ts` — credential cards that hold work, across a
  restart too.
- `server/usage-traces.e2e.test.ts` — a delegated job traced through both bots.
- `server/self-threads.e2e.test.ts` — who may open a job on itself.
- `server/stop-stops-helpers.e2e.test.ts` — Stop reaches the teammates a request
  handed work to.
- `server/remembered-stop.e2e.test.ts` — a stopped teammate is not handed the
  same work again.
- `server/room-queue.e2e.test.ts` — same-room jobs queue, or run in parallel
  threads when enabled.
- `server/room-coordination.e2e.test.ts` — rooms, departments, Chiefs, forged
  envelopes, reach and receipts.
- `server/runtime-coordination.e2e.test.ts` — the runtime's envelopes, parked
  questions, restart reruns and Stop.
- `server/crossed-handoffs.e2e.test.ts` — a request back to a bot waiting on the
  person.
- `server/handoff-in-my-folder.e2e.test.ts` — a teammate's thread in the
  delegating bot's folder.
- `server/webhook-post-thread.e2e.test.ts` and
  `server/webhook-room-post.e2e.test.ts` — webhook posts and their transcript.
- `server/active-routines-context.e2e.test.ts` — a routine's monitor in the
  work conversation and its pause.
- `server/memory-order.e2e.test.ts` — memory-gated starts, queueing and a typed
  stop.
- `server/folder-pages.e2e.test.ts` and
  `server/published-pages.e2e.test.ts` — pages shown, pointed at and published.
- `server/image-generation.e2e.test.ts` — image generation through the fake
  provider.
- `server/parked-cards.e2e.test.ts` — cards that park a job and survive a
  restart.
- `server/person-only-answers.e2e.test.ts` — a question about the person's own
  accounts stays theirs.
- `server/direct-coordination.e2e.test.ts` — not yet: parts observe Claude argv,
  launch dumps or the retired `openaiCompat` engine.
- `server/room-context.e2e.test.ts` — not yet: pi reports no context-window
  measurement of its own, so the room's context chips have nothing to read.

## Not migrated yet

The remaining `*.e2e.test.ts` recipes still assume the fake Claude CLI's dump
file, scripted room plans, one-shot text mode and Claude-specific argv. Most can
now move by setting `OMB_TEST_FIXTURE_ENGINE: "pi"` (plus `room: { scripted: true }`
where they use a plan) and replacing dump assertions with the evidence file or
pi's `session.started` / transcript events. Until then `pnpm test:e2e` (the old
suite) is expected to fail.

## Retired engine tests

Recipes whose only subject was a removed engine were deleted rather than ported:
`acp-context-reports`, `acp-recovery`, `acp-shutdown`, `claude-haiku`,
`claude-turn-failures`, `cline-engine`, `codex-review`, `copilot-engine`,
`custom-acp-models`, and the three `opencode-*` suites. They configured the
`opencodeGo`, `codex`, `claudeAgent`, `copilotAgent`, `clineAgent` or
`customAcp` drivers, which no longer exist.