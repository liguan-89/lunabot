// Regenerating a thread's title end to end. The build runs one agent (pi), whose driver has no one-shot text call, so a
// generated title can never be produced: the route says so, keeps the title the person or the first message gave the
// thread, and names the switch when generated titles are off. A rename is never overwritten.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_PI = join(SERVER_DIR, "testing", "fake-pi-cli.ts");
/** What the route refuses with when the bot's engine has no one-shot text call. */
const NO_ONE_SHOT = "this bot's model can't generate a title — rename the thread instead";

let child: ChildProcess;
let home = "";
let base = "";
let output = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const taskTitle = async (botId: string, threadId: string): Promise<string | undefined> => {
  const bot = (await api("GET", "/api/bots?messages=0")).body.bots.find((candidate: { id: string }) => candidate.id === botId);
  return bot?.tasks?.find((task: { threadId: string }) => task.threadId === threadId)?.title;
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-regenerate-title-"));
  const data = join(home, ".lunabot");
  const staticDir = join(home, "static");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Regenerate title test</title>");
  writeFileSync(join(staticDir, "assets", "smoke.css"), "body{}");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    features: { llmThreadTitles: true },
    instances: { pi: { driver: "piAgent", displayName: "Titled fixture", config: { cli: FAKE_PI } } },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      LUNABOT_PORT: String(port),
      LUNABOT_WEBHOOK_PORT: String(port + 1),
      LUNABOT_STATIC_DIR: staticDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (chunk) => (output += chunk));
  child.stderr!.on("data", (chunk) => (output += chunk));
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${output}`);
    try {
      if ((await fetch(`${base}/api/health`)).status === 200) break;
    } catch {
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

describe("Regenerate title", { timeout: 60_000 }, () => {
  let botId = "";
  let threadId = "";

  it("offers itself through the config only while generated titles are on", async () => {
    expect((await api("GET", "/api/config")).body.features.llmThreadTitles).toBe(true);
  });

  it("keeps a renamed thread as the person named it, since the engine has no one-shot text call", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Titled bot" })).body.bot;
    botId = bot.id;
    expect((await api("PATCH", `/api/bots/${botId}`, { memoryUpkeep: false })).status).toBe(200);
    const sent = await api("POST", `/api/bots/${botId}/messages`, { text: "every login hangs after the session expires" });
    expect(sent.status).toBe(202);
    threadId = sent.body.threadId;
    await expect.poll(async () => {
      const page = (await api("GET", `/api/threads/${threadId}/messages?limit=50`)).body;
      const current = (await api("GET", "/api/bots?messages=0")).body.bots.find((candidate: { id: string }) => candidate.id === botId);
      return !current?.busy && (page?.messages ?? []).some((message: { role: string; kind: string }) => message.role === "bot" && message.kind === "text");
    }, { timeout: 20_000, interval: 150 }).toBe(true);

    expect((await api("PATCH", `/api/bots/${botId}/tasks/${threadId}`, { title: "My name for it" })).status).toBe(200);
    const regenerated = await api("POST", `/api/bots/${botId}/tasks/${threadId}/title`);
    expect(regenerated.status).toBe(409);
    expect(regenerated.body.error).toBe(NO_ONE_SHOT);
    expect(await taskTitle(botId, threadId)).toBe("My name for it");
  });

  it("refuses a thread with nothing to name it from, and an unknown one", async () => {
    const fresh = (await api("POST", `/api/bots/${botId}/tasks`, {})).body.task;
    // The engine's own refusal comes before any look at the conversation: pi can never generate one.
    const empty = await api("POST", `/api/bots/${botId}/tasks/${fresh.threadId}/title`);
    expect(empty.status).toBe(409);
    expect(empty.body.error).toBe(NO_ONE_SHOT);
    expect((await api("POST", `/api/bots/${botId}/tasks/no-such-thread/title`)).status).toBe(404);
  });

  it("names the switch once generated titles are turned off", async () => {
    expect((await api("PATCH", "/api/config", { features: { llmThreadTitles: false } })).status).toBe(200);
    expect((await api("GET", "/api/config")).body.features.llmThreadTitles).toBe(false);
    const off = await api("POST", `/api/bots/${botId}/tasks/${threadId}/title`);
    expect(off.status).toBe(409);
    expect(off.body.error).toMatch(/generated thread titles are turned off/);
    expect(await taskTitle(botId, threadId)).toBe("My name for it");
  });
});
