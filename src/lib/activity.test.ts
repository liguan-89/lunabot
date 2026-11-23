import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "./i18n";

import { activityApp, activityLabel, groupActivityByDay, outcomeChip, type ActivityRow } from "./activity";

const row = (overrides: Partial<ActivityRow> = {}): ActivityRow => ({
  at: "2026-09-07T09:00:00.000Z",
  threadId: "t1",
  tool: "Bash",
  app: null,
  label: "Ran a command",
  outcome: "ran",
  ...overrides,
});

describe("groupActivityByDay", () => {
  it("keeps newest-first order and groups rows under their local day", () => {
    // Local-time dates, so the fixture does not depend on the machine's UTC offset.
    const local = (day: number, hour: number) => new Date(2026, 8, day, hour).toISOString();
    const rows = [
      row({ at: local(7, 18) }),
      row({ at: local(7, 9) }),
      row({ at: local(5, 9) }),
    ];
    const groups = groupActivityByDay(rows, new Date(2026, 8, 7, 20));
    expect(groups.map((group) => [group.label, group.rows.length])).toEqual([
      ["Today", 2],
      ["Sat 5 Sep", 1],
    ]);
  });

  it("calls the previous day Yesterday", () => {
    const groups = groupActivityByDay([row({ at: new Date(2026, 8, 6, 12).toISOString() })], new Date(2026, 8, 7, 20));
    expect(groups[0].label).toBe("Yesterday");
  });

  it("returns no groups for no rows", () => {
    expect(groupActivityByDay([], new Date())).toEqual([]);
  });

  it("names the days exactly as before in an English app, whatever the browser's region", () => {
    vi.stubGlobal("navigator", { language: "en-GB" });
    setLocale("en");
    try {
      const groups = groupActivityByDay([row({ at: new Date(2025, 8, 17, 9).toISOString() }), row({ at: new Date(2026, 8, 5, 9).toISOString() })], new Date(2026, 8, 7, 20));
      expect(groups.map((group) => group.label)).toEqual(["Wed 17 Sep 2025", "Sat 5 Sep"]);
    } finally {
      vi.unstubAllGlobals();
      setLocale("en");
    }
  });

  describe("in zh", () => {
    afterEach(() => { setLocale("en"); });
    it("names the days with Intl's names, and the year only when it is not this one", () => {
      setLocale("zh");
      const local = (year: number, day: number) => new Date(year, 8, day, 9).toISOString();
      const groups = groupActivityByDay([row({ at: local(2026, 7) }), row({ at: local(2026, 6) }), row({ at: local(2026, 5) }), row({ at: local(2025, 5) })], new Date(2026, 8, 7, 20));
      expect(groups.map((group) => group.label)).toEqual(["今天", "昨天", "9月5日 周六", "2025年9月5日 周五"]);
    });
  });
});

describe("activityLabel", () => {
  afterEach(() => { setLocale("en"); });

  it.each([
    ["decide", "Decide", "决策", "activity.tool.team.decide"],
    ["extract", "Extract", "提取", "activity.tool.team.extract"],
    ["message_person", "Message person", "给人员发消息", "activity.tool.team.messagePerson"],
    ["report_bug", "Report bug", "报告缺陷", "activity.tool.team.reportBug"],
  ])("words %s in zh and keeps its English label unchanged", (tool, label, chinese, labelKey) => {
    const entry = row({ tool: `mcp__agents__${tool}`, app: "Team", label, labelKey });
    expect(activityLabel(entry)).toBe(label);
    setLocale("zh");
    expect(activityLabel(entry)).toBe(chinese);
  });
  it("translates the email app's presentation key but keeps its English fallback and wire tool", () => {
    const entry = row({ tool: "mcp__email__EMAIL_SEND_EMAIL", app: "Email", appKey: "activity.app.email", label: "Send email" });
    expect(activityApp(entry)).toBe("Email");
    setLocale("zh");
    expect(activityApp(entry)).toBe("邮件");
    expect(activityApp({ app: "Email" })).toBe("Email");
    expect(activityLabel(entry)).toBe("Send email");
    expect(entry.tool).toBe("mcp__email__EMAIL_SEND_EMAIL");
  });

  it("says a known tool's action in the app language, and keeps the server's words for any other key", () => {
    expect(activityLabel(row({ labelKey: "activity.tool.ranCommand" }))).toBe("Ran a command");
    setLocale("zh");
    expect(activityLabel(row({ labelKey: "activity.tool.ranCommand" }))).toBe("运行了命令");
    expect(activityLabel(row({ label: "Send email" }))).toBe("Send email");
    expect(activityLabel(row({ label: "Ran a command", labelKey: "chat.day.today" }))).toBe("Ran a command");
    expect(activityLabel(row({ app: "Research", label: "Looked up people", labelKey: "activity.tool.lookedUpPeople" }))).toBe("查询了人物信息");
    expect(activityLabel(row({ app: "Computer", label: "Type text", labelKey: "activity.tool.computer.typeText" }))).toBe("输入文字");
    expect(activityLabel(row({ app: "Team", label: "Brand new tool", labelKey: "activity.tool.team.brandNewTool" }))).toBe("Brand new tool");
    expect([activityApp(row({ app: "Team", appKey: "activity.app.team" })), activityApp(row({ app: "Research", appKey: "activity.app.research" })), activityApp(row({ app: "X" })), activityApp(row({ app: "Gmail", appKey: "chat.day.today" })), activityApp(row({ app: null }))])
      .toEqual(["团队", "研究", "X", "Gmail", null]);
    setLocale("en");
    expect(activityApp(row({ app: "Computer", appKey: "activity.app.computer" }))).toBe("Computer");
  });
});

describe("outcomeChip", () => {
  it("gives every outcome a short word and a tone", () => {
    expect(outcomeChip("ran")).toEqual({ text: "Ran", tone: "ok" });
    expect(outcomeChip("failed")).toEqual({ text: "Failed", tone: "danger" });
    expect(outcomeChip("running")).toEqual({ text: "Running", tone: "accent" });
    expect(outcomeChip("allowed")).toEqual({ text: "Allowed", tone: "ok" });
    expect(outcomeChip("denied")).toEqual({ text: "Denied", tone: "danger" });
    expect(outcomeChip("waiting")).toEqual({ text: "Needs you", tone: "warn" });
  });
});
