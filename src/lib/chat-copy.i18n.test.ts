// Pure helpers that hold English in module-scope tables can resolve a label once at import and never follow the language.
import { afterEach, describe, expect, it } from "vitest";

import { activeLocale, setLocale } from "./i18n";
import { liveActivityLabel } from "./live-activity";
import { replyAuthor, replySnippet } from "./replies";
import { costCaption, usageChip, usageDetail } from "./usage";
import type { Message } from "@/state/store";

const activity = (name: string, extra: Record<string, unknown> = {}): Message =>
  ({ id: "a", at: 1, role: "bot", kind: "activity", tool: { ...extra, name } }) as Message;

afterEach(() => {
  setLocale("en");
});

describe("live activity label", () => {
  it("translates the fallback table, which is built once at import time", () => {
    setLocale("zh");
    expect(liveActivityLabel()).toBe("思考中");
    expect(liveActivityLabel(activity("Bash: pnpm test"))).toBe("正在执行命令");
    expect(liveActivityLabel(activity("mcp__computer__click"))).toBe("正在操作屏幕");

    setLocale("en");
    expect(liveActivityLabel(activity("web_search"))).toBe("Searching the web");
    expect(liveActivityLabel(activity("something_unknown"))).toBe("Working");
  });

  it("leaves the server's own narration alone", () => {
    setLocale("zh");
    expect(liveActivityLabel(activity("Edit", { spoken: "editando um arquivo" }))).toBe(
      "Editando um arquivo",
    );
  });
});

describe("the memo key the transcript uses", () => {
  it("reports the locale that took effect, after fallback", () => {
    // MessagesList is memoized on its props; this is the only one that changes with the language.
    expect(setLocale("zh-CN")).toBe("zh");
    expect(activeLocale()).toBe("zh");
    setLocale("zh-TW");
    expect(activeLocale()).toBe("zh");
    setLocale("pt-BR");
    expect(activeLocale()).toBe("en");
  });
});

describe("usage chip", () => {
  const usage = { input: 2000, output: 500, costUsd: 0.02, turns: 2 };

  it("translates the units and the cost caption", () => {
    expect(usageChip(usage)).toBe("$0.02");
    setLocale("zh");
    expect(usageDetail(usage)).toContain("输入");
    expect(usageDetail(usage)).toContain("输出");
    expect(usageChip(usage)).toBe("US$0.02");
    expect(usageChip({ ...usage, costUsd: null })).toContain("输入");
    expect(costCaption("subscription")).toBe("等价金额——包含在你的订阅中，不另计费");
    expect(costCaption(undefined)).toBe("由提供方报告");
  });
});

describe("reply quote", () => {
  it("names the author and the stripped attachments in the reader's language", () => {
    setLocale("zh");
    const fromUser = { id: "m", at: 1, role: "user", kind: "text" } as Message;
    expect(replyAuthor(fromUser)).toBe("你");
    expect(replyAuthor({ ...fromUser, role: "bot" } as Message)).toBe("助手");
    expect(replySnippet('<attached-image path="/tmp/a.png" />')).toBe("[图片]");
  });
});
