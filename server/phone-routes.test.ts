// The recorder and the store over shared/route-replay.ts: a run becomes a route, the route survives a restart, and a
// later request finds it. Everything here uses a throwaway root, so no test touches the real DATA_DIR.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ScreenElement, ScreenSnapshot } from "../shared/route-replay.ts";
import { PhoneRoutes, elementAtPoint, elementByRef, ownerDirectoryName, screenFromAnswer, type RouteStepNote, type RouteTurn } from "./phone-routes.ts";

const OWNER = "owner-a";
const OTHER = "owner-b";
const GOAL = "给张三发一条消息";
const TYPED = "张三";

/** The chat list: a title and the compose button. */
const listScreen: ScreenSnapshot = {
  packageName: "com.example.messages",
  elements: [
    { text: "消息", viewId: "id/title" },
    { text: "新建", viewId: "id/new", class: "android.widget.Button", bounds: [10, 200, 110, 260], clickable: true },
  ],
};

/** The compose screen: the field is empty, so what it holds is the hint, never a name. */
const composeScreen: ScreenSnapshot = {
  packageName: "com.example.messages",
  elements: [
    { text: "新消息", viewId: "id/title" },
    { text: "", viewId: "id/to", class: "android.widget.EditText", bounds: [10, 300, 400, 360], editable: true },
  ],
};

/** After typing: the field holds what the person's request named. */
const typedScreen: ScreenSnapshot = {
  packageName: "com.example.messages",
  elements: [
    { text: "新消息", viewId: "id/title" },
    { text: TYPED, viewId: "id/to", class: "android.widget.EditText", bounds: [10, 300, 400, 360], editable: true },
    { text: "发送", viewId: "id/send", class: "android.widget.Button", bounds: [10, 380, 110, 440], clickable: true },
  ],
};

const sentScreen: ScreenSnapshot = {
  packageName: "com.example.messages",
  elements: [
    { text: "新消息", viewId: "id/title" },
    { text: "已发送", viewId: "id/sent" },
  ],
};

const button = (screen: ScreenSnapshot, text: string): ScreenElement =>
  screen.elements.find((element) => element.text === text)!;
const field = (screen: ScreenSnapshot): ScreenElement =>
  screen.elements.find((element) => element.editable === true)!;

function turn(overrides: Partial<RouteTurn> = {}): RouteTurn {
  return { ownerKey: OWNER, threadId: "thread-1", botId: "bot-1", generation: "gen-1", goal: GOAL, runId: "run-1", ...overrides };
}

/** The three calls that message one person: open compose, type the name, tap Send. */
function messagingSteps(goalName = TYPED): RouteStepNote[] {
  const compose = goalName === TYPED ? typedScreen : { ...typedScreen, elements: typedScreen.elements.map((element) => (element.editable ? { ...element, text: goalName } : element)) };
  return [
    { tool: "PHONE_UI_TAP", args: { ref: "r1" }, target: button(listScreen, "新建"), screen: listScreen.elements, after: composeScreen, result: { ok: true, changed: true } },
    { tool: "PHONE_UI_TYPE", args: { text: goalName, ref: "r2" }, target: field(composeScreen), screen: composeScreen.elements, after: compose, result: { ok: true, typed: true, secret: false } },
    { tool: "PHONE_UI_TAP", args: { ref: "r3" }, target: button(compose, "发送"), screen: compose.elements, after: sentScreen, result: { ok: true, changed: true } },
  ];
}

function recordMessaging(routes: PhoneRoutes, overrides: Partial<RouteTurn> = {}, goalName = TYPED) {
  const current = turn(overrides);
  for (const step of messagingSteps(goalName)) routes.note(current, step);
  return routes.finish(current, { outcome: "done" });
}

/** Every file under a directory, read as text, so a test can say what a store did not write. */
function allText(path: string): string {
  if (!existsSync(path)) return "";
  let text = "";
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) text += allText(child);
    else if (entry.isFile()) text += readFileSync(child, "utf8");
  }
  return text;
}

