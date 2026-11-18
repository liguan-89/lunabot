// A turn its engine's usage limit refused, end to end against the real server. This build runs one agent (pi) and no
// other AI can be set up, so the switch-to-another-AI behaviour has nothing to switch to: the refused turn is reported
// once with the provider's own words, the message is never resent, no offer card appears, and the conversation stays on
// pi. OMB_QUOTA_SWITCH=0 reads the same, because there was never a backup to fall back to.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runControlOmb, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

/** A provider's usage-limit refusal, as pi reports it from the model call that failed. */
const LIMIT_TEXT = "429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"You have reached your 5-hour usage limit. Try again at 7:22 PM.\"}} retry-after-ms=18000000";

/** The smallest pi RPC child that answers setup and refuses its one prompt with the engine's own limit words. */
const LIMIT_CLI = `#!/usr/bin/env node
import { createInterface } from "node:readline";
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write("pi 0.84.2 (fake)\\n");
  process.exit(0);
}
let session = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  let cmd;
  try { cmd = JSON.parse(line); } catch { return; }
  const reply = (command, data) => out({ id: cmd.id, type: "response", command, success: true, data });
  if (cmd.type === "generate_models" || cmd.type === "get_available_models") {
    return reply("get_available_models", { models: [{ provider: "ollama-cloud", id: "glm-5.2", name: "glm-5.2" }] });
  }
  if (cmd.type === "new_session") return reply("new_session", { sessionId: "s-" + (++session), sessionFile: "/fake/limit-session.json" });
  if (cmd.type === "switch_session") return reply("switch_session", { sessionId: "s-" + session, sessionFile: cmd.sessionPath ?? "/fake/limit-session.json" });
  if (cmd.type === "set_model") return reply("set_model", { id: cmd.modelId, provider: cmd.provider });
  if (cmd.type === "set_thinking_level") return reply("set_thinking_level", undefined);
  if (cmd.type === "get_state") return reply("get_state", { model: null, thinkingLevel: "off", isStreaming: false, isCompacting: false, sessionFile: "/fake/limit-session.json" });
  if (cmd.type !== "prompt") return;
  out({ type: "agent_start" });
  out({ type: "turn_start" });
  out({ type: "turn_end", message: { stopReason: "error", errorMessage: ${JSON.stringify(LIMIT_TEXT)} }, usage: { input: 0, output: 0 } });
  out({ type: "agent_end", isTerminal: true });
});
`;

async function withLimitFixture(
  options: { env?: Record<string, string> },
  check: (fixture: {
    api: (method: string, path: string, body?: unknown) => Promise<any>;
    control: (...args: string[]) => Promise<any>;
    respond: (threadId: string, body: unknown) => Promise<{ status: number; body: any }>;
    dataDir: string;
  }) => Promise<void>,
) {
  const port = await freePortBlock([0, 1]);
  const url = `http://127.0.0.1:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), "openmausbot-quota-switch-"));
  mkdirSync(join(dataDir, "tmp"), { recursive: true });
  const evidenceDir = join(tmpdir(), "openmausbot-verification-evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const logPath = join(evidenceDir, `quota-switch-${Date.now()}-${process.pid}.log`);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: { pi: { driver: "piAgent", displayName: "Limited pi", config: { cli: fileURLToPath(new URL("./testing/fake-pi-cli.ts", import.meta.url)) } } },
  }));
  const evidence: unknown[] = [{ url, options }];
  let server: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const control = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  /** A card answer as a client posts it, with the status it got. */
  const respond = async (threadId: string, body: unknown) => {
    const response = await fetch(`${url}/api/threads/${threadId}/respond`, {
      method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    const answer = { status: response.status, body: await response.json() };
    evidence.push({ respond: body, answer });
    return answer;
  };
  try {
    const env = { ...verificationServerEnvironment({}, dataDir, port), ...options.env };
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, verificationServerArgs(env), {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 90_000 }).toBe(true);
    await check({ api, control, respond, dataDir });
  } finally {
    evidence.push({ log: existsSync(logPath) ? readFileSync(logPath, "utf8").slice(-20_000) : null });
    const evidencePath = `${logPath}.quota-switch.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    await waitForExit(server, { signal: "SIGTERM" });
    await removeTempDir(dataDir);
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}

