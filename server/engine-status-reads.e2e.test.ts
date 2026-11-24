// Real server, a fake pi CLI wrapper that logs each status probe: an engine's CLI is probed once per answer, not once per
// reader. pi's snapshot only runs `<cli> --version` (it manages its own credentials, so there is no sign-in to probe).
// The wrapper also records the probe, so a recipe can count how many times the CLI really ran.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runControlLunabot, verificationServerEnvironment } from "../scripts/control-lunabot.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_PI = join(ROOT, "server/testing/fake-pi-cli.ts");

const homes: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await waitForExit(child, { signal: "SIGTERM" });
  for (const home of homes.splice(0)) await removeTempDir(home);
});

/** A wrapper around the fake pi that logs every `--version` probe, and can be made slow or answer nothing once, as the
 * retired Claude fixture's `FAKE_CLAUDE_VERSION_DELAY_MS`/`FAKE_CLAUDE_EMPTY_VERSION_ONCE` did. It appends each probe to
 * FIXTURE_PROBE_LOG, so a recipe can count how many times the CLI really ran. */
function wrapper(home: string): string {
  const cli = join(home, "fixture-pi.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const log = ${JSON.stringify(join(home, "probes.log"))};
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  appendFileSync(log, \`version \${process.pid}\\n\`);
  const delay = Number(process.env.FIXTURE_VERSION_DELAY_MS ?? 0);
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  const once = process.env.FIXTURE_EMPTY_VERSION_ONCE;
  if (once && !existsSync(once)) { writeFileSync(once, "returned"); process.exit(0); }
}
await import(${JSON.stringify(pathToFileURL(FAKE_PI).href)});
`, { mode: 0o755 });
  return cli;
}

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "omb-engine-status-"));
  homes.push(home);
  mkdirSync(join(home, "tmp"), { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    instances: { pi: { driver: "piAgent", displayName: "Verification fixture", config: { cli: wrapper(home) } } },
  }));
  return home;
}

async function boot(home: string, knobs: Record<string, string> = {}) {
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
    cwd: ROOT,
    env: verificationServerEnvironment({ ...process.env, ...knobs }, home, port),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  const capture = (chunk: Buffer) => { output += chunk; };
  child.stdout!.on("data", capture);
  child.stderr!.on("data", capture);
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
    try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
  }, { timeout: 20_000, interval: 50 }).toBe(true);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { origin: base, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.status, `${method} ${path}`).toBe(200);
    return response.json() as Promise<any>;
  };
  const stop = () => waitForExit(child, { signal: "SIGTERM" });
  return { call, control: (...args: string[]) => runControlLunabot([...args, "--url", base]) as Promise<any>, stop };
}

const probeCount = (log: string) =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line.startsWith("version ")).length : 0;
const piStatus = (body: { instances: Array<{ instanceId: string; snapshot: Record<string, unknown> }> }) =>
  body.instances.find((instance) => instance.instanceId === "pi")!.snapshot;

it("detects a slow CLI across concurrent status reads and continues a saved chat", async () => {
  const home = freshHome();
  const probes = join(home, "probes.log");
  const server = await boot(home, { FIXTURE_VERSION_DELAY_MS: "7000" });
  const lists = await Promise.all([server.call("GET", "/api/instances"), server.call("GET", "/api/instances"), server.call("GET", "/api/instances")]);
  for (const list of lists) expect(piStatus(list)).toMatchObject({ state: "available", authenticated: true, version: expect.stringContaining("pi ") });
  expect(probeCount(probes), "three concurrent reads share one probe").toBe(1);
  const { bot } = await server.control("new-bot", "--name", "Detection fixture");
  const read = async () => (await server.call("GET", "/api/bots?messages=0")).bots.find((item: { id: string }) => item.id === bot.id);
  const selection = (await read()).modelSelection;
  const replies = (messages: Array<{ role: string; kind: string }>) => messages.filter((message) => message.role === "bot" && message.kind === "text");
  const initial = await server.control("messages", "--bot", bot.id);
  const turns = [];
  for (const text of ["First fixture turn", "Continue with the saved model"]) {
    await server.control("send", "--bot", bot.id, "--text", text);
    const settled = await server.control("wait", "--bot", bot.id, "--timeout", "30");
    turns.push({ text, settled });
    expect(settled).toMatchObject({ status: "settled" });
  }
  const transcript = await server.control("messages", "--bot", bot.id);
  expect(replies(transcript.messages)).toHaveLength(replies(initial.messages).length + 2);
  expect((await read()).modelSelection).toEqual(selection);
}, 90_000);

// A subtest of the retired fixture is gone: "an empty version reads as unavailable, once". pi's snapshot reports
// unavailable for an empty `--version`, and the registry re-probes an engine the last read saw available (so the CLI that
// answers again is found), which makes the exact probe count depend on the registry's retry policy rather than on this
// recipe. server/harness/registry.test.ts covers that policy.

it("probes the engine's CLI once on a later start while the model lists arrive and the engine list is read", async () => {
  const home = freshHome();
  await (await boot(home)).stop();

  const probes = join(home, "probes.log");
  const server = await boot(home);
  // The start-up read probes the CLI; how many times is the registry's business (it re-probes one it found unavailable).
  await expect.poll(() => probeCount(probes), { timeout: 10_000 }).toBeGreaterThan(0);
  const atStart = probeCount(probes);
  // Like the page: its first engine list, and one more on each model list's config frame.
  const lists = [server.call("GET", "/api/instances"), server.call("GET", "/api/instances"), server.call("GET", "/api/instances")];
  // Every startup model list has answered by now, each asking for the new-bot default again.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(probeCount(probes)).toBe(atStart);

  for (const list of await Promise.all(lists)) expect(piStatus(list)).toMatchObject({ state: "available", authenticated: true });
  expect(piStatus(await server.call("GET", "/api/instances"))).toMatchObject({ state: "available", authenticated: true });
  expect(probeCount(probes), "no reader probes the CLI again").toBe(atStart);
}, 60_000);

it("probes again after a model refresh and a Check, and reuses the last read otherwise", async () => {
  const home = freshHome();
  const probes = join(home, "probes.log");
  const server = await boot(home);
  const engines = () => server.call("GET", "/api/instances");
  // Each step reads the engines first: the read is reused, so the probe after it is the step's own.
  const reused = async () => {
    const before = probeCount(probes);
    const status = piStatus(await engines());
    expect(probeCount(probes)).toBe(before);
    return { status, before };
  };

  expect(piStatus(await engines())).toMatchObject({ state: "available", authenticated: true });
  let step = await reused();

  // Settings' Refresh reads the CLI's model list, and the engine list it answers with is read after it.
  expect(piStatus(await server.call("POST", "/api/instances/pi/refresh-models", {}))).toMatchObject({ state: "available", authenticated: true });
  expect(probeCount(probes)).toBe(step.before + 1);

  step = await reused();
  // A saved key may reach an engine through the environment its status read uses, so a save probes afresh.
  await server.call("PUT", "/api/config", { opencodeGo: { apiKey: "fixture-opencode-key" } });
  expect(piStatus(await engines())).toMatchObject({ state: "available", authenticated: true });
  expect(probeCount(probes)).toBe(step.before + 1);

  // Check reads the engine's status and then asks for a one-shot answer pi has no call for, so it reports that it could
  // not test rather than inventing a result.
  expect(await server.call("POST", "/api/instances/pi/check", {})).toEqual({ ok: null });
}, 60_000);
