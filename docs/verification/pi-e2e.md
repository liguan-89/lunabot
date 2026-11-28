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

- Every `launchVerificationServer` fixture ships one agent, the fake pi, and the startup
  migration keeps only that instance. `LUNABOT_TEST_FIXTURE_ENGINE=pi` is still accepted
  and changes nothing.
- `launchRestartableServer({ engine: "pi" })` starts a disposable home with one
  `pi` instance whose CLI is the fake, prints its URL, and can stop and restart
  it on the same data.
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
- The driver passes `LUNABOT_BOT_ID` and `LUNABOT_THREAD_ID` to the pi child, so the
  plan runner knows whose turn it is and which thread to record.
- `FAKE_PI_HOLD_ON`, `FAKE_PI_STALL_ON` and `FAKE_PI_DELAY_ON` /
  `FAKE_PI_DELAY_MS` script held, half-spoken and delayed turns for Stop and
  queue recipes. `FAKE_PI_STEER_REFUSE=1` forces the queued path, and
  `FAKE_PI_QUESTION_ON` makes only the prompts holding that substring ask a
  native select question.
- The fake still accepts the older `FAKE_CLAUDE_*` names while
  `FAKE_PI_CLAUDE_COMPAT=1` (the launcher sets it whenever a recipe passes one):
  `MODE=happy|slow|hang`, `REPLIES`, `REPLY_FILE`, `REPLY_STATE`,
  `MARKER_REPLIES`, `TOOL_CALLS`, `TOOL_CALLS_FILE`, `SLOW_FINISH_GATE`,
  `RELEASE`, `PROMPTS`, `STEER_RECEIVED` and `EXIT_AFTER_TURN`. A scripted
  `{ server, name, input }` call runs through the tool the turn mounted, so a
  recipe can make a bot really call `report_bug` or `mcp_server`.
- `FAKE_PI_MOUNT_TOOLS=1` makes the fake mount its MCP servers at boot, which
  a scripted server call needs: the driver deletes the config once the real
  extension has mounted it.
- The driver writes the launch it gave the child (argv, MCP config, pid) and
  each prompt into `fake-pi-dump.jsonl`; `server/testing/pi-dump.ts` reads that
  file back as launches, turns, the instructions in effect and the agents
  token, replacing the retired per-turn Claude dump.

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
- `server/routine-cron.e2e.test.ts` and `server/triggers.e2e.test.ts` — cron
  routines and chat-created triggers through their action tools (the fixture
  resolves retired aliases like `create_trigger`).
- `server/webhook-address.e2e.test.ts` — who may read an automation's address.
- `server/app-events.e2e.test.ts` — an app-event automation across a Composio
  event.
- `server/chat-pages.e2e.test.ts` — a jsx page, pointed-at records, replace and
  publish.
- `server/webhook-restart.e2e.test.ts` — a delivery committed once across a
  crash and restart.
- `server/routine-continuity.e2e.test.ts` — a routine's previous report reaches
  the next turn only when continuity is on.
- `server/runtime-paths.e2e.test.ts` — routine, consultation, one-way and
  external-runtime paths, plus a crash rerun; the agents token comes from the
  fake pi launch dump (`fake-pi-dump.jsonl`).
- `server/room-recovery.e2e.test.ts` — interrupted routines and cut room work
  recovered at boot.
- `server/room-missing-folder.e2e.test.ts` — a deleted room folder is named in
  the failure, not the bot's own settings.
- `server/loop-guard.e2e.test.ts` — the repeated-failure note reaches the turn,
  and the stop count ends it on its own failed row. pi cancels cleanly, so the
  provider event says the turn ended while the transcript keeps the guard's row.
- `server/bulk-delete-tasks.e2e.test.ts` — running tasks are refused, the rest
  deleted, with a slow turn held open.
- `server/chief-level-every-hop.e2e.test.ts` and
  `server/chief-level-delegation.e2e.test.ts` — a Chief's level rides every hop,
  in threads and rooms; plan evidence reports the level the driver booted at.
- `server/teammate-follow-ups.e2e.test.ts` — a correction steered into a running
  teammate's turn, whose one result carries it.
