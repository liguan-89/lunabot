// The real Cloud home server with the fake pi: a routine a Full access bot makes in the owner's own conversation runs at
// Full access, whatever else the bot posted there. What a webhook's run made stays confined, and what a bot asks to
// change in a conversation a guest left behind waits for the owner.
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { spawnWithSecrets } from "./cloud-home-start.ts";
import { cloudPairingSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { CLOUD_OUTSIDE_KEY } from "./cloud-sharing.ts";
import { CLOUD_NOBODY_KEY, markLeftBehind } from "./testing/cloud-left-behind.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { freePortBlock } from "./testing/ports.ts";
import { piDumpPath, piTurns, type PiMcpConfig, type PiTurn } from "./testing/pi-dump.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
const MACHINE_ID = "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93";
const OWNER_KEY = `p_${createHash("sha256").update(`cloud-owner:${MACHINE_ID}`).digest("base64url").slice(0, 22)}`;
const secret = randomBytes(32).toString("base64url");
let home = "";
let dataDir = "";
let base = "";
let child: ChildProcess;
let hooksBase = "";
let log = "";
let owner = "";
let boot: () => Promise<void> = async () => {};
let stallClock = false;
const proxies: ChildProcess[] = [];

async function api(method: string, path: string, options: { body?: unknown; token?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}`,
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
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
    "x-lunabot-cloud-timestamp": timestamp, "x-lunabot-cloud-nonce": nonce, "x-lunabot-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body });
  const granted = await response.json() as { code: string };
  return (await api("POST", "/api/auth/pair", { body: { code: granted.code } })).body.token;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-cloud-routine-level-"));
  dataDir = join(home, ".lunabot");
  mkdirSync(dataDir, { recursive: true });
  // The plan scripts the turns the owner starts (each one keeps its turn open); every other turn holds on the release
  // file, so a routine's run can be read while it runs. A routine's prompt also asks permission, so a confined run
  // waits on a real card whose `held` line says why.
  const cli = join(SERVER_DIR, "testing", "fake-pi-cli.ts");
  chmodSync(cli, 0o755);
  const planPath = join(home, "room-plan.json");
  writeFileSync(planPath, JSON.stringify({ "*": { gateFile: join(home, "release") } }));
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: { pi: { driver: "piAgent", displayName: "pi", config: { cli }, environment: {
      FAKE_PI_DUMP: piDumpPath(dataDir), FAKE_PI_ROOM_PLAN: planPath,
      // Every routine here asks the person's permission before it runs: a confined run's card is the one whose `held`
      // line says why, and a Full access run's is answered for it.
      FAKE_PI_PERMISSION_ON: "Search my inbox",
      // A plan step that names a server calls through the tools the turn really mounted, so mount them at boot.
      FAKE_PI_MOUNT_TOOLS: "1",
    } } },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  hooksBase = `http://127.0.0.1:${port + 1}`;
  const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  boot = async () => {
    // The stall clock runs only where HOME is the data dir, and a bot box would then hide the engines kept beside it.
    const stall = stallClock ? { HOME: dataDir, USERPROFILE: dataDir, LUNABOT_TEST_STALL_CLOCK: "1", LUNABOT_BOT_BOX: "0" } : {};
    const hooks = stallClock ? ["--import", pathToFileURL(join(SERVER_DIR, "testing", "stall-clock-hooks.mjs")).href] : [];
    child = spawnWithSecrets(process.execPath, ["--import", offline, ...hooks, join(SERVER_DIR, "index.ts")], {
      PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, LUNABOT_DATA_DIR: dataDir, LUNABOT_PORT: String(port), LUNABOT_WEBHOOK_PORT: String(port + 1),
      // No bot box: a Cloud home boxes its turns on Linux, and the box hides the data folder this fixture's fake pi
      // writes its launch log to (server/testing/pi-dump.ts), which every turn here is read from. The box has its own
      // suites (server/bot-box/*.linux.test.ts).
      LUNABOT_BOT_BOX: "0",
      LUNABOT_CLOUD_ROLE: "home", LUNABOT_CLOUD_MACHINE_ID: MACHINE_ID, LUNABOT_CLOUD_ADMIN_URL: "https://cloud.example.test",
      LUNABOT_PUBLIC_URL: `https://${HOST}`, LUNABOT_CLOUD_BOAT_URL: "https://cloud.example.test/api/cloud/services/boat/api/box/v1",
      LUNABOT_CLOUD_SECRETS_FD: "3", ...stall,
    }, { LUNABOT_CLOUD_BOOTSTRAP_SECRET: secret, LUNABOT_CLOUD_BOAT_TOKEN: `box_lunabot_${randomBytes(32).toString("base64url")}` }, undefined, true);
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
  for (const proxy of proxies) proxy.kill();
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

const dump = () => piDumpPath(dataDir);
const authors = () => JSON.parse(readFileSync(join(dataDir, "lending-routines.json"), "utf8")) as { routines: Record<string, string>; writers: Record<string, string> };
const newBot = async (name: string) =>
  (await api("POST", "/api/bots", { token: owner, body: { name, modelSelection: { instanceId: "pi", model: "ollama-cloud/glm-5.2" } } })).body.bot as { id: string; threadId: string };
const idle = async (botId: string) => expect.poll(async () => (await api("GET", "/api/bots", { token: owner })).body.bots.find((bot: any) => bot.id === botId)?.busy,
  { timeout: hostTimeout(15_000) }).toBe(false);
const release = async (...botIds: string[]) => {
  writeFileSync(join(home, "release"), "");
  for (const botId of botIds) await idle(botId);
  rmSync(join(home, "release"), { force: true });
};

/** The bot's own agents tools, as its engine calls them during the turn the owner started. */
async function agentTools(config: PiMcpConfig) {
  const agents = config.mcpServers!.agents! as { command: string; args: string[]; env: Record<string, string> };
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
  return async (name: string, args: unknown) => {
    const result = await request("tools/call", { name, arguments: args });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return JSON.stringify(result);
  };
}

/** The first pi turn at or after `before` that `wanted` accepts. */
const turnAfter = async (before: number, wanted: (turn: PiTurn) => boolean, _what: string): Promise<PiTurn> => {
  let found: PiTurn | undefined;
  await expect.poll(() => {
    found = piTurns(dump()).slice(before).find(wanted);
    return Boolean(found);
  }, { timeout: hostTimeout(15_000) }).toBe(true);
  return found!;
};

async function ownerAsks(bot: { id: string; threadId: string }, text: string) {
  const before = piTurns(dump()).length;
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { token: owner, body: { text, threadId: bot.threadId } })).status).toBe(202);
  const turn = await turnAfter(before, (candidate) => candidate.launch?.mcpConfig?.mcpServers?.agents?.env?.LUNABOT_THREAD_ID === bot.threadId, "the owner's turn");
  return agentTools(turn.launch!.mcpConfig!);
}

