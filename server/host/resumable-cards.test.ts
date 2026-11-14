import { describe, expect, it } from "vitest";

import type { OptionCardData } from "../../shared/wire.ts";
import { expireOrphanedHolds } from "./resumable-cards.ts";

const heldCard = (extra: Partial<OptionCardData> = {}): OptionCardData => ({
  title: "Send on your behalf?", options: ["Allow", "Deny"], requestId: "r1", tool: "send_email",
  held: "This sends something on your behalf, so it asks you first.", heldCode: "approval.held.outbound",
  ...extra,
} as OptionCardData);

function sweep(rows: ReadonlyArray<{ threadId: string; id: string; card: unknown }>) {
  const patched: Array<{ threadId: string; id: string; card: OptionCardData }> = [];
  const expired = expireOrphanedHolds(
    rows.map((row) => ({ ...row, card: row.card === null ? null : JSON.stringify(row.card) })),
    (threadId, messageId, card) => patched.push({ threadId, id: messageId, card }),
  );
  return { expired, patched };
}

describe("boot sweep of cards whose hold died with the run", () => {
  it("expires an unanswered held approval and keeps it a card, only dead", () => {
    const { expired, patched } = sweep([{ threadId: "t1", id: "m1", card: heldCard() }]);
    expect(expired).toBe(1);
    expect(patched).toHaveLength(1);
    expect(patched[0]).toMatchObject({ threadId: "t1", id: "m1" });
    expect(patched[0]!.card.expired).toBe(true);
    expect(patched[0]!.card.requestId).toBe("r1");
  });

  it.each([
    ["a grant proposal, which answers from its saved message", { title: "Allow for 4 hours?", options: ["Allow", "Deny"], requestId: "r2", grantProposal: { id: "g1" } }],
    ["a question card built to be answered late", heldCard({ requestType: "question" })],
    ["an already-expired row never reaches the sweep", null],
  ])("leaves %s alone", (_name, card) => {
    const { expired, patched } = sweep([{ threadId: "t1", id: "m1", card }]);
    expect(expired).toBe(0);
    expect(patched).toEqual([]);
  });
});
