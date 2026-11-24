import { describe, expect, it, afterEach } from "vitest";

import { setLocale, t } from "@/lib/i18n";
import { locales } from "@/locales";
import { approvalModeOptions } from "./ApprovalModeSelector";

const PACKS = Object.keys(locales).filter((code) => code !== "pt");

afterEach(() => {
  setLocale("en");
});

describe("held notes name the buttons the selector shows", () => {
  it("quotes the same mode names in every pack", () => {
    for (const code of PACKS) {
      setLocale(code);
      const label = (mode: string) =>
        approvalModeOptions().find((option) => option.mode === mode)!.label;

      expect(t("approval.held.undelivered"), code).toContain(label("auto"));
      expect(t("approval.held.sandbox"), code).toContain(label("full"));
      expect(t("approval.held.undeliveredFull"), code).toContain(label("full"));
    }
  });

  it("resolves the labels when they are read, not when the module loads", () => {
    setLocale("zh");
    expect(approvalModeOptions().map((option) => option.label)).toEqual([
      "请求批准",
      "自动接受编辑",
      "代我批准",
      "完全访问",
      "自定义（config.toml）",
    ]);

    setLocale("en");
    expect(approvalModeOptions()[2].label).toBe("Approve for me");
  });
});