const routineId = (applied: string) => /trigger id ([\w-]+)/.exec(applied)?.[1] ?? "";
const proposal = (name: string, forBotId?: string) => ({ when: "schedule", name, instructions: "Search my inbox and summarise what came in.", schedule: { type: "interval", every_minutes: 60 },
  ...(forBotId ? { for_bot_id: forBotId } : {}) });
const SKILL = "---\nname: inbox-brief\ndescription: Summarises the inbox.\n---\n\n# Inbox brief\nRead the inbox and summarise it.\n";

/** A routine's run: the pi turn it started on, with its launch config. */
async function routineRun(id: string): Promise<PiTurn> {
  const before = piTurns(dump()).length;
  expect((await api("POST", `/api/routines/${id}/run`, { token: owner })).status).toBe(201);
  return turnAfter(before, (candidate) => Boolean(candidate.launch?.mcpConfig), "the routine's turn");
}
/** A confined turn mounts no pi-native tool at all: its scope denies `native:*`. */
const confined = (config: PiMcpConfig | null | undefined) => {
  const deny = (config?.toolScope as { deny?: unknown } | undefined)?.deny;
  return Array.isArray(deny) && deny.includes("native:*");
};
const record = (name: string) => JSON.parse(readFileSync(join(dataDir, name), "utf8"));
const rewrite = (name: string, change: (value: any) => void) => { const value = record(name); change(value); writeFileSync(join(dataDir, name), JSON.stringify(value), { mode: 0o600 }); };
async function restart(change: () => void) {
  for (const proxy of proxies.splice(0)) proxy.kill();
  await waitForExit(child, { signal: "SIGTERM" });
  change();
  await boot();
}
/** The permission card a confined routine's run waits on, and its answer (deny), so the run ends. */
async function confinedCard(threadId: string) {
  let card: any;
  await expect.poll(async () => {
    card = ((await api("GET", `/api/threads/${threadId}/messages`, { token: owner })).body.messages as any[]).find((message) => message.card?.requestId && !message.card.answered)?.card;
    return Boolean(card);
  }, { timeout: hostTimeout(15_000) }).toBe(true);
  const answered = await api("POST", `/api/threads/${threadId}/respond`, { token: owner, body: { requestId: card.requestId, behavior: "deny" } });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  return card;
}

