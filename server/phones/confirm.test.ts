// The gate's server side: the screen a phone answer describes, the control one call is about, and the per-turn approval
// that lets an irreversible control run exactly once. The word list itself is shared/irreversible.test.ts.
import { describe, expect, it } from "vitest";

import type { ConfirmationRequest } from "../../shared/irreversible.ts";
import { MAX_CONFIRM_TURNS, PhoneConfirms, controlFor, recordsScreen, screenViewOf } from "./confirm.ts";

const APP = "com.example.shop";
const PHONE = "companion:pixel";
const TURN = { threadId: "thread-1", botId: "chief" };

/** A screen as PHONE_UI_OBSERVE answers it. */
const observed = (elements: unknown[], extra: Record<string, unknown> = {}) => ({ topPackage: APP, elements, ...extra });
const payScreen = observed([
  { ref: "e1", text: "付款", bounds: [0, 900, 400, 960] },
  { ref: "e2", text: "合计 ¥39.90", bounds: [0, 800, 400, 840] },
  { ref: "e3", text: "返回", bounds: [0, 40, 120, 100] },
]);
const deleteScreen = observed([
  { ref: "e1", text: "旧照片", bounds: [0, 100, 400, 200] },
  { ref: "e2", text: "删除", bounds: [0, 300, 400, 360] },
]);
const orderScreen = observed([
  { ref: "e1", text: "合计 ¥39.90", bounds: [0, 800, 400, 840] },
  { ref: "e2", text: "去结算", bounds: [0, 900, 400, 960] },
]);
const sendScreen = observed([
  { ref: "e1", text: "张三", bounds: [0, 40, 400, 100] },
  { ref: "e2", text: "晚上好", editable: true, bounds: [0, 300, 400, 360] },
  { ref: "e3", text: "发送", bounds: [0, 800, 400, 860] },
]);
const request = (over: Partial<ConfirmationRequest> = {}): ConfirmationRequest =>
  ({ action: "delete", target: "旧照片", content: "", amount: null, app: APP, ...over });

function confirmsWith(result: unknown): PhoneConfirms {
  const confirms = new PhoneConfirms();
  confirms.noteScreen(PHONE, result);
  return confirms;
}

describe("screenViewOf", () => {
  it("reads the package, the elements and the display height of an observe result", () => {
    const view = screenViewOf(observed([{ ref: "e1", text: "付款", bounds: [0, 1, 2, 3], clickable: true, scrollable: true }]));
    expect(view.packageName).toBe(APP);
    expect(view.elements).toEqual([{ text: "付款", description: null, editable: false, scrollable: true, bounds: [0, 1, 2, 3] }]);
    expect(view.height).toBeUndefined();
    expect(screenViewOf(observed([], { height: 1920 })).height).toBe(1920);
  });

  it("reads the screen a PHONE_UI_RUN result carries, and converts a screenshot's scaled height", () => {
    const run = { steps: [], stopped: "done", screen: { topPackage: APP, elements: [{ ref: "e1", text: "删除" }] } };
    expect(screenViewOf(run)).toMatchObject({ packageName: APP, elements: [{ text: "删除" }] });
    // The JPEG was scaled to half, so its 960 pixels are 1920 on the display the bounds use.
    expect(screenViewOf({ topPackage: APP, elements: [], width: 540, height: 960, scale: 0.5 }).height).toBe(1920);
  });

  it("reads malformed phone JSON as an empty screen rather than throwing", () => {
    for (const broken of [null, undefined, "screen", 42, [], {}, { elements: "none" }, { elements: null }]) {
      expect(screenViewOf(broken)).toEqual({ packageName: null, elements: [] });
    }
    // Elements that are not objects are dropped; a bounds list of the wrong length is no bounds.
    const view = screenViewOf(observed([null, "付款", 7, [], { ref: "e1", text: "删除", bounds: [0, 1] }]));
    expect(view.elements).toEqual([{ text: "删除", description: null, editable: false, scrollable: false, bounds: null }]);
    expect(view.packageName).toBe(APP);
  });
});

