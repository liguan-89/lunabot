import { describe, expect, it } from "vitest";

import {
  MAX_ANCHORS,
  anchorTexts,
  anchorsAfter,
  anchorsFrom,
  effectiveWrite,
  fillTemplate,
  hasUserScreenAttachment,
  isPhoneReadTool,
  isReplayablePhoneTool,
  learnable,
  matchesRoute,
  needsDecision,
  recordRoute,
  ROUTE_PROMPT_MAX_STEPS,
  routeCandidates,
  routeFingerprint,
  routePrompt,
  routeSlots,
  selectorFor,
  stableAnchor,
  templateValues,
  type Anchors,
  type Route,
  type RouteAction,
  type RouteRun,
  type RouteStep,
  type ScreenElement,
  type Selector,
} from "./route-replay.ts";

const routeOf = (template: string, slots: number): Route => ({
  id: "r",
  template,
  slots,
  packages: [],
  appVersions: {},
  steps: [],
  successes: 0,
  consecutiveMisses: 0,
  missStep: null,
  disabled: false,
  lastUsedMs: 0,
});

const slotsOf = (template: string, slots: number, request: string) => routeSlots(routeOf(template, slots), request);

describe("routeSlots: the request's variable parts", () => {
  it("binds the exact original text, including out-of-order slot numbers", () => {
    expect(slotsOf("给 {2} 发消息说 {1}", 2, "给 张三丰 发消息说 hello world")).toEqual(["hello world", "张三丰"]);
    expect(slotsOf("打开设置", 0, "打开 设置")).toEqual([]);
  });

  it("keeps the original whitespace inside a slot", () => {
    const content = "    indented\n";
    expect(slotsOf("把以下内容写入备忘录：{1}", 1, `把以下内容写入备忘录：${content}`)).toEqual([content]);
    expect(slotsOf("给{2}发送「{1}」", 2, "给张三发送「\n  hello world\n」")).toEqual(["\n  hello world\n", "张三"]);
    expect(slotsOf("写{1}然后保存", 1, "写  hello  然后保存")).toEqual(["  hello  "]);
  });

  it("refuses more slots than the cap", () => {
    const template = Array.from({ length: 9 }, (_, index) => `a{${index + 1}}`).join("");
    expect(slotsOf(template, 9, template.replace(/\{\d+\}/g, "x"))).toBeNull();
  });

  it("refuses a request longer than the character cap", () => {
    expect(slotsOf("写{1}", 1, `写${"a".repeat(8_001)}`)).toBeNull();
    expect(slotsOf(`写{1}${"b".repeat(8_001)}`, 1, `写x${"b".repeat(8_001)}`)).toBeNull();
  });

  it("refuses duplicated or missing slot ids instead of guessing", () => {
    expect(slotsOf("写{1}然后{1}", 1, "写甲然后甲")).toBeNull();
    expect(slotsOf("写{1}然后{3}", 2, "写甲然后乙")).toBeNull();
    expect(slotsOf("写{2}", 2, "写甲")).toBeNull();
  });

  it("refuses a blank fixed segment between slots", () => {
    expect(slotsOf("写{1} {2}", 2, "写内容 其他")).toBeNull();
  });

  it("refuses an ambiguous split rather than picking one", () => {
    expect(slotsOf("给{1}发消息说{2}", 2, "给张三发消息说李四发消息说你好")).toBeNull();
    expect(slotsOf("给{1}发消息说{2}", 2, "给好发消息说好")).toBeNull();
    expect(slotsOf("写{1}{2}", 2, "写甲乙丙")).toBeNull();
  });

  it("refuses changed whitespace in the fixed text", () => {
    expect(slotsOf("在 备忘录里写{1}", 1, "在备忘录里写内容")).toBeNull();
    expect(slotsOf("写{1}然后 保存", 1, "写内容然后保存")).toBeNull();
    expect(slotsOf("写{1} {2}", 2, "写内容 其他")).toBeNull();
  });

  it("refuses text the template does not account for, and a slot with nothing in it", () => {
    expect(slotsOf("打开设置", 0, "打开设置并关闭蓝牙")).toBeNull();
    expect(slotsOf("写{1}然后保存", 1, "写内容然后保存并删除")).toBeNull();
    expect(slotsOf("写{1}", 1, "写")).toBeNull();
  });

  it("gives up when the search budget is spent", () => {
    expect(slotsOf("写{1}然后{2}保存", 2, `写内容${"然后".repeat(200)}`)).toBeNull();
  });
});

