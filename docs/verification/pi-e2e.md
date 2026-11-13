# The pi end-to-end fixture

The product runs pi as its only agent. New end-to-end recipes drive the real
server and the real `PiDriver` against `server/testing/fake-pi-cli.ts`, not the
retired Claude/Codex fixtures.

```sh
pnpm test:e2e:pi
```

Run one recipe:

```sh
pnpm vitest run server/pi-turn.e2e.test.ts
```

## What the fixture covers

- `launchRestartableServer({ engine: "pi" })` starts a disposable home with one
  `pi` instance whose CLI is the fake, prints its URL, and can stop and restart
  it on the same data.
- `launchVerificationServer({ ...process.env, OMB_TEST_FIXTURE_ENGINE: "pi" })`
  adds a pi instance to the control-omb fixture. The old Claude instance stays
  as an unavailable shadow, so nothing routes to it.
- The fake pi CLI also accepts the older `FAKE_CLAUDE_REPLIES`,
  `FAKE_CLAUDE_TOOL_CALLS` and `FAKE_CLAUDE_MODE=hang|exit-early` knobs. These
  are a bridge for recipes being moved over; they emit pi RPC events, not
  Claude stream-json.

## Not migrated yet

The remaining `*.e2e.test.ts` recipes still assume the fake Claude CLI's dump
file, scripted room plans, one-shot text mode and Claude-specific argv. Port
them by moving to `launchRestartableServer({ engine: "pi" })`, replacing the
Claude dump assertions with pi's `session.started` / transcript events, and
calling `pnpm vitest run <recipe>` until green. Until then `pnpm test:e2e`
(the old suite) is expected to fail.