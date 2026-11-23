// The work digest end to end on the fixture's only engine, the fake pi: one settled direct turn yields exactly one
// digest naming the tools it observed and the same turn id its activity rows carry, and a turn held open while a
// project file appears names that file in its digest.
//
// The old per-engine matrix is one pi run. Its second half — a replay read by a *different* engine — is gone: the
// build has no second engine, and a warm pi session is handed only its new words (the digest line reaches a rebuilt
// session, which a direct thread does not open here). The changed-file subject is kept in full.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { launchVerificationServer, verificationServerArgs, verificationServerEnvironment, type VerificationServer } from "../scripts/control-lunabot.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { piDumpPath, piTurnHolding } from "./testing/pi-dump.ts";

interface Msg {
  id: string;
  role: string;
  kind: string;
  text?: string;
  turnId?: string;
  tool?: { name: string };
  digest?: { turnId: string; tools: Array<{ name: string; count: number }>; files?: { added: string[]; changed: string[] }; hookCoverage: string };
}

let fixture: VerificationServer | undefined;
afterEach(async () => {
  if (fixture) {
    const closing = fixture;
    fixture = undefined;
    await closing.close();
  }
});

async function start(env: NodeJS.ProcessEnv) {
  const server = await launchVerificationServer({ ...process.env, ...env });
  fixture = server;
  const { url, dataDir } = server.info;
  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() as any };
  };
  const instances = (await api("GET", "/api/instances")).body.instances as Array<{ instanceId: string; models?: { default?: string } }>;
  const model = instances.find((instance) => instance.instanceId === "pi")?.models?.default;
  expect(model, "the fake pi reports a default model").toBeTruthy();
  const createBot = async () => {
    const created = (await api("POST", "/api/bots", { modelSelection: { instanceId: "pi", model }, requireAvailableModel: true })).body.bot;
    expect(created?.id).toBeTruthy();
    return created as { id: string };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots?messages=200")).body.bots.find((b: any) => b.id === id);
  const settled = async (id: string) => {
    const bot = await getBot(id);
    return !!bot && !bot.busy && bot.messages.some((m: Msg) => m.role === "bot" && m.kind === "text" && m.text);
  };
  return { server, dataDir, api, createBot, getBot, settled };
}

/** The real git, if this machine has one: the fixture seals PATH to node's own folder, where git is not. */
const GIT = (process.env.PATH ?? "").split(delimiter)
  .flatMap((dir) => [join(dir, "git"), join(dir, "git.exe")])
  .find((path) => existsSync(path));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Restart the same fixture on the same home and port with git's folder back on PATH. The config, the data and
 * the fake-pi instance are still the launcher's, so a file digest has a checkpoint to diff. */
async function restartWithGit(server: VerificationServer, launchEnv: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const port = Number(new URL(server.info.url).port);
  await waitForExit(server.child, { signal: "SIGTERM" });
  const env = verificationServerEnvironment(launchEnv, server.info.dataDir, port);
  env.PATH = [dirname(GIT!), dirname(process.execPath)].join(delimiter);
  const log = openSync(server.info.logPath, "a", 0o600);
  const child = spawn(process.execPath, verificationServerArgs(env), { cwd: ROOT, env, stdio: ["ignore", log, log] });
  closeSync(log);
  try {
    await expect.poll(async () => {
      try { return (await fetch(`${server.info.url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
  } catch (error) {
    await waitForExit(child, { signal: "SIGTERM" });
    throw error;
  }
  return child;
}

it("one settled turn yields exactly one digest naming its tools", async () => {
  const f = await start({ FAKE_PI_MODE: "tooluse" });
  const created = await f.createBot();
  expect((await f.api("POST", `/api/bots/${created.id}/messages`, { text: "do one thing" })).status).toBe(202);
  await expect.poll(() => f.settled(created.id), { timeout: 45_000 }).toBe(true);
  await expect.poll(async () => (await f.getBot(created.id)).messages.some((m: Msg) => m.kind === "digest"), { timeout: 45_000 }).toBe(true);

  const bot = await f.getBot(created.id);
  const digests: Msg[] = bot.messages.filter((m: Msg) => m.kind === "digest");
  const reply: Msg = bot.messages.find((m: Msg) => m.role === "bot" && m.kind === "text" && m.text);
  expect(digests).toHaveLength(1);
  const [d] = digests;
  expect(d!.role).toBe("bot");
  expect(d!.text ?? "").toMatch(/^\[digest\]/);
  expect(d!.digest?.turnId).toBeTruthy();
  if (reply.turnId) expect(d!.digest?.turnId).toBe(reply.turnId);
  expect(d!.digest!.tools.map((tool) => tool.name)).toContain("bash");
  // pi has no hook channel: the digest reports a tool-showing turn from the driver's bounded preview.
  expect(d!.digest?.hookCoverage).toBe("preview");
  const activities: Msg[] = bot.messages.filter((m: Msg) => m.kind === "activity" && m.tool);
  expect(activities.length).toBeGreaterThan(0);
  for (const activity of activities) expect(activity.turnId).toBe(d!.digest?.turnId);
  expect(d!.digest!.tools.reduce((n, tool) => n + tool.count, 0)).toBe(activities.length);
}, 60_000);

it.skipIf(!GIT)("names the project file a held turn added", async () => {
  const project = mkdtempSync(join(tmpdir(), "omb-digest-project-"));
  const gate = join(tmpdir(), `omb-digest-gate-${process.pid}-${Date.now()}`);
  let restarted: ChildProcess | undefined;
  try {
    writeFileSync(join(project, "README.md"), "hello");
    // `slow` holds the turn until the gate file exists, so the file can appear while the turn is under way.
    const launchEnv = { ...process.env, FAKE_PI_MODE: "slow", FAKE_PI_SLOW_FINISH_GATE: gate };
    const f = await start(launchEnv);
    restarted = await restartWithGit(f.server, launchEnv);
    const created = await f.createBot();
    expect((await f.api("PATCH", `/api/bots/${created.id}`, { cwd: project })).status).toBe(200);
    expect((await f.api("POST", `/api/bots/${created.id}/messages`, { text: "raise the retry limit" })).status).toBe(202);
    // Busy flips at claim, before the pre-turn checkpoint; the dump shows the prompt only once it reaches the engine.
    await expect.poll(() => Boolean(piTurnHolding(piDumpPath(f.dataDir), "raise the retry limit")), { timeout: 30_000 }).toBe(true);
    writeFileSync(join(project, "retry.ts"), "export const RETRY_LIMIT = 5;");
    writeFileSync(gate, "go");
    await expect.poll(() => f.settled(created.id), { timeout: 45_000 }).toBe(true);
    await expect.poll(async () => {
      const bot = await f.getBot(created.id);
      return bot.messages.find((m: Msg) => m.kind === "digest")?.digest?.files?.added;
    }, { timeout: 45_000 }).toEqual(["retry.ts"]);
  } finally {
    rmSync(gate, { force: true });
    if (restarted) await waitForExit(restarted, { signal: "SIGTERM" });
    await removeTempDir(project);
  }
}, 90_000);
