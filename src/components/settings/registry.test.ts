import { describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { ADVANCED_PAGES, SECTIONS, SETTINGS_GROUPS, SIMPLE_PAGES, advancedSettingsPages, simpleSettingsPages } from "./registry";

const all = new Set(SECTIONS.map((entry) => entry.id));

describe("the settings map", () => {
  it("files every section under exactly one Simple page and one Advanced page", () => {
    const placedSimple = SIMPLE_PAGES.flatMap((page) => page.sections);
    expect(new Set(placedSimple).size).toBe(placedSimple.length);
    expect(SECTIONS.map((entry) => entry.id).filter((id) => !placedSimple.includes(id))).toEqual([]);

    const placedAdvanced = ADVANCED_PAGES.flatMap((page) => page.sections);
    expect(new Set(placedAdvanced).size).toBe(placedAdvanced.length);
    expect(SECTIONS.map((entry) => entry.id).filter((id) => !placedAdvanced.includes(id))).toEqual([]);
  });

  it("puts every section in a rail group", () => {
    const groups = new Set(SETTINGS_GROUPS.map((group) => group.id));
    expect(SECTIONS.filter((entry) => !groups.has(entry.group))).toEqual([]);
  });

  it("drops a page whose sections are all unavailable, rather than drawing it empty", () => {
    // Updates is Simple's own page, not a rail section: the dialog adds it to the available set itself.
    const withUpdates = new Set([...all, "updates" as const]);
    expect(simpleSettingsPages(withUpdates).map((page) => page.id)).toEqual(SIMPLE_PAGES.map((page) => page.id));
    expect(simpleSettingsPages(all).map((page) => page.id)).not.toContain("updates");
    expect(simpleSettingsPages(new Set())).toEqual([]);
    const generalOnly = simpleSettingsPages(new Set(["general"]));
    expect(generalOnly.map((page) => page.id)).toEqual(["general"]);
    expect(generalOnly[0]!.sections).toEqual(["general"]);

    expect(advancedSettingsPages(all).map((page) => page.id)).toEqual(ADVANCED_PAGES.map((page) => page.id));
    expect(advancedSettingsPages(new Set())).toEqual([]);
    expect(advancedSettingsPages(new Set(["appearance", "companion", "desktopWorkspaces"])).map((page) => page.id)).toEqual(["appearance", "devices"]);
  });

  it("keeps a page's label in every language", () => {
    for (const locale of ["zh", "ja", "de"] as const) {
      setLocale(locale);
      for (const page of [...SIMPLE_PAGES, ...ADVANCED_PAGES]) expect(page.labelKey, locale).toBeTruthy();
    }
    setLocale("en");
  });
});