- `server/verification-fixture.e2e.test.ts`, `server/request-auth.e2e.test.ts`,
  `server/new-bot-defaults.e2e.test.ts`, `server/mascot-face-color.e2e.test.ts`,
  `server/notification-read.e2e.test.ts`, `server/no-omb-cards.e2e.test.ts`,
  `server/live-config-auth.e2e.test.ts`, `server/group-thread-usage.e2e.test.ts`,
  `server/delete-bot-memory.e2e.test.ts`,
  `server/bot-deletion-write-failure.e2e.test.ts`,
  `server/skills-library-config.e2e.test.ts`, `server/team-share.e2e.test.ts`,
  `server/presets.e2e.test.ts`, `server/org-library.e2e.test.ts`,
  `server/saved-login.e2e.test.ts`, `server/app-events.ui.e2e.test.ts` — fixture
  visibility, pairing, defaults, routes and config through the real server.
- `server/mcp-cards.e2e.test.ts`, `server/mcp-own-servers.e2e.test.ts`,
  `server/mcp-restart.e2e.test.ts` — parked MCP cards, a bot's own server kept in
  its folder, and a restart that replaces the warm process.
- `server/chat-apps.e2e.test.ts`, `server/chat-apps-mcp.e2e.test.ts`,
  `server/chat-widgets.e2e.test.ts` — pages, MCP apps and widgets, and the
  prompt the engine was handed.
- `server/create-bot-model.e2e.test.ts` and `server/bot-setup.e2e.test.ts` —
  model selection on creation, and setup/standing instructions as the model
  actually receives them.
- `server/devs-reports.e2e.test.ts` — a report the bot sends through the agents
  `report_bug` tool, and the server's own facts when it never calls it.
- `server/engine-limits.e2e.test.ts` — a turn reads its engine's usage through
  its own capability; pi reports none of its own.
- `server/external-runtime.e2e.test.ts` and
  `server/external-runtime-timeout.e2e.test.ts` — the standing external
  capability and a long peer ask answered without waking its engine.
- `server/skill-commands.e2e.test.ts` — pi loads a turn folder's `.pi/skills`
  and its own config home's, and only a person's words call them.
- `server/routine-results.e2e.test.ts` — every run reports into the bot's main
  thread while a run parks on its native question card; the replaced CLI makes
  only the parked run ask.
- `server/profile-card-lifecycle.e2e.test.ts` — the bot's own alert and voice
  changes, stale Undo, and superseding credential requests.
- `server/starter-bots.e2e.test.ts` — a Starter Cloud's limits and a Chief's
  create_bot/team setup past five bots.
- `server/routine-unanswered-wait.e2e.test.ts` — an unanswered sign-in wait is
  stopped and the next scheduled run starts.
- `server/routine-model.e2e.test.ts` — each run opens on its own model, which
  pi is told over its RPC (`piModelsSet`), and refuses an unknown effort.
- `server/cli-stop.e2e.test.ts` — Stop ends the whole pi process tree, including
  a helper that ignores SIGTERM, and a queued turn runs afterwards.
- `server/room-roots.e2e.test.ts` — a member's room root parks on the computer
  seat, is cut by a restart and reruns once, and its goal steps reconcile.
- `server/room-holds.e2e.test.ts` — holds, releases and a member's final reply
  (a working note and its answer are separate assistant messages of one turn).
- `server/routine-delegation.e2e.test.ts` — a routine waits for a busy peer and
  resumes it as a routine turn; a provider key change interrupts its turn.
- `server/runtime-roots.e2e.test.ts` — a person's root parks on cards and the
  computer seat, reruns a cut turn after a restart, and Stop cancels it.
  T6 (the step-capped OpenAI-compatible continuation) is skipped: that engine
  is gone and pi has no step cap.
- `server/mcp-sign-in-card.e2e.test.ts` — a sign-in card holds a turn that is
  mounting an HTTP MCP server; the mount's remote spec carries the signed-in
  header.
- `server/desktop-computer.e2e.test.ts`, `server/phone-claim.e2e.test.ts` and
  `server/host-lazy-claim.e2e.test.ts` — computer and phone mounts per turn,
  phone claims across a restart, and the Bot API's refusal on pi's guest mode.
