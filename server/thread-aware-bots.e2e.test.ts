// Turns are held open by a gated pi CLI so the slot arithmetic is observable rather than raced.
// This build runs pi only: the retired Claude/ACP/Cursor/Grok engine instances are gone, so every bot runs on the
// fake pi and the two engine-selection subtests collapsed into the one pi instance they could express.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { piInstructionsAt, piModelsSet, piTurns } from "./testing/pi-dump.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse } from "./testing/sse.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_PI = join(SERVER_DIR, "testing", "fake-pi-cli.ts");
const TEST_CAPABILITY_KEY = "thread-aware-bots-fixture-capability";
const PI = "pi";
const SONNET = "openai/gpt-4o";
const OPUS = "ollama-cloud/glm-5.2";

let child: ChildProcess;
let home = "";
let gates = "";
let base = "";
let stderr = "";

const api = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
};

/** A gate written before the turn starts lets it finish at once. Turns of one thread share a process (and its gate);
 * a `[[gate:NAME]]` in the prompt moves that turn's gate, so one thread's requests can be released one at a time. */
const release = (threadId: string) => writeFileSync(join(gates, `${threadId}.gate`), "finish");
const piDump = (key: string) => join(gates, `${key}.pi.jsonl`);
/** The launch this thread's turn ran on, read from the pi launch log rather than the retired Claude per-turn dump. */
const dumpOf = (key: string): { argv?: string[]; systemPrompt?: string; mcpConfig?: any } | undefined => {
  const turns = piTurns(piDump(key));
  const launch = turns.at(-1)?.launch;
  if (!launch) return undefined;
  return { argv: launch.argv, systemPrompt: piInstructionsAt(turns, 0), mcpConfig: launch.mcpConfig };
};
const promptsOf = (key: string): any[] =>
  piTurns(piDump(key)).map((turn) => ({ message: { content: turn.prompt } }));
