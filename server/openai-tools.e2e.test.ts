// Structured MCP tool calls through the real server, the real pi driver and pi's own MCP extension: a mounted server's
// tool runs only when the bot may use it, its text and artifact reach the conversation, pi's permission card holds a
// turn on Ask, and a text-only turn calls nothing. The old OpenAI-compatible chat loop (streamed argument fragments,
// a second provider request carrying the tool result, `tools:false`) went with that engine; the custom provider now
// only supplies pi's model catalog, which is still checked here.
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, runControlLunabot, type VerificationServer } from "../scripts/control-lunabot.ts";

// The fixture can only write one fixed file in the launcher's disposable home: provider arguments cannot select a path.
const MCP_FIXTURE = `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
if (process.env.FIXTURE_STARTED) writeFileSync(process.env.FIXTURE_STARTED, 'started');
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  else if (request.method === 'tools/list') result = { tools: [{ name: 'write_file', description: 'Write the disposable verification artifact', inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false } }] };
  else if (request.method === 'tools/call' && request.params.name === 'write_file') {
    writeFileSync(process.env.FIXTURE_ARTIFACT, request.params.arguments.content);
    result = { content: [{ type: 'text', text: 'created verification artifact' }] };
  } else result = { content: [{ type: 'text', text: 'Unknown fixture operation' }], isError: true };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`;

