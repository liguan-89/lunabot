import { describe, expect, it } from "vitest";

import { isReadOnlyTool } from "../../shared/outbound.ts";
import { PHONE_TOOL_NAMES } from "../../shared/phone-apps.ts";
import { phoneWriteSummary } from "./summary.ts";

/**
 * A write that posts an activity row has to have words for it. The generic
 * fallback in `phoneWriteSummary` exists so a missing pack cannot throw, not so
 * a new write can quietly show up as its bare action name — that is what made
 * a run read "Ui run on <phone>" until it got a key.
 *
 * Reads are exempt by definition: they push nothing to the chat.
 */
describe("every phone write has an activity sentence", () => {
  const writes = PHONE_TOOL_NAMES.filter((name) => !isReadOnlyTool(name));

  it("finds the writes it is meant to check", () => {
    expect(writes.length).toBeGreaterThan(20);
    expect(writes).toContain("PHONE_UI_TAP");
  });

  it("gives each one its own sentence rather than the fallback", () => {
    const missing = writes.filter((name) => phoneWriteSummary(name, "Pixel").summaryCode === undefined);
    expect(missing).toEqual([]);
  });

  it("lets a read keep the bare sentence, because it posts no row", () => {
    const read = "PHONE_FILE_SEND";
    expect(isReadOnlyTool(read)).toBe(true);
    const summary = phoneWriteSummary(read, "Pixel");
    expect(summary.summaryCode).toBeUndefined();
    // Not pinned to the exact words: describeAction owns that sentence, and the
    // point here is only that no locale key was asked for.
    expect(summary.summary.endsWith(" on Pixel")).toBe(true);
  });
});