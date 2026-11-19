// The real Cloud home server with the fake pi and a synthetic lent PC (Windows, apps and screen and Chrome lent,
// no terminal). A conversation on Auto that an earlier turn pinned to the cloud computer: its turn is told the PC is
// reached through shared_computer, never that everything on screen happens on the cloud computer, and the PC's apps and
// screen answer it. A conversation the lending rules refuse is told why by list_shared_computers, never the PC's tools.
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { spawnWithSecrets } from "./cloud-home-start.ts";
import { cloudPairingSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { markLeftBehind } from "./testing/cloud-left-behind.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { freePortBlock } from "./testing/ports.ts";
import { piDumpPath, piInstructionsAt, piTurns, piTurnText, type PiMcpConfig } from "./testing/pi-dump.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
const secret = randomBytes(32).toString("base64url");
const PC = { id: randomUUID(), secret: randomBytes(32).toString("hex") };
let home = "";
let dataDir = "";
let base = "";
let child: ChildProcess;
let log = "";
let owner = "";
let boot: () => Promise<void> = async () => {};
let lending = true;
const proxies: ChildProcess[] = [];
const answered: string[] = [];

async function api(method: string, path: string, options: { body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}`,
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

async function adminPairing(): Promise<string> {
  const body = JSON.stringify({ label: "Luna Bot app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const response = await fetch(`${base}/api/cloud/pairing`, { method: "POST", headers: {
    host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "content-type": "application/json",
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body });
  const granted = await response.json() as { code: string };
  return (await api("POST", "/api/auth/pair", { body: { code: granted.code } })).body.token;
}

/** The person's Windows PC, lending its apps and screen and its Chrome but no terminal and no folder, as the desktop app
 * registers it; it answers computer_tools with its own tool list, as cua-driver there would. */
async function lendPc(): Promise<void> {
  const environmentId = (await api("GET", "/.well-known/lunabot/environment")).body.environmentId as string;
  const headers = { "x-omb-computer-secret": PC.secret };
  const connected = await api("POST", "/api/shared-computers/connect", { token: owner, headers, body: {
    id: PC.id, name: "OFFICE-PC", environmentId, folders: [], terminal: false, computer: true, platform: "win32", chrome: true,
    commandTimeouts: true, longCommands: true, fileEdits: true,
  } });
  expect(connected.status, JSON.stringify(connected.body)).toBe(200);
  void (async () => {
    while (lending) {
      const polled = await api("POST", `/api/shared-computers/${PC.id}/poll`, { token: owner, headers, body: {} }).catch(() => null);
      const job = polled?.body?.job as { id: string; operation: { action: string } } | null | undefined;
      if (!job) { if (!polled || polled.status !== 200) await new Promise((resolve) => setTimeout(resolve, 200)); continue; }
      answered.push(job.operation.action);
      await api("POST", `/api/shared-computers/${PC.id}/result`, { token: owner, headers, body: { jobId: job.id,
        result: { ok: true, value: { tools: [{ name: "launch_app" }, { name: "click" }, { name: "type_text" }, { name: "get_window_state" }] } } } });
    }
  })();
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-cloud-lent-screen-"));
  dataDir = join(home, ".lunabot");
  mkdirSync(dataDir, { recursive: true });
  const cli = join(SERVER_DIR, "testing", "fake-pi-cli.ts");
  chmodSync(cli, 0o755);
  // Each turn holds until the test writes the release file, so its launch and prompt can be read while it runs.
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {
    pi: { driver: "piAgent", displayName: "pi", config: { cli }, environment: {
      FAKE_PI_DUMP: piDumpPath(dataDir), FAKE_PI_CLAUDE_COMPAT: "1", FAKE_PI_MODE: "hang", FAKE_PI_RELEASE: join(home, "release"),
      // Mount the turn's MCP servers through the real extension at boot: a confined launch must leave its
      // scope-ready receipt or the driver never sends the prompt.
      FAKE_PI_MOUNT_TOOLS: "1",
    } },
  } }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  boot = async () => {
    child = spawnWithSecrets(process.execPath, ["--import", offline, join(SERVER_DIR, "index.ts")], {
      PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
      // No bot box: a Cloud home boxes its turns on Linux, and the box hides the data folder this fixture's fake pi
      // writes its launch log to (server/testing/pi-dump.ts). The box has its own suites (server/bot-box/*.linux.test.ts).
      OMB_BOT_BOX: "0",
      OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
      OMB_PUBLIC_URL: `https://${HOST}`, OMB_CLOUD_BOAT_URL: "https://cloud.example.test/api/cloud/services/boat/api/box/v1",
      OMB_CLOUD_SECRETS_FD: "3",
    }, { OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_CLOUD_BOAT_TOKEN: `box_omb_${randomBytes(32).toString("base64url")}` }, undefined, true);
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk) => { log += chunk; });
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`the Cloud home exited:\n${log}`);
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
      if (Date.now() > deadline) throw new Error(`the Cloud home did not start:\n${log}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  await boot();
  owner = await adminPairing();
}, hostTimeout(40_000));

afterAll(async () => {
  lending = false;
  for (const proxy of proxies) proxy.kill();
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

const dump = () => piDumpPath(dataDir);
type Turn = { systemPrompt: string; mcpConfig: PiMcpConfig };

/** The turn `start` set off in `threadId`: the pi launch it ran on and the instructions in effect there. */
async function ownerAsks(botId: string, threadId: string, text: string): Promise<Turn> {
  const before = piTurns(dump()).length;
  const sent = await api("POST", `/api/bots/${botId}/messages`, { token: owner, body: { text, threadId } });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  let found: Turn | undefined;
  await expect.poll(() => {
    const turns = piTurns(dump());
    for (let index = before; index < turns.length; index++) {
      const turn = turns[index]!;
      if (!piTurnText(turn).includes(text)) continue;
      if (turn.launch?.mcpConfig?.mcpServers?.agents?.env?.OMB_THREAD_ID !== threadId) continue;
      const session = turns.slice(0, index + 1).filter((candidate) => candidate.launch === turn.launch);
      found = { systemPrompt: piInstructionsAt(session, session.length - 1), mcpConfig: turn.launch?.mcpConfig ?? {} };
      return true;
    }
    return false;
  }, { timeout: hostTimeout(15_000) }).toBe(true);
  return found!;
}

async function agentTools(turn: Turn) {
  const agents = turn.mcpConfig.mcpServers!.agents! as { command: string; args: string[]; env: Record<string, string> };
  const proxy = spawn(agents.command, agents.args, { env: { PATH: process.env.PATH, HOME: home, ...agents.env }, stdio: ["pipe", "pipe", "pipe"] });
  proxies.push(proxy);
  const replies = new Map<number, (value: any) => void>();
  createInterface({ input: proxy.stdout! }).on("line", (line) => { const msg = JSON.parse(line); replies.get(msg.id)?.(msg.result ?? msg); replies.delete(msg.id); });
  let next = 0;
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve) => {
    const id = ++next; replies.set(id, resolve);
    proxy.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await request("initialize", { protocolVersion: "2024-11-05" });
  return (name: string, args: unknown = {}) => request("tools/call", { name, arguments: args }) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
}

it("lets an Auto conversation pinned to the cloud computer use the person's lent PC, and says how", async () => {
  const created = (await api("POST", "/api/bots", { token: owner, body: { name: "Office", modelSelection: { instanceId: "pi", model: "ollama-cloud/glm-5.2" } } })).body.bot as { id: string; threadId: string };
  const guestThread = (await api("POST", `/api/bots/${created.id}/tasks`, { token: owner, body: { title: "Guest's" } })).body.task.threadId as string;
  // Stopped: an earlier Auto turn selected the cloud computer in this conversation (the pin a turn makes on its own), and
  // a guest opened the other one before the Cloud was personal.
  await waitForExit(child, { signal: "SIGTERM" });
  const bots = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
  const record = (bots.bots ?? bots).find((bot: any) => bot.id === created.id);
  expect(record.computer).toBeUndefined();
  const task = record.tasks.find((candidate: any) => candidate.threadId === created.threadId);
  Object.assign(task, { surface: "cloud", surfaceSource: "auto" });
  writeFileSync(join(dataDir, "bots.json"), JSON.stringify(bots), { mode: 0o600 });
  markLeftBehind(dataDir, { threadIds: [guestThread] });
  await boot();
  await lendPc();

  const turn = await ownerAsks(created.id, created.threadId, "Open Notepad on my PC.");
  const prompt = turn.systemPrompt;
  // The cloud computer is what this turn mounts, as the pin says…
  expect(prompt).toContain("This conversation is pinned to the cloud computer");
  expect(prompt).toContain("The screen tools mounted this turn work on the cloud computer, web pages included");
  // …and the person's PC is still theirs to ask for, through shared_computer.
  expect(prompt).not.toContain("Everything you do on screen happens on the cloud computer");
  expect(prompt).not.toContain("the user's own computer cannot be reached from here");
  expect(prompt).toContain("Their PC (OFFICE-PC) is reached only through shared_computer, never select_computer");
  expect(prompt).toContain("whatever this conversation is pinned to");

  const call = await agentTools(turn);
  const listed = JSON.parse((await call("list_shared_computers")).content[0]!.text);
  expect(listed.computers).toEqual([expect.objectContaining({ id: PC.id, name: "OFFICE-PC", device: "PC", computer: true, terminal: false, chrome: true })]);
  expect(listed.unavailable).toBeUndefined();
  const tools = await call("shared_computer", { computer_id: PC.id, action: "computer_tools" });
  expect(tools.isError, JSON.stringify(tools)).not.toBe(true);
  expect(tools.content[0]!.text).toContain("launch_app");
  expect(answered).toEqual(["computer_tools"]);
  writeFileSync(join(home, "release"), "");
  await expect.poll(async () => (await api("GET", "/api/bots", { token: owner })).body.bots.find((bot: any) => bot.id === created.id)?.busy,
    { timeout: hostTimeout(15_000) }).toBe(false);
  rmSync(join(home, "release"), { force: true });

  // A conversation a guest left behind: the same paragraph points to list_shared_computers, which says why it can't.
  const guest = await ownerAsks(created.id, guestThread, "Open Notepad on my PC.");
  expect(guest.systemPrompt).toContain("If list_shared_computers says this conversation can't use it");
  const refused = await agentTools(guest);
  const listing = JSON.parse((await refused("list_shared_computers")).content[0]!.text);
  expect(listing.computers).toEqual([]);
  expect(listing.say).toEqual(expect.any(String));
  expect((await refused("shared_computer", { computer_id: PC.id, action: "computer_tools" })).isError).toBe(true);
  expect(answered).toEqual(["computer_tools"]);
  writeFileSync(join(home, "release"), "");
}, hostTimeout(120_000));