- `server/live-call.e2e.test.ts` — a live voice call's turns, steering, queued
  lines and parking on a question. Four subtests were removed with the engines
  they exercised: a spoken provider permission ask, provider-side rejection of
  a non-option answer, a file-gated steer refusal, and engine-generated thread
  titles (pi's driver has no one-shot text call).
- `server/message-search.e2e.test.ts`, `server/sign-in-code.e2e.test.ts` and
  `server/talk-server.e2e.test.ts` — history search, pairing codes and the
  Quick-asks runtime, now reading pi's own reply.
- `server/automation-reports.e2e.test.ts` — reports copied into the main chat,
  question cards answered in the chat or by 👍, and the images a tool returned
  plus the files it attached. pi reports a tool's image content as a tool-made
  image of the turn.
- `server/fresh-start.e2e.test.ts` — a divider sends nothing from before it,
  a warm session continues, a fresh start opens a new pi session, and a repeat
  press adds nothing. The old codex switch section is gone with that engine;
  pi re-anchors once after a divider because the rewound cursor is cleared.
- `server/context-compaction.e2e.test.ts` — a forced `/compact` is durable,
  keeps corrections, starts a fresh session and survives a restart; auto-fold
  keeps the two latest exchanges. The stalled-summary and native-autocompact
  subtests are gone: pi has no one-shot text call and no provider context
  measurement, so the summary is local.
- `server/delta-context.e2e.test.ts` — per-thread prompt counts from pi's own
  RPC log, restarts that rerun cut turns, and steered messages. The
  rejected-resume ledger, Codex and file-gated steer groups are gone: no driver
  declares strict resume and the single engine cannot be swapped.
- `server/direct-coordination.e2e.test.ts` — direct bot-to-bot coordination,
  envelopes, one-way sends, thread targeting and task closing through the
  fixture's single pi instance. Two Claude-specific subtests are gone: a
  provider-side transient retry (the fake pi has no such script) and recovery
  from a rejected `--resume` (pi never rejects a stored session). The
  OpenAI-compatible step-cap subtest went with `openaiCompat` as an engine, and
  the ACK-vs-NEEDS subtest went with the one-shot text call that fed it.
- `server/room-context.e2e.test.ts` — a room's transcript reaches each warm pi
  turn, another member's turn replaces that warm child, and the compact route
  refuses a member pi never measured. The token-threshold and dropped-reading
  subtests were removed: pi reports no provider context-window usage, so there
  is no reading to fold or drop (the local compaction estimate belongs to
  direct conversations, not room members).
- `server/long-running-chief.e2e.test.ts` — a Chief's consult-and-implement
  job, approval cards reported back to it, restarts that cut teammates, a no-op
  provider settings save, the stall watchdog, a card that holds only its own
  job, and person-versus-routine trust. pi asks through its own permission card,
  so the retired engine's 64-step cap and its approval-timeout clock are gone;
  the screen-seat subtest went with the Claude `screenCalls` fixture and is
  covered by `room-roots`/`host-lazy-claim`.
- `server/headless-cli.e2e.test.ts` — the headless team apply → run --wait →
  export flow on pi's model and tools; native tool selection applies because pi
  supports it, instead of the deleted engine's refusal.
- `server/reply-behaviour.e2e.test.ts` — reply habits, remember/forget and a
  routine's plain wording through the plan agent's real agents tools. The memory
  learner's scripted text routes were removed with the Claude/openaiCompat
  one-shot text call; its About me lines are seeded through the profile instead.
- `server/key-rejected.e2e.test.ts` — a rejected custom-provider key is reported
  by `/api/keys/test` (while config still shows the key is on file), a config
  event reaches SSE, turn failure and recovery are exercised through the fake
  pi's finish gate, and no key appears in config, instances, frames or logs. The
  retired `openaiCompat` instance snapshot and its `authenticated/reason` fields
  are gone: pi's own snapshot is always available because pi holds no key.
- `server/vps-routing.test.ts` — a cloud bot's direct and delegated turns use
  the bot's VPS desktop through the harness proxy, keep computer credentials out
  of the engine, share slow screenshots safely, and describe an unavailable VPS
  truthfully instead of letting the model believe it controls a desktop.
- `server/parallel-threads.e2e.test.ts` — a bot's threads run at once on pi,
  and the Starter Cloud's slot arithmetic, browser seat and team computer still
  hold per thread. The old per-engine matrix (Claude, ACP, OpenAI-compatible)
  is one pi run.
- `server/thread-aware-bots.e2e.test.ts` — `start_thread`, report-back,
  `coordinate_bots`, `list_threads` and a Chief's closes, with pi turns held by
  a gate keyed to their thread (and moved per turn by a `[[gate:NAME]]` in the
  turn's own words). Model assertions read `piModelsSet`; the signed-out-engine
  and Cursor/Grok selection subtests were cut with those engines.
- `server/digest-control.e2e.test.ts` — two direct turns that reuse the fake's
  tool id, each with its own turn id and `digest.append` receipt, plus room
  digests naming their speaker. pi reports bounded tool previews and has no
  hook channel, so coverage is `preview`, never `full`; the retired hook's
  untruncated result and spill-file assertions are gone.
- `server/digest.e2e.test.ts` — a settled direct turn's digest names its tools
  and turn id, and a turn held at pi's finish gate names the project file it
  added. The per-engine matrix is one pi run, and the old "another engine takes
  over" replay half is gone with the second engine. Its file digest restarts
  the fixture with git on PATH: the sealed PATH has only node's folder.

- `server/agents-bridge.e2e.test.ts` — pi refuses the agents tool bridge
  (`engineBridgeRefusal`), so the recipe proves the switch never mounts it:
  the whole catalog, no bridge prompt, the tool-selection gate and the
  Chief-only refusal.
- `server/automatic-recovery.e2e.test.ts` — the settings contract, a real
  recovery, and pi's own failure boundary. `FAKE_PI_EXIT_ON_FIRST_MODEL=1`
  kills the fake while it selects the bot's model, before the prompt frame;
  the driver classifies that pre-prompt exit as `TurnNotStartedError` and the
  harness replays the turn once on the configured backup model of the same
  instance. A turn whose prompt pi already accepted (`turn-error`) stays
  failed and is never replayed. The retired sign-out and usage-limit refusal
  classes still have no pi equivalent.
- `server/bot-visibility.e2e.test.ts` — per-bot visibility on a shared
  workspace, with the closed and hidden bots' prompts read from
  `FAKE_PI_PROMPTS` instead of a second echo engine.
- `server/decider-rooms.e2e.test.ts` — room deciders on pi; engine-generated
  thread titles are gone with pi's missing one-shot text call.
- `server/full-access-workflows.e2e.test.ts` and
  `server/room-sessions.e2e.test.ts` — full-access plans and room sessions,
  with turns read from `piTurnsForThread`/`piTurnText`. Room delta turns and
  Claude Code's compaction hooks are gone; failure/stop recovery and
  cross-member replay stay.
- `server/incidents.e2e.test.ts` — a crashed run, the Chief's retry, and the
  same-failure-once note, with a per-thread pi wrapper and per-thread dump so
  interleaved warm children stay attributable.
- `server/limit-reset.e2e.test.ts` — pi reports no plan usage, reset time or
  sign-in state, so the honest coverage is one test: a usage-limit refusal
  fails the turn, keeps the provider's words, invents no reset, and creates
  the one-time `limit_reset` automation.
- `server/notification-routing.e2e.test.ts` — one pi instance whose per-bot
  flavors come from prompt-keyed `FAKE_PI_HOLD_ON`/`FAKE_PI_QUESTION_ON` and
  marker replies.
- `server/openai-tools.e2e.test.ts` — the custom-provider key/catalog path
  plus a mounted MCP `write_file` and pi's permission card; the old
  chat-completions argument-streaming matrix went with that transport.
- `server/team-move.e2e.test.ts` — a moved team's homes all run the pi
  stand-in, read from one `FAKE_PI_DUMP`.
- `server/thread-model-follow.e2e.test.ts` — a thread saved on a deleted
  engine gives way to the bot's pi model with a notice on every turn, then
  follows the bot.
- `server/trust-controls.e2e.test.ts` — delegated and routine plans call pi's
  plain app tools, relayed as their Composio tools; account-fallback
  instances are gone with the accounts.
- `server/voice-notes.e2e.test.ts` — a held voice-note turn detected from pi's
  launch log, and Stop keeping the partial that is then not spoken.

## Not migrated yet

The remaining old e2e recipes are the upstream cross-engine and
cloud/browser/UI suites: they configure the retired `claudeAgent`/`grokAgent`/
ACP instances, assert Claude argv or read `fake-claude-dump.json`, and many
need live cloud or browser infrastructure. They are not part of this build's
acceptance suite: `pnpm test:e2e:pi` is the e2e suite for the pi-only product.
They remain as source material and can move by reading `fake-pi-dump.jsonl`
through `server/testing/pi-dump.ts` and replacing argv assertions with the
launch, turn and transcript events.

## Retired engine tests

Recipes whose only subject was a removed engine were deleted rather than ported:
`acp-context-reports`, `acp-recovery`, `acp-shutdown`, `claude-haiku`,
`claude-turn-failures`, `cline-engine`, `codex-review`, `copilot-engine`,
`custom-acp-models`, and the three `opencode-*` suites. They configured the
`opencodeGo`, `codex`, `claudeAgent`, `copilotAgent`, `clineAgent` or
`customAcp` drivers, which no longer exist. `scripts/testing/cline-native`,
`scripts/testing/cline-ui` and `server/portable-hermes` went with those
drivers, and `server/hooks` went with Claude Code's hook channel: pi reports no
`hooks` capability, so that ingestion path has no caller left.