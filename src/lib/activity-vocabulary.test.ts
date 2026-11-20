import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FALLBACK_LABELS, toolActivityPhrases } from "./live-activity";

// One vocabulary, two spellings: the desktop's FALLBACK_LABELS maps a tool id to a
// locale key, the phone's ActivityNaming.TOOL_LABELS maps the same id groups, in
// the same order, to its words. This test reads the Kotlin source and makes drift
// a failure instead of a review comment — a group added on one side and forgotten
// on the other fails here.
const KOTLIN = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../android/app/src/main/kotlin/com/lunabot/companion/ui/ActivityNaming.kt",
);

function kotlinIdGroups(): string[][] {
  const source = readFileSync(KOTLIN, "utf8");
  const groups: string[][] = [];
  for (const match of source.matchAll(/Regex\("\^(?:\(\?:)?([a-z0-9_|]+)\)?\$"/g)) {
    groups.push(match[1]!.split("|"));
  }
  return groups;
}

describe("the phone and the desktop label the same tool ids", () => {
  const groups = kotlinIdGroups();

  it("finds the phone's groups", () => {
    expect(groups.length).toBe(FALLBACK_LABELS.length);
    expect(groups.length).toBeGreaterThan(10);
  });

  it("every phone-labelled id lands on the desktop's same-position phrase", () => {
    const misses: string[] = [];
    groups.forEach((ids, index) => {
      const expected = FALLBACK_LABELS[index];
      for (const id of ids) {
        const phase = toolActivityPhrases({ name: id }).phase;
        if (phase !== expected?.[1]) misses.push(`${id}: expected ${expected?.[1]}, got ${phase}`);
      }
    });
    expect(misses).toEqual([]);
  });
});
