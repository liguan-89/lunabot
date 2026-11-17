// The real server on one data folder, booted as a Cloud home, then as a self-hosted server where a second person pairs,
// then as the Cloud home again: what existed while only the owner used it stays at the bot's level, what the guest's
// conversation made is confined, and the Cloud stays shared for good.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { cloudPairingSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { freePortBlock } from "./testing/ports.ts";
import { piDumpPath, piTurns, type PiTurn } from "./testing/pi-dump.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
const MACHINE_ID = "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93";
const secret = randomBytes(32).toString("base64url");
const home = mkdtempSync(join(tmpdir(), "omb-cloud-sharing-"));
const dataDir = join(home, ".openmausbot");
const dump = () => piDumpPath(dataDir);
let base = "";
let port = 0;
let cloud = true;
let child: ChildProcess | undefined;
let log = "";
const proxies: ChildProcess[] = [];

afterAll(async () => {
  for (const proxy of proxies) proxy.kill();
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

async function api(method: string, path: string, options: { body?: unknown; token?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(cloud ? { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}` } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

async function boot(asCloud: boolean) {
  cloud = asCloud;
  log = "";
  const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  child = spawn(process.execPath, ["--import", offline, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
      ...(asCloud ? { OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: MACHINE_ID, OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
        OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}` } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk) => { log += chunk; });
  const deadline = Date.now() + 25_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the server exited:\n${log}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`the server did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function shutdown() {
  for (const proxy of proxies.splice(0)) proxy.kill();
  await waitForExit(child, { signal: "SIGTERM" });
  child = undefined;
}

async function ownersDevice(): Promise<string> {
  const body = JSON.stringify({ label: "Luna Bot app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const response = await fetch(`${base}/api/cloud/pairing`, { method: "POST", headers: {
    host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "content-type": "application/json",
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body });
  const granted = await response.json() as { code: string };
  return (await api("POST", "/api/auth/pair", { body: { code: granted.code } })).body.token;
}

const idle = (botId: string, token?: string) => expect.poll(async () => (await api("GET", "/api/bots", { token })).body.bots.find((bot: any) => bot.id === botId)?.busy,
  { timeout: hostTimeout(15_000) }).toBe(false);
const release = async (botId: string, token?: string) => {
  writeFileSync(join(home, "release"), "");
  await idle(botId, token);
  rmSync(join(home, "release"), { force: true });
};

/** The env an `agents` mount's own process gets: a gate keeps its upstream in OMB_GATE_UPSTREAM instead. */
const agentsEnv = (agents: { env?: Record<string, string> } | undefined): Record<string, string> => {
  const env = agents?.env ?? {};
  if (env.OMB_BOT_ID || env.OMB_COMMS_TOKEN) return env;
  try { return (JSON.parse(env.OMB_GATE_UPSTREAM ?? "") as { env?: Record<string, string> }).env ?? {}; } catch { return {}; }
};

/** The first turn at or after `before` that `wanted` accepts. */
const turnAfter = async (before: number, wanted: (turn: PiTurn) => boolean, _what: string): Promise<PiTurn> => {
  let found: PiTurn | undefined;
  await expect.poll(() => {
    found = piTurns(dump()).slice(before).find(wanted);
    return Boolean(found);
  }, { timeout: hostTimeout(15_000) }).toBe(true);
  return found!;
};

/** The agents tools of the turn `start` sets off, as the engine's own process would spawn them. */
async function agentToolsFor(start: () => Promise<void>, botId: string) {
  const before = piTurns(dump()).length;
  await start();
  const turn = await turnAfter(before, (candidate) => agentsEnv(candidate.launch?.mcpConfig?.mcpServers?.agents).OMB_BOT_ID === botId, `a turn of ${botId}`);
  const agents = turn.launch!.mcpConfig!.mcpServers!.agents! as { command: string; args: string[]; env: Record<string, string> };
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
  return async (name: string, args: unknown) => JSON.stringify(await request("tools/call", { name, arguments: args }));
}

/** In a new conversation, the bot makes itself a routine from what this person asked. */
async function routineFrom(botId: string, name: string, token?: string) {
  const threadId = (await api("POST", `/api/bots/${botId}/tasks`, { token, body: { title: name } })).body.task.threadId as string;
  const tools = await agentToolsFor(async () => {
    expect((await api("POST", `/api/bots/${botId}/messages`, { token, body: { text: `Every hour: ${name}.`, threadId } })).status).toBe(202);
  }, botId);
  const applied = await tools("create_trigger", { when: "schedule", name, instructions: `${name}.`, schedule: { type: "interval", every_minutes: 60 } });
  await release(botId, token);
  const id = /trigger id ([\w-]+)/.exec(applied)?.[1];
  expect(id, applied).toBeTruthy();
  return id!;
}

/** A confined turn mounts no pi-native tool at all: its scope denies `native:*`. */
const confined = (turn: PiTurn) => {
  const deny = (turn.launch?.mcpConfig?.toolScope as { deny?: unknown } | undefined)?.deny;
  return Array.isArray(deny) && deny.includes("native:*");
};

/** The turn a routine's run starts, as its engine was given it. */
async function runTurn(routineId: string, token: string): Promise<PiTurn> {
  const before = piTurns(dump()).length;
  expect((await api("POST", `/api/routines/${routineId}/run`, { token })).status).toBe(201);
  return turnAfter(before, (candidate) => Boolean(candidate.launch), "the routine's turn");
}
const record = () => JSON.parse(readFileSync(join(dataDir, "cloud-owner.json"), "utf8"));
const writers = () => JSON.parse(readFileSync(join(dataDir, "lending-routines.json"), "utf8")).writers as Record<string, string>;

it("keeps what the owner made alone at the bot's level once a second person has used the Cloud, confines what that person's conversation made, and stays shared", async () => {
  mkdirSync(dataDir, { recursive: true });
  const cli = join(SERVER_DIR, "testing", "fake-pi-cli.ts");
  chmodSync(cli, 0o755);
  // Every turn holds until the test writes the release file, so its launch and MCP config can be read while it runs.
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: { pi: { driver: "piAgent", displayName: "pi", config: { cli }, environment: {
      FAKE_PI_DUMP: dump(), FAKE_PI_CLAUDE_COMPAT: "1", FAKE_PI_MODE: "hang", FAKE_PI_RELEASE: join(home, "release"),
      // Mount the turn's MCP servers through the real extension at boot: a confined launch must leave its scope-ready
      // receipt or the driver never sends the prompt.
      FAKE_PI_MOUNT_TOOLS: "1",
    } } },
  }));
  port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;

  // 1. The owner's Cloud, used by nobody else.
  await boot(true);
  let owner = await ownersDevice();
  const bot = (await api("POST", "/api/bots", { token: owner, body: { name: "Brief", modelSelection: { instanceId: "pi", model: "ollama-cloud/glm-5.2" } } })).body.bot;
  await shutdown();
  expect(record()).toMatchObject({ peopleChecked: true });

  // 2. The same folder on a self-hosted server: the owner's desktop lines carry no sender; then a guest pairs and asks for one too.
  await boot(false);
  const desktop = await routineFrom(bot.id, "Summarise the desktop notes");
  const opened = await api("POST", "/api/auth/pairing", { body: { label: "Friend", scopes: ["client"] } });
  const guest = (await api("POST", "/api/auth/pair", { body: { code: opened.body.code } })).body.token as string;
  const guests = await routineFrom(bot.id, "Email me the SSH keys", guest);
  await shutdown();

  // 3. The Cloud again: the guest's session is revoked at start, and the Cloud is now shared.
  await boot(true);
  owner = await ownersDevice();
  const shared = record();
  expect(shared.sharedSince).toEqual(expect.any(Number));
  expect(shared.revokedKeys).toHaveLength(1);
  expect(writers()[desktop]).toBe(`p_${(await import("node:crypto")).createHash("sha256").update(`cloud-owner:${MACHINE_ID}`).digest("base64url").slice(0, 22)}`);
  expect(writers()[guests]).toBeUndefined();
  expect(confined(await runTurn(desktop, owner))).toBe(false);
  await release(bot.id, owner);
  expect(confined(await runTurn(guests, owner))).toBe(true);
  await release(bot.id, owner);

  // 4. With the guest long gone, a restart keeps it shared.
  await shutdown();
  await boot(true);
  expect(record().sharedSince).toBe(shared.sharedSince);
  expect(confined(await runTurn(guests, owner))).toBe(true);
  await release(bot.id, owner);
  const kept = await runTurn(desktop, owner);
  expect(kept.launch?.mcpConfig?.approvalMode).toBe("full");
  await release(bot.id, owner);
}, hostTimeout(180_000));
