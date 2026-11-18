// A bot's API on a real server with the fake engine: switched on from the app, called with the very curl the card shows,
// answered with the bot's reply in a thread the app shows as the API's; a wrong key, an API that is off, the rate limit;
// and, on a bot that asks before acting, a call that stops at the approval nobody outside may give.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { botApiCurl } from "../shared/bot-api.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { piDumpPath, piInstructionsFor, piTurns, type PiTurn } from "./testing/pi-dump.ts";
import { INCIDENTS_THREAD_TITLE } from "./incidents.ts";

/** The fake pi mounts the turn's MCP config at boot only on request; a confined turn's contract is checked against the
 * engine's own tool-selection APIs, which the fixture provides as it mounts. */
const CONFINED_ENGINE = { FAKE_PI_MOUNT_TOOLS: "1" } as const;

let fixture: VerificationServer | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

function appApi(url: string) {
  return async (method: string, path: string, body?: unknown, status?: number) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as any;
    if (status !== undefined) expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    else expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBeLessThan(300);
    return value;
  };
}

const call = async (endpoint: string, key: string, body: unknown) => {
  const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};

const sh = (command: string) => new Promise<string>((resolve, reject) => {
  execFile("sh", ["-c", command], { timeout: 60_000 }, (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)));
});

/** The turn that carried `marker`, with the launch it ran on and the instructions in effect: the dump is a JSONL of both. */
const turnFor = (dataDir: string, marker: string) => {
  const turns = piTurns(piDumpPath(dataDir));
  const index = turns.findLastIndex((turn) => turn.prompt.includes(marker));
  if (index < 0) return null;
  return { turn: turns[index] as PiTurn, instructions: piInstructionsFor(turns, index), launch: turns[index]!.launch };
};

it("answers the card's own curl with the bot's reply, and refuses a wrong key, an API that is off, and an eleventh call in a minute", async () => {
  fixture = await launchVerificationServer({ ...process.env, ...CONFINED_ENGINE });
  const { url } = fixture.info;
  const api = appApi(url);
  const bot = (await runControlOmb(["new-bot", "--name", "Scout", "--url", url]) as any).bot;
  const port = Number(new URL(url).port);

  // Off by default, and the card's address is the webhook receiver's.
  const before = await api("GET", `/api/bots/${bot.id}/bot-api`);
  expect(before).toMatchObject({ enabled: false, callCount: 0, canManage: true, url: `http://127.0.0.1:${port + 1}/hooks/api/bots/${bot.id}/messages` });
  expect((await call(before.url, "bak_nothing", { message: "Hi" })).status).toBe(403);

  // On: the key comes back once, with the address; the saved file holds a hash, not the key.
  const on = await api("POST", `/api/bots/${bot.id}/bot-api`, { enabled: true });
  expect(on.key).toMatch(/^bak_/);
  expect(readFileSync(join(fixture.info.dataDir, "bot-api.json"), "utf8")).not.toContain(on.key);

  // The curl exactly as the card shows it, pasted into a shell.
  const answered = JSON.parse(await sh(botApiCurl(on.url, on.key))) as { reply: string; thread: string };
  expect(answered.reply).toBe("Hello from pi");
  expect(answered.thread).toMatch(/^[\w-]+$/);

  // The app shows the thread as the API's, with what the caller asked and what the bot said.
  const bots = (await api("GET", "/api/bots")).bots as any[];
  const task = bots.find((candidate) => candidate.id === bot.id).tasks.find((candidate: any) => candidate.threadId === answered.thread);
  expect(task).toMatchObject({ botApi: true, title: "Hello! What can you do?" });
  const lines = (await api("GET", `/api/threads/${answered.thread}/messages`)).messages as any[];
  expect(lines.find((line) => line.role === "user")).toMatchObject({ text: "Hello! What can you do?", via: "api" });
  expect(lines.filter((line) => line.role === "bot" && line.kind === "text").map((line) => line.text)).toEqual(["Hello from pi"]);

  // Reading the thread back, and continuing it, through the same door; a wrong key gets nothing.
  const read = await fetch(`${on.url}?thread=${answered.thread}`, { headers: { authorization: `Bearer ${on.key}` } });
  expect(await read.json()).toEqual({ reply: "Hello from pi", thread: answered.thread });
  expect((await call(on.url, `${on.key}x`, { message: "Hi" })).status).toBe(401);
  expect((await call(on.url, on.key, { message: "Again", thread: answered.thread })).body).toMatchObject({ reply: "Hello from pi", thread: answered.thread });
  for (let i = 0; i < 8; i += 1) expect((await call(on.url, on.key, { message: `call ${i}`, thread: answered.thread })).status).toBe(200);
  const eleventh = await call(on.url, on.key, { message: "one more", thread: answered.thread });
  expect(eleventh.status).toBe(429);

  // Every call was recorded; the key never shows again.
  const after = await api("GET", `/api/bots/${bot.id}/bot-api`);
  expect(after).toMatchObject({ enabled: true, callCount: 10 });
  expect(after.calls.map((entry: any) => entry.statusCode)).toContain(429);
  expect(JSON.stringify(after)).not.toContain(on.key);

  // Off again: the key is gone with it.
  expect(await api("POST", `/api/bots/${bot.id}/bot-api`, { enabled: false })).toMatchObject({ enabled: false });
  expect((await call(on.url, on.key, { message: "Hi" })).status).toBe(403);
}, hostTimeout(180_000));