const promptCount = (threadId: string) => piTurns(piDump(threadId)).length;
const liveToken = async (threadId: string): Promise<Record<string, string>> => {
  await expect.poll(() => dumpOf(threadId)?.mcpConfig?.mcpServers?.agents?.env?.LUNABOT_COMMS_TOKEN, { timeout: 15_000 }).toBeTruthy();
  return { authorization: `Bearer ${dumpOf(threadId)!.mcpConfig.mcpServers.agents.env.LUNABOT_COMMS_TOKEN}` };
};
/** A wake on that thread cannot start while this turn runs, so the token stays valid while the test holds the gate. */
const heldTurn = async (bot: { id: string; threadId: string }, text: string): Promise<Record<string, string>> => {
  // idle first: an earlier turn still finishing must find its gate
  await expect.poll(async () => Boolean((await botState(bot.id))?.busy), { timeout: 15_000 }).toBe(false);
  rmSync(join(gates, `${bot.threadId}.gate`), { force: true });
  const before = promptCount(bot.threadId);
  const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId });
  expect(sent.status).toBe(202);
  expect(sent.body.queued).toBeUndefined();
  // A warm child appends only the new prompt; a respawn appends a new launch. Either way the token below is the live one.
  await expect.poll(() => promptCount(bot.threadId), { timeout: 15_000 }).toBeGreaterThan(before);
  return liveToken(bot.threadId);
};
const proxyCall = async (threadId: string, name: string, args: Record<string, unknown>) => {
  await liveToken(threadId);
  const server = dumpOf(threadId)!.mcpConfig.mcpServers.agents;
  const proxy = spawn(server.command, server.args, { cwd: ROOT, env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: proxy.stdout });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<any>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Mounted proxy ${name} timed out`)), 15_000);
      lines.on("line", line => {
        try {
          const response = JSON.parse(line);
          if (response.error) { reject(new Error(JSON.stringify(response.error))); return; }
          if (response.id === 1) {
            proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
            proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) + "\n");
          }
          if (response.id === 2) resolve(response.result);
        } catch { reject(new Error("Mounted proxy returned malformed JSON")); }
      });
      proxy.once("error", reject);
      proxy.once("exit", (code, signal) => reject(new Error(`Mounted proxy exited before replying: ${signal ?? code}`)));
      proxy.stdin.on("error", reject);
      proxy.stderr.resume();
      proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "thread-fixture", version: "1" } } }) + "\n");
    });
  } finally {
    clearTimeout(timer);
    lines.close();
    proxy.stdin.destroy();
    await waitForExit(proxy, { signal: "SIGTERM" });
  }
};
const mintedToken = async (botId: string, threadId: string, depth = 0): Promise<Record<string, string>> => {
  const minted = await api(
    "POST",
    "/api/testing/internal-capability",
    { botId, threadId, kind: "agents", depth },
    { "x-lunabot-test-capability": TEST_CAPABILITY_KEY },
  );
  expect(minted.status).toBe(201);
  return { authorization: `Bearer ${minted.body.token}` };
};

const bots = async () => (await api("GET", "/api/bots?messages=0")).body.bots as any[];
const botState = async (botId: string) => (await bots()).find((bot) => bot.id === botId);
const taskOf = async (botId: string, threadId: string) => (await botState(botId))?.tasks.find((task: any) => task.threadId === threadId);
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
const handoffs = (): any[] => readHandoffs(join(home, ".lunabot"));
const coordinated = async (headers: Record<string, string>, botId: string, message: string) => {
  const response = await api("POST", "/api/internal/coordinate-bots", { botIds: [botId], message }, headers);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.receipts).toHaveLength(1);
  return handoffs().find(node => node.id === response.body.receipts[0].requestId);
};

const createBot = async (name: string, model = SONNET) => {
  const created = (await api("POST", "/api/bots", {})).body.bot;
  const patched = await api("PATCH", `/api/bots/${created.id}`, { name, notifications: true, modelSelection: { instanceId: PI, model } });
  expect(patched.status).toBe(200);
  return patched.body.bot;
};

const cleanup = async (botIds: string[]) => {
  for (const botId of botIds) await api("POST", `/api/bots/${botId}/interrupt`, {}).catch(() => undefined);
  for (const botId of botIds) await api("DELETE", `/api/bots/${botId}`).catch(() => undefined);
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-thread-aware-"));
  gates = join(home, "gates");
  const data = join(home, ".lunabot");
  mkdirSync(data, { recursive: true });
  mkdirSync(gates, { recursive: true });
  // Every turn holds until its gate exists and the fake appends its launch and prompt to a log keyed by the agents
  // thread id; a [[gate:NAME]] marker moves that turn's gate, so requests queued in one thread release one at a time.
  // The wrapper buffers each prompt line, picks the gate, then hands the line to the real fake pi.
  const gated = join(home, "gated-pi.mjs");
  writeFileSync(gated, [
    "#!/usr/bin/env node",
    'import { readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'import { PassThrough } from "node:stream";',
    `const gates = ${JSON.stringify(gates)};`,
    "let thread = process.env.LUNABOT_THREAD_ID ?? null;",
    "if (!thread && process.env.LUNABOT_MCP_CONFIG) {",
    "  try {",
    '    const servers = JSON.parse(readFileSync(process.env.LUNABOT_MCP_CONFIG, "utf8")).mcpServers ?? {};',
    "    for (const server of Object.values(servers)) thread ??= server?.env?.LUNABOT_THREAD_ID ?? null;",
    "  } catch {}",
    "}",
    'thread ??= "peer";',
    'process.env.FAKE_PI_MODE = "slow";',
    `process.env.FAKE_PI_DUMP = join(gates, thread + ".pi.jsonl");`,
    `process.env.FAKE_PI_SLOW_FINISH_GATE = join(gates, thread + ".gate");`,
    "const relay = new PassThrough();",
    "const real = process.stdin;",
    'Object.defineProperty(process, "stdin", { value: relay, configurable: true });',
    'let held = "";',
    'real.on("data", (chunk) => {',
    "  held += chunk;",
    "  let nl;",
    '  while ((nl = held.indexOf("\\n")) !== -1) {',
    "    const line = held.slice(0, nl);",
    "    held = held.slice(nl + 1);",
    "    if (line.trim()) {",
    "      try {",
    "        const cmd = JSON.parse(line);",
    '        if (cmd.type === "prompt") {',
    '          const own = String(cmd.message ?? "");',
    '          const clockAt = own.lastIndexOf("Current time when this message was sent: ");',
    // Only the marker in this turn\'s own words may pick its gate: history, notes and quoted requests may carry one too.
    '          const marker = /\\[\\[gate:([\\w-]+)\\]\\]/.exec(clockAt >= 0 ? own.slice(clockAt) : own);',
    `          process.env.FAKE_PI_SLOW_FINISH_GATE = join(gates, (marker?.[1] ?? thread) + ".gate");`,
    "        }",
    "      } catch {}",
    "    }",
    '    relay.write(line + "\\n");',
    "  }",
    "});",
    'real.on("end", () => relay.end());',
    `await import(${JSON.stringify(pathToFileURL(FAKE_PI).href)});`,
  ].join("\n"), { mode: 0o700 });
  writeFileSync(join(data, "config.json"), JSON.stringify({
    // These tests compare whole conversations; a setup card refreshing after a rename would change under them.
    features: { smartSetupChoices: false },
    threads: { maxConcurrentPerBot: 2 },
    instances: {
      pi: {
        driver: "piAgent",
        displayName: "Verification pi",
        config: { cli: gated },
        environment: {
          // A coordinated request saying this asks the person a question, as a teammate's native ask would.
          FAKE_PI_QUESTION_ON: "Which colour?",
        },
      },
    },
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
      LUNABOT_TEST_INTERNAL_CAPABILITY_KEY: TEST_CAPABILITY_KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    try {
      if ((await fetch(`${base}/api/health`)).status === 200) break;
    } catch {
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 45_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

describe("start_thread on yourself", () => {
  it("opens a quiet thread that runs like a person's message, or waits its turn", async () => {
    const pm = await createBot("Pam");
    try {
      expect((await api("POST", `/api/bots/${pm.id}/messages`, { text: "Plan the QA round." })).status).toBe(202);
      const token = await liveToken(pm.threadId);
      const folder = (await api("POST", `/api/bots/${pm.id}/projects`, { name: "QA" })).body.project;

      const first = await api("POST", "/api/internal/threads", { title: "QA: PR #1", message: "Review the login fix." }, token);
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ title: "QA: PR #1", botId: pm.id, self: true, state: "running", limit: 2 });
      const second = await api("POST", "/api/internal/threads", { title: "QA: PR #2", message: "Review the signup fix.", folder: "qa" }, token);
      expect(second.status).toBe(201);
      expect(second.body).toMatchObject({ state: "queued", position: 1 });
      const third = await api("POST", "/api/internal/threads", { title: "QA: PR #3", message: "Review the reset fix." }, token);
      expect(third.body).toMatchObject({ state: "queued", position: 2 });

      const state = await botState(pm.id);
      expect(state.threadId).toBe(pm.threadId);
      const opened = state.tasks.find((task: any) => task.threadId === first.body.threadId);
      expect(opened).toMatchObject({ title: "QA: PR #1", openedBy: { botId: pm.id, name: "Pam" }, busy: true });
      expect(opened.openedBy.delegationId).toBeUndefined();
      expect(opened.resumeCursors).toBeUndefined();
      expect(await taskOf(pm.id, second.body.threadId)).toMatchObject({ projectId: folder.id, busy: false });

      const chip = (await messages(pm.threadId)).find((message) => message.threadRef?.threadId === first.body.threadId);
      expect(chip).toMatchObject({ kind: "activity", tool: { name: "Opened thread #QA: PR #1", ok: true }, threadRef: { botId: pm.id, title: "QA: PR #1" } });

      const opening = (await messages(first.body.threadId)).find((message) => message.role === "user");
      expect(opening.text).toContain("[Thread you opened yourself from #Plan the QA round.");
      expect(opening.text).toContain("Review the login fix.");
      await liveToken(first.body.threadId);
      const self = dumpOf(first.body.threadId)!.mcpConfig.mcpServers.agents;
      expect(self.env.LUNABOT_THREAD_ID).toBe(first.body.threadId);

      release(first.body.threadId);
      await expect.poll(async () => (await taskOf(pm.id, second.body.threadId))?.busy, { timeout: 15_000 }).toBe(true);
      expect((await taskOf(pm.id, third.body.threadId)).busy).toBe(false);
      release(second.body.threadId);
      await expect.poll(async () => (await taskOf(pm.id, third.body.threadId))?.busy, { timeout: 15_000 }).toBe(true);
      release(third.body.threadId);
      release(pm.threadId);
      await expect.poll(async () => (await botState(pm.id))?.busy, { timeout: 15_000 }).toBe(false);
      expect((await messages(third.body.threadId)).some((message) => message.role === "bot" && message.text?.includes("reply to:"))).toBe(true);
      await heldTurn({ id: pm.id, threadId: first.body.threadId }, "Please start a separate follow-up job.");
      const followUp = await proxyCall(first.body.threadId, "start_thread", { title: "User follow-up", message: "A separately requested check." });
      expect(followUp.isError).not.toBe(true);
      expect((await botState(pm.id)).tasks.some((task: any) => task.title === "User follow-up")).toBe(true);
    } finally {
      await cleanup([pm.id]);
    }
  }, 60_000);

  it("refuses a title that would not fit a row, a folder the bot does not have, and a sixth thread", async () => {
    const bot = await createBot("Quin");
    try {
      const token = await heldTurn(bot, "Open separate checks.");
      const twoLines = await api("POST", "/api/internal/threads", { title: "two\nlines", message: "x" }, token);
      expect(twoLines.status).toBe(400);
      expect(twoLines.body.error).toContain("fit on one line");
      const long = await api("POST", "/api/internal/threads", { title: "x".repeat(81), message: "x" }, token);
      expect(long.status).toBe(400);
      const untitled = await api("POST", "/api/internal/threads", { title: "  ", message: "x" }, token);
      expect(untitled.status).toBe(400);
      const noFolder = await api("POST", "/api/internal/threads", { title: "Filed", message: "x", folder: "Nowhere" }, token);
      expect(noFolder.status).toBe(400);
      expect(noFolder.body.error).toContain("no folder named \"Nowhere\"");
      expect((await botState(bot.id)).tasks).toHaveLength(1);
      for (let index = 0; index < 5; index++) {
        release(`unused-${index}`);
        const opened = await api("POST", "/api/internal/threads", { title: `Job ${index}`, message: "go" }, token);
        expect(opened.status).toBe(201);
      }
      const sixth = await api("POST", "/api/internal/threads", { title: "Job 5", message: "go" }, token);
      expect(sixth.status).toBe(429);
      expect(sixth.body.error).toContain("already opened 5 threads this turn");
      expect((await botState(bot.id)).tasks).toHaveLength(6);
      for (const task of (await botState(bot.id)).tasks) release(task.threadId);
      await expect.poll(async () => (await botState(bot.id))?.busy, { timeout: 15_000 }).toBe(false);
    } finally {
      await cleanup([bot.id]);
    }
  }, 60_000);

  it("opens the thread on the model the bot picks, refuses one it cannot use, and leaves teammates on their own", async () => {
    const pm = await createBot("Pam");
    const qa = await createBot("Quinn");
    const sonnet = { instanceId: PI, model: SONNET };
    const opus = { instanceId: PI, model: OPUS };
    try {
      const token = await heldTurn(pm, "Run the deep review on a stronger model.");
      const picked = await api("POST", "/api/internal/threads", { title: "Deep review", message: "go", modelSelection: opus }, token);
      expect(picked.status, JSON.stringify(picked.body)).toBe(201);
      release(picked.body.threadId);
      expect(await taskOf(pm.id, picked.body.threadId)).toMatchObject({ modelSelection: opus });
      expect((await botState(pm.id)).modelSelection).toMatchObject(sonnet);
      const unknown = await api("POST", "/api/internal/threads", { title: "Nowhere", message: "go", modelSelection: { instanceId: "retired", model: "old-model" } }, token);
      expect(unknown.status).toBe(400);
      expect(unknown.body.error).toContain("retired");
      const notOffered = await api("POST", "/api/internal/threads", { title: "Nowhere", message: "go", modelSelection: { instanceId: PI, model: "no-such-model" } }, token);
      expect(notOffered.status).toBe(400);
      const teammate = await api("POST", "/api/internal/threads", { toBotId: qa.id, title: "Job", message: "go", modelSelection: opus }, token);
      expect(teammate.status).toBe(400);
      expect((await botState(pm.id)).tasks.filter((task: any) => task.title === "Nowhere")).toHaveLength(0);
      release(pm.threadId);
      await expect.poll(async () => (await botState(pm.id))?.busy, { timeout: 15_000 }).toBe(false);
      await heldTurn({ id: pm.id, threadId: picked.body.threadId }, "Open one more on the stronger model.");
      const viaTool = await proxyCall(picked.body.threadId, "start_thread", { title: "Second pass", message: "go", model_selection: opus });
      expect(viaTool.isError, JSON.stringify(viaTool)).not.toBe(true);
      const second = (await botState(pm.id)).tasks.find((task: any) => task.title === "Second pass");
      expect(second).toMatchObject({ modelSelection: opus });
      release(second.threadId);
      release(picked.body.threadId);
    } finally {
      await cleanup([pm.id, qa.id]);
    }
  }, 60_000);

  it("starts on the model of the thread it was opened from, never on a teammate's", async () => {
    const pm = await createBot("Pam");
    const qa = await createBot("Quinn");
    const sonnet = { instanceId: PI, model: SONNET };
    const opus = { instanceId: PI, model: OPUS };
    try {
      // pi has no auto-accept-edits level, so Ask is the level whose inheritance this test can observe.
      expect((await api("PATCH", `/api/bots/${pm.id}`, { approvalMode: "ask" })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${pm.id}/tasks/${pm.threadId}`, { modelSelection: opus })).status).toBe(200);
      const token = await heldTurn(pm, "Split this into separate jobs.");
      const opened = await api("POST", "/api/internal/threads", { title: "Same model", message: "go" }, token);
      expect(opened.status).toBe(201);
      release(opened.body.threadId);
      expect(await taskOf(pm.id, opened.body.threadId)).toMatchObject({ modelSelection: opus, approvalMode: "ask" });
      expect((await botState(pm.id)).modelSelection).toMatchObject(sonnet);
      const handed = await coordinated(token, qa.id, "Check it.");
      release(handed.threadId);
      expect(await taskOf(qa.id, handed.threadId)).toMatchObject({ modelSelection: sonnet });
      release(pm.threadId);
      await expect.poll(async () => (await botState(pm.id))?.busy, { timeout: 15_000 }).toBe(false);

      const fresh = await api("POST", `/api/bots/${pm.id}/tasks`, { title: "From scratch" });
      expect(fresh.body.task).toMatchObject({ modelSelection: sonnet, approvalMode: "ask" });
      const retired = { instanceId: "retired", model: "old-model" };
      expect((await api("PATCH", `/api/bots/${pm.id}/tasks/${fresh.body.task.threadId}`,
        { modelSelection: retired, resetApprovalToAsk: true })).status).toBe(200);
      const elsewhere = await api("POST", "/api/internal/threads", { title: "Retired engine", message: "go" },
        await mintedToken(pm.id, fresh.body.task.threadId));
      expect(elsewhere.status).toBe(201);
      expect(await taskOf(pm.id, elsewhere.body.threadId)).toMatchObject({ modelSelection: sonnet, followsBotModel: true, approvalMode: "ask", alwaysAllow: [] });
      expect((await messages(elsewhere.body.threadId)).filter((message) => message.tool?.name?.startsWith("notice: This thread's model (old-model)")))
        .toHaveLength(1);
      expect(await botState(pm.id)).toMatchObject({ modelSelection: sonnet, approvalMode: "ask" });
    } finally {
      await cleanup([pm.id, qa.id]);
    }
  }, 60_000);
});

