import { expect, it } from "vitest";

import { byLanguage, intlLocale } from "./language.ts";

it("picks the pack the app would: exact, parent, else English", () => {
  const table = { en: "en", zh: "zh" };
  expect([" ZH ", "zh-CN", "zh-Hans", "zh-Hant-TW", "zh-HK", "en-GB", "xx", undefined, ""].map((language) => byLanguage(table, language)))
    .toEqual(["zh", "zh", "zh", "zh", "zh", "en", "en", "en", "en"]);
});

it("formats in the language set, and in US English when none or a bad one is set", () => {
  expect([intlLocale("zh"), intlLocale(undefined), intlLocale("not a locale!")]).toEqual(["zh", "en-US", "en-US"]);
});


it("returns a present-but-falsy value instead of falling back to English", () => {
  expect(byLanguage({ en: true, zh: false }, "zh")).toBe(false);
  expect(byLanguage({ en: "E", zh: "" }, "zh")).toBe("");
  expect(byLanguage({ en: 1, zh: 0 }, "ZH")).toBe(0);
});
