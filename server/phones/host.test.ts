// The host's second gate over screen writes: a control the word list names as irreversible runs only on an approval of
// that exact step, and only once; everything else reaches the phone exactly as it did before. The loop guard rides the
// same host: the same action on a screen that does not move is nudged in the answer, then refused. The per-turn ledger
// keeps what each call read, so the answer check and the route recorder work from the same evidence.
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Route } from "../../shared/route-replay.ts";
import { flushDecisionLog, readDecisions } from "../decision-log.ts";
import { PhoneRoutes, ownerDirectoryName } from "../phone-routes.ts";
import type { BotRecord } from "../store.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import type { PhoneBot } from "./access.ts";
import { MAX_CONFIRM_TURNS, PhoneConfirms } from "./confirm.ts";
import { createPhoneHost, verifyPhoneTurn, type PhoneHostDeps } from "./host.ts";
import { PhoneJobs, type PhoneJobDelivery, type PhoneJobOutcome } from "./jobs.ts";
import { PhoneRegistry, type PhoneRegistration } from "./registry.ts";
import type { PhoneToolsList } from "./rpc.ts";
import { PhoneSteer } from "./steer.ts";
import type { PhoneToolResult } from "./tools.ts";

const OWNER = "owner";
const PIXEL = "companion:pixel";
const APP = "com.example.shop";
const TURN = { botId: "chief", threadId: "thread-1", generation: "gen-1" };

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) { await flushDecisionLog(dir); await removeTempDir(dir); }
});

const registration = (capabilities: PhoneRegistration["capabilities"]): PhoneRegistration =>
  ({ installId: "install-pixel", name: "Work Pixel", platform: "android", appVersion: "1.6.0", timeZone: "Asia/Shanghai", capabilities });
const call = (name: string, args: Record<string, unknown> = {}) => ({ method: "tools/call", params: { name, arguments: args } });
const text = (result: PhoneToolsList | PhoneToolResult) =>
  (result as PhoneToolResult).content.map((item) => (item.type === "text" ? item.text : "")).join(" ");

const PAY = {
  topPackage: APP,
  elements: [
    { ref: "e1", text: "付款", bounds: [0, 900, 400, 960] },
    { ref: "e2", text: "合计 ¥39.90", bounds: [0, 800, 400, 840] },
    { ref: "e3", text: "返回", bounds: [0, 40, 120, 100] },
  ],
};
const DELETE = {
  topPackage: APP,
  elements: [
    { ref: "e1", text: "旧照片", bounds: [0, 100, 400, 200] },
    { ref: "e2", text: "删除", bounds: [0, 300, 400, 360] },
  ],
};
const ORDER = {
  topPackage: APP,
  elements: [
    { ref: "e1", text: "合计 ¥39.90", bounds: [0, 800, 400, 840] },
    { ref: "e2", text: "去结算", bounds: [0, 900, 400, 960] },
  ],
};