describe("start_thread on another model, reporting back", () => {
  it("runs the thread on the chosen model and resumes the opener with its result", async () => {
    const pm = await createBot("Pam");
    const opus = { instanceId: PI, model: OPUS };
    try {
      const token = await heldTurn(pm, "Get a second opinion on the diff.");
      const models = await api("GET", "/api/internal/models", undefined, token);
      expect(models.status).toBe(200);
      expect(models.body.current).toMatchObject({ instanceId: PI, model: SONNET });
      expect(models.body.engines.find((row: any) => row.instanceId === PI).models.map((model: any) => model.id ?? model)).toEqual(expect.arrayContaining([SONNET, OPUS]));
      const unknown = await api("POST", "/api/internal/threads",
        { title: "Review", message: "go", modelSelection: { instanceId: PI, model: "no-such-model" }, reportBack: true }, token);
      expect([unknown.status, unknown.body.error]).toEqual([400, `model "no-such-model" is not offered by instance "${PI}"`]);
      expect((await botState(pm.id)).tasks).toHaveLength(1);

      const opened = await api("POST", "/api/internal/threads",
        { title: "Review: Opus", message: "Review the diff. [[gate:own-review]]", modelSelection: opus, reportBack: true }, token);
      expect(opened.status, JSON.stringify(opened.body)).toBe(201);
      expect(opened.body).toMatchObject({ self: true, reportBack: true, title: "Review: Opus" });
      const { threadId, requestId } = opened.body;
      expect(await taskOf(pm.id, threadId)).toMatchObject({ title: "Review: Opus", modelSelection: opus, openedBy: { botId: pm.id, threadId: pm.threadId } });
      expect((await messages(pm.threadId)).find((message) => message.threadRef?.threadId === threadId))
        .toMatchObject({ tool: { name: "Opened thread #Review: Opus", ok: true } });

      release(pm.threadId);
      await expect.poll(() => piModelsSet(piDump(threadId)).at(-1), { timeout: 15_000 }).toEqual({ provider: "ollama-cloud", modelId: "glm-5.2" });
      expect(handoffs().find((node) => node.id === requestId)).toMatchObject({ botId: pm.id, threadId, status: "running" });
      release("own-review");
      await expect.poll(() => handoffs().find((node) => node.id === requestId)?.status, { timeout: 15_000 }).toBe("completed");
      await expect.poll(async () => (await messages(pm.threadId)).find((message) => message.roomRequest?.id === requestId && message.roomRequest.phase === "result")
        ?.tool?.name, { timeout: 15_000 }).toBe("#Review: Opus replied");
      expect(promptsOf(threadId)[0].message.content).toContain("Brief from @Pam (you, in #Get a second opinion on the diff.):\nReview the diff.");
      // The resumed opener's turn quotes the review request, so it used to land in the review thread's gate-keyed log.
      await expect.poll(() => promptsOf(pm.threadId).some((prompt) => prompt.message.content.includes(
        `[From @Pam (your thread #Review: Opus, on ${OPUS}) (bot) · report on assignment ${requestId}: done`)), { timeout: 15_000 }).toBe(true);
      expect((await messages(pm.threadId)).some((message) => message.tool?.name === "Resumed with #Review: Opus results, reviewing")).toBe(true);
      await expect.poll(async () => (await botState(pm.id))?.busy, { timeout: 15_000 }).toBe(false);
      expect((await botState(pm.id)).modelSelection).toMatchObject({ model: SONNET });
    } finally {
      await cleanup([pm.id]);
    }
  }, 60_000);

  // The old first half ("runs it on another engine") is gone with the engines it selected (Cursor, Grok): this build
  // has one pi instance, so there is no other engine to choose. The room refusal it also covered is kept below.
  it("refuses report_back from a room", async () => {
    const pm = await createBot("Pam");
    try {
      await heldTurn(pm, "Ask from a room.");
      const { group } = (await api("POST", "/api/groups", { name: "Review room", memberIds: [pm.id],
        setup: { bulletin: "", defaultResponder: { kind: "member", botId: pm.id } } })).body;
      const inRoom = await api("POST", "/api/internal/threads", { title: "Review", message: "go", reportBack: true }, await mintedToken(pm.id, group.threadId));
      expect([inRoom.status, inRoom.body.error]).toEqual([400, "report_back works only from your own conversation, not a room. Leave it out; the thread's result then stays in that thread."]);
      expect((await botState(pm.id)).tasks.some((task: any) => task.title === "Review")).toBe(false);
      release(pm.threadId);
    } finally {
      await cleanup([pm.id]);
    }
  }, 60_000);
  it("lets the opener answer its own thread's question, and that thread carries on with the answer", async () => {
    const pm = await createBot("Pam");
    try {
      // With no teammates the brief is the end of the prompt, so the echoing engine's reply ends on its question.
      expect((await api("PATCH", `/api/bots/${pm.id}`, { visibility: { people: ["pam-alone@example.test"] } })).status).toBe(200);
      const token = await heldTurn(pm, "Get a second opinion on the wording.");
      const opened = await api("POST", "/api/internal/threads",
        { title: "Review: wording", message: "Check the wording. [[gate:own-ask]]\nNEEDS INPUT: Formal or casual?", reportBack: true }, token);
      expect(opened.status, JSON.stringify(opened.body)).toBe(201);
      const { requestId } = opened.body;
      release("own-ask");
      await expect.poll(() => handoffs().find((node) => node.id === requestId)?.status, { timeout: 15_000 }).toBe("waiting");

      const answered = await api("POST", "/api/internal/coordinate-bots", { botIds: [pm.id], message: "Casual.", answers: requestId }, token);
      expect(answered.status, JSON.stringify(answered.body)).toBe(200);
      expect(answered.body.receipts).toMatchObject([{ outcome: "injected", requestId }]);
      await expect.poll(() => promptsOf(opened.body.threadId).at(-1)?.message.content ?? "", { timeout: 15_000 }).toContain("Casual.");
      await expect.poll(() => handoffs().find((node) => node.id === requestId)?.status, { timeout: 15_000 }).toBe("completed");
      expect((await botState(pm.id)).tasks.filter((task: any) => task.title === "Review: wording")).toHaveLength(1);

      const notMine = await api("POST", "/api/internal/coordinate-bots", { botIds: [pm.id], message: "Do it again." }, token);
      expect([notMine.status, notMine.body.error]).toEqual([403, "Choose a teammate, not yourself"]);
      release(pm.threadId);
      await expect.poll(async () => (await botState(pm.id))?.busy, { timeout: 15_000 }).toBe(false);
    } finally {
      await cleanup([pm.id]);
    }
  }, 60_000);

  it("lets the opener steer its own report-back thread while it runs and send it a follow-up after, never another thread of its own", async () => {
    const pm = await createBot("Pam");
    try {
      const token = await heldTurn(pm, "Get a review of the diff.");
      const opened = await api("POST", "/api/internal/threads", { title: "Review: steer", message: "Review the diff. [[gate:own-steer]]", reportBack: true }, token);
      expect(opened.status, JSON.stringify(opened.body)).toBe(201);
      const { threadId, requestId } = opened.body;
      await expect.poll(() => handoffs().find((node) => node.id === requestId)?.status, { timeout: 15_000 }).toBe("running");
      await expect.poll(() => dumpOf(threadId), { timeout: 15_000 }).toBeTruthy();
      const seen = () => JSON.stringify(promptsOf(threadId));
      // The opener's turn ends, and the person's next message asks it to steer the thread still running.
      release(pm.threadId);
      await expect.poll(() => handoffs().find((node) => node.threadId === pm.threadId)?.status, { timeout: 15_000 }).toBe("waiting");
      rmSync(join(gates, `${pm.threadId}.gate`), { force: true });
      const before = promptCount(pm.threadId);
      const nextSent = await api("POST", `/api/bots/${pm.id}/messages`, { text: "Have it check the tests too.", threadId: pm.threadId });
      expect(nextSent.status).toBe(202);
      // A warm pi child appends only the new prompt, so wait for that turn's prompt before taking its live token.
      await expect.poll(() => promptCount(pm.threadId), { timeout: 15_000 }).toBeGreaterThan(before);
      const later = await liveToken(pm.threadId);

      const steered = await api("POST", "/api/internal/coordinate-bots", { botIds: [pm.id], message: "Also check the tests.", thread: threadId }, later);
      expect(steered.status, JSON.stringify(steered.body)).toBe(200);
      expect(steered.body.receipts).toMatchObject([{ outcome: "injected", threadId, requestId }]);
      expect((await messages(threadId)).find((message) => message.text === "Also check the tests.")).toMatchObject({ role: "user", steered: true, peerAsk: { botId: pm.id } });
      release(threadId);
      release("own-steer");
      await expect.poll(() => handoffs().filter((node) => node.threadId === threadId).every((node) => node.status === "completed"), { timeout: 15_000 }).toBe(true);
      // The running turn itself read the correction mid-turn (the fake CLI echoes steers into its reply), not just the stored thread.
      expect((await messages(threadId)).some((message) => message.role === "bot" && message.text?.includes("steered:") && message.text.includes("Also check the tests."))).toBe(true);

      const followUp = await api("POST", "/api/internal/coordinate-bots", { botIds: [pm.id], message: "One more: check the docs.", thread: threadId }, later);
      expect(followUp.status, JSON.stringify(followUp.body)).toBe(200);
      const [receipt] = followUp.body.receipts;
      expect(receipt).toMatchObject({ threadId });
      await expect.poll(seen, { timeout: 15_000 }).toContain("One more: check the docs.");
      await expect.poll(() => handoffs().find((node) => node.id === receipt.requestId)?.status, { timeout: 15_000 }).toBe("completed");
      expect((await botState(pm.id)).tasks.filter((task: any) => task.title === "Review: steer")).toHaveLength(1);

      const standing = await api("POST", "/api/internal/coordinate-bots", { botIds: [pm.id], message: "Do it again." }, later);
      expect([standing.status, standing.body.error]).toEqual([403, "Choose a teammate, not yourself"]);
      const quiet = await api("POST", "/api/internal/threads", { title: "Quiet job", message: "Tidy up. [[gate:own-quiet]]" }, later);
      expect(quiet.status, JSON.stringify(quiet.body)).toBe(201);
      const notReporting = await api("POST", "/api/internal/coordinate-bots", { botIds: [pm.id], message: "Faster.", thread: quiet.body.threadId }, later);
      expect([notReporting.status, notReporting.body.error]).toEqual([403, "Choose a teammate, not yourself"]);
      // Only the conversation that opened it may steer it, and never through a room.
      const { task: other } = (await api("POST", `/api/bots/${pm.id}/tasks`, { title: "Other chat" })).body;
      const fromOther = await api("POST", "/api/internal/coordinate-bots", { botIds: [pm.id], message: "Faster.", thread: threadId }, await mintedToken(pm.id, other.threadId));
      expect([fromOther.status, fromOther.body.error]).toEqual([403, "Choose a teammate, not yourself"]);
      const { group } = (await api("POST", "/api/groups", { name: "Steer room", memberIds: [pm.id],
        setup: { bulletin: "", defaultResponder: { kind: "member", botId: pm.id } } })).body;
      const viaRoom = await api("POST", "/api/internal/coordinate-bots", { botIds: [pm.id], message: "Faster.", thread: threadId, groupId: group.id }, later);
      expect([viaRoom.status, viaRoom.body.error]).toEqual([403, "Choose a teammate, not yourself"]);
      release("own-quiet");
      release(pm.threadId);
      // The follow-up reports back too: its result lands in the opener's chat and the opener resumes with it.
      await expect.poll(async () => (await messages(pm.threadId)).some((message) => message.roomRequest?.id === receipt.requestId && message.roomRequest.phase === "result"), { timeout: 15_000 }).toBe(true);
      await expect.poll(() => JSON.stringify(promptsOf(pm.threadId)), { timeout: 15_000 }).toContain(`report on assignment ${receipt.requestId}: done`);
      await expect.poll(async () => (await botState(pm.id))?.busy, { timeout: 15_000 }).toBe(false);
    } finally {
      await cleanup([pm.id]);
    }
  }, 60_000);

  // Cut with the engine it needed: this subtest moved a queued report-back thread onto a signed-out Grok instance
  // and proved the provider's sign-out reason failed it rather than falling back. pi is BYOK and has no signed-out
  // instance state to reach, so there is no pi expression of "this model can no longer run" to test.
});

