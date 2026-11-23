import { describe, expect, it } from "vitest";

import { pickBotName } from "./names.ts";

describe("pickBotName", () => {
  it("picks from the caller's language pool and skips taken names", () => {
    const zh = pickBotName([], "zh");
    expect(zh).toMatch(/^[A-Z][a-z]+( \d+)?$/);
    expect(pickBotName([zh], "zh")).not.toBe(zh);
    expect(pickBotName([], "zh-tw")).toMatch(/\p{Script=Han}/u);
    expect(pickBotName([], "zh-hk")).toMatch(/\p{Script=Han}/u);
    expect(pickBotName([], "en")).toMatch(/^[A-Z][a-z]+( \d+)?$/);
    expect(pickBotName([], undefined)).toMatch(/^[A-Z][a-z]+( \d+)?$/);
  });

  it("suffixes a base name once its pool is exhausted", () => {
    const taken: string[] = [];
    let suffixed = "";
    for (let i = 0; i < 200 && !suffixed; i++) {
      const name = pickBotName(taken, "zh");
      if (/ \d+$/.test(name)) suffixed = name;
      else taken.push(name);
    }
    expect(suffixed).toMatch(/ 2$/);
    expect(taken).toContain(suffixed.slice(0, -2));
  });
});
