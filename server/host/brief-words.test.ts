import { describe, expect, it } from "vitest";

import en from "../../src/locales/en.json" with { type: "json" };
import zh from "../../src/locales/zh.json" with { type: "json" };
import { briefWords } from "./brief-words.ts";

describe.each([
  ["en", en],
  ["zh", zh],
] as const)("brief words in %s", (language, catalog) => {
  it("keeps retry wording in sync with the catalog", () => {
    expect(briefWords(language).tryAgainSoon).toBe(catalog["brief.row.tryAgainSoon"]);
  });

  it.each([0, 1, 3, 40])("keeps the caption for %i chats in sync with the catalog", (count) => {
    expect(briefWords(language).noticedAcross(count)).toBe(catalog["brief.row.noticedAcross"].replace("{count}", String(count)));
  });
});

describe("zh brief rows", () => {
  const words = briefWords("zh");

  it("keeps static rows in sync with the catalog", () => {
    expect(words.intro).toBe(zh["brief.card.intro"]);
    expect(words.needsYou).toBe(zh["brief.card.needsYou"]);
    expect(words.nothingNeedsYou).toBe(zh["brief.card.nothingNeedsYou"]);
    expect(words.waitingMany).toBe(zh["brief.card.waitingMany"]);
    expect(words.didNotFinish).toBe(zh["brief.row.didNotFinish"]);
    expect(words.unsorted).toBe(zh["brief.row.unfenced"]);
    expect(words.signInAgain).toBe(zh["brief.row.signInAgain"]);
  });

  it.each([0, 1, 3, 40])("keeps the backlog for %i emails in sync with the catalog", (count) => {
    const key = count === 1 ? "brief.card.waitingOne" : "brief.card.waitingOther";
    expect(words.waitingCount(count)).toBe(zh[key].replace("{count}", String(count)));
  });

  it("keeps app and bot details in sync with the catalog", () => {
    expect(words.draftReply("Ada")).toBe(zh["brief.card.draftReply"].replace("{who}", "Ada"));
    expect(words.couldNotRead("Gmail")).toBe(zh["brief.row.cantRead"].replace("{app}", "Gmail"));
    expect(words.unsortedNote("Scout")).toBe(zh["brief.row.unfencedNote"].replace("{name}", "Scout"));
    expect(words.unpreparedNote("Scout")).toBe(zh["brief.row.unpreparedNote"].replace("{name}", "Scout"));
  });

  it("keeps calendar overlaps in sync with the catalog", () => {
    expect(words.overlap("Planning", "Review")).toBe(zh["brief.row.clash"].replace("{first}", "Planning").replace("{second}", "Review"));
  });
});
