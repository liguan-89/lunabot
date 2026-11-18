// Real server, the fake pi CLI, and a stand-in `pi` whose `--version` probe waits on a file (the probe may take up to
// its 8 s timeout), so a start can be shown answering health before its one engine has been read.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CLI = join(ROOT, "server/testing/fake-pi-cli.ts");

const homes: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await waitForExit(child, { signal: "SIGTERM" });
  for (const home of homes.splice(0)) await removeTempDir(home);
});

function freshHome(cli = FAKE_CLI): string {
  const home = mkdtempSync(join(tmpdir(), "omb-boot-readiness-"));
  homes.push(home);
  mkdirSync(join(home, "tmp"), { recursive: true });
  chmodSync(FAKE_CLI, 0o755);
  writeFileSync(join(home, "config.json"), JSON.stringify({
    instances: { pi: { driver: "piAgent", displayName: "Verification fixture", config: { cli } } },
  }));
  return home;
}

/** A stand-in `pi` whose `--version` probe logs its pid and waits for `release`; every other launch is the fake pi. */
function slowProbeCli(home: string): { cli: string; probes: string; release: string } {
  const probes = join(home, "probes.log");
  const release = join(home, "release-version");
  const cli = join(home, "slow-pi.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (process.argv.includes("--version")) {
  appendFileSync(${JSON.stringify(probes)}, "version " + process.pid + "\\n");
  for (const deadline = Date.now() + 30_000; !existsSync(${JSON.stringify(release)}); ) {
    if (Date.now() > deadline) break;
    await wait(50);
  }
  process.stdout.write("pi 0.84.2 (fake)\\n");
  process.exit(0);
}
await import(${JSON.stringify(new URL("./testing/fake-pi-cli.ts", import.meta.url).href)});
`, { mode: 0o755 });
  chmodSync(cli, 0o755);
  return { cli, probes, release };
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
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { output += chunk; });
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
    try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
  }, { timeout: 20_000, interval: 50 }).toBe(true);
  const get = async (path: string) => {
    const response = await fetch(base + path, { headers: { origin: base } });
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  };
  const control = (...args: string[]) => runControlOmb([...args, "--url", base]) as Promise<any>;
  const stop = () => waitForExit(child, { signal: "SIGTERM" });
  return { get, control, stop };
}

it("makes a first run's starter bot on the engine a new bot gets", async () => {
  const server = await boot(freshHome());
  const { bots } = await server.get("/api/bots?messages=0");
  expect(bots).toHaveLength(1);
  expect(bots[0].modelSelection).toMatchObject({ instanceId: "pi", model: expect.stringMatching(/.+/) });
});

it("answers on a later start while its engine's CLI is still being probed, and runs turns once it has answered", async () => {
  const home = freshHome();
  const first = await boot(home);
  const [starter] = (await first.get("/api/bots?messages=0")).bots;
  const member = (await first.control("new-bot", "--name", "Room member")).bot;
  const room = (await first.control("new-channel", "--name", "Start room", "--members", member.id)).channel;
  await first.stop();

  const slow = slowProbeCli(home);
  writeFileSync(join(home, "config.json"), JSON.stringify({
    instances: { pi: { driver: "piAgent", displayName: "Verification fixture", config: { cli: slow.cli } } },
  }));
  const dump = join(home, "fake-pi-dump.jsonl");
  const server = await boot(home);
  // The probe the server is still waiting on is alive: health did not wait for it (the server would have killed it at
  // its timeout first).
  let held = 0;
  await expect.poll(() => {
    held = existsSync(slow.probes) ? Number(/^version (\d+)$/m.exec(readFileSync(slow.probes, "utf8"))?.[1] ?? 0) : 0;
    return held;
  }, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(() => process.kill(held, 0)).not.toThrow();

  await server.control("send", "--bot", starter.id, "--task", starter.threadId, "--text", "Right after the start");
  await server.control("send-channel", "--channel", room.id, "--text", "Right after the start, in a room");
  expect(() => process.kill(held, 0)).not.toThrow();
  writeFileSync(slow.release, "");

  expect((await server.control("wait", "--bot", starter.id, "--task", starter.threadId, "--timeout", "30")).status).toBe("settled");
  expect((await server.control("wait", "--channel", room.id, "--timeout", "30")).status).toBe("settled");
  // Each turn was given the words it was sent, on the one engine this build runs.
  expect(readFileSync(dump, "utf8")).toContain("Right after the start");
  expect((await server.get("/api/instances")).instances.find((instance: { instanceId: string }) => instance.instanceId === "pi")?.snapshot)
    .toMatchObject({ state: "available", authenticated: true });
}, 60_000);

// Cut with the engines it needed: this case proved a turn runs on its own engine while another engine's CLI is still
// being probed. This build runs one engine, so there is no second CLI for a turn to wait behind.

it("starts the words a later start restored before a message sent while the engine is read", async () => {
  const home = freshHome();
  const first = await boot(home);
  const [starter] = (await first.get("/api/bots?messages=0")).bots;
  await first.stop();
  // Words still queued for the conversation when the last run stopped.
  const db = new DatabaseSync(join(home, "messages.db"));
  try {
    db.prepare("INSERT INTO chat_followups(id, kind, owner_id, thread_id, send_id, status, payload) VALUES (?, 'bot', ?, ?, NULL, 'pending', ?)")
      .run("queued_before_restart", starter.id, starter.threadId, JSON.stringify({ text: "Queued before the restart" }));
  } finally { db.close(); }

  const slow = slowProbeCli(home);
  writeFileSync(join(home, "config.json"), JSON.stringify({
    instances: { pi: { driver: "piAgent", displayName: "Verification fixture", config: { cli: slow.cli } } },
  }));
  const server = await boot(home);
  await expect.poll(() => existsSync(slow.probes) && /^version \d+$/m.test(readFileSync(slow.probes, "utf8")), { timeout: 10_000 }).toBe(true);
  await server.control("send", "--bot", starter.id, "--task", starter.threadId, "--text", "Sent while the engine is read");
  writeFileSync(slow.release, "");

  const said = async () => ((await server.get(`/api/threads/${starter.threadId}/messages?limit=100`)).messages as Array<{ role: string; text?: string }>)
    .filter((message) => message.role === "user").map((message) => message.text);
  await expect.poll(said, { timeout: 30_000 }).toHaveLength(2);
  expect(await said()).toEqual(["Queued before the restart", "Sent while the engine is read"]);
  expect((await server.control("wait", "--bot", starter.id, "--task", starter.threadId, "--timeout", "30")).status).toBe("settled");
}, 60_000);