describe("coordinate_bots on a teammate", () => {
  it.each([1, 2])("runs three requests in the teammate's one thread, one at a time within capacity %i, returns all results, and leaves the person's selected thread untouched", async (capacity) => {
    expect((await api("PUT", "/api/config", { threads: { maxConcurrentPerBot: capacity } })).status).toBe(200);
    const pm = await createBot("Pam");
    const qa = await createBot("Quinn");
    const stream = await openSse(`${base}/api/events`);
    try {
      const originalConversation = await messages(qa.threadId);
      const token = await heldTurn(pm, "Hand the pull requests to QA.");
      // Each request carries its own gate, so each turn in the shared thread is held on its own.
      const gate = (index: number) => `pr-${capacity}-${index}`;
      const opened: any[] = [];
      for (let index = 1; index <= 3; index++) {
        opened.push(await coordinated(token, qa.id, `Test pull request ${index}. [[gate:${gate(index)}]]`));
      }
      const before = await botState(qa.id);
      expect(before.threadId).toBe(qa.threadId);
      const thread = opened[0].threadId;
      expect(opened.map((node) => node.threadId)).toEqual([thread, thread, thread]);
      expect(before.tasks.filter((task: any) => task.openedBy?.botId === pm.id).map((task: any) => [task.threadId, task.openedBy.threadId]))
        .toEqual([[thread, pm.threadId]]);
      // pi's launch log keys a turn by its thread, so a prompt names the request it was given: the later two have not run.
      const given = (index: number) => promptsOf(thread).some((prompt) => prompt.message.content.includes(`Test pull request ${index}.`));
      expect(given(2)).toBe(false);
      expect(given(3)).toBe(false);
      const chips = (await messages(pm.threadId)).filter((message) => message.threadRef);
      expect(chips.map((chip) => [chip.tool.name, chip.threadRef.botId, chip.threadRef.threadId])).toEqual(
        opened.map(() => ["Sent to Quinn", qa.id, thread]),
      );
      release(pm.threadId);
      for (let index = 0; index < opened.length; index++) {
        const node = opened[index];
        await expect.poll(() => promptCount(thread), { timeout: 15_000 }).toBeGreaterThan(index);
        const live = await liveToken(thread);
        await expect.poll(() => handoffs().filter(n => n.botId === qa.id && n.status === "running").map(n => n.id), { timeout: 15_000 }).toEqual([node.id]);
        expect(handoffs().filter(n => n.botId === qa.id && n.status === "queued")).toHaveLength(opened.length - index - 1);
        const request = (await messages(thread)).find((message) => message.roomRequest?.id === node.id && message.roomRequest.phase === "request");
        expect(request).toMatchObject({ from: { botId: pm.id } });
        expect(request.text).toContain(`Test pull request ${index + 1}.`);
        expect(piInstructionsAt(piTurns(piDump(thread)), 0)).toContain("coordinate_bots");
        expect((await api("GET", "/api/internal/assignment-status", undefined, live)).status).toBe(200);
        release(gate(index + 1));
        await expect.poll(() => handoffs().find(n => n.id === node.id)?.status, { timeout: 15_000 }).toBe("completed");
      }
      await expect.poll(async () => (await messages(pm.threadId)).filter(
        (message) => message.from?.botId === qa.id && message.roomRequest?.phase === "result",
      ).length, { timeout: 20_000 }).toBe(3);
      await expect.poll(async () => {
        const state = await botState(pm.id);
        return state?.busy === false && state.waitingForTeammates !== true;
      }, { timeout: 15_000 }).toBe(true);
      // The review turn quotes the requests, gate markers included, and runs in the opener's own thread.
      expect(promptsOf(pm.threadId).at(-1)?.message.content).toContain("Your downstream room requests have settled");
      expect(stream.frames.filter((frame) => frame.kind === "notify" && frame.notification?.botId === qa.id)).toEqual([]);
      expect((await botState(qa.id)).tasks.filter((task: any) => task.unread)).toEqual([]);
      expect((await botState(qa.id)).threadId).toBe(qa.threadId);
      expect(await messages(qa.threadId)).toEqual(originalConversation);
    } finally {
      stream.close();
      await cleanup([pm.id, qa.id]);
      expect((await api("PUT", "/api/config", { threads: { maxConcurrentPerBot: 2 } })).status).toBe(200);
    }
  }, 90_000);

  it("opens a peer thread through the threads route, refuses inaccessible peers and oversized batches, and does not duplicate a retried request", async () => {
    const pm = await createBot("Pam");
    const near = await createBot("Near");
    const far = await createBot("Far");
    const other = await createBot("Other");
    try {
      expect((await api("PATCH", `/api/bots/${other.id}`, { section: "Elsewhere", visibility: "admins" })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${far.id}`, { visibility: "admins" })).status).toBe(200);
      const token = await heldTurn(pm, "Coordinate only with the teammate I can reach.");
      const opened = await api("POST", "/api/internal/threads", { toBotId: near.id, title: "Job", message: "go" }, token);
      expect(opened.status, JSON.stringify(opened.body)).toBe(200);
      expect(opened.body.deprecation).toBeUndefined();
      expect(opened.body.receipts).toEqual([expect.objectContaining({ botId: near.id, outcome: "queued", threadId: expect.any(String) })]);
      const job = opened.body.receipts[0].threadId as string;
      expect(job).not.toBe(near.threadId);
      expect((await botState(near.id)).tasks.find((task: any) => task.threadId === job)).toMatchObject({ title: "Job", openedBy: { botId: pm.id } });
      expect(handoffs().find(node => node.threadId === job)).toMatchObject({ botId: near.id, mode: "work", reply: "resume", text: "go" });
      const send = (botIds: string[]) => api("POST", "/api/internal/coordinate-bots", { botIds, message: "Check it." }, token);
      const outside = await send([other.id]);
      expect(outside.status).toBe(403);
      expect(outside.body.error).toContain("Other is shared with different people from Pam, so nothing was sent.");
      const unlisted = await send([far.id]);
      expect(unlisted.status).toBe(403);
      expect(unlisted.body.error).toContain("Far is shared with different people from Pam, so nothing was sent.");
      expect((await send([near.id, far.id])).status).toBe(403);
      expect((await send([near.id, far.id, other.id, pm.id, "fifth"])).status).toBe(400);
      for (const bot of [other, far]) expect((await botState(bot.id)).tasks).toHaveLength(1);
      expect((await botState(near.id)).tasks).toHaveLength(2);
      const first = await coordinated(token, near.id, "Check it.");
      const retry = await send([near.id]);
      expect(retry.body.receipts).toEqual([expect.objectContaining({ requestId: first.id, detail: expect.stringContaining("already sent") })]);
      expect((await botState(near.id)).tasks).toHaveLength(3);
      expect((await api("PATCH", `/api/bots/${near.id}/tasks/${first.threadId}`, { archivedAt: Date.now() })).status).toBe(200);
      const afterArchive = await send([near.id]);
      expect(afterArchive.body.receipts).toEqual([expect.objectContaining({ requestId: first.id, threadId: first.threadId, detail: expect.stringContaining("already sent") })]);
      expect((await botState(near.id)).tasks).toHaveLength(3);
      expect((await messages(pm.threadId)).filter(message => message.threadRef?.threadId === first.threadId)).toHaveLength(1);
      release(job);
      await expect.poll(() => handoffs().find(node => node.threadId === job)?.status, { timeout: 15_000 }).toBe("completed");
    } finally {
      await cleanup([pm.id, near.id, far.id, other.id]);
    }
  }, 60_000);

  it("reports a deleted queued destination without falling back to the recipient's own conversation", async () => {
    const pm = await createBot("Pam");
    const qa = await createBot("Quinn");
    try {
      const originalConversation = await messages(qa.threadId);
      // An accepted handoff dispatches at once: hold Quinn's only slot so the destination is still queued when it is deleted.
      expect((await api("PUT", "/api/config", { threads: { maxConcurrentPerBot: 1 } })).status).toBe(200);
      const hold = (await api("POST", `/api/bots/${qa.id}/tasks`, { title: "Hold the slot" })).body.task;
      rmSync(join(gates, `${hold.threadId}.gate`), { force: true });
      expect((await api("POST", `/api/bots/${qa.id}/messages`, { text: "Hold the slot.", threadId: hold.threadId })).status).toBe(202);
      await expect.poll(async () => (await taskOf(qa.id, hold.threadId))?.busy, { timeout: 15_000 }).toBe(true);
      const token = await heldTurn(pm, "Hand it to QA.");
      const opened = await coordinated(token, qa.id, "Test it.");
      expect((await api("DELETE", `/api/bots/${qa.id}/tasks/${opened.threadId}`)).status).toBe(200);
      release(pm.threadId);
      await expect.poll(() => handoffs().find(node => node.id === opened.id)?.status, { timeout: 15_000 }).toBe("cancelled");
      // The cancelled report resumes Pam; wait for that review turn too.
      await expect.poll(async () => {
        const state = await botState(pm.id);
        return state?.busy === false && state.waitingForTeammates !== true;
      }, { timeout: 15_000 }).toBe(true);
      expect((await messages(pm.threadId)).some(message => message.roomRequest?.id === opened.id && message.roomRequest.phase === "result" && message.tool?.ok === false)).toBe(true);
      release(hold.threadId);
      await expect.poll(async () => (await taskOf(qa.id, hold.threadId))?.busy, { timeout: 15_000 }).toBe(false);
      expect(await messages(qa.threadId)).toEqual(originalConversation);
    } finally {
      await cleanup([pm.id, qa.id]);
      expect((await api("PUT", "/api/config", { threads: { maxConcurrentPerBot: 2 } })).status).toBe(200);
    }
  }, 60_000);

  it("still buzzes when a coordinated thread asks the person a question, deep-linked to that thread", async () => {
    const pm = await createBot("Pam");
    const sage = await createBot("Sage");
    // On "Ask me first" a teammate's question is the person's; at Full access the bot that handed the work on answers it.
    for (const bot of [pm, sage]) expect((await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask", applyToAllThreads: true })).status).toBe(200);
    const stream = await openSse(`${base}/api/events`);
    try {
      const token = await heldTurn(pm, "Ask Sage.");
      const opened = await coordinated(token, sage.id, "Which colour?");
      release(pm.threadId);
      const frame = await stream.until(
        (candidate) => candidate.kind === "notify" && candidate.notification?.botId === sage.id,
        20_000,
      );
      expect(frame.notification).toMatchObject({ kind: "question", botId: sage.id, threadId: opened.threadId });
      expect(frame.notification.threadId).not.toBe(sage.threadId);
      const card = (await messages(opened.threadId)).findLast((message) => message.kind === "options" && Boolean(message.card));
      expect(card?.card).toMatchObject({ title: "Your bot has a question" });
    } finally {
      stream.close();
      await cleanup([pm.id, sage.id]);
    }
  }, 60_000);
});

describe("list_threads", () => {
  it("lists your own threads and the ones you opened on a teammate, never a teammate's other threads", async () => {
    const pm = await createBot("Parker");
    const qa = await createBot("Quinn");
    try {
      const theirs = await api("POST", `/api/bots/${qa.id}/tasks`, { title: "Quinn's own audit" });
      expect(theirs.status).toBe(201);
      const token = await heldTurn(pm, "Find the tasks I opened for QA.");
      await coordinated(token, qa.id, "QA: PR #77");
      const mine = await api("GET", "/api/internal/threads", undefined, token);
      expect(mine.status).toBe(200);
      const titles = mine.body.threads.map((row: { title: string; botName: string; own: boolean }) => `${row.own ? "own" : row.botName}:${row.title}`);
      expect(titles).toContain("Quinn:@Parker · work");
      expect(titles.some((title: string) => title.startsWith("own:"))).toBe(true);
      expect(titles).not.toContain("Quinn:Quinn's own audit");
      const qaToken = await mintedToken(qa.id, qa.threadId);
      const theirsSeen = await api("GET", "/api/internal/threads", undefined, qaToken);
      expect(theirsSeen.body.threads.every((row: { own: boolean }) => row.own)).toBe(true);
      expect(theirsSeen.body.threads.map((row: { title: string }) => row.title)).toContain("Quinn's own audit");
    } finally {
      await cleanup([pm.id, qa.id]);
    }
  });
});

describe("a Chief of Staff tidying its team (MOCA-202)", () => {
  it("lists and closes threads one teammate opened on another, never a person's thread or for a non-Chief", async () => {
    const chief = await createBot("Charlie");
    const pm = await createBot("Parker");
    const qa = await createBot("Quinn");
    const rio = await createBot("Rio");
    try {
      expect((await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true })).status).toBe(200);
      const theirs = (await api("POST", `/api/bots/${qa.id}/tasks`, { title: "Quinn's own audit" })).body.task.threadId as string;
      // Parker hands Quinn work, and Quinn's turn is stopped: the handoff
      // never completes, so nothing auto-closes the thread Parker opened.
      const child = await coordinated(await heldTurn(pm, "Ask QA to check PR #90."), qa.id, "QA: PR #90");
      const close = (threadId: string, headers: Record<string, string>) =>
        api("POST", `/api/internal/threads/${threadId}/close`, {}, headers);
      const beforeDispatch = await mintedToken(chief.id, chief.threadId);
      // The runtime dispatches on its next tick once Quinn is free, so the handoff is queued or already running here.
      expect(handoffs().find(node => node.id === child.id)?.status).toMatch(/^(queued|running)$/);
      expect((await api("GET", "/api/internal/threads", undefined, beforeDispatch)).body.threads
        .find((row: any) => row.threadId === child.threadId)?.state).toMatch(/^(queued|running)$/);
      expect((await close(child.threadId, beforeDispatch)).status).toBe(409);
      release(pm.threadId);
      await expect.poll(async () => (await taskOf(qa.id, child.threadId))?.busy, { timeout: 15_000 }).toBe(true);
      expect((await api("POST", `/api/bots/${qa.id}/interrupt`, { threadId: child.threadId })).status).toBe(200);
      await expect.poll(() => handoffs().find(node => node.id === child.id)?.status, { timeout: 15_000 })
        .not.toMatch(/^(queued|running)$/);
      await expect.poll(async () => (await taskOf(qa.id, child.threadId))?.busy, { timeout: 15_000 }).toBe(false);
      expect((await taskOf(qa.id, child.threadId)).closedBy).toBeUndefined();

      // An ordinary teammate still sees and closes only its own work.
      const asRio = await mintedToken(rio.id, rio.threadId);
      const rioRows = (await api("GET", "/api/internal/threads", undefined, asRio)).body.threads as any[];
      expect(rioRows.map((row) => row.threadId)).not.toContain(child.threadId);
      expect((await close(child.threadId, asRio)).status).toBe(403);

      const asChief = await heldTurn(chief, "Tidy the team's finished threads.");
      const rows = (await api("GET", "/api/internal/threads", undefined, asChief)).body.threads as any[];
      expect(rows.find((row) => row.threadId === child.threadId))
        .toMatchObject({ botName: "Quinn", openedBy: "Parker", own: false, state: "idle" });
      expect(rows.map((row) => row.threadId)).not.toContain(theirs);
      expect((await proxyCall(chief.threadId, "list_threads", {})).content[0].text)
        .toContain("on @Quinn, opened by @Parker, idle");

      expect((await close(theirs, asChief)).status).toBe(403);
      const closed = await close(child.threadId, asChief);
      expect(closed.status, JSON.stringify(closed.body)).toBe(200);
      expect((await taskOf(qa.id, child.threadId)).closedBy).toMatchObject({ botId: chief.id, name: "Charlie" });
      expect((await taskOf(qa.id, theirs)).closedBy).toBeUndefined();
    } finally {
      release(chief.threadId);
      release(pm.threadId);
      await cleanup([chief.id, pm.id, qa.id, rio.id]);
    }
  }, 60_000);

  it("closes your own thread, auto-closes completed peer work, and refuses other or running threads", async () => {
    const pm = await createBot("Parker");
    const qa = await createBot("Quinn");
    try {
      let token = await heldTurn(pm, "Ask QA to check this, then close its completed task.");
      const close = (threadId: string, headers = token) => api("POST", `/api/internal/threads/${threadId}/close`, {}, headers);
      const theirs = (await api("POST", `/api/bots/${qa.id}/tasks`, { title: "Quinn's own audit" })).body.task.threadId as string;
      expect((await close(theirs)).status).toBe(403);
      const child = await coordinated(token, qa.id, "QA: PR #78");
      const opened = { body: child };
      expect((await close(child.threadId)).status).toBe(409);
      release(child.threadId);
      release(pm.threadId);
      await expect.poll(() => handoffs().find(node => node.id === child.id)?.status, { timeout: 15_000 }).toBe("completed");
      await expect.poll(async () => (await taskOf(qa.id, child.threadId)).closedBy, { timeout: 15_000 })
        .toMatchObject({ botId: pm.id, name: "Parker" });
      token = await heldTurn(pm, "Close the completed QA task.");
      const closed = await close(opened.body.threadId);
      expect(closed.status).toBe(200);
      expect(closed.body).toMatchObject({ closed: true, alreadyClosed: true, title: "@Parker · work", botName: "Quinn" });
      expect((await taskOf(qa.id, opened.body.threadId)).closedBy).toMatchObject({ botId: pm.id, name: "Parker" });
      const listed = (await api("GET", "/api/internal/threads", undefined, token)).body.threads as any[];
      expect(listed.find((row) => row.threadId === opened.body.threadId)).toMatchObject({ state: "closed" });
      expect((await close(opened.body.threadId)).body).toMatchObject({ closed: true, alreadyClosed: true });
      expect((await messages(opened.body.threadId)).filter((message) => message.tool?.name === "Closed by @Parker")).toHaveLength(0);
      const own = (await api("POST", `/api/bots/${pm.id}/tasks`, { title: "Notes" })).body.task.threadId as string;
      expect((await close(own)).status).toBe(200);
      expect((await taskOf(pm.id, own)).closedBy).toMatchObject({ name: "Parker" });
      expect((await close(pm.threadId)).status).toBe(400);
      rmSync(join(gates, `${own}.gate`), { force: true });
      expect((await api("POST", `/api/bots/${pm.id}/messages`, { text: "One more thing.", threadId: own })).status).toBe(202);
      await expect.poll(async () => (await taskOf(pm.id, own))?.busy, { timeout: 15_000 }).toBe(true);
      expect(await taskOf(pm.id, own)).not.toHaveProperty("closedBy");
      release(own);
      const asQuinn = await mintedToken(qa.id, qa.threadId);
      expect((await close(qa.threadId, asQuinn)).status).toBe(400);
      const busyOther = (await api("POST", `/api/bots/${qa.id}/tasks`, { title: "Busy one" })).body.task.threadId as string;
      rmSync(join(gates, `${busyOther}.gate`), { force: true });
      expect((await api("POST", `/api/bots/${qa.id}/messages`, { text: "Work here.", threadId: busyOther })).status).toBe(202);
      await expect.poll(async () => (await taskOf(qa.id, busyOther))?.busy, { timeout: 15_000 }).toBe(true);
      expect((await close(busyOther, asQuinn)).status).toBe(409);
      release(busyOther);
    } finally {
      await cleanup([pm.id, qa.id]);
    }
  });
});
