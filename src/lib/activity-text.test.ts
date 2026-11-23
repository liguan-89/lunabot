import { afterEach, describe, expect, it } from "vitest";

import { activityText, routineLineText } from "./activity-text";
import { formatServerText } from "../../shared/server-text";
import { redactParams } from "../../shared/redact";
import en from "@/locales/en.json";
import { botLineText } from "./transcript-derivations";
import { routineRunText } from "./routine-display";
import type { RoutineRun } from "./routines";
import { serverLine } from "../../server/server-lines";
import "../../server/server-line-packs";
import { setLocale } from "./i18n";

afterEach(() => setLocale("en"));

describe("a delegating bot's resumed line", () => {
  it("shows the line in the language the server used without translating it twice", () => {
    const english = serverLine(undefined, "server.teammates.resumedQuestionRestart", { who: "Scout, Ada" });
    expect(english).toBe("Resumed with a question from Scout, Ada after a restart, reviewing");
    expect(activityText({}, english)).toBe(english);
    setLocale("zh");
    const chinese = serverLine("zh", "server.teammates.resumedQuestionRestart", { who: "Scout, Ada" });
    expect(activityText({}, chinese)).toBe("重启后已带着 Scout, Ada 的问题继续，正在查看");
    expect(activityText({}, english)).toBe(english);
  });
});

describe("server notices", () => {
  const resets = {
    name: "error: This Claude account has reached its weekly limit, which resets Oct 22, 3:00 PM (UTC). Until then, switch this bot to another AI or Claude account.",
    nameCode: "chat.notice.claudeLimitResets",
    nameParams: { limit: "chat.notice.part.weeklyLimit", meanwhile: "chat.notice.part.switchAccount", resetsAt: Date.UTC(2026, 9, 22, 15), timeZone: "UTC" },
  };
  const english = resets.name.slice("error: ".length);

  it("word the parts they name and the moment they reset, in the reader's language", () => {
    setLocale("zh");
    expect(activityText(resets, english)).toBe("这个 Claude 账户已达到其每周上限，10月22日 15:00 (UTC)重置。在此之前，将此机器人切换到其他 AI 或 Claude 账户。");
    expect(activityText({ nameCode: "chat.notice.usageLimit", nameParams: { provider: "Grok", detail: " (Grok says: \"quota\")" } }, "x"))
      .toBe("这个 Grok 账户已达到用量上限 (Grok says: \"quota\")。请等待重置，或将此机器人切换到其他 AI。");
  });

  it("show the server's own English in English, and when a part or the zone cannot be worded", () => {
    expect(activityText(resets, english)).toBe(english);
    setLocale("zh");
    expect(activityText({ ...resets, nameParams: { ...resets.nameParams, timeZone: "Not/AZone" } }, english)).toBe(english);
    expect(activityText({ ...resets, nameParams: { ...resets.nameParams, limit: "chat.notice.part.inventedLater" } }, english)).toBe(english);
  });

  it("word a bot's fixed line, and leave its other lines as written", () => {
    setLocale("zh");
    expect(botLineText({ text: "English", textCode: "chat.notice.webhookHome", textParams: { name: "Orders" } }))
      .toBe("我回到了这台电脑，所以我的 Webhook「Orders」在这里又有地址了。请打开自动化，在「Orders」上选择「复制地址」，并把它粘贴到向它发送内容的应用里。");
    expect(botLineText({ text: "Hello" })).toBe("Hello");
  });
});

describe("a routine's fixed lines", () => {
  it("are worded by their code, and only a routines.server code", () => {
    expect(routineLineText("routines.server.nothingNew", "Nothing new since the last check")).toBe("Nothing new since the last check");
    setLocale("zh");
    expect(routineLineText("routines.server.nothingNew", "Nothing new since the last check")).toBe("自上次检查以来没有新内容");
    expect(routineLineText("chat.notice.resumingAfterRestart", "x")).toBe("x");
    expect(routineLineText(undefined, "x")).toBe("x");
  });
});