/** A bot whose conversation meets the engine's usage limit on the next turn. */
async function meetTheLimit(api: (method: string, path: string, body?: unknown) => Promise<any>, control: (...args: string[]) => Promise<any>, text: string, dataDir: string) {
  const { bot } = await control("new-bot", "--name", "Out of quota");
  const threadId = bot.activeTaskId as string;
  // The greeting ran on the ordinary fake; the limit CLI takes over from the person's next turn, as a real account's
  // limit would between two turns.
  expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
  const limitCli = join(dataDir, "limit-cli.mjs");
  writeFileSync(limitCli, LIMIT_CLI, { mode: 0o700 });
  await api("PATCH", "/api/instances/pi", { cli: limitCli });
  await control("send", "--bot", bot.id, "--task", threadId, "--text", text);
  expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("failed");
  const messages = async () => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  const state = async () => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
  return { bot, threadId, messages, state };
}

it("reports a usage-limit refusal once with the provider's words, resends nothing, and keeps the conversation on pi", async () => {
  await withLimitFixture({}, async ({ api, control, dataDir }) => {
    const text = "SUMMARISE_THE_QUARTER_4K";
    const { bot, threadId, messages, state } = await meetTheLimit(api, control, text, dataDir);
    const { task: sibling } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Sibling keeps its engine" });

    const after = await messages();
    const failures = after.filter((message) => message.tool?.name?.startsWith("error:"));
    expect(failures).toHaveLength(1);
    expect(failures[0].tool.name).toContain("You have reached your 5-hour usage limit");
    // There is no other AI to carry the request to: nothing is offered, and the person's message is sent once.
    expect(after.some((message) => message.card?.quotaSwitch), "nothing to answer").toBe(false);
    expect(after.filter((message) => message.role === "user" && message.text === text)).toHaveLength(1);

    // The conversation never moves: pi is the only engine, and the bot's own engine and other conversation stay put.
    const bots = await state();
    expect(bots.tasks.find((task: any) => task.threadId === threadId)).toMatchObject({ modelSelection: { instanceId: "pi" }, busy: false });
    expect(bots.modelSelection.instanceId).toBe("pi");
    expect(bots.tasks.find((task: any) => task.threadId === sibling.threadId).modelSelection?.instanceId ?? bots.modelSelection.instanceId).toBe("pi");
    // One notice for this bot, saying plainly that it waits because nothing else can take over.
    const notices = (await api("GET", "/api/notifications")).notifications.filter((entry: any) => entry.kind === "notice" && entry.botId === bot.id);
    expect(notices.map((entry: any) => entry.body)).toEqual([expect.stringMatching(/^Limited pi reached its limit.*, so Out of quota waits.*: no other AI you have set up can take over\.$/)]);
  });
}, 240_000);

it("reads the same with OMB_QUOTA_SWITCH=0: one notice, nothing resent, nothing moved", async () => {
  await withLimitFixture({ env: { OMB_QUOTA_SWITCH: "0" } }, async ({ api, control, dataDir }) => {
    const text = "NO_MOVE_WHEN_OFF_2B";
    const { bot, threadId, messages, state } = await meetTheLimit(api, control, text, dataDir);
    const mine = async () => (await api("GET", "/api/notifications")).notifications.filter((entry: any) => entry.kind === "notice" && entry.botId === bot.id);
    await expect.poll(async () => (await mine()).length, { timeout: 20_000 }).toBe(1);
    expect((await mine())[0].body).toMatch(/, so Out of quota waits.*: no other AI you have set up can take over\.$/);
    expect((await messages()).filter((message) => message.role === "user")).toHaveLength(1);
    expect((await state()).tasks.find((task: any) => task.threadId === threadId).modelSelection?.instanceId ?? "pi").toBe("pi");
  });
}, 240_000);