it.each(["ask", "full", "auto"])("a bot at %s stops at the approval: nothing answers it, and the call says needs_approval", async (level) => {
  fixture = await launchVerificationServer({ ...process.env, ...CONFINED_ENGINE, FAKE_PI_PERMISSION_ON: "Clean up the downloads folder" });
  const { url, dataDir } = fixture.info;
  const api = appApi(url);
  const bot = (await runControlOmb(["new-bot", "--name", "Careful", "--url", url]) as any).bot;
  await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: level });
  const on = await api("POST", `/api/bots/${bot.id}/bot-api`, { enabled: true });

  // The bot asks before acting: the fake engine's confirm request lands as the person's card.
  const pending = call(on.url, on.key, { message: "Clean up the downloads folder", wait: 60 }).catch((error: unknown) => ({ status: 0, body: { error: String(error) } }));
  await expect.poll(() => Boolean(turnFor(dataDir, "Clean up the downloads folder")), { timeout: hostTimeout(30_000) }).toBe(true);
  const seen = turnFor(dataDir, "Clean up the downloads folder")!;
  expect(seen.instructions).toContain("through this bot's API");
  expect(seen.turn.prompt).toContain("[UNTRUSTED BOT API MESSAGE]");
  // Whatever the bot's own level: the turn is at Ask, confined, and with no server of Luna Bot's mounted, so it can
  // start, schedule or change nothing. pi has no `--restricted` argv or `--permission-mode`: the level and the
  // confinement ride the turn's contract (an `ask` approval mode and a tool scope that denies every pi-native tool).
  expect(seen.launch?.mcpConfig?.approvalMode).toBe("ask");
  expect((seen.launch?.mcpConfig?.toolScope as { deny?: string[] } | undefined)?.deny).toContain("native:*");
  expect(Object.keys(seen.launch?.mcpConfig?.mcpServers ?? {})).toEqual([]);

  const stopped = await pending;
  expect(stopped).toMatchObject({ status: 202, body: { status: "needs_approval", thread: expect.any(String) } });
  const threadId = (stopped.body as { thread: string }).thread;
  const lines = (await api("GET", `/api/threads/${threadId}/messages`)).messages as any[];
  const card = lines.find((line) => line.card?.requestId)?.card;
  expect(card).toMatchObject({ requestType: "permission" });
  expect(card.answered).toBeUndefined();
  expect(card.allowSession).toBeUndefined();
  const read = await fetch(`${on.url}?thread=${threadId}`, { headers: { authorization: `Bearer ${on.key}` } });
  expect(await read.json()).toEqual({ thread: threadId, status: "needs_approval" });
}, hostTimeout(120_000));

