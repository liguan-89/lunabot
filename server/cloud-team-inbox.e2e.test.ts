// Each person's inbox on a Team Cloud, end to end (docs/team-cloud.md "One inbox per person"): Acme's Owner Cleo and
// a member Ben, the synthetic pi CLI calling message_person through the real agents MCP server, real cards through pi's
// own dialogs, and Ben's own Google Calendar on the fake connected-apps service. A bot's "tell Ben", an @Ben and an
// approval routed to Ben land in his inbox, his chat with his Chief, with one notification each; his answer reaches the
// bot that asked, which carries on. A question a fact Ben shares with the team could answer still waits for him: this
// build's only engine, pi, has no one-off text call for a person's assistant (server/helper-model.e2e.test.ts), so
// nothing answers for him. The asks waiting on him are counted on his inbox, live, and each stops waiting however he
// answers it: in the bot's own chat, through either respond route, or with a 👍. It proves where things land and what is
// read, not a model's judgement.
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { personKey } from "./person-key.ts";
import { startBrokerFake, type BrokerFake } from "./testing/broker-fake.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { piTurns } from "./testing/pi-dump.ts";

const CLEO = { email: "cleo@acme.test", role: "owner" as const };
const BEN = { email: "ben@acme.test", role: "member" as const };
const BEN_KEY = personKey({ id: "", email: BEN.email });
const SECRET = "interviewing at Globex";
// Each turn reads its scripted calls and reply again, and its child ends with the turn, so every turn spawns afresh: that
// is what lets the question gate below be read per turn. A prompt carrying the approval marker raises pi's own
// confirmation card, which holds its turn until the person answers it. A prompt carrying the question token raises pi's
// select card, but only while the test's `question-armed` file exists: the turn that carries the person's answer on has
// their earlier words in its history, so the test disarms the gate before answering.
const APPROVES = "Clean the build";
const ASKS = "CHART-ORDER";
const ENGINE = `const dir = process.env.FAKE_CLAUDE_FIXTURE_DIR;
const { existsSync } = process.getBuiltinModule("node:fs");
process.env.FAKE_PI_DUMP = dir + "/turns.jsonl";
process.env.FAKE_CLAUDE_TOOL_CALLS_FILE = dir + "/tool-calls.json";
process.env.FAKE_CLAUDE_REPLY_FILE = dir + "/reply.txt";
process.env.FAKE_CLAUDE_EXIT_AFTER_TURN = "1";
process.env.FAKE_PI_PERMISSION_ON = ${JSON.stringify(APPROVES)};
if (existsSync(dir + "/question-armed")) process.env.FAKE_PI_QUESTION_ON = ${JSON.stringify(ASKS)};`;
const TOKEN = `ops_fake-team-${randomBytes(8).toString("hex")}`;

type Card = { requestId?: string; requestType?: string; subtitle?: string; options?: string[]; answered?: string; answeredText?: string; stopped?: boolean };
type Row = { id: string; role: string; kind: string; text?: string; card?: Card; replyToId?: string;
  relay?: { kind: string; email: string; name: string }; peerAsk?: { botId: string; name: string };
  inbox?: { kind: string; from: { name: string; email?: string; botId?: string }; via?: { name: string }; origin?: { botId: string; threadId: string; title: string }; replies?: true; answers?: Array<{ by: string; text: string }> } };
type Task = { threadId: string; title: string; inbox?: true; private?: true; openAsks?: number; inboxChangedAt?: number };
type Bot = { id: string; name: string; threadId: string; mainThreadId?: string; busy?: boolean; activity?: string; tasks?: Task[] };
type Frame = { kind: string; bot?: Bot; notification?: { kind: string; botId: string; threadId: string; title: string; body: string; forPerson?: string } };

let fx: CloudSendFixture, team: CloudTeamFixture, broker: BrokerFake;
let cleo = "", ben = "";
let scout: Bot, chief: Bot, reporter: Bot;
let cleoThread = "", benThread = "", inbox = "";
const streams: AbortController[] = [];
let bens: Frame[] = [], cleos: Frame[] = [];