describe("reading a phone answer", () => {
  it("reads a screen from the answer itself, or from the screen a run holds", () => {
    expect(screenFromAnswer({ topPackage: "com.example.messages", elements: [{ ref: "r1", text: "消息" }] }))
      .toEqual({ packageName: "com.example.messages", elements: [{ ref: "r1", text: "消息", description: null, viewId: null, class: null, bounds: null, clickable: false, editable: false, scrollable: false, password: false }] });
    expect(screenFromAnswer({ ok: true, screen: { topPackage: "com.example.pair", elements: [{ text: "完成" }] } })?.packageName).toBe("com.example.pair");
    // A launch or an OCR answer carries no element list, so it leaves the last screen alone.
    expect(screenFromAnswer({ ok: true, launched: "com.example.messages" })).toBeNull();
    expect(screenFromAnswer(null)).toBeNull();
    expect(screenFromAnswer({ elements: "not a list" })).toBeNull();
  });

  it("finds the element a step names by ref, or the one under a tapped point", () => {
    const elements: ScreenElement[] = [{ ref: "r1", text: "消息" }, { ref: "r2", text: "新建" }];
    expect(elementByRef(elements, "r2")?.text).toBe("新建");
    expect(elementByRef(elements, "r9")).toBeNull();
    expect(elementByRef(elements, undefined)).toBeNull();
    expect(elementByRef(null, "r1")).toBeNull();

    const screen: ScreenElement[] = [
      { text: "card", bounds: [0, 0, 400, 400], clickable: true },
      { text: "button", bounds: [100, 100, 200, 200], clickable: true },
      { text: "label", bounds: [100, 100, 200, 200] },
    ];
    // The smallest element under the point; a tie goes to the clickable one.
    expect(elementAtPoint(screen, 150, 150)?.text).toBe("button");
    expect(elementAtPoint(screen, 10, 10)?.text).toBe("card");
    expect(elementAtPoint(screen, 500, 500)).toBeNull();
    expect(elementAtPoint(screen, Number.NaN, 1)).toBeNull();
  });
});