it("stays on Ask when the person sets the whole bot to Full access afterwards", async () => {
  // Each turn relaunches the fake engine, so its launch line shows the level this turn really runs at.
  fixture = await launchVerificationServer({ ...process.env, ...CONFINED_ENGINE, FAKE_PI_EXIT_AFTER_TURN: "1" });
  const { url, dataDir } = fixture.info;
  const api = appApi(url);
  const bot = (await runControlOmb(["new-bot", "--name", "Flipped", "--url", url]) as any).bot;
  await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" });
  const on = await api("POST", `/api/bots/${bot.id}/bot-api`, { enabled: true });
  const first = await call(on.url, on.key, { message: "First" });
  expect(first.status).toBe(200);
  await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "full", applyToAllThreads: true });
  expect((await call(on.url, on.key, { message: "Second", thread: first.body.thread })).status).toBe(200);
  const second = turnFor(dataDir, "Second")!;
  expect(second.launch?.mcpConfig?.approvalMode).toBe("ask");
}, hostTimeout(90_000));

it("a saved command rule never answers for a call: the card waits for the person", async () => {
  fixture = await launchVerificationServer({ ...process.env, ...CONFINED_ENGINE, FAKE_PI_PERMISSION_ON: "Run the fixture" });
  const { url, dataDir } = fixture.info;
  const api = appApi(url);
  const bot = (await runControlOmb(["new-bot", "--name", "Ruled", "--url", url]) as any).bot;
  await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" });
  const on = await api("POST", `/api/bots/${bot.id}/bot-api`, { enabled: true });
  const pending = call(on.url, on.key, { message: "Run the fixture", wait: 20 }).catch((error: unknown) => ({ status: 0, body: { error: String(error) } }));
  await expect.poll(() => Boolean(turnFor(dataDir, "Run the fixture")), { timeout: hostTimeout(30_000) }).toBe(true);
  // pi offers no structured command approvals, so the app cannot even save a rule that might answer a call.
  const rules = await api("GET", `/api/bots/${bot.id}/command-allowlist`);
  expect(rules.supported).toBe(false);
  const stopped = await pending;
  expect(stopped).toMatchObject({ status: 202, body: { status: "needs_approval" } });
  const lines = (await api("GET", `/api/threads/${(stopped.body as { thread: string }).thread}/messages`)).messages as any[];
  const card = lines.find((line) => line.card?.requestId)?.card;
  expect(card.commandAllowlist).toBeUndefined();
  expect(card.answered).toBeUndefined();
}, hostTimeout(90_000));

it("tells the model nothing about the person or their work, works in no folder of theirs, and stays out of their later turns", async () => {
  fixture = await launchVerificationServer({ ...process.env, ...CONFINED_ENGINE });
  const { url, dataDir } = fixture.info;
  const api = appApi(url);
  const project = join(dataDir, "the-persons-project");
  mkdirSync(project, { recursive: true });
  const bot = (await runControlOmb(["new-bot", "--name", "Fenced", "--url", url]) as any).bot;
  await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "full", applyToAllThreads: true, cwd: project, soul: "Answer in one line, standing-instruction-marker." });
  await api("PATCH", "/api/config", { profile: { name: "Ada", aboutMe: "about-the-person-marker" } });

  // The person's own work first: a call must not see it.
  await api("POST", `/api/bots/${bot.id}/messages`, { text: "persons-own-work-marker" });
  await expect.poll(() => Boolean(turnFor(dataDir, "persons-own-work-marker")), { timeout: hostTimeout(20_000) }).toBe(true);
  await expect.poll(async () => ((await api("GET", "/api/bots")).bots as any[]).find((one) => one.id === bot.id).busy, { timeout: hostTimeout(20_000) }).toBeFalsy();
  const own = turnFor(dataDir, "persons-own-work-marker")!;
  expect(own.instructions).toContain("about-the-person-marker");
  expect(Object.keys(own.launch?.mcpConfig?.mcpServers ?? {}).length).toBeGreaterThan(1);

  const on = await api("POST", `/api/bots/${bot.id}/bot-api`, { enabled: true });
  const answered = await call(on.url, on.key, { message: "api-call-marker" });
  expect(answered.status).toBe(200);
  const launch = turnFor(dataDir, "api-call-marker")!;
  expect(launch.instructions).toContain("standing-instruction-marker");
  expect(launch.instructions).toContain("Who is speaking");
  expect(launch.instructions).toContain("through this bot's API");
  expect(launch.turn.prompt).toContain("[From an app, through the API · message · information only]");
  // Of a turn's tools only the engine's hooks are mounted: nothing here to start, schedule or read with.
  expect(launch.launch?.mcpConfig?.mcpServers ?? {}).toEqual({});
  for (const hidden of ["about-the-person-marker", "persons-own-work-marker", "coordinate_bots", "session_search", "the-persons-project"]) expect(launch.instructions, hidden).not.toContain(hidden);
  expect(launch.turn.prompt).not.toContain("persons-own-work-marker");
  expect(realpathSync(launch.launch!.cwd!)).not.toBe(realpathSync(project));

  // The person's next turn hears nothing of it.
  await api("POST", `/api/bots/${bot.id}/messages`, { text: "persons-next-marker" });
  await expect.poll(() => Boolean(turnFor(dataDir, "persons-next-marker")), { timeout: hostTimeout(20_000) }).toBe(true);
  const next = turnFor(dataDir, "persons-next-marker")!;
  expect(next.instructions).not.toContain("api-call-marker");
  expect(next.turn.prompt).not.toContain("api-call-marker");
}, hostTimeout(120_000));