const file = (name: string) => join(team.home, name);
/** Every turn the team's pi processes were given, in order: the log is a JSONL of launches and prompts. */
const turns = () => piTurns(file("turns.jsonl"));
const script = (calls: unknown[] | null, reply = "Done.") => {
  if (calls) writeFileSync(file("tool-calls.json"), JSON.stringify(calls)); else rmSync(file("tool-calls.json"), { force: true });
  writeFileSync(file("reply.txt"), reply);
};
const tell = (to: string, message: string) => [{ name: "message_person", server: "agents", input: { to, message } }];
const messages = async (token: string, threadId: string) => {
  const answer = await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`);
  return { status: answer.status, rows: (answer.body.messages ?? []) as Row[] };
};
const bots = async (token: string) => (await team.as(token, "GET", "/api/bots")).body.bots as Bot[];
const idle = async () => (await bots(cleo)).every((bot) => !bot.busy && bot.activity !== "working");
const notifiedIn = (frames: Frame[], threadId: string) => frames.filter((frame) => frame.kind === "notify" && frame.notification?.threadId === threadId);
const inboxLines = async () => (await messages(ben, inbox)).rows.filter((row) => row.inbox);
const inboxTask = async () => (await bots(ben)).find((bot) => bot.id === chief.id)!.tasks!.find((task) => task.inbox)!;
/** Ben's inbox task in each frame about his Chief that reached his live stream. */
const inboxFrames = (frames: Frame[]) => frames.filter((frame) => frame.kind === "bot" && frame.bot?.id === chief.id).map((frame) => frame.bot!.tasks?.find((task) => task.inbox));
const needsYou = async (token: string) => (await team.as(token, "GET", "/api/needs-you")).body.items as Array<{ kind: string; botId?: string; text?: string }>;
const chiefTurns = async () => (await messages(ben, inbox)).rows.filter((row) => row.role === "bot" && row.kind === "text" && !row.inbox);
/** The open card a thread asks with, newest first: pi's fake names its dialogs the same from one child to the next, so a
 * thread can hold more than one card of the same request id. */
const openCard = async (threadId: string, requestType: "permission" | "question") =>
  (await messages(cleo, threadId)).rows.findLast((row) => row.card?.requestType === requestType && !row.card.answered);

// 150 s, not 60: a loaded ubuntu shard once missed a turn's prompt line inside 60 s across three attempts
// (Nov 18 CI rounds); local runs settle in single-digit seconds, so the headroom costs nothing green.
async function until(done: () => Promise<boolean> | boolean, timeoutMs = hostTimeout(150_000)): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error(`timed out waiting: ${done.toString().slice(0, 160)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
/** As `token`, one message to `bot` in `threadId`, through the bot's settled turn. */
async function turn(token: string, bot: Bot, threadId: string, text: string) {
  const before = turns().length;
  const sent = await team.as(token, "POST", `/api/bots/${bot.id}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await until(() => turns().length > before);
  await until(async () => await idle() && (await messages(token, threadId)).rows.some((row) => row.role === "bot" && row.kind === "text" && row.text === readFileSync(file("reply.txt"), "utf8")));
}
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
async function newThread(token: string, bot: Bot, title: string) {
  const opened = await team.as(token, "POST", `/api/bots/${bot.id}/tasks`, { title });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  return opened.body.task.threadId as string;
}
/** message_person from Scout in Cleo's chat, straight from the turn's own bearer as the agents server sends it: the bot
 * that then carries on is scripted with no calls, so it does not ask again. */
async function passFromScout(message: string) {
  script(null, "Thanks, noted.");
  const bearer = await team.capability(scout.id, cleoThread);
  const answer = await fetch(`${team.base}/api/internal/people/message`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ to: "Ben", message }) });
  expect(answer.status, await answer.clone().text()).toBe(200);
}
/** Cleo asks Reporter to work in a room of its own, which is the team's: the card it asks there is Reporter's owner's
 * (Ben's). A room per ask keeps one conversation's cards apart, and each ask holds its own turn. */
async function askReporterInRoom(title: string, text: string) {
  await until(idle);
  const created = await team.as(cleo, "POST", "/api/groups", { name: title, memberIds: [reporter.id],
    setup: { bulletin: "", defaultResponder: { kind: "member", botId: reporter.id } } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const threadId = created.body.group.threadId as string;
  const sent = await team.as(cleo, "POST", `/api/groups/${created.body.group.id}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  return threadId;
}
/** The open approval a room's turn asks with. */
async function openApproval(threadId: string) {
  let requestId = "";
  await until(async () => { requestId = (await openCard(threadId, "permission"))?.card?.requestId ?? ""; return Boolean(requestId); }, 30_000);
  return requestId;
}
/** Cleo's message holds Reporter's turn while pi asks the person to approve a command. */
async function approvalFromReporter(command: string) {
  const threadId = await askReporterInRoom(`Clean the build: ${command}`, `Clean the build: ${command}`);
  return { requestId: await openApproval(threadId), threadId };
}

beforeAll(async () => {
  broker = await startBrokerFake();
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, broker, team: { id: "team-acme-1", name: "Acme", engine: ENGINE, env: { LUNABOT_BOT_BOX: "0" } } });
  team = fx.team!;
  cleo = (await team.pair(CLEO)).token!;
  ben = (await team.pair(BEN)).token!;
  await bots(ben);
  const create = async (body: Record<string, unknown>) => {
    const created = await team.as(cleo, "POST", "/api/bots", body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.bot as Bot;
  };
  scout = await create({ name: "Scout" });
  chief = await create({ name: "Ben's Chief", reportsTo: BEN.email });
  expect((await team.as(cleo, "PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true })).status).toBe(200);
  reporter = await create({ name: "Reporter", reportsTo: BEN.email });
  expect((await team.as(cleo, "PATCH", `/api/bots/${reporter.id}`, { approvalMode: "ask" })).status).toBe(200);
  cleoThread = await newThread(cleo, scout, "Cleo and Scout");
  benThread = await newThread(ben, scout, "Ben and Scout");
  script(null);
  await turn(ben, scout, benThread, `Keep this between us: I'm ${SECRET} on Thursday.`);

  // Google Calendar is each person's own on Acme, and Ben connected his.
  expect((await team.as(cleo, "PUT", "/api/team/connection-scopes", { kind: "app", id: "googlecalendar", scope: "person" })).status).toBe(200);
  expect((await team.as(ben, "POST", "/api/team/my-connections/apps/googlecalendar/connect", {})).status).toBe(200);
  const benUser = broker.userFor(broker.installationIds().at(-1)!);
  broker.account(benUser, "googlecalendar", BEN.email);
  // At noon two days on, so the busy hour never runs past midnight, which the prompt words as two days.
  const noon = new Date(Date.now() + 2 * 24 * 60 * 60_000);
  noon.setHours(12, 0, 0, 0);
  const start = noon.getTime();
  broker.calendarEvents[benUser] = [{ id: "ev1", summary: "Interview at Globex", status: "confirmed", location: "Globex HQ", attendees: [{ email: "hr@globex.test" }],
    start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(start + 60 * 60_000).toISOString() } }];
  bens = listen(ben);
  cleos = listen(cleo);
  await new Promise((resolve) => setTimeout(resolve, 500));
}, hostTimeout(180_000));

afterAll(async () => {
  for (const stream of streams) stream.abort();
  await fx?.close();
  await broker?.close();
});

it("lands a bot's \"tell Ben\" in his inbox, his chat with his Chief, with one notification and nothing else of Cleo's chat", async () => {
  script(tell("Ben", "The launch moved to Friday."), "Told Ben.");
  await turn(cleo, scout, cleoThread, "Tell Ben the launch moved to Friday. (My bonus talk is private.)");
  const tasks = (await bots(ben)).find((bot) => bot.id === chief.id)!.tasks ?? [];
  inbox = tasks.find((task) => task.inbox)!.threadId;
  expect(tasks.find((task) => task.threadId === inbox)).toMatchObject({ title: "Inbox", private: true, inbox: true });
  await until(async () => (await inboxLines()).length === 1);
  const [line] = await inboxLines();
  expect(line).toMatchObject({ role: "bot", text: "The launch moved to Friday.", inbox: { kind: "message", from: { name: "Cleo", email: CLEO.email }, via: { name: "Scout" }, replies: true } });
  expect(line!.inbox!.origin, "Ben can't open Cleo's private chat").toBeUndefined();
  expect(JSON.stringify((await messages(ben, inbox)).rows)).not.toContain("bonus");
  await until(() => notifiedIn(bens, inbox).length === 1);
  expect(notifiedIn(bens, inbox)[0]!.notification).toMatchObject({ kind: "mention", botId: chief.id, title: "Message from Cleo via Scout", forPerson: BEN_KEY });
  expect(notifiedIn(cleos, inbox)).toEqual([]);
  expect((await messages(cleo, inbox)).status, "Cleo never reads Ben's inbox").toBe(404);
  expect((await messages(cleo, cleoThread)).rows.some((row) => row.relay?.kind === "told" && row.relay.email === BEN.email)).toBe(true);
}, hostTimeout(120_000));

it("brings Ben's reply back to Scout in Cleo's chat, where Scout carries on, and his Chief takes no turn", async () => {
  const [line] = await inboxLines();
  script(null, "Great, Friday it is.");
  const sent = await team.as(ben, "POST", `/api/bots/${chief.id}/messages`, { text: "Friday works for me.", threadId: inbox, replyToId: line!.id });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await until(async () => (await messages(cleo, cleoThread)).rows.some((row) => row.role === "bot" && row.text === "Great, Friday it is."));
  const rows = (await messages(cleo, cleoThread)).rows;
  expect(rows.find((row) => row.relay?.kind === "reply")).toMatchObject({ role: "user", text: 'Ben replied to your message ("The launch moved to Friday."): Friday works for me.', relay: { email: BEN.email, name: "Ben" }, peerAsk: { botId: chief.id } });
  expect(turns().some((one) => one.prompt.includes("Ben replied to your message")), "Scout's turn was told the reply").toBe(true);
  const inboxRows = (await messages(ben, inbox)).rows;
  expect(inboxRows.filter((row) => row.role === "bot" && row.kind === "text" && !row.inbox), "no turn of Ben's Chief").toEqual([]);
  expect(inboxRows.at(-1)).toMatchObject({ kind: "activity", relay: { kind: "told", email: CLEO.email } });
  expect(inboxRows.find((row) => row.id === line!.id)!.inbox!.answers).toEqual([expect.objectContaining({ by: "person", text: "Friday works for me." })]);
}, hostTimeout(240_000));

it("lands an @Ben from a shared chat in his inbox with a link back and one notification", async () => {
  script(null, "Noted.");
  const before = (await inboxLines()).length;
  await turn(cleo, scout, scout.mainThreadId ?? scout.threadId, "@Ben can you check the numbers before Friday?");
  await until(async () => (await inboxLines()).length === before + 1);
  expect((await inboxLines()).at(-1)).toMatchObject({ text: "@Ben can you check the numbers before Friday?", inbox: {
    from: { name: "Cleo" }, origin: { botId: scout.id, threadId: scout.mainThreadId ?? scout.threadId, title: "Scout" } } });
  await until(() => notifiedIn(bens, inbox).length === 2);
  expect(notifiedIn(bens, inbox)[1]!.notification).toMatchObject({ title: "Cleo mentioned you in Scout", forPerson: BEN_KEY });
  expect(bens.filter((frame) => frame.notification?.kind === "mention" && frame.notification.threadId !== inbox), "the mention's one notification is the inbox's").toEqual([]);
}, hostTimeout(120_000));

it("copies an approval Ben's bot asks into his inbox, with one notification, and Ben approves it there", async () => {
  const { requestId, threadId } = await approvalFromReporter("rm -rf ./build");
  await until(async () => (await inboxLines()).some((row) => row.card?.requestId === requestId));
  const copy = (await inboxLines()).findLast((row) => row.card?.requestId === requestId)!;
  expect(copy).toMatchObject({ kind: "options", inbox: { kind: "ask", from: { name: "Reporter" }, origin: { botId: reporter.id, threadId } } });
  await until(() => notifiedIn(bens, inbox).length === 3);
  expect(notifiedIn(bens, inbox)[2]!.notification).toMatchObject({ kind: "approval", botId: chief.id, title: "Reporter needs approval", forPerson: BEN_KEY });
  expect(bens.filter((frame) => frame.kind === "notify" && frame.notification?.botId === reporter.id), "one notification, from the inbox").toEqual([]);
  expect(notifiedIn(cleos, inbox)).toEqual([]);
  const answered = await team.as(ben, "POST", `/api/threads/${inbox}/respond`, { requestId, behavior: "allow" });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  await until(async () => Boolean((await messages(cleo, threadId)).rows.findLast((row) => row.card?.requestId === requestId)?.card?.answered));
  await until(async () => Boolean((await inboxLines()).findLast((row) => row.card?.requestId === requestId)?.card?.answered));
  await until(idle);
}, hostTimeout(120_000));

it("leaves a free/busy question for Ben himself: this build's only engine has no one-off text call for an assistant", async () => {
  const before = (await inboxLines()).length;
  await passFromScout("Are you free on Thursday at 3pm?");
  await until(async () => (await inboxLines()).length === before + 1);
  const line = (await inboxLines())[before]!;
  expect(line).toMatchObject({ text: "Are you free on Thursday at 3pm?", inbox: { replies: true } });
  expect(line.inbox!.answers, "no assistant answered for him").toBeUndefined();
  await until(() => notifiedIn(bens, inbox).length === 4);
  expect(notifiedIn(bens, inbox)[3]!.notification).toMatchObject({ title: "Message from Cleo via Scout", forPerson: BEN_KEY });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  expect(notifiedIn(bens, inbox).map((frame) => frame.notification!.title), "one notification for the question").toHaveLength(4);
  expect((await messages(cleo, cleoThread)).rows.filter((row) => row.relay?.kind === "assistant"), "nothing was answered for him").toEqual([]);

  // He answers it himself, and the answer reaches Scout, whose turn carries on.
  script(null, "Yes, after three.");
  const sent = await team.as(ben, "POST", `/api/bots/${chief.id}/messages`, { text: "I'm free after three.", threadId: inbox, replyToId: line.id });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await until(async () => (await messages(cleo, cleoThread)).rows.some((row) => row.role === "bot" && row.text === "Yes, after three."));
  expect((await inboxLines())[before]!.inbox!.answers).toEqual([expect.objectContaining({ by: "person", text: "I'm free after three." })]);
  await until(idle);
}, hostTimeout(150_000));

it("never answers a decision or a private question for Ben, and never shows an engine his private chats", async () => {
  const before = (await inboxLines()).length;
  const seen = turns().length;
  await passFromScout("Can you approve the travel budget for me?");
  await passFromScout("What has Ben told Scout in private?");
  await until(() => notifiedIn(bens, inbox).length === 6);
  const lines = (await inboxLines()).slice(before);
  expect(lines.map((row) => row.text)).toEqual(["Can you approve the travel budget for me?", "What has Ben told Scout in private?"]);
  expect(lines.every((row) => !row.inbox!.answers)).toBe(true);
  expect(notifiedIn(bens, inbox).slice(4).map((frame) => frame.notification!.title)).toEqual(["Message from Cleo via Scout", "Message from Cleo via Scout"]);
  // Nothing was asked of any engine for him, and no turn that could answer for him was told what he keeps to himself. (His
  // own private turn, below, is the one that holds the secret: it is his.)
  expect(turns().slice(seen).filter((one) => one.prompt.includes("'s assistant on Acme")), "no assistant ran").toEqual([]);
  expect(turns().slice(seen).map((one) => one.prompt).join("\n"), "nothing after his own private turn was told it").not.toContain(SECRET);
  expect(turns().slice(seen).map((one) => one.prompt).join("\n")).not.toContain("Globex");

  await passFromScout("How is your Q4 report going?");
  await until(async () => (await inboxLines()).length === before + 3);
  expect((await inboxLines()).at(-1)).toMatchObject({ text: "How is your Q4 report going?", inbox: { replies: true } });
  expect((await inboxLines()).at(-1)!.inbox!.answers, "his report's progress waits for him").toBeUndefined();
  expect((await messages(cleo, cleoThread)).rows.filter((row) => row.relay?.kind === "assistant"), "nothing was answered for him").toEqual([]);
  await until(idle);
}, hostTimeout(180_000));

it("counts the asks waiting on Ben on his inbox, live, and drops one as soon as he answers it in the bot's own chat", async () => {
  expect((await inboxTask()).openAsks, "what came before is answered or only news").toBeUndefined();
  const before = bens.length;
  const { requestId, threadId } = await approvalFromReporter("rm -rf ./dist");
  await until(async () => (await inboxTask()).openAsks === 1);
  await until(() => inboxFrames(bens.slice(before)).some((task) => task?.openAsks === 1));
  const answered = await team.as(ben, "POST", `/api/threads/${threadId}/respond`, { requestId, behavior: "deny" });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  await until(async () => (await inboxTask()).openAsks === undefined);
  await until(() => { const seen = inboxFrames(bens.slice(before)); return seen.length > 1 && seen.at(-1)!.openAsks === undefined; });
  expect((await inboxLines()).findLast((row) => row.card?.requestId === requestId)!.card!.answered, "the copy in his inbox follows").toBeTruthy();
  expect((await needsYou(ben)).filter((item) => item.botId === reporter.id)).toEqual([]);
  await until(idle);
}, hostTimeout(120_000));

it("brings an answer given through the inbox bot's own respond route to the bot that asked, after its turn ended too", async () => {
  // Reporter's turn stops on pi's own question card; the person stops the turn, and the question still waits. The ask is
  // Reporter's owner's (Ben's), because a room is the team's, so its copy lands in his inbox.
  writeFileSync(file("question-armed"), "");
  let threadId = "";
  let requestId = "";
  try {
    threadId = await askReporterInRoom("Which chart goes first", `${ASKS}: which chart goes first?`);
    await until(async () => { requestId = (await openCard(threadId, "question"))?.card?.requestId ?? ""; return Boolean(requestId); }, 30_000);
  } finally {
    rmSync(file("question-armed"), { force: true });
  }
  await until(async () => (await inboxTask()).openAsks === 1);
  expect((await team.as(cleo, "POST", `/api/bots/${reporter.id}/interrupt`, { threadId })).status).toBe(200);
  await until(idle);
  expect((await inboxTask()).openAsks, "a question nobody answered still waits once its turn is over").toBe(1);
  const answered = await team.as(ben, "POST", `/api/bots/${chief.id}/respond`, { threadId: inbox, requestId, behavior: "answer", message: "Revenue" });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  const asked = async () => (await messages(cleo, threadId)).rows.findLast((row) => row.card?.requestId === requestId)!;
  // In a room the person's answer comes back as their line there, addressed to the bot that asked.
  await until(async () => { const card = await asked(); return (await messages(cleo, threadId)).rows.some((row) => row.role === "user" && row.text === `@${reporter.name}: Revenue` && row.replyToId === card.id); });
  expect((await asked()).card!.answered, "Reporter got the answer where it asked").toBe("answer");
  await until(async () => (await inboxTask()).openAsks === undefined);
  expect(await chiefTurns(), "Ben's Chief took no turn").toEqual([]);
  await until(idle);
}, hostTimeout(120_000));

it("takes Ben's 👍 on a line in his inbox back to the bot that asked, which carries on", async () => {
  await passFromScout("Can you send me the slides by Friday?");
  const line = (await inboxLines()).findLast((row) => row.text === "Can you send me the slides by Friday?")!;
  script(null, "Great, the slides are on their way.");
  const reacted = await team.as(ben, "POST", `/api/threads/${inbox}/messages/${line.id}/reactions`, { emoji: "👍" });
  expect(reacted.status, JSON.stringify(reacted.body)).toBe(200);
  await until(async () => (await messages(cleo, cleoThread)).rows.some((row) => row.role === "bot" && row.text === "Great, the slides are on their way."));
  expect((await messages(cleo, cleoThread)).rows.findLast((row) => row.relay?.kind === "reply"))
    .toMatchObject({ text: 'Ben replied to your message ("Can you send me the slides by Friday?"): 👍', relay: { email: BEN.email } });
  expect((await inboxLines()).find((row) => row.id === line.id)!.inbox!.answers).toEqual([expect.objectContaining({ by: "person", text: "👍" })]);
  expect(await chiefTurns(), "Ben's Chief took no turn").toEqual([]);
  await until(idle);
}, hostTimeout(120_000));

it("lets a tag Ben answered in the chat it came from leave his Needs you", async () => {
  const main = scout.mainThreadId ?? scout.threadId;
  const tag = "@Ben can you confirm the Q4 numbers?";
  script(null, tag);
  await turn(cleo, scout, main, "Ask Ben to confirm the Q4 numbers.");
  const listed = async () => (await needsYou(ben)).some((item) => item.kind === "message" && item.text === tag);
  await until(listed);
  script(null, "Thanks Ben, the numbers stand.");
  await turn(ben, scout, main, "Confirmed, they are right.");
  expect(await listed()).toBe(false);
}, hostTimeout(240_000));

it("lists Ben's inbox by tab, settles an ask answered from its row, and keeps news until he marks it done", async () => {
  type Listed = { id: string; kind: string; tab: string; text: string; card?: { requestId?: string } };
  const listed = async () => (await team.as(ben, "GET", "/api/inbox")).body as { botId: string; threadId: string; rows: Listed[] };
  const before = bens.length;
  const { requestId, threadId } = await approvalFromReporter("rm -rf ./tmp");
  await until(async () => (await listed()).rows.some((row) => row.card?.requestId === requestId));
  const view = await listed();
  expect(view).toMatchObject({ botId: chief.id, threadId: inbox });
  expect(view.rows.find((row) => row.card?.requestId === requestId)).toMatchObject({ kind: "ask", tab: "needs-you" });
  expect(view.rows.filter((row) => row.tab === "needs-you").map((row) => row.card?.requestId), "only what waits on him needs him").toEqual([requestId]);
  expect(view.rows.find((row) => row.text === "Can you approve the travel budget for me?")).toMatchObject({ kind: "message", tab: "info" });
  expect(view.rows.find((row) => row.text === "The launch moved to Friday."), "answered from the inbox").toMatchObject({ tab: "done" });
  const ask = view.rows.find((row) => row.card?.requestId === requestId)!;
  expect((await team.as(ben, "POST", `/api/inbox/${ask.id}/done`)).status, "an ask is settled by its answer").toBe(409);

  const answered = await team.as(ben, "POST", `/api/threads/${threadId}/respond`, { requestId, behavior: "allow" });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  await until(async () => (await listed()).rows.find((row) => row.id === ask.id)?.tab === "done");
  expect((await inboxTask()).openAsks).toBeUndefined();
  await until(() => inboxFrames(bens.slice(before)).some((task, index, all) => index > 0 && (task?.inboxChangedAt ?? 0) > (all[0]?.inboxChangedAt ?? 0)));

  const news = view.rows.find((row) => row.text === "Can you approve the travel budget for me?")!;
  const marked = await team.as(ben, "POST", `/api/inbox/${news.id}/done`);
  expect(marked.status, JSON.stringify(marked.body)).toBe(200);
  expect((marked.body as { rows: Listed[] }).rows.find((row) => row.id === news.id)).toMatchObject({ tab: "done" });
  expect((await team.as(cleo, "POST", `/api/inbox/${news.id}/done`)).status, "only his own").toBe(404);
  await until(idle);
}, hostTimeout(120_000));

it("opens Ben's inbox on his first arrival of the day, and forgets it once he leaves", async () => {
  await passFromScout("Can you book the meeting room for Friday?");
  const arrived = await team.as(ben, "POST", "/api/presence/active", { source: "desktop" });
  expect(arrived.body.open, JSON.stringify(arrived.body)).toEqual({ botId: chief.id, threadId: inbox });
  expect((await team.as(ben, "POST", "/api/presence/active", { source: "desktop" })).body.open).toBeUndefined();
  const left = await team.signed("POST", "/api/cloud/team/member-left", { email: BEN.email });
  expect(left.status, JSON.stringify(left.body)).toBe(200);
  const bearer = await team.capability(scout.id, cleoThread);
  const refused = await fetch(`${team.base}/api/internal/people/message`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ to: "Ben", message: "Still there?" }) });
  expect(refused.status).toBe(410);
}, hostTimeout(60_000));

it("has none of it on a My Cloud: no inbox, no person route", async () => {
  const solo = (await fx.onCloud("POST", "/api/bots", { name: "Solo" })).body.bot as Bot;
  expect(solo.tasks?.some((task) => task.inbox || task.openAsks !== undefined) ?? false).toBe(false);
  expect(((await fx.onCloud("GET", "/api/needs-you")).body.items as Array<{ kind: string }>).filter((item) => item.kind === "message")).toEqual([]);
  expect((await fx.onCloud("GET", "/api/notifications")).body.notifications.filter((entry: { forPerson?: string }) => entry.forPerson)).toEqual([]);
}, hostTimeout(60_000));