function harness(options: { steer?: PhoneSteer; routes?: boolean; verifyMode?: () => "off" | "log"; intent?: PhoneHostDeps["intent"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-phone-host-"));
  dirs.push(dir);
  const registry = new PhoneRegistry(join(dir, "phones.json"));
  const jobs = new PhoneJobs();
  const confirm = new PhoneConfirms();
  const bot = { id: "chief", name: "Luna Bot", color: "teal", phoneApps: { phoneUi: "write" } } as BotRecord;
  /** A recorder over this harness's own temp folder, so no test touches the real DATA_DIR. */
  const routes = options.routes ? new PhoneRoutes({ root: join(dir, "phone-routes"), enabled: true }) : undefined;
  const host = createPhoneHost({
    registry, jobs, dataDir: dir, bot: () => bot, turnOwner: () => OWNER, inRoom: () => false,
    appendMessage: () => {}, active: () => true, confirm,
    holdOutbound: async () => ({ ok: true, approved: true }),
    approvalMode: () => "ask",
    ...(options.verifyMode ? { verifyMode: options.verifyMode } : {}),
    ...(options.steer ? { steer: options.steer } : {}),
    ...(options.intent ? { intent: options.intent } : {}),
    ...(routes ? { routes } : {}),
  });
  registry.register(PIXEL, OWNER, registration({ phoneUi: "full" }));
  const handle = (body: unknown, turn: { botId: string; threadId: string; generation: string } = TURN) => host.handle(body, turn, () => {});
  return { registry, jobs, confirm, handle, host, dir, routes };
}

/** The phone's side of one job: take it from the long poll, lease it and answer. */
async function answerNext(jobs: PhoneJobs, answer: PhoneJobOutcome): Promise<PhoneJobDelivery> {
  const job = await jobs.poll(PIXEL);
  if (!job) throw new Error("no job reached the phone");
  expect(jobs.lease(PIXEL, job.id)).toBe(true);
  jobs.complete(PIXEL, job.id, answer);
  return job;
}

/** Observe a screen, so the gate has one to read the next control against. */
async function see(h: ReturnType<typeof harness>, screen: unknown): Promise<void> {
  const pending = h.handle(call("PHONE_UI_OBSERVE"));
  await answerNext(h.jobs, { ok: true, result: screen });
  expect((await pending as PhoneToolResult).isError).toBeUndefined();
}

describe("the irreversible-control gate over a screen write", () => {
  it("runs a tap on 删除 the approved card covers, and asks the phone for the job", async () => {
    const h = harness();
    await see(h, DELETE);
    const request = vi.spyOn(h.jobs, "request");
    const tap = h.handle(call("PHONE_UI_TAP", { ref: "e2" }));
    const job = await answerNext(h.jobs, { ok: true, result: { tapped: true } });
    expect(job).toMatchObject({ tool: "PHONE_UI_TAP", arguments: { ref: "e2" } });
    expect((await tap as PhoneToolResult).isError).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("refuses a tap on 付款 even with the card approved, before any job reaches the phone", async () => {
    const h = harness();
    await see(h, PAY);
    const request = vi.spyOn(h.jobs, "request");
    const refused = await h.handle(call("PHONE_UI_TAP", { ref: "e1" })) as PhoneToolResult;
    expect(refused).toMatchObject({ isError: true, structuredContent: { code: "denied" } });
    expect(text(refused)).toContain('tapping 付款 is the irreversible action "pay"');
    expect(text(refused)).toContain("make the payment themselves");
    expect(request).not.toHaveBeenCalled();
  });

  it("lets a tap the word list does not name through, as before", async () => {
    const h = harness();
    await see(h, PAY);
    const back = h.handle(call("PHONE_UI_TAP", { ref: "e3" }));
    expect((await answerNext(h.jobs, { ok: true, result: { tapped: true } })).arguments).toEqual({ ref: "e3" });
    expect((await back as PhoneToolResult).isError).toBeUndefined();
    // Observe, back and a coordinate tap on no element are not this gate's to judge either.
    for (const [tool, args] of [["PHONE_UI_BACK", {}], ["PHONE_UI_OBSERVE", {}], ["PHONE_UI_TAP_AT", { x: 5, y: 5 }]] as const) {
      const pending = h.handle(call(tool, args));
      await answerNext(h.jobs, { ok: true, result: tool === "PHONE_UI_OBSERVE" ? PAY : { ok: true } });
      expect((await pending as PhoneToolResult).isError, tool).toBeUndefined();
    }
  });

  it("uses up the card's approval on the first delete, so a second one needs the person", async () => {
    const h = harness();
    await see(h, DELETE);
    const first = h.handle(call("PHONE_UI_TAP", { ref: "e2" }));
    await answerNext(h.jobs, { ok: true, result: { tapped: true } });
    expect((await first as PhoneToolResult).isError).toBeUndefined();
    const request = vi.spyOn(h.jobs, "request");
    const again = await h.handle(call("PHONE_UI_TAP", { ref: "e2" })) as PhoneToolResult;
    expect(again).toMatchObject({ isError: true, structuredContent: { code: "denied" } });
    expect(text(again)).toContain('tapping 删除 is the irreversible action "delete"');
    expect(text(again)).toContain("Ask the person again");
    expect(request).not.toHaveBeenCalled();
  });

  it("runs the same delete in a second turn of the same thread, with a fresh card", async () => {
    const h = harness();
    await see(h, DELETE);
    const first = h.handle(call("PHONE_UI_TAP", { ref: "e2" }));
    await answerNext(h.jobs, { ok: true, result: { tapped: true } });
    expect((await first as PhoneToolResult).isError).toBeUndefined();
    // The next turn in the same conversation: the phone's screen stands, the spent card and its grant do not, so the
    // same tap is approved again rather than refused as spent.
    const nextTurn = { ...TURN, generation: "gen-2" };
    const second = h.handle(call("PHONE_UI_TAP", { ref: "e2" }), nextTurn);
    const job = await answerNext(h.jobs, { ok: true, result: { tapped: true } });
    expect(job).toMatchObject({ tool: "PHONE_UI_TAP", arguments: { ref: "e2" } });
    const result = await second as PhoneToolResult;
    expect(result.isError).toBeUndefined();
    expect(text(result)).not.toContain("already used in this task");
  });

  it("refuses a run that carries a 付款 tap, naming that step", async () => {
    const h = harness();
    await see(h, PAY);
    const request = vi.spyOn(h.jobs, "request");
    const run = await h.handle(call("PHONE_UI_RUN", { commands: [{ op: "tap", ref: "e3" }, { op: "tap", ref: "e1" }] })) as PhoneToolResult;
    expect(run).toMatchObject({ isError: true, structuredContent: { code: "denied" } });
    expect(text(run)).toContain("PHONE_UI_RUN includes tapping 付款");
    expect(text(run)).toContain('"pay"');
    expect(text(run)).toContain("never approved for a bot");
    expect(request).not.toHaveBeenCalled();
  });

  it("runs a run whose steps the word list does not name", async () => {
    const h = harness();
    await see(h, PAY);
    const commands = [{ op: "launch", app: APP }, { op: "scroll", direction: "down" }, { op: "back" }];
    const run = h.handle(call("PHONE_UI_RUN", { commands }));
    const job = await answerNext(h.jobs, { ok: true, result: { steps: [], stopped: "done" } });
    expect(job).toMatchObject({ tool: "PHONE_UI_RUN", arguments: { commands } });
    expect((await run as PhoneToolResult).isError).toBeUndefined();
  });

  it("runs an approved 去结算, the grant bound to the total the screen showed", async () => {
    const h = harness();
    await see(h, ORDER);
    const pending = h.handle(call("PHONE_UI_TAP", { ref: "e2" }));
    const job = await answerNext(h.jobs, { ok: true, result: { tapped: true } });
    expect(job).toMatchObject({ tool: "PHONE_UI_TAP", arguments: { ref: "e2" } });
    expect((await pending as PhoneToolResult).isError).toBeUndefined();
  });

  it("logs the gate's refusal as an auto-denied outbound decision with the step's risk grade", async () => {
    const h = harness();
    await see(h, PAY);
    const refused = await h.handle(call("PHONE_UI_TAP", { ref: "e1" })) as PhoneToolResult;
    expect(refused).toMatchObject({ isError: true, structuredContent: { code: "denied" } });
    await flushDecisionLog(h.dir);
    const rows = readDecisions(h.dir, 10).filter((row) => row.tool === "mcp__device__PHONE_UI_TAP");
    expect(rows).toEqual([expect.objectContaining({
      threadId: TURN.threadId, botId: "chief", decision: "auto-denied", source: "outbound", rule: "phone-risk:irreversible",
    })]);
    expect(rows[0]!.summary).toContain("tapping 付款");
  });

  it("reads an enter key as a send and refuses it on a payment screen", async () => {
    const h = harness();
    await see(h, PAY);
    const request = vi.spyOn(h.jobs, "request");
    const refused = await h.handle(call("PHONE_UI_KEY", { key: "enter" })) as PhoneToolResult;
    expect(refused).toMatchObject({ isError: true, structuredContent: { code: "denied" } });
    expect(text(refused)).toContain('pressing the enter key is the irreversible action "send"');
    expect(request).not.toHaveBeenCalled();
    // The back key is not a control.
    const back = h.handle(call("PHONE_UI_KEY", { key: "back" }));
    await answerNext(h.jobs, { ok: true, result: { ok: true } });
    expect((await back as PhoneToolResult).isError).toBeUndefined();
  });

  it("reads a malformed observe result as an empty screen and does not throw", async () => {
    const h = harness();
    await see(h, { displayId: 3, elements: "not a list" });
    await see(h, { topPackage: APP, elements: [null, "付款", 7] });
    // Nothing to classify, so the tap reaches the phone as it always did.
    const tap = h.handle(call("PHONE_UI_TAP", { ref: "e1" }));
    await answerNext(h.jobs, { ok: true, result: { tapped: true } });
    expect((await tap as PhoneToolResult).isError).toBeUndefined();
  });
});

/** A screen with nothing irreversible on it, so only the loop guard has an opinion about a tap on e1. */
const HOME = {
  topPackage: APP,
  elements: [
    { ref: "e1", text: "下一页", bounds: [0, 900, 400, 960] },
    { ref: "e2", text: "搜索", bounds: [0, 40, 400, 100] },
  ],
};
/** The same screen a page later: the fingerprint differs, which is what the guard reads as progress. */
const page = (index: number) => ({ ...HOME, elements: [{ ...HOME.elements[0]!, text: `第 ${index} 页` }, HOME.elements[1]!] });

/** Tap e1 and answer with the screen the phone is left on. */
async function tapAnswering(h: ReturnType<typeof harness>, screen: unknown): Promise<PhoneToolResult> {
  const pending = h.handle(call("PHONE_UI_TAP", { ref: "e1" }));
  await answerNext(h.jobs, { ok: true, result: screen });
  return await pending as PhoneToolResult;
}

describe("the loop guard over a screen-driving call", () => {
  it("warns on the third identical tap on a screen that does not move, and the tap still runs", async () => {
    const h = harness();
    await see(h, HOME);
    const request = vi.spyOn(h.jobs, "request");
    const first = await tapAnswering(h, HOME);
    const second = await tapAnswering(h, HOME);
    const third = await tapAnswering(h, HOME);
    // The first two say nothing about a loop; the third carries the nudge in the text the model reads.
    expect(text(first)).not.toContain("Ways out:");
    expect(text(second)).not.toContain("Ways out:");
    expect(text(third)).toContain("You have done the same action on the same screen 3 times");
    expect(text(third)).toContain("Ways out:");
    expect(text(third)).toContain("re-read the screen");
    expect(third.isError).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("refuses the twelfth identical tap before any job is requested", async () => {
    const h = harness();
    await see(h, HOME);
    const results: PhoneToolResult[] = [];
    for (let index = 1; index <= 12; index += 1) {
      const pending = h.handle(call("PHONE_UI_TAP", { ref: "e1" }));
      if (index === 12) { results.push(await pending as PhoneToolResult); break; }
      await answerNext(h.jobs, { ok: true, result: HOME });
      results.push(await pending as PhoneToolResult);
    }
    const refused = results[11]!;
    expect(refused).toMatchObject({ isError: true, structuredContent: { code: "denied" } });
    expect(text(refused)).toContain("stuck on the phone (repeating_action)");
    expect(text(refused)).toContain("Stop here and report");
    expect(results.slice(0, 11).every((result) => result.isError === undefined)).toBe(true);
    // The stop holds for the rest of the turn: another tap is refused without asking the phone.
    const request = vi.spyOn(h.jobs, "request");
    const again = await h.handle(call("PHONE_UI_TAP", { ref: "e1" })) as PhoneToolResult;
    expect(again).toMatchObject({ isError: true, structuredContent: { code: "denied" } });
    expect(request).not.toHaveBeenCalled();
  });

  it("never warns a tap whose screen changes every time", async () => {
    const h = harness();
    await see(h, page(0));
    for (let index = 1; index <= 15; index += 1) {
      const result = await tapAnswering(h, page(index));
      expect(result.isError, `tap ${index}`).toBeUndefined();
      expect(text(result), `tap ${index}`).not.toContain("Ways out:");
    }
  });

  it("never counts a read, however often the same screen is observed", async () => {
    const h = harness();
    const request = vi.spyOn(h.jobs, "request");
    for (let index = 1; index <= 20; index += 1) {
      const pending = h.handle(call("PHONE_UI_OBSERVE"));
      await answerNext(h.jobs, { ok: true, result: HOME });
      const result = await pending as PhoneToolResult;
      expect(result.isError, `observe ${index}`).toBeUndefined();
      expect(text(result), `observe ${index}`).not.toContain("Ways out:");
    }
    expect(request).toHaveBeenCalledTimes(20);
  });

  it("starts a fresh turn without a guard, so its first repeat is not refused", async () => {
    const h = harness();
    await see(h, HOME);
    for (let index = 1; index <= 11; index += 1) await tapAnswering(h, HOME);
    const refused = await h.handle(call("PHONE_UI_TAP", { ref: "e1" })) as PhoneToolResult;
    expect(refused).toMatchObject({ isError: true });
    // The same conversation in a new turn: the phone's screen stands, the loop guard does not.
    const nextTurn = { ...TURN, generation: "gen-2" };
    const pending = h.handle(call("PHONE_UI_TAP", { ref: "e1" }), nextTurn);
    await answerNext(h.jobs, { ok: true, result: HOME });
    expect((await pending as PhoneToolResult).isError).toBeUndefined();
  });

  it("drops the oldest turn's guard rather than growing without bound", async () => {
    const h = harness();
    await see(h, HOME);
    for (let index = 0; index <= MAX_CONFIRM_TURNS; index += 1) {
      h.confirm.noteGuard({ threadId: `other-${index}`, botId: "chief", generation: "gen-1" }, PIXEL, "PHONE_UI_TAP", { ref: "e1" });
    }
    expect(h.confirm.guardSize).toBe(MAX_CONFIRM_TURNS);
    // The newest turn's guard is still there; resetting it frees its entry, so the map is not stuck at the cap.
    h.confirm.reset({ threadId: `other-${MAX_CONFIRM_TURNS}`, botId: "chief" });
    expect(h.confirm.guardSize).toBe(MAX_CONFIRM_TURNS - 1);
  });
});

describe("a phone job cut short by the person's new message", () => {
  it("answers skipped_for_new_message for a turn already steered, and still leaves the job to the phone", async () => {
    const steer = new PhoneSteer();
    const h = harness({ steer });
    const request = vi.spyOn(h.jobs, "request");
    steer.noteUserMessage(TURN, TURN.generation);
    const skipped = await h.handle(call("PHONE_UI_OBSERVE")) as PhoneToolResult;
    expect(skipped).toMatchObject({ isError: true, structuredContent: { error: "skipped_for_new_message" } });
    expect(text(skipped)).toBe("skipped_for_new_message");
    expect(request).toHaveBeenCalledTimes(1);
    // Nothing was cancelled: the job is still there for the phone, and only its answer is unread.
    const job = await h.jobs.poll(PIXEL);
    expect(job).toMatchObject({ tool: "PHONE_UI_OBSERVE" });
    expect(h.jobs.lease(PIXEL, job!.id)).toBe(true);
    h.jobs.complete(PIXEL, job!.id, { ok: true, result: HOME });
    expect(h.jobs.busy(PIXEL)).toBe(false);
  });

  it("ends a wait under way at once, and the job still reaches the phone and finishes there", async () => {
    const steer = new PhoneSteer();
    const h = harness({ steer });
    const pending = h.handle(call("PHONE_UI_OBSERVE"));
    steer.noteUserMessage(TURN, TURN.generation);
    const skipped = await pending as PhoneToolResult;
    expect(skipped).toMatchObject({ isError: true, structuredContent: { error: "skipped_for_new_message" } });
    // Nothing was cancelled: the phone still takes the job, leases it and answers it.
    const job = await h.jobs.poll(PIXEL);
    expect(job).toMatchObject({ tool: "PHONE_UI_OBSERVE" });
    expect(h.jobs.lease(PIXEL, job!.id)).toBe(true);
    h.jobs.complete(PIXEL, job!.id, { ok: true, result: HOME });
    expect(h.jobs.busy(PIXEL)).toBe(false);
  });

  it("leaves the loop guard where it stood, so the repeat it was on still counts", async () => {
    const steer = new PhoneSteer();
    const h = harness({ steer });
    await see(h, HOME);
    expect((await tapAnswering(h, HOME)).isError).toBeUndefined();
    expect((await tapAnswering(h, HOME)).isError).toBeUndefined();
    // The third tap of the same action on a screen that does not move is cut short before its answer is recorded; the
    // job it queued is still the phone's to run.
    const pending = h.handle(call("PHONE_UI_TAP", { ref: "e1" }));
    steer.noteUserMessage(TURN, TURN.generation);
    expect(await pending as PhoneToolResult).toMatchObject({ isError: true, structuredContent: { error: "skipped_for_new_message" } });
    await answerNext(h.jobs, { ok: true, result: HOME });
    // A guard reset would make this the first repeat and say nothing; it is still the third, so it is nudged.
    const fourth = await tapAnswering(h, HOME);
    expect(fourth.isError).toBeUndefined();
    expect(text(fourth)).toContain("You have done the same action on the same screen 3 times");
  });

  it("waits out a job exactly as before when no message came", async () => {
    const plain = harness();
    const withSteer = harness({ steer: new PhoneSteer() });
    const observed = (h: ReturnType<typeof harness>) => {
      const pending = h.handle(call("PHONE_UI_OBSERVE"));
      return answerNext(h.jobs, { ok: true, result: HOME }).then(async () => await pending);
    };
    expect(await observed(withSteer)).toEqual(await observed(plain));
  });
});

/** How many route files an owner has under the harness's temp folder; zero when the store never wrote one. */
function routeFiles(dir: string): number {
  const owner = join(dir, "phone-routes", ownerDirectoryName(OWNER));
  return existsSync(owner) ? readdirSync(owner).length : 0;
}

/** A screen with one password box and one pairing-code field: neither may reach the ledger's text. */
const SECRETS = {
  topPackage: APP,
  elements: [
    { ref: "e1", text: "登录", bounds: [0, 0, 400, 100] },
    { ref: "e2", text: "hunter2", password: true, bounds: [0, 100, 400, 200] },
    { ref: "e3", text: "", description: "验证码", bounds: [0, 200, 400, 260], editable: true },
  ],
};

describe("the per-turn evidence ledger", () => {
  it("keeps one entry per screen-carrying call, and a refused call is evidence but not a step", async () => {
    const h = harness({ routes: true });
    await see(h, HOME);
    await see(h, PAY);
    const refused = await h.handle(call("PHONE_UI_TAP", { ref: "e1" })) as PhoneToolResult;
    expect(refused).toMatchObject({ isError: true, structuredContent: { code: "denied" } });
    const evidence = h.host.evidenceFor(TURN);
    expect(evidence).toHaveLength(3);
    expect(evidence[0]).toMatchObject({ tool: "PHONE_UI_OBSERVE", ok: true });
    expect(evidence[0]!.text).toContain("下一页");
    // The refused tap never ran, so it read nothing and the route recorder is never offered it as a step.
    expect(evidence[2]).toMatchObject({ tool: "PHONE_UI_TAP", ok: false, text: "" });
    const ended = h.host.endTurn(TURN, { goal: "付款", ownerKey: OWNER });
    expect(ended.route).toBeNull();
    expect(routeFiles(h.dir)).toBe(0);
    // The evidence is handed over once and not kept afterwards.
    expect(h.host.evidenceFor(TURN)).toEqual([]);
  });

  it("resolves a tap's ref to the element the person was looking at", async () => {
    const h = harness({ routes: true });
    await see(h, HOME);
    expect((await tapAnswering(h, page(1))).isError).toBeUndefined();
    // The tap's answer is the screen after it; the ref it named only exists on the screen before, which is the one the
    // ledger kept.
    expect(h.host.lastScreen(PIXEL)?.elements[0]?.text).toBe("第 1 页");
    const ended = h.host.endTurn(TURN, { goal: "打开下一页", ownerKey: OWNER });
    expect(ended.route).not.toBeNull();
    const saved = h.routes!.list(OWNER)[0]!;
    expect(saved.steps[0]!.target).not.toBeNull();
    // The goal names the control, so the target's label is the request's slot rather than a pinned word.
    expect(saved.steps[0]!.target!.name).toBe("{1}");
  });

  it("keeps a password box and a pairing-code field out of the ledger's text", async () => {
    const h = harness();
    await see(h, SECRETS);
    const evidence = h.host.evidenceFor(TURN);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.text).toBe("登录");
    expect(evidence[0]!.text).not.toContain("hunter2");
    expect(evidence[0]!.text).not.toContain("验证码");
  });

  it("records exactly one route for a clean turn, and none for a stopped or a failed one", async () => {
    const clean = harness({ routes: true });
    await see(clean, HOME);
    await tapAnswering(clean, page(1));
    expect(clean.host.endTurn(TURN, { goal: "打开下一页", ownerKey: OWNER }).route).not.toBeNull();
    expect(routeFiles(clean.dir)).toBe(1);

    const stopped = harness({ routes: true });
    await see(stopped, HOME);
    await tapAnswering(stopped, page(1));
    expect(stopped.host.endTurn(TURN, { goal: "打开下一页", ownerKey: OWNER, stopped: true }).route).toBeNull();
    expect(routeFiles(stopped.dir)).toBe(0);

    const failed = harness({ routes: true });
    await see(failed, HOME);
    const pending = failed.handle(call("PHONE_UI_TAP", { ref: "e1" }));
    await answerNext(failed.jobs, { ok: false, error: "the tap did not land" });
    expect((await pending as PhoneToolResult).isError).toBe(true);
    expect(failed.host.endTurn(TURN, { goal: "打开下一页", ownerKey: OWNER }).route).toBeNull();
    expect(routeFiles(failed.dir)).toBe(0);
  });
});

describe("the route a matching request is told about", () => {
  const BOT: PhoneBot = { id: "chief", name: "Luna Bot", phoneApps: { phoneUi: "write" } };
  /** A goal long enough that the template it leaves clears the matcher's similarity floor. */
  const GOAL = "帮我在备忘录里打开下一页";
  const REQUEST = "帮我在备忘录里打开第 2 页";

  const record = async (h: ReturnType<typeof harness>): Promise<void> => {
    await see(h, HOME);
    await tapAnswering(h, page(1));
    expect(h.host.endTurn(TURN, { goal: GOAL, ownerKey: OWNER }).route).not.toBeNull();
  };

  it("offers the one fitting route as a prompt part, its slot filled from the request", async () => {
    const h = harness({ routes: true });
    await record(h);
    const parts = h.host.parts(BOT, OWNER, "computer", REQUEST);
    const part = parts.find((entry) => entry.id === "device-route");
    expect(part?.text).toContain('("帮我在备忘录里打开{1}")');
    expect(part?.text).toContain("It starts on com.example.shop.");
    expect(part?.text).toContain('tap "第 2 页"');
  });

  it("offers nothing when two routes fit, rather than guessing between them", async () => {
    const h = harness({ routes: true });
    await record(h);
    // A second stored route whose template the same request also fits: the choice needs a classifier, so no part.
    const owner = join(h.dir, "phone-routes", ownerDirectoryName(OWNER));
    mkdirSync(owner, { recursive: true });
    const other: Route = {
      id: "other", template: "帮我在备忘录里{1}", slots: 1, packages: [], appVersions: {},
      steps: [{ tool: "PHONE_UI_BACK", args: {}, target: null, before: { packageName: null, texts: [] }, after: { packageName: null, texts: [] } }],
      successes: 0, consecutiveMisses: 0, missStep: null, disabled: false, lastUsedMs: 0,
    };
    writeFileSync(join(owner, "other.json"), JSON.stringify(other));
    const parts = h.host.parts(BOT, OWNER, "computer", REQUEST);
    expect(parts.find((entry) => entry.id === "device-route")?.text ?? "").toBe("");
  });

  it("offers nothing without a recorder, a request, or a fit", async () => {
    const plain = harness();
    expect(plain.host.parts(BOT, OWNER, "computer", REQUEST).find((entry) => entry.id === "device-route")?.text ?? "").toBe("");
    const h = harness({ routes: true });
    await record(h);
    expect(h.host.parts(BOT, OWNER, "computer").find((entry) => entry.id === "device-route")?.text ?? "").toBe("");
    expect(h.host.parts(BOT, OWNER, "computer", "把手机关机").find((entry) => entry.id === "device-route")?.text ?? "").toBe("");
  });

  it("keeps the route out on a discussion or an unreadable verdict, and tells it on read or act", async () => {
    const h = harness({ routes: true });
    await record(h);
    for (const intent of ["discuss", null] as const) {
      expect(h.host.parts(BOT, OWNER, "computer", REQUEST, intent).find((entry) => entry.id === "device-route")?.text ?? "").toBe("");
    }
    for (const intent of ["read", "act"] as const) {
      expect(h.host.parts(BOT, OWNER, "computer", REQUEST, intent).find((entry) => entry.id === "device-route")?.text).toContain("帮我在备忘录里打开{1}");
    }
  });
});

describe("the settle an offered route earns when its turn ends", () => {
  const GOAL = "帮我在备忘录里打开下一页";
  const LATER = { ...TURN, generation: "gen-2" };

  /** The run the route was learned from: an observe and one tap that moved the screen. */
  const record = async (h: ReturnType<typeof harness>): Promise<void> => {
    await see(h, HOME);
    await tapAnswering(h, page(1));
    expect(h.host.endTurn(TURN, { goal: GOAL, ownerKey: OWNER }).route).not.toBeNull();
  };

  /** Observe then tap on a later turn, answering each job with what it was given. */
  const drive = async (h: ReturnType<typeof harness>, answer: PhoneJobOutcome): Promise<void> => {
    const seen = h.handle(call("PHONE_UI_OBSERVE"), LATER);
    await answerNext(h.jobs, { ok: true, result: HOME });
    await seen;
    const tapped = h.handle(call("PHONE_UI_TAP", { ref: "e1" }), LATER);
    await answerNext(h.jobs, answer);
    await tapped;
  };

  it("counts the replay a success when every call that ran moved the screen", async () => {
    const h = harness({ routes: true });
    await record(h);
    const route = h.routes!.list(OWNER)[0]!;
    await drive(h, { ok: true, result: page(2) });
    h.host.endTurn(LATER, { goal: GOAL, ownerKey: OWNER, offeredRoute: { ownerKey: OWNER, id: route.id } });
    // The turn is learnable too, and the same path replaces the offered file — the settle lives on the merged copy.
    const settled = h.routes!.list(OWNER);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ successes: 1, consecutiveMisses: 0, missStep: null });
  });

  it("marks the first call that changed nothing as the step the replay diverged at", async () => {
    const h = harness({ routes: true });
    await record(h);
    const route = h.routes!.list(OWNER)[0]!;
    // The tap ran and the screen came back identical: ok but nothing moved is the one honest miss we can see.
    await drive(h, { ok: true, result: HOME });
    h.host.endTurn(LATER, { goal: GOAL, ownerKey: OWNER, offeredRoute: { ownerKey: OWNER, id: route.id } });
    expect(h.routes!.list(OWNER).find((one) => one.id === route.id)).toMatchObject({ successes: 0, consecutiveMisses: 1, missStep: 0 });
  });

  it("settles nothing when every call was refused and none ran, or the turn was stopped", async () => {
    const h = harness({ routes: true, intent: async () => "discuss" });
    const owner = join(h.dir, "phone-routes", ownerDirectoryName(OWNER));
    mkdirSync(owner, { recursive: true });
    const saved: Route = {
      id: "saved", template: "帮我在备忘录里打开{1}", slots: 1, packages: [], appVersions: {},
      steps: [{ tool: "PHONE_UI_BACK", args: {}, target: null, before: { packageName: null, texts: [] }, after: { packageName: null, texts: [] } }],
      successes: 0, consecutiveMisses: 0, missStep: null, disabled: false, lastUsedMs: 0,
    };
    writeFileSync(join(owner, "saved.json"), JSON.stringify(saved));
    // The discuss refusal never reaches the phone, so the only evidence is a call that did not run.
    await h.handle(call("PHONE_UI_TAP", { ref: "e1" }), LATER);
    h.host.endTurn(LATER, { goal: GOAL, ownerKey: OWNER, offeredRoute: { ownerKey: OWNER, id: "saved" } });
    expect(h.routes!.list(OWNER).find((one) => one.id === "saved")).toMatchObject({ successes: 0, consecutiveMisses: 0, missStep: null });

    const stopped = harness({ routes: true });
    await record(stopped);
    const route = stopped.routes!.list(OWNER)[0]!;
    await drive(stopped, { ok: true, result: page(2) });
    stopped.host.endTurn(LATER, { goal: GOAL, ownerKey: OWNER, stopped: true, offeredRoute: { ownerKey: OWNER, id: route.id } });
    expect(stopped.routes!.list(OWNER).find((one) => one.id === route.id)).toMatchObject({ successes: 0, consecutiveMisses: 0, missStep: null });
  });
});

describe("Mika's intent gate at the first phone call", () => {
  it("refuses the call in a discussion, before any job reaches the phone", async () => {
    const h = harness({ intent: async () => "discuss" as const });
    const request = vi.spyOn(h.jobs, "request");
    const refused = await h.handle(call("PHONE_UI_OBSERVE")) as PhoneToolResult;
    expect(refused).toMatchObject({ isError: true, structuredContent: { code: "denied" } });
    expect(text(refused)).toContain("discussing or reviewing");
    expect(request).not.toHaveBeenCalled();
  });

  it("lets the call through on a read verdict, and when the gate answered nothing", async () => {
    for (const intent of [async () => "read" as const, async () => null]) {
      const h = harness({ intent });
      const pending = h.handle(call("PHONE_UI_OBSERVE"));
      await answerNext(h.jobs, { ok: true, result: PAY });
      expect((await pending as PhoneToolResult).isError).toBeUndefined();
    }
  });
});

describe("the answer check after a phone turn", () => {
  /** The verdict a checker model would write for a reply that quotes the screen it read. */
  const PASS = JSON.stringify({
    checks: [{ criterion: "打开下一页", status: "met", quote: "下一页" }],
    verdict: "pass",
    reason: "the screen showed the next page",
  });

  const evidence = (overrides: Partial<Parameters<typeof verifyPhoneTurn>[0]> = {}) => ({
    dataDir: "", threadId: TURN.threadId, mode: "log" as const, goal: "打开下一页", reply: "已翻到下一页。",
    evidence: [{ tool: "PHONE_UI_TAP", text: "下一页\n搜索", where: APP, args: {}, before: null, screen: null, result: { ok: true }, ok: true, changed: true, irreversible: true, incomplete: false, protected: false, at: 1 }],
    ...overrides,
  });

  it("makes no model call when the server injects no mode, which is off", async () => {
    const h = harness();
    await see(h, HOME);
    await tapAnswering(h, page(1));
    const complete = vi.fn(async () => PASS);
    // The dep is absent, so the host answers `off` and the caller never reaches the checker.
    expect(h.host.verifyMode()).toBe("off");
    expect(await verifyPhoneTurn({ ...evidence({ dataDir: h.dir, complete }), mode: h.host.verifyMode() })).toBeNull();
    expect(await verifyPhoneTurn({ ...evidence({ dataDir: h.dir, complete }), mode: undefined })).toBeNull();
    expect(complete).not.toHaveBeenCalled();
    await flushDecisionLog(h.dir);
    expect(readDecisions(h.dir, 10).filter((row) => row.tool === "phone.verify")).toEqual([]);
  });

  it("reads the injected mode at call time, makes one call, and writes one decision row", async () => {
    let mode: "off" | "log" = "off";
    const h = harness({ verifyMode: () => mode });
    await see(h, HOME);
    await tapAnswering(h, page(1));
    const complete = vi.fn(async () => PASS);
    // Off at turn end: nothing is checked, even though the turn left evidence behind.
    expect(h.host.verifyMode()).toBe("off");
    const ended = h.host.endTurn(TURN, { goal: "打开下一页", ownerKey: OWNER });
    expect(ended.evidence.length).toBeGreaterThan(0);
    expect(await verifyPhoneTurn({ dataDir: h.dir, threadId: TURN.threadId, mode: h.host.verifyMode(), goal: "打开下一页", reply: "已翻到下一页。", evidence: ended.evidence, complete })).toBeNull();
    expect(complete).not.toHaveBeenCalled();
    // Turned on in Settings: the same accessor now answers `log`, so the check runs once and logs once.
    mode = "log";
    expect(h.host.verifyMode()).toBe("log");
    const verdict = await verifyPhoneTurn({ dataDir: h.dir, threadId: TURN.threadId, mode: h.host.verifyMode(), goal: "打开下一页", reply: "已翻到下一页。", evidence: ended.evidence, complete });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(verdict).toMatchObject({ verdict: "pass" });
    await flushDecisionLog(h.dir);
    // One decision row for the check, beside the rows the turn's own calls wrote.
    const rows = readDecisions(h.dir, 20).filter((row) => row.tool === "phone.verify");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: "review-would-approve", source: "model" });
  });

  it("swallows a checker that throws, so a finished turn is never affected", async () => {
    const h = harness({ verifyMode: () => "log" });
    await see(h, HOME);
    await tapAnswering(h, page(1));
    const ended = h.host.endTurn(TURN, { goal: "打开下一页", ownerKey: OWNER });
    const complete = vi.fn(async () => { throw new Error("the engine went away"); });
    // Fail-open: the throw comes back as cannot_verify, and the caller's promise still resolves.
    await expect(verifyPhoneTurn({ dataDir: h.dir, threadId: TURN.threadId, mode: h.host.verifyMode(), goal: "打开下一页", reply: "已翻到下一页。", evidence: ended.evidence, complete })).resolves.toMatchObject({ verdict: "cannot_verify" });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("makes one call, logs the verdict, and never edits the reply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-phone-verify-"));
    dirs.push(dir);
    const complete = vi.fn(async () => PASS);
    const input = evidence({ dataDir: dir, complete });
    const verdict = await verifyPhoneTurn(input);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(verdict).toMatchObject({ verdict: "pass" });
    expect(input.reply).toBe("已翻到下一页。");
    await flushDecisionLog(dir);
    const rows = readDecisions(dir, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "phone.verify", decision: "review-would-approve", source: "model" });
    // The verdict is logged; the screen the bot read is not.
    expect(rows[0]!.rule).toContain("phone-verify:pass");
    expect(rows[0]!.rule).not.toContain("下一页");
  });
});