describe("a routine run's coded error and attention", () => {
  it.each([
    ["stalled", "the AI stalled", "AI 卡住了"],
    ["rateLimited", "a rate limit", "触发频率限制"],
    ["provider", "a temporary error", "临时错误"],
    ["failed", "a failure", "一次失败"],
  ])("composes the %s retry reason as a complete sentence", (part, english, chinese) => {
    setLocale("zh");
    expect(routineLineText("routines.server.retryAfter", `Starting again shortly after ${english}: 429`, { why: `routines.server.part.${part}`, failure: "429" }))
      .toBe(`${chinese} 后即将重新开始：429`);
  });

  const limitWait = "Waiting for the AI's usage limit to reset; this run starts again at Oct 22, 3:00 PM (UTC)";
  const params = { resets: "Oct 22, 3:00 PM (UTC)", resetsAt: Date.UTC(2026, 9, 22, 15), timeZone: "UTC" };

  it("words parts and moments, and only while the field still reads as the line's English", () => {
    setLocale("zh");
    expect(routineLineText("routines.server.limitWait", limitWait, params)).toBe("正在等待 AI 用量上限重置；此运行将于 10月22日 15:00 (UTC) 重新开始");
    expect(routineLineText("routines.server.retryAfter", "Starting again shortly after a rate limit: 429", { why: "routines.server.part.rateLimited", failure: "429" }))
      .toBe("触发频率限制 后即将重新开始：429");
    expect(routineLineText("routines.server.limitWait", "The routine was paused before this run started", params)).toBe("The routine was paused before this run started");
    expect(routineLineText("settings.title", "Settings")).toBe("Settings");
  });
});

describe("data that looks like a catalog key", () => {
  it("is shown as written: only the params a line declares as references are looked up", () => {
    setLocale("zh");
    expect(botLineText({ text: "x", textCode: "chat.notice.webhookHome", textParams: { name: "chat.notice.part.switchAccount" } }))
      .toContain("我的 Webhook「chat.notice.part.switchAccount」");
    expect(activityText({ nameCode: "chat.notice.claudeLimitSaid", nameParams: { limit: "chat.notice.part.weeklyLimit", meanwhile: "chat.notice.part.chooseModel", said: "chat.notice.part.switchAccount" } }, "x"))
      .toBe("这个 Claude 账户已达到其每周上限（Claude 说：「chat.notice.part.switchAccount」）。目前，为此机器人选择其他模型。");
    expect(routineLineText("routines.server.waitingToStart", "Waiting to start: routines.server.part.stalled", { failure: "routines.server.part.stalled" }))
      .toBe("等待开始：routines.server.part.stalled");
  });
});

describe("what a reader is shown of a stored line", () => {
  const SECRET = `sk-ant-${"a1B2".repeat(8)}`;

  it("never holds a secret its params were scrubbed of", () => {
    setLocale("zh");
    const textParams = redactParams({ name: SECRET });
    expect(botLineText({ text: "x", textCode: "chat.notice.webhookHome", textParams })).not.toContain(SECRET);
    expect(activityText({ nameCode: "chat.notice.goalWaiting", nameParams: redactParams({ name: SECRET }) }, "x")).not.toContain(SECRET);
  });

  it("is worded at the length limit, where the server cut the quoted failure to fit", () => {
    setLocale("zh");
    const params = { why: "routines.server.part.provider", failure: `${"x".repeat(450)}…` };
    const english = formatServerText(en["routines.server.retryAfter"], { ...params, why: en["routines.server.part.provider"] });
    expect(english.length).toBeLessThanOrEqual(500);
    expect(routineLineText("routines.server.retryAfter", english, params)).toMatch(/^临时错误 后即将重新开始：x+…$/);
  });
});

describe("a run's coded engine error as the routine page shows it", () => {
  const whole = "This Claude account has reached its usage limit (Claude says: \"Weekly limit reached\"). For now, switch this bot to another AI or Claude account.";
  const params = { limit: "chat.notice.part.usageLimit", meanwhile: "chat.notice.part.switchAccount", said: "Weekly limit reached" };

  it("is worded while it is whole, and shown in English once the server cut it and dropped its code", () => {
    setLocale("zh");
    expect(routineRunText({ error: whole, errorCode: "chat.notice.claudeLimitSaid", errorParams: params } as unknown as RoutineRun, "error"))
      .toBe("这个 Claude 账户已达到其用量上限（Claude 说：「Weekly limit reached」）。目前，将此机器人切换到其他 AI 或 Claude 账户。");
    const cut = `This Claude account has reached its usage limit (Claude says: "${"x".repeat(500)}`.slice(0, 500);
    expect(routineRunText({ error: cut } as unknown as RoutineRun, "error")).toBe(cut);
    expect(routineRunText({ error: cut, errorCode: "chat.notice.claudeLimitSaid", errorParams: { ...params, said: "x".repeat(500) } } as unknown as RoutineRun, "error")).toBe(cut);
  });
});