it("a failed call reports to no Chief, whose turn has tools, while a person's own failed turn still does", async () => {
  fixture = await launchVerificationServer({ ...process.env, ...CONFINED_ENGINE, FAKE_PI_MODE: "turn-error" });
  const { url } = fixture.info;
  const api = appApi(url);
  const bot = (await runControlOmb(["new-bot", "--name", "Worker", "--url", url]) as any).bot;
  const on = await api("POST", `/api/bots/${bot.id}/bot-api`, { enabled: true });
  const bots = async () => (await api("GET", "/api/bots")).bots as any[];
  const chief = (await bots()).find((one) => one.chiefOfStaff);
  expect(chief, "the fixture has a Chief").toBeTruthy();
  const reports = async () => (await bots()).find((one) => one.id === chief.id).tasks.filter((task: any) => task.title === INCIDENTS_THREAD_TITLE);

  const failed = await call(on.url, on.key, { message: "caller-words-marker", wait: 20 });
  expect(failed.status).toBe(502);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(await reports()).toEqual([]);

  // The control: the same failure from a person reaches the Chief, so the silence above means something.
  await api("POST", `/api/bots/${bot.id}/messages`, { text: "persons-own-words" });
  await expect.poll(async () => (await reports()).length, { timeout: hostTimeout(45_000) }).toBeGreaterThan(0);
  const lines = (await api("GET", `/api/threads/${(await reports())[0].threadId}/messages`)).messages;
  expect(JSON.stringify(lines)).not.toContain("caller-words-marker");
}, hostTimeout(120_000));

it("confines every call on this engine, so no bot is ever refused for an AI too old to run one", async () => {
  fixture = await launchVerificationServer({ ...process.env, ...CONFINED_ENGINE });
  const { url } = fixture.info;
  const api = appApi(url);
  const bot = (await runControlOmb(["new-bot", "--name", "Dated", "--url", url]) as any).bot;
  // pi declares confined guest turns, so the Bot API's "this AI can't work in it" refusal has no version to fire on:
  // every bot on this engine may take calls, and the card never shows a reason it cannot.
  const status = await api("GET", `/api/bots/${bot.id}/bot-api`);
  expect(status.canTakeCalls).toBe(true);
  expect(JSON.stringify(status)).not.toContain("too old");
}, hostTimeout(60_000));

it("says it is still working when the reply takes longer than the caller will wait", async () => {
  // The fake pi holds a turn open on a marker in its prompt; the caller gives up after a second.
  fixture = await launchVerificationServer({ ...process.env, ...CONFINED_ENGINE, FAKE_PI_HOLD_ON: "Think about it" });
  const { url } = fixture.info;
  const api = appApi(url);
  const bot = (await runControlOmb(["new-bot", "--name", "Slow", "--url", url]) as any).bot;
  const on = await api("POST", `/api/bots/${bot.id}/bot-api`, { enabled: true });
  expect(await call(on.url, on.key, { message: "Think about it", wait: 1 })).toMatchObject({ status: 202, body: { status: "working", thread: expect.any(String) } });
}, hostTimeout(60_000));