describe("controlFor", () => {
  it("resolves a tap by ref, a coordinate tap by the smallest element under it, and an enter key", () => {
    expect(controlFor("PHONE_UI_TAP", { ref: "e1" }, payScreen)).toMatchObject({ element: { text: "付款" } });
    expect(controlFor("mcp__device__PHONE_UI_TAP", { ref: "e1" }, payScreen)).toMatchObject({ element: { text: "付款" } });
    expect(controlFor("PHONE_UI_TAP_AT", { x: 10, y: 920 }, payScreen)).toMatchObject({ element: { text: "付款" } });
    expect(controlFor("PHONE_UI_KEY", { key: "enter" }, payScreen)).toMatchObject({ interaction: "enter" });
    expect(controlFor("PHONE_UI_SWIPE", { direction: "left" }, payScreen)).toMatchObject({ interaction: "swipe" });
  });

  it("passes the screen's own texts, so a generic 确认 is read against what it confirms", () => {
    const input = controlFor("PHONE_UI_TAP", { ref: "e1" }, payScreen);
    expect(input?.screenTexts).toEqual(["付款", "合计 ¥39.90", "返回"]);
  });

  it("is null for a tool that is not a control, and for a ref the screen no longer has", () => {
    for (const tool of ["PHONE_UI_OBSERVE", "PHONE_UI_QUERY", "PHONE_UI_LAUNCH", "PHONE_UI_SCROLL", "PHONE_UI_TYPE",
      "PHONE_UI_BACK", "PHONE_UI_WAIT", "PHONE_UI_SCREENSHOT", "PHONE_UI_OCR", "PHONE_LIST_APPS"]) {
      expect(controlFor(tool, {}, payScreen), tool).toBeNull();
    }
    // A stale ref names no element, so the word list has nothing to read.
    expect(controlFor("PHONE_UI_TAP", { ref: "gone" }, payScreen)?.element).toBeNull();
    expect(controlFor("PHONE_UI_KEY", { key: "back" }, payScreen)).toBeNull();
    expect(controlFor("PHONE_UI_SWIPE", { direction: "up" }, payScreen)).toBeNull();
  });

  it("judges a do-each loop by its body steps, and records the screen it ends on", () => {
    // The body's first classified step on this screen refuses the whole loop.
    const body = { item: { text: "row" }, body: [{ op: "tap", ref: "e3" }, { op: "tap", ref: "e1" }] };
    expect(controlFor("PHONE_UI_DO_EACH", body, payScreen)).toMatchObject({ element: { text: "付款" } });
    // A body whose targets are all harmless, or not on this screen, has nothing to judge.
    expect(controlFor("PHONE_UI_DO_EACH", { item: { text: "row" }, body: [{ op: "tap", ref: "e3" }] }, payScreen)).toBeNull();
    expect(recordsScreen("PHONE_UI_DO_EACH")).toBe(true);
  });

  it("finds the classified step of a run, so a run is not a way around the gate", () => {
    const run = { commands: [{ op: "tap", ref: "e3" }, { op: "tap", ref: "e1" }] };
    expect(controlFor("PHONE_UI_RUN", run, payScreen)).toMatchObject({ element: { text: "付款" } });
    // A run whose targets are all harmless, or not on this screen, has nothing to judge.
    expect(controlFor("PHONE_UI_RUN", { commands: [{ op: "tap", ref: "e3" }, { op: "tap", text: "下一页" }] }, payScreen)).toBeNull();
  });

  it("names the tools whose answer is a whole screen", () => {
    expect(recordsScreen("PHONE_UI_OBSERVE")).toBe(true);
    expect(recordsScreen("mcp__device__PHONE_UI_SCREENSHOT")).toBe(true);
    expect(recordsScreen("PHONE_UI_TAP")).toBe(true);
    // A query answers with only the elements it matched, which would shrink the screen the next control is read against.
    expect(recordsScreen("PHONE_UI_QUERY")).toBe(false);
    expect(recordsScreen("PHONE_UI_OCR")).toBe(false);
    expect(recordsScreen("PHONE_LIST_EVENTS")).toBe(false);
  });

  it("records a COLLECT or FIND answer as a screen, but not a query's", () => {
    expect(recordsScreen("PHONE_UI_COLLECT")).toBe(true);
    // FIND answers with a match list, but carries the whole snapshot beside it
    // in `screen`; its refs are that snapshot's, so a later tap is judged
    // against it rather than against a stale screen.
    expect(recordsScreen("PHONE_UI_FIND")).toBe(true);
    expect(recordsScreen("PHONE_UI_QUERY")).toBe(false);
  });
});

