// Who a Team Cloud bot reports to, end to end: Acme's Owner (Olive), an Admin (Ada) and a User (Bob), the synthetic pi
// CLI asking real question and approval cards through its own dialogs, and each person's Needs you, notifications, Chief
// of Staff and inbox. It proves the routing and the audience rule, not a model's judgement.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { personKey } from "./person-key.ts";
import { startBrokerFake, type BrokerFake } from "./testing/broker-fake.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { piInstructionsFor, piTurns } from "./testing/pi-dump.ts";

const TOKEN = `ops_fake-team-${randomBytes(8).toString("hex")}`;
const OLIVE = { email: "olive@acme.test", role: "owner" as const };
const ADA = { email: "ada@acme.test", role: "admin" as const };
const BOB = { email: "bob@acme.test", role: "member" as const };
const QUESTION_1 = "Which landing page should I rewrite?";
const QUESTION_2 = "Can I merge the auth refactor?";
const APPROVAL = "rm -rf ./build";
// A scripted plan (server/testing/room-handoff-agent.ts) answers every ordinary turn, and each bot that asks a question
// gets an entry that calls pi's own ask_user: a select card whose title is the question and whose options are the
// choices. The one bot that asks an approval raises pi's own confirmation card instead, named by a file the test writes
// before that bot's first turn (pi reads its dialogs' knobs at boot).
const ENGINE = `const dir = process.env.FAKE_CLAUDE_FIXTURE_DIR;
const { readFileSync: readKnob } = process.getBuiltinModule("node:fs");
process.env.FAKE_PI_DUMP = dir + "/dump.jsonl";
process.env.FAKE_PI_ROOM_PLAN = dir + "/room-plan.json";
try {
  const approver = readKnob(dir + "/approver.txt", "utf8").trim();
  if (approver && process.env.LUNABOT_BOT_ID === approver) {
    process.env.FAKE_PI_PERMISSION_ON = "APPROVE-MARKER";
    process.env.FAKE_PI_CONFIRM_TITLE = ${JSON.stringify(APPROVAL)};
  }
} catch {}`;

type Bot = { id: string; name: string; threadId: string; createdBy?: string; reportsTo?: string; chiefOfStaff?: boolean; busy?: boolean };
type Frame = { kind: string; notification?: { kind: string; botId: string; threadId: string; title: string; body: string; forPerson?: string } };
type Card = { requestId?: string; requestType?: string; answered?: string };

let fx: CloudSendFixture, team: CloudTeamFixture, broker: BrokerFake;
let olive = "", ada = "", bob = "";
let fox: Bot, owl: Bot, lead: Bot;
const streams: AbortController[] = [];