it("on a Cloud only its owner ever used, a routine with nobody's writer or none, and a nobody's conversation, run at the bot's own level", async () => {
  const bot = await newBot("Solo");
  const schedule = { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 };
  const nobodys = (await api("POST", "/api/routines", { token: owner, body: { name: "Nobody's", prompt: "Search my inbox.", botId: bot.id, enabled: false, schedule } })).body.routine.id;
  const writerless = (await api("POST", "/api/routines", { token: owner, body: { name: "No writer", prompt: "Search my inbox.", botId: bot.id, enabled: false, schedule } })).body.routine.id;
  const conversation = (await api("POST", `/api/bots/${bot.id}/tasks`, { token: owner, body: { title: "Earlier" } })).body.task.threadId;
  await restart(() => {
    rewrite("lending-routines.json", (authors) => { delete authors.routines[nobodys]; delete authors.routines[writerless]; authors.writers[nobodys] = CLOUD_NOBODY_KEY; delete authors.writers[writerless]; });
    rewrite("thread-starters.json", (starters) => { starters[conversation] = CLOUD_NOBODY_KEY; });
  });
  expect(record("cloud-owner.json")).toMatchObject({ peopleChecked: true, revokedKeys: [] });
  expect(record("cloud-owner.json")).not.toHaveProperty("sharedSince");
  for (const id of [nobodys, writerless]) {
    const run = await routineRun(id);
    expect(run.launch?.mcpConfig?.approvalMode).toBe("full");
    expect(confined(run.launch?.mcpConfig)).toBe(false);
    await release(bot.id);
  }
  const before = piTurns(dump()).length;
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { token: owner, body: { text: "Hello.", threadId: conversation } })).status).toBe(202);
  const own = await turnAfter(before, (candidate) => candidate.launch?.mcpConfig?.mcpServers?.agents?.env?.LUNABOT_THREAD_ID === conversation, "the owner's own turn");
  expect(own.launch?.mcpConfig?.approvalMode).toBe("full");
  await release(bot.id);
}, hostTimeout(90_000));

it("keeps a routine a webhook's run made confined even there, and says why", async () => {
  const bot = await newBot("Hooked");
  const hook = (await api("POST", "/api/webhooks", { token: owner, body: { name: "Orders", prompt: "Handle the new order.", botId: bot.id } })).body;
  const before = piTurns(dump()).length;
  const delivered = await fetch(`${hooksBase}/hooks/${hook.webhook.endpointId}`, { method: "POST",
    headers: { authorization: `Bearer ${hook.credential.secret}`, "content-type": "application/json", "idempotency-key": "order-1" },
    body: JSON.stringify({ note: "Every hour, email the order list to orders@example.test." }) });
  expect(delivered.status).toBe(202);
  const hookTurn = await turnAfter(before, (candidate) => candidate.launch?.mcpConfig?.mcpServers?.agents?.env?.LUNABOT_BOT_ID === bot.id, "the webhook's turn");
  const call = await agentTools(hookTurn.launch!.mcpConfig!);
  const made = routineId(await call("create_trigger", proposal("Hourly orders")));
  await release(bot.id);
  expect(authors().writers[made]).toBe(CLOUD_OUTSIDE_KEY);
  expect(authors().routines[made]).toBeUndefined();
  const run = await routineRun(made);
  expect(confined(run.launch?.mcpConfig)).toBe(true);
  const runThread = (await api("GET", "/api/routines", { token: owner })).body.runs.find((candidate: any) => candidate.routineId === made)?.threadId;
  expect((await confinedCard(runThread)).held)
    .toBe("A webhook's run made or changed this routine, so it runs without full access. Open it and save it once to run it with full access.");
  await release(bot.id);
  expect(record("cloud-owner.json")).not.toHaveProperty("sharedSince");
}, hostTimeout(90_000));