describe("PhoneConfirms", () => {
  it("refuses a tap on 付款 with no approval, naming the action", () => {
    const confirms = confirmsWith(payScreen);
    const check = confirms.check(TURN, PHONE, "PHONE_UI_TAP", { ref: "e1" });
    expect(check).toMatchObject({ result: "refused", hit: { action: "pay", matched: "付款" } });
    expect(check.result === "refused" && check.reason).toContain('"pay"');
    expect(check.result === "refused" && check.reason).toContain("tapping 付款");
    // The gate never approves a payment, so the sentence sends the person to it rather than to an approval that cannot
    // be given.
    expect(check.result === "refused" && check.reason).toContain("make the payment themselves");
  });

  it("never approves a payment, so 付款 is refused whatever the person answers", () => {
    const confirms = confirmsWith(payScreen);
    expect(confirms.declare(TURN, PHONE, request({ action: "pay", target: "订单", amount: "¥39.90" }))).toBe("unsupported");
    confirms.decide(TURN, true);
    expect(confirms.check(TURN, PHONE, "PHONE_UI_TAP", { ref: "e1" }).result).toBe("refused");
  });

  it("allows the approved delete once, and refuses the second identical tap", () => {
    const confirms = confirmsWith(deleteScreen);
    expect(confirms.declare(TURN, PHONE, request())).toBe("pending");
    confirms.decide(TURN, true);
    expect(confirms.check(TURN, PHONE, "PHONE_UI_TAP", { ref: "e2" })).toMatchObject({ result: "allowed", hit: { action: "delete" } });
    const second = confirms.check(TURN, PHONE, "PHONE_UI_TAP", { ref: "e2" });
    expect(second).toMatchObject({ result: "refused", hit: { action: "delete" } });
    expect(second.result === "refused" && second.reason).toContain("has not approved this exact step");
  });

  it("remembers a refusal for the turn, and forgets it on reset", () => {
    const confirms = confirmsWith(deleteScreen);
    expect(confirms.declare(TURN, PHONE, request())).toBe("pending");
    confirms.decide(TURN, false);
    expect(confirms.declare(TURN, PHONE, request())).toBe("declined");
    confirms.reset(TURN);
    expect(confirms.declare(TURN, PHONE, request())).toBe("pending");
  });

  it("never refuses a control the word list does not name", () => {
    const confirms = confirmsWith(payScreen);
    expect(confirms.check(TURN, PHONE, "PHONE_UI_TAP", { ref: "e3" })).toEqual({ result: "proceed" });
    expect(confirms.check(TURN, PHONE, "PHONE_UI_BACK", {})).toEqual({ result: "proceed" });
    expect(confirms.check(TURN, PHONE, "PHONE_UI_OBSERVE", {})).toEqual({ result: "proceed" });
    // A tap on nothing at all, before any observe, is not this gate's to judge.
    expect(new PhoneConfirms().check(TURN, PHONE, "PHONE_UI_TAP", { ref: "e1" })).toEqual({ result: "proceed" });
  });

  it("classifies an enter key on a screen showing a pay amount, and refuses it as a send", () => {
    const confirms = confirmsWith(payScreen);
    const check = confirms.check(TURN, PHONE, "PHONE_UI_KEY", { key: "enter" });
    expect(check).toMatchObject({ result: "refused", hit: { action: "send", matched: "enter" } });
    expect(check.result === "refused" && check.reason).toContain("pressing the enter key");
    expect(check.result === "refused" && check.reason).toContain('"send"');
    // The same enter key is classified with or without the amount on the screen: the phone names no focused field.
    expect(controlFor("PHONE_UI_KEY", { key: "enter" }, observed([]))).toMatchObject({ interaction: "enter" });
  });

  it("does not let a grant cross a thread or a bot", () => {
    const confirms = confirmsWith(deleteScreen);
    confirms.declare(TURN, PHONE, request());
    confirms.decide(TURN, true);
    expect(confirms.check({ ...TURN, threadId: "thread-2" }, PHONE, "PHONE_UI_TAP", { ref: "e2" }).result).toBe("refused");
    expect(confirms.check({ ...TURN, botId: "other" }, PHONE, "PHONE_UI_TAP", { ref: "e2" }).result).toBe("refused");
    expect(confirms.check(TURN, PHONE, "PHONE_UI_TAP", { ref: "e2" }).result).toBe("allowed");
  });

  it("does not let a grant cross turns in the same thread", () => {
    const confirms = confirmsWith(deleteScreen);
    const first = { ...TURN, generation: "gen-1" };
    const second = { ...TURN, generation: "gen-2" };
    expect(confirms.declare(first, PHONE, request())).toBe("pending");
    confirms.decide(first, true);
    const check = confirms.check(second, PHONE, "PHONE_UI_TAP", { ref: "e2" });
    expect(check).toMatchObject({ result: "refused", hit: { action: "delete" } });
    // The grant is gone rather than used up: this is the ordinary unapproved sentence, not the spent one.
    expect(check.result === "refused" && check.reason).toContain("has not approved this exact step");
    expect(check.result === "refused" && check.reason).not.toContain("already used in this task");
  });

  it("does not remember a refusal across turns in the same thread", () => {
    const confirms = confirmsWith(deleteScreen);
    const first = { ...TURN, generation: "gen-1" };
    const second = { ...TURN, generation: "gen-2" };
    expect(confirms.declare(first, PHONE, request())).toBe("pending");
    confirms.decide(first, false);
    expect(confirms.declare(first, PHONE, request())).toBe("declined");
    expect(confirms.declare(second, PHONE, request())).toBe("pending");
  });

  it("keeps an approval within a turn that names no generation", () => {
    const confirms = confirmsWith(deleteScreen);
    expect(confirms.declare(TURN, PHONE, request())).toBe("pending");
    confirms.decide(TURN, true);
    expect(confirms.check(TURN, PHONE, "PHONE_UI_TAP", { ref: "e2" })).toMatchObject({ result: "allowed", hit: { action: "delete" } });
  });

  it("drops the oldest turn rather than growing without bound", () => {
    const confirms = confirmsWith(deleteScreen);
    confirms.declare(TURN, PHONE, request());
    confirms.decide(TURN, true);
    for (let index = 0; index <= MAX_CONFIRM_TURNS; index++) {
      expect(confirms.declare({ threadId: `other-${index}`, botId: "chief" }, PHONE, request())).toBe("pending");
    }
    expect(confirms.size).toBe(MAX_CONFIRM_TURNS);
    // The first turn's grant went with its entry: the tap is refused again.
    expect(confirms.check(TURN, PHONE, "PHONE_UI_TAP", { ref: "e2" }).result).toBe("refused");
  });

  it("keeps the last screen per phone, and never lets a malformed answer blank it", () => {
    const confirms = confirmsWith(deleteScreen);
    // An answer with no element list is not a screen: the one before it stands.
    confirms.noteScreen(PHONE, { error: "no screen here" });
    expect(confirms.declare(TURN, PHONE, request())).toBe("pending");
    // A phone that never showed a screen cannot say what app the person approved in.
    expect(confirms.declare({ threadId: "thread-9", botId: "chief" }, "companion:other", request())).toBe("mismatch");
  });
});

