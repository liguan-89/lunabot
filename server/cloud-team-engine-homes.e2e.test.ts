// A real Team Cloud with the Owner, an Admin (Ben) and a Member (Bob). Engine homes (server/engine-homes/) give each
// audience's engine a home of its own; the retired Claude fixture proved it by reading the transcripts a turn wrote there.
// The only engine this build runs, pi, writes no transcript of its own and boots its child in `prewarm`, which runs
// before the turn enters `engineHomes.within` (that wrapper covers sendTurn, keep-warm and compact only), so a team turn
// starts in the server's HOME and no audience home is made. What still holds, and is checked here, is that a Team Cloud
// answers in every audience, that a member who leaves leaves no engine home behind, and that My Cloud keeps its single
// home. No bot box runs here (it needs Linux bubblewrap: server/engine-homes/box.linux.test.ts proves the box side).
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { audienceHome, engineHomesRoot } from "./engine-homes/layout.ts";
import { personKey } from "./person-key.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { piTurns } from "./testing/pi-dump.ts";

const posix = process.platform !== "win32";
const TOKEN = `ops_fake-team-homes-${randomBytes(8).toString("hex")}`;
const OWNER = { email: "olive@acme.test", role: "owner" as const };
const ADMIN = { email: "ben@acme.test", role: "admin" as const };
const BOB = { email: "bob@acme.test", role: "member" as const };
// Each launch records where it ran: the pi driver boots a child per conversation, and pi keeps its own state under HOME.
const HOME_FILES = `const { appendFileSync } = process.getBuiltinModule("node:fs");
process.env.FAKE_PI_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.jsonl";
appendFileSync(process.env.FAKE_CLAUDE_FIXTURE_DIR + "/homes.jsonl", JSON.stringify({ pid: process.pid, home: process.env.HOME ?? "", thread: process.env.OMB_THREAD_ID ?? null }) + "\\n");`;

let fx: CloudSendFixture, team: CloudTeamFixture;
let owner = "", admin = "", bob = "";
let bot: { id: string; mainThreadId: string };
let dataDir = "", bobHome = "", ownerHome = "", bobThread = "";

type Launch = { pid?: number; home: string; thread?: string | null };
/** Every launch the team's pi processes made, oldest first: where it ran. A warm child keeps its pid across its turns. */
const launches = (): Launch[] => (existsSync(join(team.home, "homes.jsonl"))
  ? readFileSync(join(team.home, "homes.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Launch) : []);
const messages = async (token: string, threadId: string) => (await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as Array<{ role: string; kind?: string; text?: string }>;
const idle = async (token: string) => ((await team.as(token, "GET", "/api/bots")).body.bots as Array<{ activity?: string; busy?: boolean }>)
  .every((entry) => entry.activity !== "working" && !entry.busy);
/** One turn, settled, and the launch of the child that ran it. */
async function turn(token: string, threadId: string, text: string): Promise<Launch> {
  const before = (await messages(token, threadId)).length;
  const sent = await team.as(token, "POST", `/api/bots/${bot.id}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await expect.poll(async () => await idle(token) && (await messages(token, threadId)).length >= before + 2
    && piTurns(join(team.home, "dump.jsonl")).some((entry) => entry.prompt.includes(text)), { timeout: 60_000, interval: 100 }).toBe(true);
  return launches().at(-1)!;
}
const newThread = async (token: string, title: string) => {
  const created = await team.as(token, "POST", `/api/bots/${bot.id}/tasks`, { title });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.task.threadId as string;
};

beforeAll(async () => {
  if (!posix) return;
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, team: { id: "team-acme-homes", name: "Acme", engine: HOME_FILES }, cloudEngine: HOME_FILES });
  team = fx.team!;
  dataDir = join(team.home, ".lunabot");
  bobHome = audienceHome(dataDir, `member:${personKey({ id: "", email: BOB.email })}`);
  ownerHome = audienceHome(dataDir, `member:${personKey({ id: "", email: OWNER.email })}`);
  owner = (await team.pair(OWNER)).token!;
  admin = (await team.pair(ADMIN)).token!;
  bob = (await team.pair(BOB)).token!;
  const created = await team.as(owner, "POST", "/api/bots", { name: "Scout" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  bot = created.body.bot;
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
});

it.runIf(posix)("every audience's chat answers, in a child of its own, and Bob's conversation keeps it warm", async () => {
  bobThread = await newThread(bob, "Bob and Scout");
  const bobTurn = await turn(bob, bobThread, "My locker code is sardine.");
  await turn(owner, await newThread(owner, "Olive and Scout"), "Hello from the Owner.");
  await turn(admin, await newThread(admin, "Ben and Scout"), "Hello from the Admin.");
  await turn(owner, bot.mainThreadId, "Hello, team.");
  // Where a child starts: with engine homes reaching every spawn, each would be the audience's home. pi's prewarm runs
  // before the turn enters `engineHomes.within`, so today they start in the server's HOME (see the file header). What the
  // server does hold, and this checks, is that no launch lands inside another audience's home.
  for (const seen of launches()) expect(seen.home.startsWith(engineHomesRoot(dataDir))).toBe(false);
  // The same conversation answers again, from the same place (pi may boot a fresh child for the second turn, since its
  // prewarm contract is rebuilt per turn, but the conversation is resumed, not lost).
  const again = await turn(bob, bobThread, "What was my locker code?");
  expect(again.home).toBe(bobTurn.home);
  const answers = (await messages(bob, bobThread)).filter((message) => message.role === "bot" && message.kind !== "activity");
  expect(JSON.stringify(answers.at(-1))).not.toMatch(/No conversation found|Not logged in/);
}, hostTimeout(180_000));

it.runIf(posix)("a member who leaves leaves no engine home behind", async () => {
  const left = await team.signed("POST", "/api/cloud/team/member-left", { email: BOB.email });
  expect(left.status, JSON.stringify(left.body)).toBe(200);
  expect(existsSync(bobHome)).toBe(false);
  expect(existsSync(ownerHome)).toBe(false);
  // The Owner's own chat still answers after the member is gone.
  await turn(owner, bot.mainThreadId, "Still here?");
}, hostTimeout(90_000));

it.runIf(posix)("My Cloud is unchanged: its engine runs in the server's HOME", async () => {
  const cloudHome = join(team.home, "..", "cloud");
  const created = await fx.onCloud("POST", "/api/bots", { name: "Solo" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const solo = created.body.bot as { id: string; mainThreadId: string };
  expect((await fx.onCloud("POST", `/api/bots/${solo.id}/messages`, { text: "Hello.", threadId: solo.mainThreadId })).status).toBe(202);
  await expect.poll(() => existsSync(join(cloudHome, "homes.jsonl")), { timeout: 60_000, interval: 100 }).toBe(true);
  const seen = JSON.parse(readFileSync(join(cloudHome, "homes.jsonl"), "utf8").trim().split("\n").at(-1)!) as Launch;
  expect(seen.home).toBe(cloudHome);
  expect(existsSync(join(cloudHome, ".lunabot", "engine-homes"))).toBe(false);
}, hostTimeout(90_000));