describe("filling a template and reading it back", () => {
  it("round-trips values through the request", () => {
    const template = "给{2}发送「{1}」";
    const values = ["\n  hello world\n", "张三"];
    const filled = fillTemplate(template, values);
    expect(filled).toBe("给张三发送「\n  hello world\n」");
    expect(templateValues(template, filled!)).toEqual(values);
  });

  it("round-trips a template with no slots", () => {
    expect(fillTemplate("打开设置", [])).toBe("打开设置");
    expect(templateValues("打开设置", "打开 设置")).toEqual([]);
  });

  it("refuses values that do not match the template's slots", () => {
    expect(fillTemplate("写{1}", [])).toBeNull();
    expect(fillTemplate("写{1}", ["a", "b"])).toBeNull();
    expect(fillTemplate("写{1}然后{1}", ["a"])).toBeNull();
    expect(templateValues("写{1}", "写")).toBeNull();
  });
});

describe("matchesRoute and routeCandidates", () => {
  const goal = "打开微信给张三发消息";
  const full = routeOf("打开微信给{1}发消息", 1);
  const short = routeOf("打开{1}", 1);

  it("applies when the template yields slot values, and never when disabled", () => {
    expect(matchesRoute(full, goal)).toBe(true);
    expect(matchesRoute(full, "打开计算器")).toBe(false);
    expect(matchesRoute({ ...full, disabled: true }, goal)).toBe(false);
  });

  it("orders candidates by similarity, keeps input order on ties, and drops disabled routes", () => {
    const tie = { ...full, id: "tie" };
    const disabled = { ...full, id: "off", disabled: true };
    expect(routeCandidates([short, full, tie, disabled], goal).map((route) => route.id)).toEqual(["r", "tie"]);
  });

  it("cuts the shortlist to the limit before fitting", () => {
    const routes = Array.from({ length: 7 }, (_, index) => ({ ...full, id: `r${index + 1}` }));
    expect(routeCandidates(routes, goal).map((route) => route.id)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    expect(routeCandidates(routes, goal, { limit: 2 }).map((route) => route.id)).toEqual(["r1", "r2"]);
  });

  it("keeps a low-similarity route only when the caller matched one of its packages", () => {
    const far = { ...routeOf("打开{1}", 1), id: "far", packages: ["com.tencent.mm"] };
    expect(routeCandidates([far], goal)).toEqual([]);
    expect(routeCandidates([far], goal, { packages: ["com.tencent.mm"] }).map((route) => route.id)).toEqual(["far"]);
  });

  it("drops a similar route whose template does not fit", () => {
    expect(routeCandidates([full], `${goal}并置顶`)).toEqual([]);
  });

  it("asks for a decision only when more than one route fits", () => {
    expect(needsDecision([])).toBe(false);
    expect(needsDecision([full])).toBe(false);
    expect(needsDecision([full, short])).toBe(true);
  });
});

describe("learnable", () => {
  const base = { outcome: "done", runId: "run-1", goal: "在备忘录里写今天天气不错" };

  it("learns exactly a done run with an id and no user-screen attachment", () => {
    expect(learnable(base)).toBe(true);
    expect(learnable({ ...base, outcome: "partial" })).toBe(false);
    expect(learnable({ ...base, outcome: "not_possible" })).toBe(false);
    expect(learnable({ ...base, outcome: "unknown" })).toBe(false);
    expect(learnable({ ...base, runId: null })).toBe(false);
    expect(learnable({ ...base, runId: "" })).toBe(false);
    expect(learnable({ ...base, goal: `${base.goal}\n[[screen:abc_1-2]]` })).toBe(false);
    expect(learnable({ ...base, userScreen: true })).toBe(false);
    expect(learnable({ ...base, routesOn: false })).toBe(false);
    expect(learnable({ ...base, unconfirmed: ["今天"] })).toBe(false);
    expect(learnable({ ...base, doubtful: true })).toBe(false);
  });

  it("recognises a user-screen line only when it is a whole line", () => {
    expect(hasUserScreenAttachment("看看这个\n[[screen:Abc_1-2]]")).toBe(true);
    expect(hasUserScreenAttachment("  [[screen:abc]]  ")).toBe(true);
    expect(hasUserScreenAttachment("hello [[screen:abc]]")).toBe(false);
    expect(hasUserScreenAttachment(`[[screen:${"a".repeat(65)}]]`)).toBe(false);
  });
});

describe("what may be saved", () => {
  const goal = "在备忘录里写今天天气不错";
  const newButton: ScreenElement = { ref: "e1", class: "android.widget.Button", text: "新建", viewId: "n:id/new", bounds: [800, 900, 999, 999], clickable: true };
  const bodyField: ScreenElement = { ref: "e2", class: "android.widget.EditText", text: "今天天气不错", viewId: "n:id/body", bounds: [0, 120, 999, 900], editable: true };

  const tap = (target: ScreenElement | null, screen: readonly ScreenElement[], args: Record<string, unknown> = { ref: "@e1", snapshotId: "s1" }): RouteAction => ({
    tool: "PHONE_UI_TAP",
    args,
    target,
    screen,
    before: { packageName: "com.notes", texts: ["备忘录", "全部笔记"] },
    after: { packageName: "com.notes", texts: ["新笔记"] },
    result: { ok: true, changed: true },
  });
  const type = (text: string, result: Record<string, unknown> = { ok: true, verification: "match", secret: false }): RouteAction => ({
    tool: "PHONE_UI_TYPE",
    args: { ref: "@e2", snapshotId: "s2", text },
    target: { ...bodyField, text },
    screen: [{ ...bodyField, text }],
    before: { packageName: "com.notes", texts: ["新笔记", "完成"] },
    after: { packageName: "com.notes", texts: ["保存"] },
    result,
  });
  const run = (overrides: Partial<RouteRun> = {}): RouteRun => ({
    outcome: "done",
    runId: "run-1",
    goal,
    nowMs: 99,
    actions: [tap(newButton, [newButton]), type("今天天气不错")],
    ...overrides,
  });

  it("records the steps, template, packages and time of a done run", () => {
    const route = recordRoute(run());
    expect(route).not.toBeNull();
    expect(route!.template).toBe("在备忘录里写{1}");
    expect(route!.slots).toBe(1);
    expect(route!.packages).toEqual(["com.notes"]);
    expect(route!.lastUsedMs).toBe(99);
    expect(route!.steps.map((step) => step.tool)).toEqual(["PHONE_UI_TAP", "PHONE_UI_TYPE"]);
    // Refs and snapshot ids only live for one observation.
    expect(route!.steps[0]!.args).toEqual({});
    expect(route!.steps[1]!.args).toEqual({ text: "{1}" });
  });

  it("never saves typed text, and never names an editable element by what was typed", () => {
    const route = recordRoute(run())!;
    expect(JSON.stringify(route)).not.toContain("今天天气不错");
    expect(route.steps[1]!.target).toMatchObject({ role: "android.widget.EditText", name: "", resourceId: "n:id/body" });
    // The button keeps its label, which is the screen's fixed frame, not something the person typed.
    expect(route.steps[0]!.target).toMatchObject({ role: "android.widget.Button", name: "新建", resourceId: "n:id/new", ordinal: 0, uniqueAtRecord: true });
  });

  it("keeps the anchors before and after a step, without numbers, the target or a slot value", () => {
    const noisy: Anchors = { packageName: "com.notes", texts: ["备忘录", "3条新消息", "新建", "今天天气不错的日子", "一二三四五六七八九十一二三"] };
    const route = recordRoute(run({ actions: [{ ...tap(newButton, [newButton]), before: noisy }, type("今天天气不错")] }))!;
    expect(route.steps[0]!.before.texts).toEqual(["备忘录"]);
    expect(route.steps[1]!.after.texts).toEqual(["保存"]);
    expect(route.steps[0]!.before.texts.length).toBeLessThanOrEqual(MAX_ANCHORS);
  });

  it("refuses a run that was not exactly done, has no id, or carries a user screen", () => {
    expect(recordRoute(run({ outcome: "partial" }))).toBeNull();
    expect(recordRoute(run({ outcome: "not_possible" }))).toBeNull();
    expect(recordRoute(run({ outcome: "unknown" }))).toBeNull();
    expect(recordRoute(run({ runId: null }))).toBeNull();
    expect(recordRoute(run({ goal: `${goal}\n[[screen:abc]]` }))).toBeNull();
    expect(recordRoute(run({ routesOn: false }))).toBeNull();
  });

  it("refuses a run that needed the person, a password box, a shielded screen or another capability", () => {
    expect(recordRoute(run({ spoiled: true }))).toBeNull();
    // A type whose result or element says it was a password box is never saved.
    expect(recordRoute(run({ actions: [tap(newButton, [newButton]), type("今天天气不错", { ok: true, verification: "match", secret: true })] }))).toBeNull();
    const passwordField: ScreenElement = { ...bodyField, text: "今天天气不错", password: true };
    const typedPassword: RouteAction = {
      tool: "PHONE_UI_TYPE",
      args: { ref: "@e2", text: "今天天气不错" },
      target: passwordField,
      screen: [passwordField],
      result: { ok: true, verification: "match" },
    };
    expect(recordRoute(run({ actions: [tap(newButton, [newButton]), typedPassword] }))).toBeNull();
    // With no element and no result either way, a type cannot be shown to be safe.
    expect(recordRoute(run({ actions: [{ tool: "PHONE_UI_TYPE", args: { text: "今天天气不错" }, result: { ok: true, verification: "match" } }] }))).toBeNull();
    expect(recordRoute(run({ actions: [tap(newButton, [newButton]), type("***")] }))).toBeNull();
    expect(recordRoute(run({ actions: [{ ...tap(newButton, [newButton]), protected: true }, type("今天天气不错")] }))).toBeNull();
    expect(recordRoute(run({ actions: [tap(newButton, [newButton]), type("今天天气不错"), { ...tap(newButton, [newButton]), tool: "RUN_COMMAND" }] }))).toBeNull();
    expect(recordRoute(run({ actions: [{ ...tap(newButton, [newButton]), incomplete: true }] }))).toBeNull();
  });

  it("refuses typed text that is not one unique piece of the request", () => {
    expect(recordRoute(run({ actions: [tap(newButton, [newButton]), type("日记")] }))).toBeNull();
    expect(recordRoute(run({ actions: [tap(newButton, [newButton]), type("a")] }))).toBeNull();
    const twice = "写今天天气不错,今天天气不错";
    expect(recordRoute(run({ goal: twice, actions: [tap(newButton, [newButton]), type("今天天气不错")] }))).toBeNull();
  });

  it("ignores a read the run made, but refuses a phone write it cannot replay", () => {
    const observe: RouteAction = { tool: "PHONE_UI_OBSERVE", args: {}, result: { elements: [newButton] } };
    const route = recordRoute(run({ actions: [observe, tap(newButton, [newButton]), type("今天天气不错")] }))!;
    expect(route.steps.map((step) => step.tool)).toEqual(["PHONE_UI_TAP", "PHONE_UI_TYPE"]);
    const clipboard: RouteAction = { tool: "PHONE_CLIPBOARD_SET", args: { text: "x" }, result: { ok: true } };
    expect(recordRoute(run({ actions: [clipboard, tap(newButton, [newButton])] }))).toBeNull();
  });

  it("refuses a run whose writes changed nothing", () => {
    const idle = { ...tap(newButton, [newButton]), result: { ok: true, changed: false } };
    expect(recordRoute(run({ actions: [idle] }))).toBeNull();
    expect(recordRoute(run({ actions: [] }))).toBeNull();
  });

  it("refuses a route past the step or byte cap", () => {
    const back = (): RouteAction => ({ tool: "PHONE_UI_BACK", args: {}, result: { ok: true, changed: true } });
    expect(recordRoute(run({ actions: Array.from({ length: 61 }, back) }))).toBeNull();
    const heavy = (): RouteAction => ({ ...back(), args: { note: "x".repeat(2_000) } });
    expect(recordRoute(run({ actions: Array.from({ length: 40 }, heavy) }))).toBeNull();
  });

  it("binds a target whose label is in the request as a slot, and drops one that contains a slot", () => {
    const memoIcon: ScreenElement = { class: "android.widget.TextView", text: "备忘录", bounds: [0, 0, 100, 100], clickable: true };
    const bound = recordRoute(run({ actions: [tap(memoIcon, [memoIcon]), type("今天天气不错")] }))!;
    expect(bound.template).toBe("在{1}里写{2}");
    expect(bound.slots).toBe(2);
    expect(bound.steps[0]!.target).toMatchObject({ name: "{1}" });

    const composed: ScreenElement = { class: "android.widget.Button", text: "发送今天天气不错", viewId: "n:id/x", bounds: [0, 0, 1, 1] };
    const dropped = recordRoute(run({ actions: [tap(composed, [composed]), type("今天天气不错")] }))!;
    expect(dropped.steps[0]!.target).toMatchObject({ name: "", uniqueAtRecord: false, resourceId: "n:id/x" });
  });

  it("counts same-shaped elements on one screen for the ordinal", () => {
    const first: ScreenElement = { class: "android.widget.TextView", text: "甲", bounds: [0, 0, 10, 10] };
    const second: ScreenElement = { class: "android.widget.TextView", text: "甲", bounds: [0, 20, 10, 30] };
    expect(selectorFor(first, [first, second])).toMatchObject({ ordinal: 0, uniqueAtRecord: false });
    expect(selectorFor(second, [first, second])).toMatchObject({ ordinal: 1, uniqueAtRecord: false });
    expect(selectorFor(first, [first])).toMatchObject({ ordinal: 0, uniqueAtRecord: true });
  });

  it("numbers slots by first use, so the template can name them out of order", () => {
    const late: ScreenElement = { class: "android.widget.TextView", text: "晚上好", bounds: [0, 0, 10, 10], clickable: true };
    const route = recordRoute(
      run({
        goal: "给张三发消息说晚上好",
        actions: [tap(late, [late]), type("张三")],
      }),
    )!;
    expect(route.template).toBe("给{2}发消息说{1}");
    expect(route.slots).toBe(2);
    expect(routeSlots(route, "给李四发消息说早上好")).toEqual(["早上好", "李四"]);
    expect(matchesRoute(route, "给李四发消息说早上好")).toBe(true);
  });

  it("keeps a package only once", () => {
    const route = recordRoute(run())!;
    expect(route.packages).toEqual(["com.notes"]);
  });
});

describe("anchors: the screen's fixed frame", () => {
  const list: ScreenElement = { class: "androidx.recyclerview.widget.RecyclerView", scrollable: true, bounds: [0, 100, 999, 900] };
  const row: ScreenElement = { class: "android.widget.TextView", text: "张三", bounds: [0, 200, 900, 300] };
  const typed: ScreenElement = { class: "android.widget.EditText", text: "今天天气不错", editable: true, bounds: [0, 900, 999, 999] };
  const title: ScreenElement = { class: "android.widget.TextView", text: "聊天", bounds: [0, 0, 999, 100] };
  const withId: ScreenElement = { class: "android.widget.Button", text: "发送", viewId: "n:id/send", bounds: [800, 900, 999, 999] };

  it("keeps titles and buttons, and drops list rows, typed text and numbers", () => {
    const screen = { packageName: "com.chat", elements: [title, list, row, typed, { ...withId, text: "12:30" }, withId] };
    expect(anchorTexts(screen)).toEqual(["发送", "聊天"]);
  });

  it("leaves out the target's own label before an action", () => {
    const screen = { packageName: "com.chat", elements: [title, withId] };
    expect(anchorsFrom(screen, withId)).toEqual({ packageName: "com.chat", texts: ["聊天"] });
    expect(anchorsFrom(null)).toEqual({ packageName: null, texts: [] });
  });

  it("after an action keeps only the texts the screen did not have", () => {
    const before = { packageName: "com.chat", elements: [title] };
    const after = { packageName: "com.chat", elements: [title, { ...withId, text: "已发送", viewId: null }] };
    expect(anchorsAfter(before, after)).toEqual({ packageName: "com.chat", texts: ["已发送"] });
    expect(anchorsAfter(null, after)).toEqual({ packageName: "com.chat", texts: ["聊天", "已发送"] });
  });
});

describe("small helpers", () => {
  it("knows which texts are stable enough to be anchors or names", () => {
    expect(stableAnchor("全部笔记")).toBe(true);
    for (const text of ["12:30", "¥25", "2026-10-23", "", "一二三四五六七八九十一二三"]) expect(stableAnchor(text)).toBe(false);
  });

  it("knows which writes did something", () => {
    expect(effectiveWrite("PHONE_UI_TAP", { ok: true, changed: true })).toBe(true);
    expect(effectiveWrite("PHONE_UI_TYPE", { ok: true, verification: "match" })).toBe(true);
    expect(effectiveWrite("PHONE_UI_TYPE", { typed: true, channel: "set_text" })).toBe(true);
    expect(effectiveWrite("PHONE_UI_LAUNCH", { ok: true })).toBe(true);
    expect(effectiveWrite("PHONE_UI_TAP", { ok: true })).toBe(false);
    expect(effectiveWrite("PHONE_UI_TAP", { ok: false, changed: true })).toBe(false);
    expect(effectiveWrite("PHONE_UI_TAP", { isError: true, changed: true })).toBe(false);
    expect(effectiveWrite("PHONE_UI_TAP", { error: "stale ref", changed: true })).toBe(false);
    expect(effectiveWrite("PHONE_UI_LAUNCH", { ok: true, changed: false })).toBe(false);
  });

  it("replays only the screen controls, never reads, clipboard or files", () => {
    for (const tool of ["PHONE_UI_LAUNCH", "PHONE_UI_TAP", "PHONE_UI_TYPE", "PHONE_UI_SCROLL", "PHONE_UI_KEY", "PHONE_UI_BACK"]) {
      expect(isReplayablePhoneTool(tool), tool).toBe(true);
    }
    for (const tool of ["PHONE_UI_OBSERVE", "PHONE_UI_WAIT", "PHONE_CLIPBOARD_SET", "PHONE_FILE_SHARE", "RUN_COMMAND"]) {
      expect(isReplayablePhoneTool(tool), tool).toBe(false);
    }
  });

  it("tells a phone read from a write", () => {
    for (const tool of ["PHONE_UI_OBSERVE", "PHONE_UI_WAIT", "PHONE_UI_QUERY", "PHONE_CLIPBOARD_GET", "PHONE_FILE_LIST"]) {
      expect(isPhoneReadTool(tool), tool).toBe(true);
    }
    for (const tool of ["PHONE_UI_TAP", "PHONE_UI_TYPE", "PHONE_CLIPBOARD_SET", "RUN_COMMAND"]) {
      expect(isPhoneReadTool(tool), tool).toBe(false);
    }
  });
});

describe("routeFingerprint", () => {
  const selector = { role: "button", name: "新建", resourceId: "n:id/new", bounds: [1, 2, 3, 4], ordinal: 0, uniqueAtRecord: true };
  const anchors: Anchors = { packageName: "com.notes", texts: ["备忘录"] };
  const routeOfStep = (args: Record<string, unknown>, tool = "PHONE_UI_TAP"): Route => ({
    id: "r1",
    template: "在备忘录里写{1}",
    slots: 1,
    packages: ["com.notes"],
    appVersions: {},
    steps: [{ tool, args, target: selector, before: anchors, after: anchors }],
    successes: 0,
    consecutiveMisses: 0,
    missStep: null,
    disabled: false,
    lastUsedMs: 1,
  });

  it("does not depend on object key order", () => {
    const left = routeOfStep({ package: "com.notes", text: "{1}" });
    const right = routeOfStep({ text: "{1}", package: "com.notes" });
    expect(routeFingerprint(left)).toBe(routeFingerprint(right));
    expect(routeFingerprint(left)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not depend on the id, counters, time or anchors", () => {
    const base = routeOfStep({ package: "com.notes" });
    const changed: Route = {
      ...base,
      id: "other",
      successes: 9,
      consecutiveMisses: 2,
      missStep: 1,
      disabled: true,
      lastUsedMs: 5_000,
      steps: [{ ...base.steps[0]!, before: { packageName: null, texts: ["别的"] }, after: { packageName: null, texts: [] } }],
    };
    expect(routeFingerprint(changed)).toBe(routeFingerprint(base));
  });

  it("changes when a step, its arguments or its selector differ", () => {
    const base = routeOfStep({ package: "com.notes" });
    expect(routeFingerprint(routeOfStep({ package: "com.notes" }, "PHONE_UI_TYPE"))).not.toBe(routeFingerprint(base));
    expect(routeFingerprint(routeOfStep({ package: "com.other" }))).not.toBe(routeFingerprint(base));
    const otherSelector = { ...base, steps: [{ ...base.steps[0]!, target: { ...selector, ordinal: 1 } }] };
    expect(routeFingerprint(otherSelector)).not.toBe(routeFingerprint(base));
    const otherTemplate = { ...base, template: "在备忘录里写{1}。" };
    expect(routeFingerprint(otherTemplate)).not.toBe(routeFingerprint(base));
  });

  it("is the same path whether packages were listed once or twice", () => {
    const base = routeOfStep({});
    expect(routeFingerprint({ ...base, packages: ["a", "b"] })).toBe(routeFingerprint({ ...base, packages: ["b", "a"] }));
  });
});

describe("routePrompt: the path a matched route tells the bot", () => {
  const selector: Selector = { role: "Button", name: "搜索", resourceId: null, bounds: [0, 0, 10, 10], ordinal: 0, uniqueAtRecord: true };
  const step = (over: Partial<RouteStep>): RouteStep => ({
    tool: "PHONE_UI_TAP",
    args: {},
    target: null,
    before: { packageName: "com.tencent.mm", texts: [] },
    after: { packageName: null, texts: [] },
    ...over,
  });

  it("renders each step with its slot values filled from the request", () => {
    const route: Route = {
      ...routeOf("在{1}里搜索{2}", 2),
      packages: ["com.tencent.mm"],
      steps: [
        step({ tool: "PHONE_UI_LAUNCH", args: { app: "com.tencent.mm" }, before: { packageName: null, texts: [] } }),
        step({ tool: "PHONE_UI_TAP", args: { text: "搜索" }, target: selector }),
        step({ tool: "PHONE_UI_TYPE", args: { text: "{2}" } }),
        step({ tool: "PHONE_UI_TAP", args: {}, target: { ...selector, name: "{1}" } }),
      ],
    };
    const prompt = routePrompt(route, "在微信里搜索奶茶店");
    expect(prompt).toContain('("在{1}里搜索{2}")');
    expect(prompt).toContain("It starts on com.tencent.mm.");
    expect(prompt).toContain("1. launch com.tencent.mm");
    expect(prompt).toContain('2. tap "搜索"');
    expect(prompt).toContain('3. type "奶茶店"');
    expect(prompt).toContain('4. tap "微信"');
    expect(prompt).toContain("the path does not apply");
  });

  it("is empty for a route with no steps, and caps a long one with an ellipsis", () => {
    expect(routePrompt(routeOf("打开{1}", 1), "打开设置")).toBe("");
    const long: Route = { ...routeOf("打开{1}", 1), steps: Array.from({ length: ROUTE_PROMPT_MAX_STEPS + 3 }, () => step({})) };
    const prompt = routePrompt(long, "打开设置");
    expect(prompt).toContain(`${ROUTE_PROMPT_MAX_STEPS}. tap`);
    expect(prompt).toContain("… 3 more steps");
    expect(prompt).not.toContain(`${ROUTE_PROMPT_MAX_STEPS + 1}. tap`);
  });

  it("falls back to the tool name and its arguments for a step it has no words for", () => {
    const route: Route = { ...routeOf("定一个{1}的闹钟", 1), steps: [step({ tool: "PHONE_SET_ALARM", args: { hour: 7, minute: 30 } })] };
    expect(routePrompt(route, "定一个七点半的闹钟")).toContain('PHONE_SET_ALARM {"hour":7,"minute":30}');
  });
});
