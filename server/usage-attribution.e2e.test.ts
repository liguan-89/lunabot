// POSIX-gated like the other CLI e2es: the fake is a shebang script.
//
// Usage attribution on the one engine this build runs (pi): each turn is booked once, to its starter, its department and
// its bot, with pi's own priced cost where the fixture reports one and a list-price estimate where it reports tokens
// only. Steered words and queued words never book a turn of their own.
//
// One pi instance serves every bot, so a turn's flavour is a knob on that instance (a marker its words carry, or the
// mode every turn runs in), and each flavour gets its own booted server: FAKE_PI_MODE=slow holds every turn behind a
// gate file the recipe writes, FAKE_PI_HOLD_ON holds only the turn whose words carry the marker, FAKE_PI_MODE=priced
// makes every turn report pi's own cost.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { workerPort } from "./testing/worker-port.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = join(SERVER_DIR, "testing", "fake-pi-cli.ts");
const PORT = workerPort(18800, 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");
const PERSON = "Safari on Mac";

type Reply = { status: number; body: any };
type Fixture = {
  api: (method: string, path: string, body?: unknown) => Promise<Reply>;
  asPerson: (scopes?: string[]) => Promise<(method: string, path: string, body?: unknown) => Promise<Reply>>;
  getBot: (id: string) => Promise<any>;
  ledger: (botId: string) => any[];
  newBot: (model: string) => Promise<{ id: string; threadId: string }>;
  waitFor: (predicate: () => Promise<boolean> | boolean, what: string, ms?: number) => Promise<void>;
  home: string;
  gate: string;
  stop: () => Promise<void>;
};

const running: Array<{ child: ChildProcess; home: string }> = [];
afterEach(async () => {
  for (const { child, home } of running.splice(0)) {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  }
});

/** A real server whose one pi instance carries these knobs; its slow turns wait for the gate file this returns. */
async function start(knobs: (gate: string) => Record<string, string> = () => ({})): Promise<Fixture> {
  chmodSync(FAKE_PI, 0o755);
  const home = mkdtempSync(join(tmpdir(), "omb-attribution-"));
  const dataDir = join(home, ".lunabot");
  mkdirSync(dataDir, { recursive: true });
  const gate = join(home, "finish.gate");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: { pi: { driver: "piAgent", displayName: "Verification pi", config: { cli: FAKE_PI }, environment: { ...knobs(gate) } } },
  }));
  const child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home,
      OMB_DATA_DIR: dataDir, OMB_PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.push({ child, home });
  let stderr = "";
  child.stderr!.on("data", (c) => (stderr += c));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const request = async (headers: Record<string, string>, method: string, path: string, body?: unknown): Promise<Reply> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const api = (method: string, path: string, body?: unknown) => request({}, method, path, body);
  const waitFor = async (predicate: () => Promise<boolean> | boolean, what: string, ms = 30_000) => {
    const end = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  return {
    api,
    home,
    gate,
    waitFor,
    getBot: async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id),
    asPerson: async (scopes?: string[]) => {
      const opened = await api("POST", "/api/auth/pairing", scopes ? { scopes } : {});
      expect(opened.status).toBe(200);
      const paired = await fetch(`${BASE}/api/auth/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1" },
        body: JSON.stringify({ code: opened.body.code }),
      });
      const session = (await paired.json()) as any;
      expect(session.session.label).toBe(PERSON);
      return (method: string, path: string, body?: unknown) => request({ authorization: `Bearer ${session.token}` }, method, path, body);
    },
    ledger: (botId: string) => {
      const file = join(home, ".lunabot", "usage", `${new Date().toISOString().slice(0, 7)}.jsonl`);
      if (!existsSync(file)) return [];
      // The server may be appending a line as this reads: only complete lines count, and the caller's wait reads again.
      const text = readFileSync(file, "utf8");
      return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.botId === botId);
    },
    newBot: async (model: string) => {
      const created = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "pi", model } });
      return created as { id: string; threadId: string };
    },
    stop: async () => {
      await waitForExit(child, { signal: "SIGTERM" });
      await removeTempDir(home);
      running.splice(running.findIndex((entry) => entry.child === child), 1);
    },
  };
}

const owner = { kind: "owner" };
const person = { kind: "user", label: PERSON };

posixOnly("usage attribution e2e", () => {
  it("books a pi turn that reports tokens but no price at its model's list price, and an unlisted model as unpriced", async () => {
    const f = await start();
    const listed = await f.newBot("grok-4.7");
    expect((await f.api("POST", `/api/bots/${listed.id}/messages`, { text: "priced from the list" })).status).toBe(202);
    await f.waitFor(() => f.ledger(listed.id).length === 1, "the listed model's turn to be booked");
    const row = f.ledger(listed.id)[0];
    // The fake's default turn reports 12 tokens in and 3 out, with no cost of its own.
    expect(row).toMatchObject({ driverKind: "piAgent", model: "grok-4.7", input: 12, output: 3, costSource: "estimated" });
    // xAI's list price for grok-4.7: $2 in, $6 out per million tokens
    expect(row.costUsd).toBeCloseTo((12 * 2 + 3 * 6) / 1_000_000, 12);

    const unlisted = await f.newBot("fake-model");
    expect((await f.api("POST", `/api/bots/${unlisted.id}/messages`, { text: "no known price" })).status).toBe(202);
    await f.waitFor(() => f.ledger(unlisted.id).length === 1, "the unlisted model's turn to be booked");
    expect(f.ledger(unlisted.id)[0].costUsd).toBeNull();
    expect(f.ledger(unlisted.id)[0]).not.toHaveProperty("costSource");

    const usage = (await f.api("GET", "/api/usage?groupBy=bot")).body;
    const byBot = (id: string) => usage.groups.find((g: any) => g.key === `bot:${id}`);
    expect(byBot(listed.id)).toMatchObject({ unpriced: 0 });
    expect(byBot(listed.id).estimatedUsd).toBeCloseTo(row.costUsd, 12);
    expect(byBot(unlisted.id)).toMatchObject({ costUsd: null, estimatedUsd: null, unpriced: 1 });
    await f.waitFor(async () => (await f.getBot(unlisted.id)).busy === false, "the bots to go idle");
  }, 40_000);

  it("books each turn to the department its bot was in then, and moving the bot later keeps what was spent there", async () => {
    const f = await start();
    const bot = await f.newBot("grok-4.7");
    expect((await f.api("PATCH", `/api/bots/${bot.id}`, { section: "Finance" })).status).toBe(200);
    expect((await f.api("POST", `/api/bots/${bot.id}/messages`, { text: "for finance" })).status).toBe(202);
    await f.waitFor(() => f.ledger(bot.id).length === 1, "the Finance turn to be booked");
    await f.waitFor(async () => (await f.getBot(bot.id)).busy === false, "the bot to go idle");
    expect(f.ledger(bot.id)[0]).toMatchObject({ section: "Finance" });
    expect((await f.api("PATCH", `/api/bots/${bot.id}`, { section: "Operations" })).status).toBe(200);
    expect((await f.api("POST", `/api/bots/${bot.id}/messages`, { text: "for operations" })).status).toBe(202);
    await f.waitFor(() => f.ledger(bot.id).length === 2, "the Operations turn to be booked");
    await f.waitFor(async () => (await f.getBot(bot.id)).busy === false, "the bot to go idle");
    const byDepartment = (await f.api("GET", "/api/usage?groupBy=department")).body.groups as Array<{ key: string; turns: number }>;
    expect(byDepartment.find((group) => group.key === "department:Finance")).toMatchObject({ turns: 1 });
    expect(byDepartment.find((group) => group.key === "department:Operations")).toMatchObject({ turns: 1 });
    const csv = await (await fetch(`${BASE}/api/usage.csv`)).text();
    expect(csv.split("\n")[0]).toMatch(/,thread,department,person$/);
    expect(csv).toContain(",Finance,");
  }, 40_000);

  it("a queued message leaves the running turn with its starter, and its own turn is booked to its sender", async () => {
    // Only the turn whose words carry the marker stays open, and the engine refuses live steers, so the person's line
    // waits in the queue and then runs as its own turn.
    const f = await start(() => ({ FAKE_PI_HOLD_ON: "owner's work", FAKE_PI_STEER_REFUSE: "1" }));
    const bot = await f.newBot("grok-4.7");
    expect((await f.api("POST", `/api/bots/${bot.id}/messages`, { text: "owner's work" })).status).toBe(202);
    await f.waitFor(async () => (await f.getBot(bot.id)).busy === true, "the owner's turn to start");
    const asPaired = await f.asPerson();
    const queued = await asPaired("POST", `/api/bots/${bot.id}/messages`, { text: "person's follow-up" });
    expect(queued.body.queued).toBe(true);

    await f.api("POST", `/api/bots/${bot.id}/interrupt`);
    await f.waitFor(() => f.ledger(bot.id).length === 1, "the owner's turn to be booked");
    expect(f.ledger(bot.id)[0].trigger).toEqual(owner);

    await f.waitFor(async () => (await f.getBot(bot.id)).messages.some((m: any) => m.text === "person's follow-up"), "the queued turn to start");
    await f.waitFor(() => f.ledger(bot.id).length === 2, "the queued turn to be booked");
    expect(f.ledger(bot.id)[1].trigger).toEqual(person);
    await f.waitFor(async () => (await f.getBot(bot.id)).busy === false, "the bot to go idle");
  }, 40_000);

  it("words steered into a running turn do not re-book it", async () => {
    const f = await start((gate) => ({ FAKE_PI_MODE: "slow", FAKE_PI_SLOW_FINISH_GATE: gate }));
    const bot = await f.newBot("grok-4.7");
    expect((await f.api("POST", `/api/bots/${bot.id}/messages`, { text: "first" })).status).toBe(202);
    await f.waitFor(async () => (await f.getBot(bot.id)).busy === true, "the slow turn to start");
    const asPaired = await f.asPerson();
    let steered: Reply;
    try {
      steered = await asPaired("POST", `/api/bots/${bot.id}/messages`, { text: "and also this" });
    } finally {
      writeFileSync(f.gate, "finish");
    }
    expect(steered.body.steered).toBe(true);
    await f.waitFor(() => f.ledger(bot.id).length === 1, "the steered turn to be booked");
    // One row for the turn, at the model's list price: the fake's slow turn reports tokens without a cost of its own.
    expect(f.ledger(bot.id)[0]).toMatchObject({ trigger: owner, model: "grok-4.7", costSource: "estimated" });
    expect(f.ledger(bot.id)[0].costUsd).toBeCloseTo((12 * 2 + 3 * 6) / 1_000_000, 12);
  }, 40_000);

  it("books each turn at pi's own reported cost", async () => {
    const f = await start(() => ({ FAKE_PI_MODE: "priced" }));
    const bot = await f.newBot("grok-4.7");
    expect((await f.api("POST", `/api/bots/${bot.id}/messages`, { text: "first turn" })).status).toBe(202);
    await f.waitFor(() => f.ledger(bot.id).length === 1, "the first turn to be booked");
    await f.waitFor(async () => (await f.getBot(bot.id)).busy === false, "the first turn to settle");
    expect((await f.api("POST", `/api/bots/${bot.id}/messages`, { text: "second turn" })).status).toBe(202);
    await f.waitFor(() => f.ledger(bot.id).length === 2, "the second turn to be booked");
    // The fake reports two priced model calls per turn: $0.0021 and $0.0004.
    const costs = f.ledger(bot.id).map((row) => [Number(row.costUsd.toFixed(4)), row.costSource]);
    expect(costs).toEqual([[0.0025, "reported"], [0.0025, "reported"]]);
    await f.waitFor(async () => (await f.getBot(bot.id)).busy === false, "the second turn to settle");
  }, 40_000);

  it("pressing Steer on a queued message does not re-book the running turn", async () => {
    // The turn whose words ask the question parks on pi's card, and the engine refuses live steers.
    const f = await start(() => ({ FAKE_PI_QUESTION_ON: "ask me first", FAKE_PI_STEER_REFUSE: "1" }));
    const bot = await f.newBot("grok-4.7");
    expect((await f.api("POST", `/api/bots/${bot.id}/messages`, { text: "ask me first, then work" })).status).toBe(202);
    await f.waitFor(async () => (await f.getBot(bot.id)).messages.some((m: any) => m.card), "the question card");
    const asPaired = await f.asPerson();
    const queued = await asPaired("POST", `/api/bots/${bot.id}/messages`, { text: "steer these words" });
    expect(queued.body.queued).toBe(true);
    // The engine refuses the live steer, so the words stay queued; the running turn is unchanged.
    const steered = await asPaired("POST", `/api/bots/${bot.id}/queue/${queued.body.queueId}/steer`, { threadId: bot.threadId });
    expect(steered.body).toMatchObject({ ok: true, queued: true });
    expect(steered.body.steered).toBeUndefined();

    await f.api("POST", `/api/bots/${bot.id}/interrupt`);
    await f.waitFor(() => f.ledger(bot.id).length === 1, "the running turn to be booked");
    expect(f.ledger(bot.id)[0].trigger).toEqual(owner);
  }, 40_000);

  it("books each room turn to the person who sent it", async () => {
    // The owner's room turn runs and settles; the person's room line holds (its words carry the marker) and books on the
    // stop, so each row carries its own starter.
    const f = await start(() => ({ FAKE_PI_HOLD_ON: "person's room follow-up" }));
    const bot = await f.newBot("grok-4.7");
    const room = (await f.api("POST", "/api/groups", {
      name: "Attribution room",
      memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    })).body.group;
    const working = async () => (await f.api("GET", "/api/bots?messages=30")).body.groups.find((g: any) => g.id === room.id);
    expect((await f.api("POST", `/api/groups/${room.id}/messages`, { text: "owner's room turn" })).status).toBe(202);
    await f.waitFor(() => f.ledger(bot.id).length >= 1, "the owner's room turn to be booked");
    expect(f.ledger(bot.id)[0].trigger).toEqual(owner);
    await f.waitFor(async () => !(await working())?.busyBotId, "the owner's room turn to settle");

    const asPaired = await f.asPerson();
    expect((await asPaired("POST", `/api/groups/${room.id}/messages`, { text: "person's room follow-up" })).status).toBe(202);
    await f.waitFor(async () => (await working())?.busyBotId === bot.id, "the person's room turn to start");
    await f.api("POST", `/api/groups/${room.id}/interrupt`, {});
    await f.waitFor(() => f.ledger(bot.id).length >= 2, "the person's room turn to be booked");
    expect(f.ledger(bot.id)[1].trigger).toEqual(person);
  }, 40_000);

  it("a guarded relay books the turn to the person it names; without one it is this machine's", async () => {
    const f = await start();
    const health = await f.api("GET", "/api/health");
    expect(health.body.capabilities.guardedOnBehalfOf).toBe(1);
    const bot = await f.newBot("grok-4.7");
    const send = async (sendId: string, extra: Record<string, unknown> = {}) => {
      const page = await f.api("GET", `/api/threads/${bot.threadId}/messages?limit=0`);
      return f.api("POST", `/api/bots/${bot.id}/messages/guarded`, {
        threadId: bot.threadId, sendId, text: `guarded ${sendId}`, expectedActiveLeafId: page.body.activeLeafId, expectedApprovalMode: "full", ...extra,
      });
    };
    const refused = await send("guarded-send-invalid-0001", { onBehalfOf: {} });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("onBehalfOf must name the person with an email address, a name, or both");

    expect((await send("guarded-send-relayed-0001", { onBehalfOf: { email: " Ada@Example.test ", name: "Ada Lovelace" } })).status).toBe(202);
    await f.waitFor(() => f.ledger(bot.id).length === 1, "the relayed turn to be booked");
    expect(f.ledger(bot.id)[0].trigger).toEqual({ kind: "user", email: "ada@example.test", label: "Ada Lovelace" });
    await f.waitFor(async () => (await f.getBot(bot.id)).busy === false, "the relayed turn to settle");

    expect((await send("guarded-send-owner-00001")).status).toBe(202);
    await f.waitFor(() => f.ledger(bot.id).length === 2, "the plain guarded turn to be booked");
    expect(f.ledger(bot.id)[1].trigger).toEqual(owner);
    await f.waitFor(async () => (await f.getBot(bot.id)).busy === false, "the plain guarded turn to settle");

    const member = await f.asPerson(["client"]);
    const page = await f.api("GET", `/api/threads/${bot.threadId}/messages?limit=0`);
    const memberTry = await member("POST", `/api/bots/${bot.id}/messages/guarded`, {
      threadId: bot.threadId, sendId: "guarded-send-member-0001", text: "as someone else", expectedActiveLeafId: page.body.activeLeafId,
      onBehalfOf: { email: "boss@example.test" },
    });
    expect(memberTry.status).toBe(403);
    expect(f.ledger(bot.id)).toHaveLength(2);
  }, 40_000);
});
