import { afterEach, describe, expect, it, vi } from "vitest";

import { cronScheduleLabel } from "../../shared/cron-label";
import { weekdayLabels } from "@/components/routines/MiniMonth";
import { cronPresetText, cronText } from "./cron-text";
import { setLocale } from "./i18n";

const cron = (expression: string) => ({ type: "cron" as const, expression, timeZone: "America/Sao_Paulo" });
const EXPRESSIONS = ["0 9 * * *", "30 8 L * *", "0 9 15 * *", "0 9 25 12 *", "0 9 * * 1-5", "0 17 * * 5", "0 9 * * 1#2", "0 9 * * 0#L", "*/5 * * * *", "0 9 1,15 * *"];

afterEach(() => { vi.unstubAllGlobals(); setLocale("en"); });

describe("a cron schedule in words", () => {
  it("says in English exactly what the server says", () => {
    expect(cronPresetText(cron("0 9 * * *"))).toBe("Every day at 9:00");
    for (const expression of EXPRESSIONS) expect(cronText(cron(expression)), expression).toBe(cronScheduleLabel(cron(expression)));
  });

  it("says familiar presets in zh, with Intl's weekday and month names and the ordinal agreeing with the weekday", () => {
    setLocale("zh");
    expect(EXPRESSIONS.map((expression) => cronText(cron(expression)))).toEqual([
      "每天 09:00 · America/Sao_Paulo",
      "每月最后一天 08:30 · America/Sao_Paulo",
      "每月 15 日 09:00 · America/Sao_Paulo",
      "每年 十二月 25 日 09:00 · America/Sao_Paulo",
      "每个工作日 09:00 · America/Sao_Paulo",
      "每周星期五 17:00 · America/Sao_Paulo",
      "每月第二个星期一 09:00 · America/Sao_Paulo",
      "每月最后一个星期日 09:00 · America/Sao_Paulo",
      "Cron */5 * * * * · America/Sao_Paulo",
      "Cron 0 9 1,15 * * · America/Sao_Paulo",
    ]);
    expect(cronPresetText(cron("*/5 * * * *"))).toBeNull();
    expect(cronText(cron("0 10 * * 6"))).toBe("每周星期六 10:00 · America/Sao_Paulo");
  });

  it("says in English exactly what the server says, whatever the browser's region", () => {
    vi.stubGlobal("navigator", { language: "en-GB" });
    setLocale("en");
    for (const expression of [...EXPRESSIONS, "0 9 25 9 *"]) expect(cronText(cron(expression)), expression).toBe(cronScheduleLabel(cron(expression)));
  });
});

describe("the mini month's weekday header", () => {
  it("starts on Monday, one narrow letter a day in the app language", () => {
    expect(weekdayLabels()).toEqual(["M", "T", "W", "T", "F", "S", "S"]);
    setLocale("zh");
    expect(weekdayLabels()).toEqual(["一", "二", "三", "四", "五", "六", "日"]);
    vi.stubGlobal("navigator", { language: "en-GB" });
    setLocale("en");
    expect(weekdayLabels()).toEqual(["M", "T", "W", "T", "F", "S", "S"]);
  });
});