describe("the approved card as the person's approval", () => {
  it("turns an approved card on 删除 into one grant, which the tap then uses up", () => {
    const confirms = confirmsWith(deleteScreen);
    expect(confirms.approveCard(TURN, PHONE, "PHONE_UI_TAP", { ref: "e2" })).toEqual({ result: "approved" });
    expect(confirms.check(TURN, PHONE, "PHONE_UI_TAP", { ref: "e2" })).toMatchObject({ result: "allowed", hit: { action: "delete" } });
    // The same tap again has no grant left, and a second card of the same kind is not enough either.
    expect(confirms.check(TURN, PHONE, "PHONE_UI_TAP", { ref: "e2" }).result).toBe("refused");
    const again = confirms.approveCard(TURN, PHONE, "PHONE_UI_TAP", { ref: "e2" });
    expect(again.result).toBe("refused");
    expect(again.result === "refused" && again.reason).toContain("Ask the person again");
  });

  it("does not carry a spent card into the next turn of the same thread", () => {
    const confirms = confirmsWith(deleteScreen);
    const first = { ...TURN, generation: "gen-1" };
    const second = { ...TURN, generation: "gen-2" };
    expect(confirms.approveCard(first, PHONE, "PHONE_UI_TAP", { ref: "e2" })).toEqual({ result: "approved" });
    // The card was spent in gen-1; gen-2 has its own, so the same delete is approved again rather than refused as spent.
    expect(confirms.approveCard(second, PHONE, "PHONE_UI_TAP", { ref: "e2" })).toEqual({ result: "approved" });
  });

  it("never approves a payment, whatever the card was for", () => {
    const confirms = confirmsWith(payScreen);
    const card = confirms.approveCard(TURN, PHONE, "PHONE_UI_TAP", { ref: "e1" });
    expect(card.result).toBe("refused");
    expect(card.result === "refused" && card.reason).toContain("make the payment themselves");
    expect(confirms.check(TURN, PHONE, "PHONE_UI_TAP", { ref: "e1" }).result).toBe("refused");
  });

  it("binds an approved order card to the total the screen showed, so the tap is allowed", () => {
    const confirms = confirmsWith(orderScreen);
    expect(confirms.approveCard(TURN, PHONE, "PHONE_UI_TAP", { ref: "e2" })).toEqual({ result: "approved" });
    expect(confirms.check(TURN, PHONE, "PHONE_UI_TAP", { ref: "e2" })).toMatchObject({ result: "allowed", hit: { action: "order" } });
  });

  it("still refuses an order whose screen shows no total the approval could name", () => {
    const confirms = confirmsWith(observed([{ ref: "e1", text: "去结算", bounds: [0, 900, 400, 960] }]));
    // The card is approved and the grant made, but with no amount to bind the permit fails closed.
    expect(confirms.approveCard(TURN, PHONE, "PHONE_UI_TAP", { ref: "e1" })).toEqual({ result: "approved" });
    const check = confirms.check(TURN, PHONE, "PHONE_UI_TAP", { ref: "e1" });
    expect(check.result).toBe("refused");
    expect(check.result === "refused" && check.reason).toContain("the approved amount");
  });

  it("grades every refused step for the decision log: a payment irreversible, a send external", () => {
    const confirms = confirmsWith(payScreen);
    const pay = confirms.check(TURN, PHONE, "PHONE_UI_TAP", { ref: "e1" });
    expect(pay).toMatchObject({ result: "refused", risk: { level: "irreversible" } });
    const card = confirms.approveCard(TURN, PHONE, "PHONE_UI_TAP", { ref: "e1" });
    expect(card).toMatchObject({ result: "refused", risk: { level: "irreversible" } });
    const send = confirms.check(TURN, PHONE, "PHONE_UI_KEY", { key: "enter" });
    expect(send).toMatchObject({ result: "refused", risk: { level: "external" } });
  });

  it("refuses a card for a screen whose foreground app is unknown, so no permit is ever granted", () => {
    // An observe answer with elements but no topPackage: the gate cannot say which app the person approved in.
    const confirms = confirmsWith({ elements: [{ ref: "e2", text: "删除", bounds: [0, 300, 400, 360] }] });
    expect(confirms.foreground(PHONE)).toBe("");
    const card = confirms.approveCard(TURN, PHONE, "PHONE_UI_TAP", { ref: "e2" });
    expect(card.result).toBe("refused");
    expect(card.result === "refused" && card.reason).toContain("the screen changed or the app in front");
    expect(confirms.check(TURN, PHONE, "PHONE_UI_TAP", { ref: "e2" }).result).toBe("refused");
  });

  it("refuses a run that carries a classified step, and lets a harmless run through", () => {
    const confirms = confirmsWith(payScreen);
    const run = confirms.approveCard(TURN, PHONE, "PHONE_UI_RUN", { commands: [{ op: "tap", ref: "e1" }] });
    expect(run.result).toBe("refused");
    expect(run.result === "refused" && run.reason).toContain("PHONE_UI_RUN includes tapping 付款");
    expect(run.result === "refused" && run.reason).toContain("Run the other steps with PHONE_UI_RUN");
    // Launch, scroll and back name no control: the run is the tool call the card approved.
    expect(confirms.approveCard(TURN, PHONE, "PHONE_UI_RUN", {
      commands: [{ op: "launch", app: APP }, { op: "scroll", direction: "down" }, { op: "back" }],
    })).toEqual({ result: "approved" });
  });

  it("refuses an each-loop whose body carries a classified step, and lets a harmless one through", () => {
    const confirms = confirmsWith(payScreen);
    const each = confirms.approveCard(TURN, PHONE, "PHONE_UI_DO_EACH", {
      item: { text: "row" },
      body: [{ op: "tap", ref: "e1" }, { op: "back" }],
    });
    expect(each.result).toBe("refused");
    expect(each.result === "refused" && each.reason).toContain("PHONE_UI_DO_EACH includes tapping 付款");
    expect(each.result === "refused" && each.reason).toContain("Run the other steps with PHONE_UI_DO_EACH");
    expect(confirms.approveCard(TURN, PHONE, "PHONE_UI_DO_EACH", {
      item: { text: "row" },
      body: [{ op: "launch", app: APP }, { op: "scroll", direction: "down" }, { op: "back" }],
    })).toEqual({ result: "approved" });
  });

  it("approves a send for the text that was typed, and only while the screen still holds it", () => {
    const confirms = confirmsWith(sendScreen);
    confirms.noteWrite(TURN, "typing", "晚上好");
    expect(confirms.approveCard(TURN, PHONE, "PHONE_UI_TAP", { ref: "e3" })).toEqual({ result: "approved" });
    expect(confirms.check(TURN, PHONE, "PHONE_UI_TAP", { ref: "e3" }))
      .toMatchObject({ result: "allowed", hit: { action: "send" } });

    // A send whose typed text is not what a field holds grants nothing.
    const other = confirmsWith(sendScreen);
    other.noteWrite(TURN, "typing", "别的话");
    expect(other.approveCard(TURN, PHONE, "PHONE_UI_TAP", { ref: "e3" })).toEqual({ result: "approved" });
    const refused = other.check(TURN, PHONE, "PHONE_UI_TAP", { ref: "e3" });
    expect(refused.result).toBe("refused");
    expect(refused.result === "refused" && refused.reason).toContain("the text to send is not exactly what was approved");

    // Nothing typed this turn: no content was approved, so the send cannot run.
    const silent = confirmsWith(sendScreen);
    expect(silent.approveCard(TURN, PHONE, "PHONE_UI_TAP", { ref: "e3" })).toEqual({ result: "approved" });
    expect(silent.check(TURN, PHONE, "PHONE_UI_TAP", { ref: "e3" }).result).toBe("refused");
  });

  it("leaves a call the word list does not name alone", () => {
    const confirms = confirmsWith(payScreen);
    expect(confirms.approveCard(TURN, PHONE, "PHONE_UI_TAP", { ref: "e3" })).toEqual({ result: "approved" });
    expect(confirms.approveCard(TURN, PHONE, "PHONE_UI_LAUNCH", { app: APP })).toEqual({ result: "approved" });
    expect(confirms.check(TURN, PHONE, "PHONE_UI_TAP", { ref: "e3" })).toEqual({ result: "proceed" });
  });
});