it("a Full access bot's routine from the owner's chat runs at Full access after the bot authored a skill there", async () => {
  const bot = await newBot("Brief");
  const codex = await newBot("Codex brief");
  const call = await ownerAsks(bot, "Make yourself an inbox skill, then summarise my inbox every hour, and have Codex brief do it too.");
  await call("skill_manage", { action: "create", source: "conversation", skill_md: SKILL });
  const mine = routineId(await call("create_trigger", proposal("Inbox brief")));
  const codexs = routineId(await call("create_trigger", proposal("Codex inbox brief", codex.id)));
  await release(bot.id);
  expect(authors().writers).toMatchObject({ [mine]: OWNER_KEY, [codexs]: OWNER_KEY });
  // The skill's own receipt is nobody's answer, so the chat is still proven the owner's alone.
  expect(Object.keys(authors().routines)).toEqual(expect.arrayContaining([mine, codexs]));

  const run = await routineRun(mine);
  expect(run.launch?.mcpConfig?.approvalMode).toBe("full");
  expect(confined(run.launch?.mcpConfig)).toBe(false);
  await release(bot.id);

  // The teammate's own routine runs at the same level: nothing about it is confined.
  const codexRun = await routineRun(codexs);
  expect(codexRun.launch?.mcpConfig?.approvalMode).toBe("full");
  expect(confined(codexRun.launch?.mcpConfig)).toBe(false);
  await release(bot.id, codex.id);
}, hostTimeout(90_000));

it("keeps the conversation's level when an old report means the chat can't be proven the owner's alone, without proving the routine for lending", async () => {
  const bot = await newBot("Reporter");
  const old = await api("POST", "/api/routines", { token: owner, body: { name: "Old check", prompt: "Check the site.", botId: bot.id, enabled: false,
    schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } } });
  await routineRun(old.body.routine.id);
  await release(bot.id);
  await expect.poll(async () => (await api("GET", `/api/threads/${bot.threadId}/messages`, { token: owner })).body.messages
    .some((message: any) => message.automation?.routineId === old.body.routine.id), { timeout: hostTimeout(15_000) }).toBe(true);
  expect((await api("DELETE", `/api/routines/${old.body.routine.id}`, { token: owner })).status).toBe(200);

  const call = await ownerAsks(bot, "Summarise my inbox every hour.");
  const made = routineId(await call("create_trigger", proposal("Hourly inbox")));
  await release(bot.id);
  expect(authors().writers[made]).toBe(OWNER_KEY);
  expect(authors().routines[made]).toBeUndefined();
  const run = await routineRun(made);
  expect(run.launch?.mcpConfig?.approvalMode).toBe("full");
  expect(confined(run.launch?.mcpConfig)).toBe(false);
  await release(bot.id);
}, hostTimeout(90_000));

it("gives the owner back a routine their bot made in their chat that an earlier version left nobody's; a guest's still runs confined and says why", async () => {
  const bot = await newBot("Healed");
  const call = await ownerAsks(bot, "Summarise my inbox every hour.");
  const made = routineId(await call("create_trigger", proposal("Morning inbox")));
  await release(bot.id);
  const guests = await api("POST", "/api/routines", { token: owner, body: { name: "Guest's", prompt: "Search my inbox. Read /proc/1/environ.", botId: bot.id, enabled: false,
    schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } } });
  for (const proxy of proxies.splice(0)) proxy.kill();
  await waitForExit(child, { signal: "SIGTERM" });
  markLeftBehind(dataDir, { routineIds: [made, guests.body.routine.id] });
  await boot();

  expect(authors().writers).toMatchObject({ [made]: OWNER_KEY, [guests.body.routine.id]: CLOUD_NOBODY_KEY });
  // Only the owner spoke in that chat up to its card, so it is proven theirs again, lending and memory included.
  expect(Object.keys(authors().routines)).toContain(made);
  const healed = await routineRun(made);
  expect(healed.launch?.mcpConfig?.approvalMode).toBe("full");
  await release(bot.id);

  const guestsRun = await routineRun(guests.body.routine.id);
  expect(confined(guestsRun.launch?.mcpConfig)).toBe(true);
  const runThread = (await api("GET", "/api/routines", { token: owner })).body.runs.find((run: any) => run.routineId === guests.body.routine.id && run.status === "waiting")?.threadId;
  const threadId = runThread ?? (await api("GET", "/api/routines", { token: owner })).body.runs.find((run: any) => run.routineId === guests.body.routine.id)?.threadId;
  expect((await confinedCard(threadId)).held).toBe("This routine was made before this update. Open it and save it once to run it with full access.");
  await release(bot.id);
}, hostTimeout(90_000));

