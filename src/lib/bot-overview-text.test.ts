import { afterEach, describe, expect, it, vi } from "vitest";

import { overviewLineText, overviewRoutineText, recentChangeText } from "./bot-overview-text";
import { setLocale } from "./i18n";

afterEach(() => setLocale("en"));

describe("an overview routine line", () => {
  const at = new Date(2026, 9, 22, 18, 20).getTime();

  it("is worded from its data in the reader's language, with two-digit 24-hour times", () => {
    setLocale("zh");
    expect(overviewRoutineText({ name: "Paused Sunday", paused: true, schedule: { type: "interval", everyMinutes: 60 } as never })).toBe("已暂停：Paused Sunday。");
    expect(overviewRoutineText({ name: "Triage", schedule: { type: "interval", everyMinutes: 60 } as never, nextRunAt: at, lastRun: { status: "completed", at } }))
      .toBe("每小时：Triage。 下次运行 18:20。 上次运行于 18:20 完成。");
    expect(overviewRoutineText({ name: "Odd", schedule: { type: "cron", expression: "*/20 9-17 * * 1-5", timeZone: "UTC" } as never })).toMatch(/：Odd。$/);
  });

  it("leaves English to the server, and a status this build does not know to the server's line", () => {
    expect(overviewRoutineText({ name: "Triage", schedule: { type: "interval", everyMinutes: 60 } as never })).toBeNull();
    setLocale("zh");
    expect(overviewRoutineText({ name: "Triage", schedule: { type: "interval", everyMinutes: 60 } as never, lastRun: { status: "paused-forever", at } })).toBeNull();
    expect(overviewRoutineText(undefined)).toBeNull();
  });
});

describe("the server's other overview lines", () => {
  const lines = [
    "Can use 2 connected apps: gmail, googlecalendar.",
    "Can use 1 connected app: gmail.",
    "Coordinates its department as Chief of Staff.",
    "May also coordinate these departments: General, Research.",
    "Connected apps could not be checked.",
    "Works in /Users/me/project.",
    "Command approvals follow the provider's custom configuration.",
    "Asks before contacting other bots.",
    "Can't use a computer.",
    "Profile proposal cards require your approval.",
    "Knows how to triage incoming bug reports.",
    "Listens for “Orders” webhooks.",
  ];

  it("read exactly as the server wrote them in English", () => {
    for (const line of lines) expect(overviewLineText(line)).toBe(line);
    expect(recentChangeText("soul: 120 → 340 bytes")).toBe("soul: 120 → 340 bytes");
  });

  it("are worded in zh, the app names, folders, quotes and department names kept as data", () => {
    setLocale("zh");
    expect(lines.map((line) => overviewLineText(line))).toEqual([
      "可以使用 2 个已连接应用：gmail, googlecalendar。",
      "可以使用 1 个已连接应用：gmail。",
      "以 Luna 的身份协调其部门。",
      "也可以协调这些部门：General, Research。",
      "无法检查已连接应用。",
      "工作于 /Users/me/project。",
      "命令批准遵循提供方的自定义配置。",
      "联系其他机器人前会先询问。",
      "无法使用电脑。",
      "配置提议卡片需要你的批准。",
      "知道如何triage incoming bug reports。",
      "监听「Orders」Webhook。",
    ]);
    expect(overviewLineText("Computer preference: Local VM, which isn't available on My Cloud.")).toBe("工作位置：私有桌面，它在 My Cloud 上不可用。");
    expect(recentChangeText("soul: 120 → 340 bytes")).toBe("长期指示: 120 → 340 bytes");
    expect(recentChangeText("mystery: a → b")).toBe("mystery: a → b");
    expect(overviewLineText("A line from a newer server.")).toBe("A line from a newer server.");
  });
});

