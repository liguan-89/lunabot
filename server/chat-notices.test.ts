import { describe, expect, it } from "vitest";

import englishCatalog from "../src/locales/en.json" with { type: "json" };
import { failedTurnCause } from "../shared/failed-turn.ts";
import { CHAT_NOTICE, failedNoticeTool, noticeTool } from "./chat-notices.ts";
import "./server-line-packs.ts";
import { serverLine } from "./server-lines.ts";
import { heldMemberLine, isHeldMemberLine } from "./room-holds.ts";
import { stoppedLine } from "./host/person-first.ts";

describe("chat notices", () => {
  it("the catalog's chat notices are exactly the ones the server writes", () => {
    const clientLabels = new Set(["chat.notice.signIn", "chat.notice.signInHint"]);
    const catalog = Object.fromEntries(Object.entries(englishCatalog).filter(([key]) => key.startsWith("chat.notice.") && !clientLabels.has(key)));
    expect(catalog).toEqual(CHAT_NOTICE);
  });

  it("keeps the English name and adds the code beside it", () => {
    expect(noticeTool("chat.notice.cutOffByRestart", { name: "Scout" }, { ok: true })).toEqual({
      ok: true,
      name: "Scout was cut off by a restart; resuming",
      nameCode: "chat.notice.cutOffByRestart",
      nameParams: { name: "Scout" },
    });
    expect(noticeTool("chat.notice.resumingAfterRestart", undefined, { ok: true })).toEqual({
      ok: true, name: "Resuming after a restart", nameCode: "chat.notice.resumingAfterRestart",
    });
  });

  it("codes only the cause of a failed turn, after its marker", () => {
    const tool = failedNoticeTool("chat.notice.stalled", { minutes: 20 });
    expect(tool).toEqual({
      name: "error: no activity for 20 minutes — the turn was stopped",
      ok: false,
      nameCode: "chat.notice.stalled",
      nameParams: { minutes: 20 },
    });
    expect(failedTurnCause(tool.name)).toBe("no activity for 20 minutes — the turn was stopped");
  });

  it.each([
    ["server.teammates.resumedQuestion", "Resumed with a question from Scout, reviewing", "已带着 Scout 的问题继续，正在查看"],
    ["server.teammates.resumedQuestionRestart", "Resumed with a question from Scout after a restart, reviewing", "重启后已带着 Scout 的问题继续，正在查看"],
    ["server.teammates.resumedResults", "Resumed with Scout results, reviewing", "已带着 Scout 的结果继续，正在查看"],
    ["server.teammates.resumedResultsRestart", "Resumed with Scout results after a restart, reviewing", "重启后已带着 Scout 的结果继续，正在查看"],
    ["server.teammates.backWithResults", "Back with the work it handed on, reviewing", "已带着转交出去的工作回来，正在查看"],
    ["server.teammates.backWithResultsRestart", "Back with the work it handed on after a restart, reviewing", "重启后已带着转交出去的工作回来，正在查看"],
  ] as const)("words %s on the server, preserving English and Chinese", (key, english, chinese) => {
    expect(serverLine(undefined, key, { who: "Scout" })).toBe(english);
    expect(serverLine("zh", key, { who: "Scout" })).toBe(chinese);
  });

  it("words the interrupted step in Chinese without changing its English duration", () => {
    expect(stoppedLine(45_000)).toBe("Stopped a step that had run for 45 s, to answer you first");
    expect(stoppedLine(120_000)).toBe("Stopped a step that had run for 2 min, to answer you first");
    expect(stoppedLine(45_000, "zh")).toBe("已停止一个已运行 45 秒的步骤，以便先回答你");
    expect(stoppedLine(120_000, "zh")).toBe("已停止一个已运行 2 分钟的步骤，以便先回答你");
  });

  it("words a routine hold in Chinese on the server", () => {
    expect(serverLine("zh", "server.routines.held.planCancelled"))
      .toBe("你的例行任务已暂停，因为方案被取消。要让某个例行任务运行到方案结束，请在「例行任务」中重新打开它。");
  });

  it("words the held line the sentinel still recognises", () => {
    expect(heldMemberLine("Reviewer")).toBe("Reviewer is held (stopped by you) — @mention it or say resume");
    expect(isHeldMemberLine(heldMemberLine("Reviewer", "zh"))).toBe(true);
  });
});