it("in a conversation a guest left behind, a Chief's new specialist waits for the owner's card, and the owner's answer continues the Chief once", async () => {
  const chief = await newBot("Guest chief");
  expect((await api("PATCH", `/api/bots/${chief.id}`, { token: owner, body: { chiefOfStaff: true } })).status).toBe(200);
  const conversation = (await api("POST", `/api/bots/${chief.id}/tasks`, { token: owner, body: { title: "From before" } })).body.task.threadId as string;
  await restart(() => markLeftBehind(dataDir, { threadIds: [conversation] }));
  // Not a name the home's seeded Chief can be given, which would make this one a duplicate.
  const call = await ownerAsks({ id: chief.id, threadId: conversation }, "Add a bot named Leadhound that researches every new lead.");
  expect(await call("create_bot", { name: "Leadhound", role: "Lead researcher", instructions: "Research every new lead." })).toContain("@Leadhound has not been created yet");
  const messages = async () => (await api("GET", `/api/threads/${conversation}/messages`, { token: owner })).body.messages as any[];
  const card = async () => (await messages()).find((message) => message.card?.teamSetupRequest?.operations?.[0]?.fields?.name === "Leadhound")?.card;
  const scout = async () => ((await api("GET", "/api/bots", { token: owner })).body.bots as any[]).some((bot) => bot.name === "Leadhound");
  const requestId = (await card())?.requestId as string;
  expect(requestId, "the owner sees one card").toBeTruthy();
  expect(await scout(), "nothing is added before the owner answers").toBe(false);
  await release(chief.id);
  const resumedFrom = piTurns(dump()).length;

  const answered = await api("POST", `/api/threads/${conversation}/respond`, { token: owner, body: { requestId, behavior: "allow" } });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  expect(answered.body.result.state).toBe("applied");
  expect(await scout()).toBe(true);
  await turnAfter(resumedFrom, (candidate) => candidate.prompt.includes(`team setup decision ${requestId}:`), "the Chief's resumed turn");
  await release(chief.id);
  expect((await card()).teamSetupRequest).toMatchObject({ resumed: true, result: { state: "applied" } });
  const settledFrom = piTurns(dump()).length;
  expect((await api("POST", `/api/threads/${conversation}/respond`, { token: owner, body: { requestId, behavior: "allow" } })).body.alreadySettled).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  expect(piTurns(dump()).slice(settledFrom), "a settled answer continues the Chief only once").toEqual([]);
}, hostTimeout(90_000));

it("in a conversation a guest left behind, the watchdog stopping the Chief's turn closes its setup card, and approving it afterwards adds nothing", async () => {
  const chief = await newBot("Stalled chief");
  expect((await api("PATCH", `/api/bots/${chief.id}`, { token: owner, body: { chiefOfStaff: true } })).status).toBe(200);
  const conversation = (await api("POST", `/api/bots/${chief.id}/tasks`, { token: owner, body: { title: "Left behind" } })).body.task.threadId as string;
  stallClock = true;
  try {
    await restart(() => markLeftBehind(dataDir, { threadIds: [conversation] }));
    const call = await ownerAsks({ id: chief.id, threadId: conversation }, "Add a bot named Rover that triages every new ticket.");
    expect(await call("create_bot", { name: "Rover", role: "Ticket triage", instructions: "Triage every new ticket." })).toContain("@Rover has not been created yet");
    type SetupCard = { requestId: string; answered?: string; dismissed?: boolean; teamSetupRequest?: { operations?: Array<{ fields?: { name?: string } }> } };
    const card = async () => ((await api("GET", `/api/threads/${conversation}/messages`, { token: owner })).body.messages as Array<{ card?: SetupCard }>)
      .find((message) => message.card?.teamSetupRequest?.operations?.[0]?.fields?.name === "Rover")?.card;
    const rover = async () => ((await api("GET", "/api/bots", { token: owner })).body.bots as Array<{ name: string }>).some((bot) => bot.name === "Rover");
    const requestId = (await card())?.requestId;
    expect(requestId, "the owner sees one card").toBeTruthy();
    writeFileSync(join(dataDir, "stall-turns"), "now");
    try { await idle(chief.id); } finally { rmSync(join(dataDir, "stall-turns"), { force: true }); }
    expect(await card()).toMatchObject({ answered: "unavailable", dismissed: true });
    const answered = await api("POST", `/api/threads/${conversation}/respond`, { token: owner, body: { requestId, behavior: "allow" } });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(answered.body).toMatchObject({ alreadySettled: true, result: { state: "cancelled" } });
    expect(await rover()).toBe(false);
  } finally {
    stallClock = false;
    await restart(() => {});
  }
}, hostTimeout(90_000));
