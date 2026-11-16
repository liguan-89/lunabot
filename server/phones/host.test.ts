// The host's second gate over screen writes: a control the word list names as irreversible runs only on an approval of
// that exact step, and only once; everything else reaches the phone exactly as it did before. The loop guard rides the
// same host: the same action on a screen that does not move is nudged in the answer, then refused.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { flushDecisionLog } from "../decision-log.ts";
import type { BotRecord } from "../store.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { MAX_CONFIRM_TURNS, PhoneConfirms } from "./confirm.ts";
import { createPhoneHost } from "./host.ts";
import { PhoneJobs, type PhoneJobDelivery, type PhoneJobOutcome } from "./jobs.ts";
import { PhoneRegistry, type PhoneRegistration } from "./registry.ts";
import type { PhoneToolsList } from "./rpc.ts";
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

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "omb-phone-host-"));
  dirs.push(dir);
  const registry = new PhoneRegistry(join(dir, "phones.json"));
  const jobs = new PhoneJobs();
  const confirm = new PhoneConfirms();
  const bot = { id: "chief", name: "Luna Bot", color: "teal", phoneApps: { phoneUi: "write" } } as BotRecord;
  const host = createPhoneHost({
    registry, jobs, dataDir: dir, bot: () => bot, turnOwner: () => OWNER, inRoom: () => false,
    appendMessage: () => {}, active: () => true, confirm,
    holdOutbound: async () => ({ ok: true, approved: true }),
    approvalMode: () => "ask",
  });
  registry.register(PIXEL, OWNER, registration({ phoneUi: "full" }));
  const handle = (body: unknown, turn: { botId: string; threadId: string; generation: string } = TURN) => host.handle(body, turn, () => {});
  return { registry, jobs, confirm, handle };
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