beforeAll(async () => {
  broker = await startBrokerFake();
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, broker, team: { id: "team-acme-1", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  writeFileSync(planPath(), JSON.stringify({ "*": { script: [{ key: "quiet", repeat: true, match: [], reply: "Done." }] } }));
  olive = (await team.pair(OLIVE)).token!;
  ada = (await team.pair(ADA)).token!;
  bob = (await team.pair(BOB)).token!;
}, hostTimeout(120_000));

afterAll(async () => {
  for (const stream of streams) stream.abort();
  await fx?.close();
  await broker?.close();
});

const create = async (token: string, body: Record<string, unknown>) => {
  const created = await team.as(token, "POST", "/api/bots", body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.bot as Bot;
};
const bots = async (token: string) => (await team.as(token, "GET", "/api/bots")).body.bots as Bot[];
const botNamed = async (name: string) => (await bots(olive)).find((one) => one.name === name)!;
const needsYou = async (token: string) => ((await team.as(token, "GET", "/api/needs-you")).body.items as Array<{ kind: string; botId: string; threadId: string; text: string }>);
const asked = async (token: string) => (await needsYou(token)).map((item) => item.text).sort();
const messages = async (token: string, threadId: string) => ((await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as Array<{ id: string; kind: string; card?: Card; widget?: unknown }>;
const busy = async (botId: string) => Boolean((await bots(olive)).find((one) => one.id === botId)?.busy);
const dumpPath = () => join(team.home, "dump.jsonl");
const planPath = () => join(team.home, "room-plan.json");
/** One entry in a bot's scripted plan, appended: each turn whose own words hold `match` runs it. */
const plan = (botId: string, entry: Record<string, unknown>) => {
  const all = JSON.parse(readFileSync(planPath(), "utf8")) as Record<string, { script: unknown[] }>;
  (all[botId] ??= { script: [] }).script.push(entry);
  writeFileSync(planPath(), JSON.stringify(all));
};

/** One person's live stream, collecting every frame it is sent. */
function listen(token: string): Frame[] {
  const frames: Frame[] = [];
  const abort = new AbortController();
  streams.push(abort);
  void (async () => {
    const response = await fetch(`${team.base}/api/events`, { headers: { ...fx.edge, authorization: `Bearer ${token}` }, signal: abort.signal });
    const reader = response.body!.getReader();
    let buffered = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffered += new TextDecoder().decode(value);
      const parts = buffered.split("\n\n");
      buffered = parts.pop()!;
      for (const part of parts) {
        const data = part.split("\n").find((line) => line.startsWith("data: "));
        if (data) try { frames.push(JSON.parse(data.slice(6)) as Frame); } catch { /* a heartbeat */ }
      }
    }
  })().catch(() => {});
  return frames;
}
/** The notifications about `bot`'s asks: each reaches its person from their inbox, titled with the bot that asked. */
const notified = (frames: Frame[], kind: string, bot: Bot) => frames.filter((frame) => frame.kind === "notify" && frame.notification?.kind === kind && frame.notification.title.startsWith(bot.name));

/** The open card the turn asks with, once it is there: newest first, since pi's fake reuses a dialog's id. */
const openCard = async (token: string, threadId: string, requestType: "question" | "permission") =>
  (await messages(token, threadId)).findLast((row) => row.card?.requestType === requestType && !row.card.answered);

/** As `token`, a message holds `bot`'s turn in `threadId` while the bot asks a card through pi's own dialogs: a select
 * card for a question (its title is the question) or pi's confirmation card for an approval. */
async function askedBy(token: string, bot: Bot, threadId: string, card: { question: string } | { approve: true }) {
  const marker = `ASK-${bot.name.replace(/\W+/gu, "-")}-${Date.now()}`;
  if ("question" in card) {
    // The card stays open across the rest of the file, so the scripted turn may not time out while it waits.
    plan(bot.id, { key: marker, match: [marker], timeoutMs: 600_000, steps: [{ server: "ogb", tool: "ask_user", arguments: { question: card.question, choices: ["Yes", "No"] } }], reply: "Done." });
  }
  // The approver's child raises pi's own confirmation card for any prompt carrying its marker (the ENGINE lines above).
  const text = "question" in card ? `${marker}: please look into it` : `${marker}: APPROVE-MARKER please look into it`;
  const sent = await team.as(token, "POST", `/api/bots/${bot.id}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await expect.poll(() => busy(bot.id), { timeout: 20_000 }).toBe(true);
  const requestType = "question" in card ? "question" : "permission";
  let requestId = "";
  await expect.poll(async () => { requestId = (await openCard(token, threadId, requestType))?.card?.requestId ?? ""; return Boolean(requestId); }, { timeout: 20_000 }).toBe(true);
  return requestId;
}
/** Each ask's turn stays open on its card, as a person walking away from it leaves it: the card is still open for the
 * rest of the file, and a later test reads it in Needs you. */

it("records who created each team bot, offers everyone who opened the team, and lets an Admin set a department's owner", async () => {
  fox = await create(ada, { name: "Fox", section: "Product A" });
  owl = await create(ada, { name: "Owl", section: "Product A" });
  lead = await create(olive, { name: "Tech Lead", section: "Product A", reportsTo: ADA.email });
  expect(fox).toMatchObject({ createdBy: ADA.email });
  expect(fox.reportsTo).toBeUndefined();
  expect(lead).toMatchObject({ createdBy: OLIVE.email, reportsTo: ADA.email });

  const people = ((await team.as(bob, "GET", "/api/team/people")).body.people as Array<Record<string, unknown>>)
    .map(({ here, ...person }) => { expect(typeof here).toBe("boolean"); return person; });
  expect(people).toEqual(expect.arrayContaining([
    { email: OLIVE.email, name: "Olive", role: "owner" }, { email: ADA.email, name: "Ada", role: "admin" }, { email: BOB.email, name: "Bob", role: "member", you: true },
  ]));
  expect((await team.as(olive, "POST", "/api/bots", { name: "Nobody's", reportsTo: "stranger@elsewhere.test" })).status).toBe(400);

  // "Set owner for all bots…" on Product A, except Tech Lead, which keeps reporting to Ada.
  expect((await team.as(bob, "PUT", "/api/team/reports-to", { botIds: [fox.id, owl.id], email: BOB.email })).status).toBe(403);
  expect((await team.as(ada, "PUT", "/api/team/reports-to", { botIds: [fox.id, owl.id], email: "stranger@elsewhere.test" })).status).toBe(400);
  const set = await team.as(ada, "PUT", "/api/team/reports-to", { botIds: [fox.id, owl.id], email: BOB.email });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  expect((await botNamed("Fox")).reportsTo).toBe(BOB.email);
  expect((await botNamed("Owl")).reportsTo).toBe(BOB.email);
  expect((await botNamed("Tech Lead")).reportsTo).toBe(ADA.email);
}, hostTimeout(60_000));

it("puts a question in a shared chat in its owner's Needs you and notifications, nobody else's", async () => {
  const [olives, adas, bobs] = [listen(olive), listen(ada), listen(bob)];
  await new Promise((resolve) => setTimeout(resolve, 500));
  await askedBy(olive, fox, fox.threadId, { question: QUESTION_1 });
  await expect.poll(() => asked(bob), { timeout: 10_000 }).toEqual([QUESTION_1]);
  expect(await asked(ada)).toEqual([]);
  expect(await asked(olive)).toEqual([]);
  await expect.poll(() => notified(bobs, "question", fox).length, { timeout: 10_000 }).toBe(1);
  expect(notified(adas, "question", fox)).toEqual([]);
  expect(notified(olives, "question", fox)).toEqual([]);
  // It reaches Bob from his inbox, and the Admins' notification feed holds it for nobody but Bob.
  expect(notified(bobs, "question", fox)[0]!.notification).toMatchObject({ forPerson: personKey({ id: "", email: BOB.email }) });
  expect(notified(bobs, "question", fox)[0]!.notification!.threadId).not.toBe(fox.threadId);
  for (const token of [olive, ada]) {
    const feed = (await team.as(token, "GET", "/api/notifications")).body.notifications as Array<{ kind: string; title: string }>;
    expect(feed.filter((entry) => entry.kind === "question" && entry.title.startsWith("Fox"))).toEqual([]);
  }
  // The card itself stays in the shared chat, for everyone who sees it.
  expect((await messages(ada, fox.threadId)).some((row) => row.kind === "options")).toBe(true);
  expect(await asked(bob)).toEqual([QUESTION_1]);
  // Bob answers it, so the turn settles: pi's fake names each dialog from a counter that starts over in every child, so
  // one bot's open question and another's would share a request id and only the newer would list. The next case asks
  // Fox again, in the same warm child, and that one stays open.
  const first = (await messages(bob, fox.threadId)).findLast((row) => row.card?.requestType === "question")!;
  const answered = await team.as(bob, "POST", `/api/threads/${fox.threadId}/respond`, { requestId: first.card!.requestId, behavior: "answer", message: "Yes" });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  await expect.poll(() => busy(fox.id), { timeout: 20_000 }).toBe(false);
  await expect.poll(() => asked(bob), { timeout: 10_000 }).toEqual([]);
}, hostTimeout(90_000));

it("follows a bot's own Reports to over its department's, and routes an approval the same way", async () => {
  // Tech Lead reports to Ada, so its question is hers; Fox's, asked again in the child it keeps warm, is Bob's.
  await askedBy(bob, lead, lead.threadId, { question: QUESTION_2 });
  await expect.poll(() => asked(ada), { timeout: 10_000 }).toEqual([QUESTION_2]);
  await askedBy(olive, fox, fox.threadId, { question: QUESTION_1 });
  await expect.poll(async () => (await asked(bob)).includes(QUESTION_1), { timeout: 10_000 }).toBe(true);
  expect(await asked(ada), "Tech Lead's, and never Fox's, is Ada's").toContain(QUESTION_2);
  expect(await asked(ada)).not.toContain(QUESTION_1);

  expect((await team.as(ada, "PATCH", `/api/bots/${owl.id}`, { approvalMode: "ask" })).status).toBe(200);
  // The approver is named before its first turn: pi reads its dialog knobs at boot.
  writeFileSync(join(team.home, "approver.txt"), owl.id);
  await askedBy(olive, owl, owl.threadId, { approve: true });
  await expect.poll(async () => (await needsYou(bob)).some((item) => item.botId === owl.id && item.text.startsWith("Approve:")), { timeout: 10_000 }).toBe(true);
  expect((await needsYou(ada)).some((item) => item.botId === owl.id)).toBe(false);
}, hostTimeout(90_000));

it("lets the member who owns a bot hand it over, and nobody else but an Admin", async () => {
  // Fox's next question, in the child it kept warm: its own dialog id, apart from Tech Lead's open one.
  await askedBy(olive, fox, fox.threadId, { question: QUESTION_1 });
  await expect.poll(async () => (await asked(bob)).includes(QUESTION_1), { timeout: 10_000 }).toBe(true);
  expect((await team.as(bob, "PUT", `/api/bots/${lead.id}/reports-to`, { email: BOB.email })).status).toBe(403);
  const handed = await team.as(bob, "PUT", `/api/bots/${fox.id}/reports-to`, { email: ADA.email });
  expect(handed.status, JSON.stringify(handed.body)).toBe(200);
  expect(handed.body.bot.reportsTo).toBe(ADA.email);
  // Its open question moves with it.
  expect(await asked(ada)).toContain(QUESTION_1);
  expect(await asked(bob)).not.toContain(QUESTION_1);
  expect((await team.as(ada, "PUT", `/api/bots/${fox.id}/reports-to`, { email: BOB.email })).status).toBe(200);
  expect(await asked(bob)).toContain(QUESTION_1);
}, hostTimeout(30_000));

let bobsChief: Bot;

it("gives each person a Chief of Staff of their own whose team is the bots that report to them, while it can reach every bot", async () => {
  const adasChief = await create(ada, { name: "Ada's Chief", reportsTo: ADA.email });
  bobsChief = await create(ada, { name: "Bob's Chief", reportsTo: BOB.email });
  for (const chief of [adasChief, bobsChief]) expect((await team.as(ada, "PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true })).status).toBe(200);
  // Both crowned in General beside the department's own Chief, which nobody owns.
  const crowned = (await bots(olive)).filter((one) => one.chiefOfStaff);
  expect(crowned.filter((one) => one.reportsTo).map((one) => one.name).sort()).toEqual(["Ada's Chief", "Bob's Chief"]);
  expect(crowned.filter((one) => !one.reportsTo && !one.createdBy)).toHaveLength(1);
  // Bob's Chief reported to Ada would be her second.
  const second = await team.as(ada, "PUT", `/api/bots/${bobsChief.id}/reports-to`, { email: ADA.email });
  expect(second.status).toBe(409);
  expect(second.body.error).toContain("Ada already has a Chief of Staff");

  /** The instructions in effect on the Chief's turn: what the retired Claude dump's systemPrompt read. */
  const prompt = async (token: string, chief: Bot) => {
    const sent = await team.as(token, "POST", `/api/bots/${chief.id}/messages`, { text: "Who is on my side?", threadId: chief.threadId });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await expect.poll(() => existsSync(dumpPath()), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => busy(chief.id), { timeout: 20_000 }).toBe(false);
    const turns = piTurns(dumpPath());
    const index = turns.findLastIndex((turn) => turn.prompt.includes("Who is on my side?"));
    expect(index, "the Chief's turn was given the question").toBeGreaterThanOrEqual(0);
    return piInstructionsFor(turns, index);
  };
  // Each Chief's own team, then everyone else it can reach.
  const split = (text: string, person: string) => {
    const [, mine = "", others = ""] = text.split(new RegExp(`Bots that report to ${person} \\(your team\\):|Other bots you can reach \\(they report to someone else\\):`));
    return { mine, others };
  };
  const adasPrompt = await prompt(ada, adasChief);
  expect(adasPrompt).toContain("You are Ada's assistant and Chief of Staff");
  const adas = split(adasPrompt, "Ada");
  expect(adas.mine).toContain("Tech Lead");
  expect(adas.mine).not.toMatch(/\bFox\b|\bOwl\b/);
  expect(adas.others).toMatch(/\bFox\b/);
  expect(adas.others).toMatch(/\bOwl\b/);
  const bobsPrompt = await prompt(bob, bobsChief);
  expect(bobsPrompt).toContain("You are Bob's assistant and Chief of Staff");
  const bobs = split(bobsPrompt, "Bob");
  expect(bobs.mine).toMatch(/\bFox\b/);
  expect(bobs.mine).toMatch(/\bOwl\b/);
  expect(bobs.mine).not.toContain("Tech Lead");
  expect(bobs.others).toContain("Tech Lead");
}, hostTimeout(90_000));

it("keeps a member's private chat theirs: its asks reach only them, never the bot's owner, an Admin, or the owner's inbox", async () => {
  const bobs = listen(bob);
  const created = await team.as(olive, "POST", `/api/bots/${fox.id}/tasks`, { title: "Olive and Fox" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const private_ = created.body.task.threadId as string;
  const PRIVATE_QUESTION = "Should I tell the board about my resignation?";
  await askedBy(olive, fox, private_, { question: PRIVATE_QUESTION });
  await expect.poll(() => asked(olive), { timeout: 10_000 }).toEqual([PRIVATE_QUESTION]);
  expect(await asked(bob)).not.toContain(PRIVATE_QUESTION);
  expect(await asked(ada)).not.toContain(PRIVATE_QUESTION);
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  expect(notified(bobs, "question", fox)).toEqual([]);

  // Bob opens the app: his inbox, a private chat with the bot of his own, holds Fox's shared question and never Olive's.
  const arrived = await team.as(bob, "POST", "/api/presence/active", { source: "desktop" });
  expect(arrived.status, JSON.stringify(arrived.body)).toBe(200);
  const inbox = JSON.stringify(await messages(bob, arrived.body.open.threadId));
  expect(inbox).toContain(QUESTION_1);
  expect(inbox).not.toContain("resignation");
  const tasks = (await bots(bob)).find((one) => one.id === arrived.body.open.botId) as unknown as { tasks: Array<{ threadId: string; private?: boolean }> };
  expect(tasks.tasks.find((task) => task.threadId === arrived.body.open.threadId)?.private).toBe(true);
  // Ada's own inbox holds Tech Lead's question, not Fox's.
  const adaArrived = await team.as(ada, "POST", "/api/presence/active", { source: "desktop" });
  const adas = JSON.stringify(await messages(ada, adaArrived.body.open.threadId));
  expect(adas).toContain(QUESTION_2);
  expect(adas).not.toContain(QUESTION_1);
  expect(adas).not.toContain("resignation");
}, hostTimeout(90_000));

it("routes nothing on a server that is not a team", async () => {
  expect((await fx.onCloud("GET", "/api/team/people")).status).toBe(400);
  const mine = (await fx.onCloud("POST", "/api/bots", { name: "Mine" })).body.bot as Bot;
  expect(mine.createdBy).toBeUndefined();
  expect((await fx.onCloud("PUT", `/api/bots/${mine.id}/reports-to`, { email: ADA.email })).status).toBe(400);
  expect((await fx.onCloud("POST", "/api/bots", { name: "Solo", reportsTo: ADA.email })).status).toBe(400);
  expect((await fx.onCloud("GET", "/api/needs-you")).status).toBe(200);
}, hostTimeout(30_000));