describe("department names in the overview", () => {
  it("stay as data, and only the unnamed department the server marks is labelled", () => {
    setLocale("zh");
    expect(overviewLineText("May also coordinate these departments: General.", ["General"])).toBe("也可以协调这些部门：General。");
    expect(overviewLineText("May also coordinate these departments: Research, General.", ["Research, General"])).toBe("也可以协调这些部门：Research, General。");
    expect(overviewLineText("May also coordinate these departments: General, Research.", ["", "Research"])).toBe("也可以协调这些部门：通用, Research。");
    expect(overviewLineText("May also coordinate these departments: General, Research.")).toBe("也可以协调这些部门：General, Research。");
  });
});

describe("coordination lines from a server of any version", () => {
  const LINES: Array<[older: string, newer: string, zh: string]> = [
    ["Can talk to 1 other bot in its section.", "Can talk to 1 other bot in its department.", "可以与其部门中的 1 个其他机器人交谈。"],
    ["Can talk to 4 other bots in its section.", "Can talk to 4 other bots in its department.", "可以与其部门中的 4 个其他机器人交谈。"],
    ["Can talk to 1 other bot in its allowed teams.", "Can talk to 1 other bot in its allowed departments.", "可以与其允许的部门中的 1 个其他机器人交谈。"],
    ["Can talk to 3 other bots in its allowed teams.", "Can talk to 3 other bots in its allowed departments.", "可以与其允许的部门中的 3 个其他机器人交谈。"],
    ["Coordinates its section as Chief of Staff.", "Coordinates its department as Chief of Staff.", "以 Luna 的身份协调其部门。"],
    ["May also coordinate these teams: General, Research.", "May also coordinate these departments: General, Research.", "也可以协调这些部门：General, Research。"],
  ];

  it("word an older server's line and a newer one's the same in zh, singular and plural", () => {
    setLocale("zh");
    for (const [older, newer, zh] of LINES) {
      expect(overviewLineText(older), older).toBe(zh);
      expect(overviewLineText(newer), newer).toBe(zh);
    }
  });

  it("label the unnamed department when the server sends managedSections, and keep its names as data when it does not", () => {
    setLocale("zh");
    for (const line of ["May also coordinate these teams: General, Research.", "May also coordinate these departments: General, Research."]) {
      expect(overviewLineText(line, ["", "Research"]), line).toBe("也可以协调这些部门：通用, Research。");
      expect(overviewLineText(line), line).toBe("也可以协调这些部门：General, Research。");
    }
  });

  it("read in English byte for byte as the server sent them, with or without managedSections", () => {
    setLocale("en");
    for (const line of LINES.flatMap(([older, newer]) => [older, newer])) {
      expect(overviewLineText(line), line).toBe(line);
      expect(overviewLineText(line, ["", "Research"]), line).toBe(line);
    }
  });
});

describe("coordination across every department", () => {
  const lines = ["Can talk to all 3 other bots, in any department.", "Also in charge of these departments: General, Research.", "Can talk to the other bot.", "Talks only to the bots chosen for it."];

  it("keeps the server's English and translates the current coordination lines", () => {
    for (const line of lines) expect(overviewLineText(line, ["", "Research"])).toBe(line);
    setLocale("zh");
    expect(lines.map(line => overviewLineText(line, ["", "Research"]))).toEqual([
      "可以与任何部门的其他 3 个机器人交谈。",
      "另外负责这些部门：通用, Research。",
      "可以与另一个机器人交谈。",
      "只与为它选定的机器人交谈。",
    ]);
    expect(overviewLineText(lines[1]!)).toBe("另外负责这些部门：General, Research。");
  });
});

describe("a computer that is not on My Cloud, in English", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["en-US", "en-GB", "en-AU", "en-IN"])("reads as it did before (%s)", (region) => {
    vi.stubGlobal("navigator", { language: region });
    setLocale("en");
    expect(overviewLineText("Computer preference: Local VM, which isn't available on My Cloud.")).toBe("Works on: Local VM, which isn't available on My Cloud.");
    expect(overviewLineText("Computer preference: this computer, which isn't available on My Cloud.")).toBe("Works on: this computer, which isn't available on My Cloud.");
  });
});