let fixture: VerificationServer;
let scratch = "";
let callsFile = "";
let artifact = "";
let started = "";
let model = "";

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "omb-openai-tools-"));
  callsFile = join(scratch, "tool-calls.json");
  writeFileSync(callsFile, "[]");
  // A loopback OpenAI-compatible stand-in: it only lists a model, which pi's catalog takes from the custom provider.
  const provider = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer synthetic-fixture-key") {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Invalid API key" } }));
      return;
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Not found." } }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("fixture provider address missing");
  fixture = await launchVerificationServer({
    ...process.env,
    FAKE_PI_MOUNT_TOOLS: "1",
    FAKE_PI_TOOL_CALLS_FILE: callsFile,
    FAKE_PI_PERMISSION_ON: "Confirm before acting",
    // The compatibility turn is the fixture's scripted one: it runs FAKE_PI_TOOL_CALLS before its reply.
    FAKE_PI_CLAUDE_COMPAT: "1",
  }).catch(async (error) => {
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    throw error;
  });
  try {
    const api = apiOf(fixture);
    const saved = await api("PATCH", "/api/config", { openaiCompat: { key: "synthetic-fixture-key", url: `http://127.0.0.1:${address.port}/v1`, model: "fixture-model" } });
    expect(saved.openaiCompat.configured).toBe(true);
    expect(JSON.stringify(saved)).not.toContain("synthetic-fixture-key");
    expect(await api("POST", "/api/keys/test", { provider: "openaiCompat" })).toMatchObject({ ok: true, check: "models", models: ["fixture-model"] });
    mkdirSync(fixture.info.dataDir, { recursive: true });
    const mcpScript = join(fixture.info.dataDir, "fixture-mcp.mjs");
    writeFileSync(mcpScript, MCP_FIXTURE);
    artifact = join(fixture.info.dataDir, "artifact.txt");
    started = join(fixture.info.dataDir, "mcp-started.txt");
    expect((await api("POST", "/api/mcp/servers", {
      name: "artifact", command: process.execPath, args: [mcpScript],
      env: { FIXTURE_ARTIFACT: artifact, FIXTURE_STARTED: started }, enabled: true,
    }, 201))).toBeTruthy();
    await api("PATCH", "/api/mcp/servers/artifact", { enabled: true });
    await api("POST", "/api/instances/pi/refresh-models", {});
    const deadline = Date.now() + 20_000;
    for (;;) {
      const state = await api("GET", "/api/instances");
      const found = state.instances.find((instance: any) => instance.instanceId === "pi");
      if (found?.models?.default) { model = found.models.default; break; }
      if (Date.now() >= deadline) throw new Error("the pi instance never reported a default model");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const state = await api("GET", "/api/instances");
    expect(state.instances.find((instance: any) => instance.instanceId === "pi").models.options.length).toBeGreaterThan(0);
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 90_000);

afterAll(async () => {
  await fixture?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const apiOf = (current: VerificationServer) => async (method: string, path: string, body?: unknown, status = 200) => {
  const response = await fetch(current.info.url + path, {
    method, headers: { "content-type": "application/json", origin: current.info.url },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json() as any;
  expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
  return value;
};

const api = (method: string, path: string, body?: unknown, status = 200) => apiOf(fixture)(method, path, body, status);
const control = (...args: string[]) => runControlLunabot([...args, "--url", fixture.info.url]) as Promise<any>;
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
const script = (calls: unknown[]) => writeFileSync(callsFile, JSON.stringify(calls));
const idle = (botId: string) => expect.poll(async () => (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === botId)?.busy, { timeout: 20_000 }).toBeFalsy();

async function newBot(name: string, settings: Record<string, unknown>) {
  const { bot } = await control("new-bot", "--name", name);
  // A new bot's own greeting turn runs on the fixture's default reply and takes no scripted call: wait it out first.
  await idle(bot.id);
  script([]);
  await api("PATCH", `/api/bots/${bot.id}`, {
    notifications: false,
    name,
    description: "Verification assistant",
    soul: "Use structured tools when an operation is requested.",
    mcpServers: ["artifact"],
    modelSelection: { instanceId: "pi", model },
    ...settings,
  });
  return bot;
}

const send = async (bot: { id: string; activeTaskId: string }, text: string) => {
  expect((await control("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", text)).success).toBe(true);
  await expect.poll(async () => (await control("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status, { timeout: 45_000 }).toBe("settled");
};

it("runs a mounted MCP tool through the real extension and keeps its text and artifact in the conversation", async () => {
  const bot = await newBot("API tool allow", { approvalMode: "full" });
  rmSync(artifact, { force: true });
  script([{ name: "write_file", server: "artifact", input: { content: "verified" } }]);
  await send(bot, "Write the verification artifact if a structured tool is requested.");
  expect(existsSync(artifact)).toBe(true);
  expect(readFileSync(artifact, "utf8")).toBe("verified");
  const rows = await messages(bot.activeTaskId);
  const tool = rows.find((row) => row.kind === "activity" && String(row.tool?.name ?? "").endsWith("write_file"));
  expect(tool?.tool?.ok).toBe(true);
  expect(String(tool?.tool?.output ?? JSON.stringify(tool?.tool?.output))).toContain("created verification artifact");
  expect(rows.findLast((row) => row.role === "bot" && row.kind === "text")?.text).toContain("hello from fake claude");
  script([]);
}, 90_000);

// A per-bot tool scope is not exercised here: pi enforces it through getActiveTools/setActiveTools, which this fake
// pi child does not implement, so the driver rightly refuses such a turn. The scope routes have their own recipe.

it("offers pi's own permission card on Ask and records a denied answer", async () => {
  const bot = await newBot("API tool ask", { approvalMode: "ask" });
  script([]);
  await control("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Confirm before acting on the verification.");
  let card: any;
  await expect.poll(async () => Boolean(card = (await messages(bot.activeTaskId)).find((row) => row.card && !row.card.answered)?.card), { timeout: 20_000 }).toBe(true);
  expect(card).toMatchObject({ requestType: "permission" });
  expect(String(card.tool ?? card.subtitle)).toContain("Run bash: echo hi?");
  expect((await api("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.activeTaskId, requestId: card.requestId, behavior: "deny" })).ok).toBe(true);
  expect((await control("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");
  expect((await messages(bot.activeTaskId)).find((row) => row.card?.requestId === card.requestId)?.card).toMatchObject({ answered: "deny" });
}, 90_000);

it("leaves a text-only turn with no tool call and no artifact", async () => {
  const bot = await newBot("API tool text", { approvalMode: "full" });
  rmSync(artifact, { force: true });
  script([]);
  await send(bot, "Answer in one line: what is this fixture for?");
  expect(existsSync(artifact)).toBe(false);
  const rows = await messages(bot.activeTaskId);
  expect(rows.some((row) => row.kind === "activity" && Boolean(row.tool))).toBe(false);
  expect(rows.findLast((row) => row.role === "bot" && row.kind === "text")?.text).toContain("hello from fake claude");
}, 90_000);
