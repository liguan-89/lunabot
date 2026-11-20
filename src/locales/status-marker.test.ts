import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import en from "./en.json";

// A status row is a tool name whose first word is a protocol marker: `notice:` for a line the harness speaks,
// `recovery:`, `stopped:`, `error:`. Every client reads that marker before it reads the sentence — the desktop's
// `statusActivity`, `failedTurnCause` and `STATUS_MARKER`, the phone's `readableActivityName` — and a marker it does not
// recognize is not a status row at all. The first translation of `server.firstReply.*` wrote "提示：" and "Hinweis:"
// into the string, which turned a rescue notice into an anonymous tool receipt: Chinese and German readers got no
// notice, and the desktop's Switch AI button never appeared for them. The words after the marker are the translation;
// the marker is the wire.
const MARKERS = ["notice: ", "recovery: ", "stopped: ", "error: "] as const;

const LOCALES_DIR = dirname(fileURLToPath(import.meta.url));

function packs(): Array<{ code: string; pack: Record<string, string> }> {
  return readdirSync(LOCALES_DIR)
    .filter((file) => file.endsWith(".json") && file !== "en.json" && file !== "source-hashes.json")
    .sort()
    .map((file) => ({ code: file.slice(0, -".json".length), pack: JSON.parse(readFileSync(join(LOCALES_DIR, file), "utf8")) as Record<string, string> }));
}

/** The marker an English line opens with, or null for a line that is not a status row. */
function markerOf(text: string): string | null {
  return MARKERS.find((marker) => text.startsWith(marker)) ?? null;
}

describe("a status row's marker survives translation", () => {
  const marked = Object.entries(en as Record<string, string>)
    .filter(([key]) => key.startsWith("server."))
    .map(([key, text]) => [key, markerOf(text)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null);

  it("finds the lines it is about", () => {
    // The guard is worthless if the catalog stops carrying any marked line.
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.map(([key]) => key)).toContain("server.firstReply.settled");
  });

  it("keeps the marker as written in every language that translates the line", () => {
    const problems: string[] = [];
    for (const { code, pack } of packs()) {
      for (const [key, marker] of marked) {
        const text = pack[key];
        if (text === undefined) continue;
        if (!text.startsWith(marker)) {
          problems.push(`${code}.json: ${key} must start with ${JSON.stringify(marker)}, not ${JSON.stringify(text.slice(0, 24))}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("leaves the marker out of the words a person reads", () => {
    // The marker is stripped before display, so a translated line that spells it out in its own language shows it
    // twice: "提示：提示：…" once the client's strip fails to match and the row falls through to a raw chip.
    const problems: string[] = [];
    for (const { code, pack } of packs()) {
      for (const [key] of marked) {
        const text = pack[key];
        if (text === undefined) continue;
        const body = MARKERS.reduce((rest, marker) => rest.replace(marker, ""), text);
        for (const localized of ["提示：", "提示:", "Hinweis:", "Hinweis：", "注意：", "通知：", "提醒："]) {
          if (body.startsWith(localized)) problems.push(`${code}.json: ${key} spells the marker out again (${localized})`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
