// The real server with two silent turns side by side: a pi turn that holds on its prompt with no tool, and a pi turn
// whose one tool holds until a release file appears. A marker file brings the stall watchdog's twenty minutes forward.
// The fake pi keeps one warm child per conversation, so the wrapper exits after every turn: each launch reads
// engine.json again and picks the role that bot plays (server/drivers/pi.ts names the child with LUNABOT_BOT_ID).
// FAKE_PI_TOOL_CALLS is only played by the fixture's scripted turns (the compat bridge or FAKE_PI_MODE=slow), never by
// the plain happy turn, so the busy bot runs under the compat bridge: its tool starts as compat-0 and holds.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

import { launchVerificationServer, runControlLunabot, type VerificationServer } from "../scripts/control-lunabot.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const STALLED = "error: no activity for 20 minutes — the turn was stopped";

let fixture: VerificationServer | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

it("stops a silent turn but spares one whose tool is still running", async () => {
  fixture = await launchVerificationServer({ ...process.env, LUNABOT_TEST_STALL_CLOCK: "1" });
  const { url, dataDir } = fixture.info;
  const cli = (...args: string[]) => runControlLunabot([...args, "--url", url]) as Promise<any>;
  const release = join(dataDir, "tool.release");
  const engineFile = join(dataDir, "engine.json");
  const wrapper = join(dataDir, "pi-stall.mjs");
  writeFileSync(wrapper, [
    "#!/usr/bin/env node",
    'import { readFileSync } from "node:fs";',
    // One fresh launch per turn, so engine.json's role is the one this turn runs.
    'process.env.FAKE_PI_EXIT_AFTER_TURN = "1";',
    // A model-catalog or `--version` probe runs before engine.json exists: it plays the quiet role harmlessly.
    'let role = "quiet";',
    `try { role = JSON.parse(readFileSync(${JSON.stringify(engineFile)}, "utf8"))[process.env.LUNABOT_BOT_ID ?? ""] ?? "quiet"; } catch {}`,
    'if (role === "busy") {',
    // The compat bridge is what plays FAKE_PI_TOOL_CALLS: the call starts, holds while the release file is absent,
    // and the reply follows once it appears.
    '  process.env.FAKE_PI_CLAUDE_COMPAT = "1";',
    '  process.env.FAKE_PI_TOOL_CALLS = JSON.stringify([{ name: "bash", input: { command: "sleep 600" }, ok: true, hold: true }]);',
    `  process.env.FAKE_PI_RELEASE = ${JSON.stringify(release)};`,
    '  process.env.FAKE_PI_REPLIES = JSON.stringify(["Hello from pi"]);',
    "} else {",
    // The quiet turn holds on its own prompt, with no tool ever started.
    '  process.env.FAKE_PI_HOLD_ON = "hello";',
    "}",
    `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-pi-cli.ts")).href)});`,
  ].join("\n"), { mode: 0o700 });
  const patched = await fetch(`${url}/api/instances/pi`, {
    method: "PATCH", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ cli: wrapper }),
  });
  expect(patched.status, await patched.text()).toBeLessThan(300);

  const { bot: quiet } = await cli("new-bot", "--name", "Quiet");
  const { bot: busy } = await cli("new-bot", "--name", "Busy");
  writeFileSync(engineFile, JSON.stringify({ [quiet.id]: "quiet", [busy.id]: "busy" }));
  await cli("send", "--bot", quiet.id, "--task", quiet.activeTaskId, "--text", "hello");
  await cli("send", "--bot", busy.id, "--task", busy.activeTaskId, "--text", "run the suite");
  const read = (path: string) => {
    try { return readFileSync(path, "utf8"); } catch { return ""; }
  };
  // Each turn's last frame before its silence: a frame read after the marker starts that turn's window over.
  await expect.poll(() => read(join(dataDir, "native", `${quiet.activeTaskId}.ndjson`)).split("\n")
    .some((line) => line.includes('"dir":"in"') && line.includes('"type":"turn_start"')), { timeout: hostTimeout(30_000) }).toBe(true);
  await expect.poll(() => read(join(dataDir, "events", `${busy.activeTaskId}.ndjson`)).includes('"itemId":"compat-0"'),
    { timeout: hostTimeout(30_000) }).toBe(true);
  const transcript = async (bot: { id: string; activeTaskId: string }) =>
    JSON.stringify(await cli("messages", "--bot", bot.id, "--task", bot.activeTaskId, "--limit", "50"));

  writeFileSync(join(dataDir, "stall-turns"), "");
  await expect.poll(() => transcript(quiet), { timeout: hostTimeout(15_000) }).toContain(STALLED);
  // The sweep that stopped the quiet turn looked at every watched turn.
  expect(await transcript(busy)).not.toMatch(/No activity for \d+ minutes/i);

  rmSync(join(dataDir, "stall-turns"));
  writeFileSync(release, "open");
  await expect.poll(() => transcript(busy), { timeout: hostTimeout(15_000) }).toContain("Hello from pi");
  expect(await transcript(busy)).not.toMatch(/No activity for \d+ minutes/i);
}, hostTimeout(90_000));
