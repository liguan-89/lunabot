// The container boundary is the group-local-vm fixture; the custom provider saved in config.json is pi's own, listed as
// dex/<model>. pi mounts the Local VM through its MCP extension, so the assertions read the launch's mcpConfig (which
// server the turn mounted, and that it is the container's) rather than a chat provider's tool list.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileAtomic } from "./atomic.ts";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { piTurns, type PiMcpConfig } from "./testing/pi-dump.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let child: ChildProcess;
let fixtureHome = "";
let base = "";
let stateFile = "";
let dumpFile = "";
let stderr = "";
let fakebin = "";
let upstream: Server;

const FAKE_PODMAN = `#!/usr/bin/env node
'use strict';
const readline = require('node:readline');
const { existsSync } = require('node:fs');
const TOOLS = [
  { name: 'screenshot', description: 'Capture the VM screen', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'click', description: 'Click at a point', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false } },
  { name: 'type_text', description: 'Type text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
  { name: 'open_url', description: 'Open a URL in the VM browser', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } },
];
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-vm', version: '1' } };
  else if (request.method === 'tools/list') result = { tools: existsSync(__dirname + '/empty-tools') ? [] : TOOLS };
  else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: 'fake vm ran ' + String(request.params?.name) }] };
  else result = { content: [{ type: 'text', text: 'unsupported call' }], isError: true };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
rl.on('close', () => process.exit(0));
`;

const vmState = (state: Record<string, unknown> = {}) => writeFileAtomic(stateFile, JSON.stringify(state));
const api = async (method: string, path: string, body?: unknown, expectedStatus?: number) => {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", origin: base },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await r.json() as any;
  if (expectedStatus !== undefined) expect(r.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(expectedStatus);
  else expect(r.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
  return result;
};
async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}\n${stderr}`);
    await new Promise(r => setTimeout(r, 50));
  }
}
/** The launch of the latest pi turn: what the turn mounted. */
const mounted = (): PiMcpConfig | null => piTurns(dumpFile).at(-1)?.launch?.mcpConfig ?? null;
const computerServer = () => mounted()?.mcpServers?.computer;
/** The env an `agents` mount's own process gets: a gate keeps its upstream in OMB_GATE_UPSTREAM instead. */
const agentsEnv = (agents: { env?: Record<string, string> } | undefined): Record<string, string> => {
  const env = agents?.env ?? {};
  if (env.OMB_BOT_ID || env.OMB_COMMS_TOKEN) return env;
  try { return (JSON.parse(env.OMB_GATE_UPSTREAM ?? "") as { env?: Record<string, string> }).env ?? {}; } catch { return {}; }
};
const idle = (botId: string) => until(() => api("GET", "/api/bots?messages=0"), s => !s.bots.find((b: any) => b.id === botId)?.busy);

beforeAll(async () => {
  fixtureHome = mkdtempSync(join(tmpdir(), "omb-openai-vm-"));
  stateFile = join(fixtureHome, "vm.json");
  dumpFile = join(fixtureHome, "fake-pi-dump.jsonl");
  vmState({ containers: [] });
  fakebin = join(fixtureHome, "fakebin");
  mkdirSync(fakebin);
  writeFileSync(join(fakebin, "podman"), FAKE_PODMAN, { mode: 0o700 });
  chmodSync(join(fakebin, "podman"), 0o700);

  // A loopback custom provider: pi's models.json points at it, so the model the bot picks is dex/fixture-model.
  upstream = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
    if (req.method === "GET") { res.statusCode = 404; return res.end(); }
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Done." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;

  const data = join(fixtureHome, "data");
  const ui = join(fixtureHome, "static");
  mkdirSync(data);
  mkdirSync(join(ui, "assets"), { recursive: true });
  writeFileSync(join(ui, "index.html"), "<title>openai-compat VM tools</title>");
  writeFileSync(join(ui, "assets", "test.css"), "body{}");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    // Per-bot isolation: a fresh bot's VM is unseen until touched, so the strict pin cannot hide behind a warm cache entry.
    localVm: { mode: "per-bot" },
    instances: { pi: {
      driver: "piAgent",
      config: { cli: join(ROOT, "server/testing/fake-pi-cli.ts") },
      environment: {
        FAKE_PI_DUMP: dumpFile,
        // The browser turn the recipe selects on stays open a few seconds, so its own capability is still live when the
        // recipe asks to move the computer; the continuation starts once it settles.
        FAKE_PI_DELAY_ON: "Open a browser on my Local VM.", FAKE_PI_DELAY_MS: "6000",
      },
    } },
  }));

  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [
    "--experimental-strip-types",
    "--import", pathToFileURL(join(ROOT, "server/testing/group-local-vm-hooks.mjs")).href,
    join(ROOT, "server/index.ts"),
  ], {
    cwd: ROOT,
    env: {
      PATH: [fakebin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
      HOME: fixtureHome, USERPROFILE: fixtureHome, OMB_DATA_DIR: data,
      OMB_AGENTS_TOOL_BRIDGE: "0",
      APPDATA: join(fixtureHome, "appdata"), LOCALAPPDATA: join(fixtureHome, "localappdata"),
      TEMP: fixtureHome, TMP: fixtureHome, TMPDIR: fixtureHome,
      OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: ui,
      OMB_TEST_VM_STATE: stateFile, OMB_EXTRA_PATH: fakebin,
      OMB_USER_DATA: join(fixtureHome, "user-data"),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", () => {});
  child.stderr!.on("data", c => { stderr += c; });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(stderr);
    try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
  }, Boolean);
  await api("PATCH", "/api/config", { openaiCompat: { key: "fixture-key", url: `http://127.0.0.1:${upstreamPort}/v1`, model: "fixture-model" } });
  // Chief first makes the seeded bot its team's Chief, which answers a teammate's failed run with a Problems to look at turn
  // of its own: its launch would stand in for the turn under test. Stepped down, each launch is the test's own.
  const seeded = (await api("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.chiefOfStaff);
  await api("PATCH", `/api/bots/${seeded.id}`, { chiefOfStaff: false });
});

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  if (upstream) await new Promise<void>(resolve => upstream.close(() => resolve()));
  if (fixtureHome) await removeTempDir(fixtureHome);
});

