import { describe, expect, it } from "vitest";

import { pickBotName } from "./names.ts";

describe("pickBotName", () => {
  it("picks a free name from the shared pool and skips taken names", () => {
    const first = pickBotName([]);
    expect(first).toMatch(/^[A-Z][a-z]+( \d+)?$/);
    expect(pickBotName([first])).not.toBe(first);
  });

  it("suffixes a base name once its pool is exhausted", () => {
    const taken: string[] = [];
    let suffixed = "";
    for (let i = 0; i < 200 && !suffixed; i++) {
      const name = pickBotName(taken);
      if (/ \d+$/.test(name)) suffixed = name;
      else taken.push(name);
    }
    expect(suffixed).toMatch(/ 2$/);
    expect(taken).toContain(suffixed.slice(0, -2));
  });
});