describe("PhoneRoutes", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omb-phone-routes-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("records a run, persists it, and a fresh instance matches a later request", () => {
    const routes = new PhoneRoutes({ root, enabled: true });
    const saved = recordMessaging(routes);
    expect(saved).not.toBeNull();
    expect(saved!.template).toBe("给{1}发一条消息");
    expect(saved!.slots).toBe(1);

    const reopened = new PhoneRoutes({ root, enabled: true });
    const found = reopened.match(OWNER, "给李四发一条消息");
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe(saved!.id);
    expect(found[0]!.steps).toHaveLength(3);
    expect(found[0]!.steps[1]!.args.text).toBe("{1}");
    expect(reopened.match(OWNER, "今天天气怎么样")).toEqual([]);
  });

  it("writes one file per route, in the owner's own folder, 0600 inside 0700", () => {
    const routes = new PhoneRoutes({ root, enabled: true });
    const saved = recordMessaging(routes)!;
    const dir = join(root, ownerDirectoryName(OWNER));
    // Windows has no POSIX permission bits: mkdir's mode and the file's 0600 are emulated away, so only the
    // one-file-per-route half of this test means anything there.
    if (process.platform !== "win32") expect(statSync(dir).mode & 0o777).toBe(0o700);
    const files = readdirSync(dir);
    expect(files).toEqual([`${saved.id}.json`]);
    if (process.platform !== "win32") expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600);
  });

  it("stores nothing when the run is not learnable", () => {
    for (const finish of [
      (routes: PhoneRoutes, current: RouteTurn) => routes.finish(current, { outcome: "partial" }),
      (routes: PhoneRoutes, current: RouteTurn) => routes.finish(current, { outcome: "done", doubtful: true }),
      (routes: PhoneRoutes, current: RouteTurn) => routes.finish(current, { outcome: "done", unconfirmed: ["the send"] }),
    ]) {
      const routes = new PhoneRoutes({ root, enabled: true });
      const current = turn();
      for (const step of messagingSteps()) routes.note(current, step);
      expect(finish(routes, current)).toBeNull();
      expect(routes.list(OWNER)).toEqual([]);
    }
    // A run with no run id cannot be rebuilt, and learning switched off learns nothing.
    for (const overrides of [{ runId: null }, { routesOn: false }, { userScreen: true }]) {
      const routes = new PhoneRoutes({ root, enabled: true });
      expect(recordMessaging(routes, overrides)).toBeNull();
      expect(routes.list(OWNER)).toEqual([]);
    }
  });

  it("stores nothing when a call spoils the run", () => {
    const spoiled: Array<(steps: RouteStepNote[]) => RouteStepNote[]> = [
      // A browser call is not the phone's screen, so the path cannot be replayed.
      (steps) => [{ tool: "BROWSER_NAVIGATE", args: { url: "https://example.com" }, result: { ok: true } }, ...steps],
      // The clipboard is a write a route may not replay.
      (steps) => [...steps, { tool: "PHONE_CLIPBOARD_SET", args: { text: "copied" }, result: { ok: true, changed: true } }],
      // A step the phone cut short, or a shielded screen, cannot be trusted.
      (steps) => steps.map((step, index) => (index === 1 ? { ...step, incomplete: true } : step)),
      (steps) => steps.map((step, index) => (index === 1 ? { ...step, protected: true } : step)),
      (steps) => steps.map((step, index) => (index === 1 ? { ...step, result: { ok: true, typed: true, secret: false, protected: true } } : step)),
    ];
    for (const spoil of spoiled) {
      const routes = new PhoneRoutes({ root, enabled: true });
      const current = turn();
      for (const step of spoil(messagingSteps())) routes.note(current, step);
      expect(routes.finish(current, { outcome: "done" })).toBeNull();
      expect(allText(root)).toBe("");
    }
  });

  it("never writes the text an editable field held", () => {
    const routes = new PhoneRoutes({ root, enabled: true });
    expect(recordMessaging(routes)).not.toBeNull();
    const stored = allText(root);
    expect(stored).toContain("给{1}发一条消息");
    expect(stored).not.toContain(TYPED);
    // The selector for the field carries no name at all, since what it holds is what the person typed.
    expect(routes.list(OWNER)[0]!.steps[1]!.target!.name).toBe("");
  });

  it("refuses a password field, and a run whose own commands type text", () => {
    const routes = new PhoneRoutes({ root, enabled: true });
    const current = turn();
    const steps = messagingSteps();
    routes.note(current, steps[0]!);
    routes.note(current, { ...steps[1]!, target: { ...field(composeScreen), password: true } });
    expect(routes.finish(current, { outcome: "done" })).toBeNull();
    expect(allText(root)).toBe("");

    const runTurn = turn({ goal: "在应用里发一条消息" });
    const runRoutes = new PhoneRoutes({ root, enabled: true });
    runRoutes.note(runTurn, {
      tool: "PHONE_UI_RUN",
      args: { commands: [{ op: "launch", app: "com.example.messages" }, { op: "type", text: "秘密口令" }] },
      result: { ok: true, changed: true },
    });
    expect(runRoutes.finish(runTurn, { outcome: "done" })).toBeNull();
    expect(allText(root)).toBe("");
  });

  it("evicts the oldest route once an owner is over the cap", () => {
    let clock = 1_000;
    const routes = new PhoneRoutes({ root, enabled: true, now: () => clock, limits: { maxRoutesPerOwner: 2 } });
    recordMessaging(routes, { goal: "给张三发一条消息" });
    clock = 2_000;
    recordMessaging(routes, { goal: "给张三发一条短信" });
    clock = 3_000;
    recordMessaging(routes, { goal: "给张三发一条彩信" });
    const kept = routes.list(OWNER).map((route) => route.template);
    expect(kept).toEqual(["给{1}发一条彩信", "给{1}发一条短信"]);
    expect(readdirSync(join(root, ownerDirectoryName(OWNER)))).toHaveLength(2);
  });

  it("rejects a route larger than the byte ceiling", () => {
    const routes = new PhoneRoutes({ root, enabled: true, limits: { maxBytesPerRoute: 120 } });
    expect(recordMessaging(routes)).toBeNull();
    expect(routes.list(OWNER)).toEqual([]);
    expect(existsSync(join(root, ownerDirectoryName(OWNER)))).toBe(false);
  });

  it("skips a corrupt or misnamed file instead of failing", () => {
    const routes = new PhoneRoutes({ root, enabled: true });
    const saved = recordMessaging(routes)!;
    const dir = join(root, ownerDirectoryName(OWNER));
    writeFileSync(join(dir, "broken.json"), "{ not json");
    writeFileSync(join(dir, "half.json"), JSON.stringify({ id: "half" }));
    // A route whose id does not match its file name was not written by this store.
    writeFileSync(join(dir, "misnamed.json"), JSON.stringify({ ...saved, id: "another" }));
    mkdirSync(join(dir, "a-directory.json"));

    const reopened = new PhoneRoutes({ root, enabled: true });
    expect(reopened.list(OWNER).map((route) => route.id)).toEqual([saved.id]);
    expect(reopened.match(OWNER, "给李四发一条消息")).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")("does not follow a symbolic link planted as a route file", () => {
    const routes = new PhoneRoutes({ root, enabled: true });
    const saved = recordMessaging(routes)!;
    const dir = join(root, ownerDirectoryName(OWNER));
    const outside = join(root, "outside.json");
    writeFileSync(outside, JSON.stringify({ ...saved, id: "planted" }));
    symlinkSync(outside, join(dir, "planted.json"));
    expect(new PhoneRoutes({ root, enabled: true }).list(OWNER).map((route) => route.id)).toEqual([saved.id]);
  });

  it("keeps two owners' routes apart", () => {
    const routes = new PhoneRoutes({ root, enabled: true });
    recordMessaging(routes, { ownerKey: OWNER });
    recordMessaging(routes, { ownerKey: OTHER, goal: "给李四发一条短信" }, "李四");

    expect(routes.list(OWNER).map((route) => route.template)).toEqual(["给{1}发一条消息"]);
    expect(routes.list(OTHER).map((route) => route.template)).toEqual(["给{1}发一条短信"]);
    expect(routes.match(OWNER, "给王五发一条短信")).toEqual([]);
    expect(routes.match(OTHER, "给王五发一条短信")).toHaveLength(1);
    expect(routes.match(null, "给王五发一条短信")).toEqual([]);
    expect(routes.list(null)).toEqual([]);
  });

  it("forgets one route and no other", () => {
    const routes = new PhoneRoutes({ root, enabled: true });
    const first = recordMessaging(routes)!;
    const second = recordMessaging(routes, { goal: "给张三发一条短信" })!;
    expect(routes.forget(OWNER, first.id)).toBe(true);
    expect(routes.list(OWNER).map((route) => route.id)).toEqual([second.id]);
    expect(routes.forget(OWNER, first.id)).toBe(false);
    expect(routes.forget(OWNER, "../../etc/passwd")).toBe(false);
    expect(routes.forget(OTHER, second.id)).toBe(false);
  });

  it("writes nothing at all when it is not enabled", () => {
    const routes = new PhoneRoutes({ root, enabled: false });
    const current = turn();
    for (const step of messagingSteps()) routes.note(current, step);
    expect(routes.finish(current, { outcome: "done" })).toBeNull();
    expect(routes.list(OWNER)).toEqual([]);
    expect(routes.match(OWNER, GOAL)).toEqual([]);
    expect(routes.forget(OWNER, "anything")).toBe(false);
    expect(existsSync(root)).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });

  it("keeps a turn's buffer apart from the next turn's", () => {
    const routes = new PhoneRoutes({ root, enabled: true });
    const first = turn();
    routes.note(first, messagingSteps()[0]!);
    const second = turn({ generation: "gen-2" });
    for (const step of messagingSteps().slice(1)) routes.note(second, step);
    // Each turn is learned from its own calls alone: the later turn never inherits the tap that opened the screen.
    expect(routes.finish(second, { outcome: "done" })!.steps).toHaveLength(2);
    expect(routes.finish(first, { outcome: "done" })!.steps).toHaveLength(1);
    // A turn with no buffer at all is not learnable.
    expect(routes.finish(turn({ generation: "gen-3" }), { outcome: "done" })).toBeNull();
  });

  it("drops the observation refs a run's own steps carry", () => {
    const routes = new PhoneRoutes({ root, enabled: true });
    const current = turn({ goal: "打开消息应用并新建一条消息" });
    routes.note(current, {
      tool: "PHONE_UI_RUN",
      args: { commands: [{ op: "launch", app: "com.example.messages" }, { op: "tap", ref: "r7", text: "新建" }] },
      result: { ok: true, changed: true },
    });
    const saved = routes.finish(current, { outcome: "done" })!;
    // A ref lives for one observation only; the run finds its target again by text instead.
    expect(saved.steps[0]!.args.commands).toEqual([{ op: "launch", app: "com.example.messages" }, { op: "tap", text: "新建" }]);
  });

  it("keeps a pairing code or a password out of the anchors and the names", () => {
    const routes = new PhoneRoutes({ root, enabled: true });
    const current = turn({ goal: "确认配对" });
    const pairing: ScreenSnapshot = {
      packageName: "com.example.pair",
      elements: [
        { text: "配对码 493 812", viewId: "id/code" },
        { text: "已连接", viewId: "id/ok" },
        { text: "确认", viewId: "id/confirm", class: "android.widget.Button", bounds: [10, 400, 110, 460], clickable: true },
      ],
    };
    const done: ScreenSnapshot = { packageName: "com.example.pair", elements: [{ text: "完成", viewId: "id/done" }] };
    routes.note(current, {
      tool: "PHONE_UI_TAP", args: { ref: "r1" }, target: button(pairing, "确认"), screen: pairing.elements, after: done,
      result: { ok: true, changed: true },
    });
    const saved = routes.finish(current, { outcome: "done" })!;
    // A number, a time or an amount is never an anchor: a code changes between runs, so it must not be pinned.
    expect(saved.steps[0]!.before.texts).toEqual(["已连接"]);
    expect(allText(root)).not.toContain("493");
  });

  it("refuses a run that showed a pairing-code field, even one with no digit in it", () => {
    const routes = new PhoneRoutes({ root, enabled: true });
    const current = turn({ goal: "确认配对" });
    const pairScreen: ScreenSnapshot = {
      packageName: "com.example.pair",
      elements: [
        { text: "", description: "配对码", viewId: "id/pair", class: "android.widget.EditText", editable: true },
        { text: "确认", viewId: "id/confirm", class: "android.widget.Button", bounds: [10, 400, 110, 460], clickable: true },
      ],
    };
    routes.note(current, {
      tool: "PHONE_UI_TAP", args: { ref: "r1" }, target: button(pairScreen, "确认"), screen: pairScreen.elements,
      result: { ok: true, changed: true },
    });
    expect(routes.finish(current, { outcome: "done" })).toBeNull();
    expect(allText(root)).toBe("");
  });

  it("takes a whole snapshot as the screen a call was read against", () => {
    const routes = new PhoneRoutes({ root, enabled: true });
    const current = turn({ goal: "在消息里新建一条" });
    routes.note(current, {
      tool: "PHONE_UI_TAP",
      args: { ref: "r2" },
      target: button(listScreen, "新建"),
      screen: listScreen,
      after: composeScreen,
      result: { ok: true, changed: true },
    });
    const saved = routes.finish(current, { outcome: "done" })!;
    // The package came from the snapshot, so the step records the app it was on.
    expect(saved.steps[0]!.before).toEqual({ packageName: "com.example.messages", texts: ["消息"] });
    expect(saved.packages).toEqual(["com.example.messages"]);
  });

  it("reads a coordinate tap's target from the screen it was read against", () => {
    const routes = new PhoneRoutes({ root, enabled: true });
    const current = turn({ goal: "打开消息应用并写一条新消息" });
    routes.note(current, {
      tool: "PHONE_UI_TAP_AT",
      args: { x: 60, y: 230 },
      screen: listScreen,
      after: composeScreen,
      result: { ok: true, changed: true },
    });
    const saved = routes.finish(current, { outcome: "done" })!;
    // The point landed inside the button, so the step knows the control it pressed, not just the pixels.
    expect(saved.steps[0]!.target?.name).toBe("新建");
  });

  it("keeps a route whose words are unlike the request when the app it used is named", () => {
    const routes = new PhoneRoutes({ root, enabled: true });
    const current = turn({ goal: "给阿里巴巴集团发消息" });
    routes.note(current, {
      tool: "PHONE_UI_TYPE",
      args: { text: "阿里巴巴集团", ref: "r1" },
      target: field(composeScreen),
      screen: composeScreen,
      after: typedScreen,
      result: { ok: true, typed: true, secret: false },
    });
    expect(routes.finish(current, { outcome: "done" })).not.toBeNull();
    // The words alone are too unlike the template, but the route was recorded on this app.
    expect(routes.match(OWNER, "给欧阳娜娜发消息")).toEqual([]);
    expect(routes.match(OWNER, "给欧阳娜娜发消息", 5, ["com.example.messages"])).toHaveLength(1);
  });

  it("replaces the copy of the same path rather than keeping two", () => {
    let clock = 1_000;
    const routes = new PhoneRoutes({ root, enabled: true, now: () => clock });
    const first = recordMessaging(routes)!;
    clock = 2_000;
    const second = recordMessaging(routes)!;
    expect(second.id).not.toBe(first.id);
    expect(routes.list(OWNER)).toHaveLength(1);
    expect(readdirSync(join(root, ownerDirectoryName(OWNER)))).toHaveLength(1);
  });
});