describe("pi's Local VM tools", () => {
  // Two subtests of the retired chat-provider matrix are gone with that provider: "fails the turn when the Local VM lists
  // no tools" (pi's MCP extension skips a server that lists nothing and the turn carries on, so there is no failure row to
  // read) and "mounts the Local VM for a claudeAgent control" (that engine no longer exists).
  it("mounts the Local VM tools on a strict Works on: Local VM turn", async () => {
    vmState({ containers: [] });
    rmSync(dumpFile, { force: true });
    const { bot } = await api("POST", "/api/bots", { name: "strict vm" });
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "vm" });
    await api("POST", `/api/bots/${bot.id}/messages`, { text: "Take a screenshot of the desktop." });
    const computer = await until(() => computerServer(), Boolean);
    await idle(bot.id);
    expect(computer?.args?.some((arg: string) => arg.includes("container-mcp"))).toBe(true);
    expect(String(computer?.env?.OMB_CONTROL_URL ?? "")).toContain("127.0.0.1");
  }, 60_000);

  it("mounts the Local VM on the select_computer continuation", async () => {
    vmState({ containers: [] });
    rmSync(dumpFile, { force: true });
    const { bot } = await api("POST", "/api/bots", { name: "select vm" });
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "browser", browser: false });
    await api("POST", `/api/bots/${bot.id}/messages`, { text: "Open a browser on my Local VM." });
    const before = await until(() => piTurns(dumpFile).at(-1)?.launch?.mcpConfig ?? null, Boolean);
    if (!before) throw new Error("no launch recorded in the pi dump");
    expect(before.mcpServers?.computer, "a browser turn mounts no Local VM").toBeUndefined();
    const token = agentsEnv(before.mcpServers?.agents).OMB_COMMS_TOKEN as string;
    const select = (body: Record<string, unknown>) => fetch(base + "/api/internal/computer/select", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(await (await select({ surface: "vm" })).json()).toMatchObject({ status: "pending", surface: "vm" });
    rmSync(dumpFile, { force: true });
    const continued = await until(() => computerServer(), Boolean);
    await idle(bot.id);
    expect(continued?.args?.some((arg: string) => arg.includes("container-mcp"))).toBe(true);
    // The continuation may not pick again: it keeps the agents tools its request had, without a select tool of its own.
    const shown = (await api("GET", "/api/bots")).bots.find((item: any) => item.id === bot.id).messages;
    expect(shown.filter((message: any) => message.card)).toEqual([]);
    expect((await api("GET", "/api/bots?messages=0")).bots.find((item: any) => item.id === bot.id).tasks[0].surface).toBe("vm");
  }, 60_000);
});
