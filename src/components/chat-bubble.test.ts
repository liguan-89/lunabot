import { describe, expect, it } from "vitest";
import { botReplySurface, botReplyWidth, SIMPLE_BOT_BUBBLE } from "./chat-bubble";

// One rule, two callers: the settled transcript row and the live streaming
// bubble. The bug these pin is the handover — a twenty-line list streamed in a
// bubble and lost it the instant the turn settled, so the answer visibly
// deflated. A rule read off one side only cannot see that.
describe("botReplySurface", () => {
  const list = "1. One is the start.\n2. Two comes right after.\n3. Three is a small crowd.\n4. Four fills a table.\n5. Five is a hand.";

  it("draws a chat line in Simple mode's one bubble tone", () => {
    expect(botReplySurface(true, "Done. I will look every morning at 8.")).toBe(SIMPLE_BOT_BUBBLE);
  });

  it("leaves a structured long reply transparent in Simple mode, streaming or settled", () => {
    const surface = botReplySurface(true, list);
    expect(surface).toContain("bg-transparent");
    expect(surface).not.toContain("bg-card");
  });

  it("gives Advanced mode its card whether the reply is structured or not", () => {
    for (const text of ["Done.", list]) {
      const surface = botReplySurface(false, text);
      expect(surface).toContain("bg-card");
      expect(surface).not.toContain("bg-transparent");
    }
  });

  it("agrees with itself for a reply that only becomes structured at the end", () => {
    // The first four list lines are not yet "structured" (> 4 lines); the fifth
    // is. Both calls are the same function, so the change is one step in the
    // stream rather than a jump at the handover.
    const four = "1. One\n2. Two\n3. Three\n4. Four";
    expect(botReplySurface(true, four)).toBe(SIMPLE_BOT_BUBBLE);
    expect(botReplySurface(true, `${four}\n5. Five`)).toContain("bg-transparent");
  });
});

describe("botReplyWidth", () => {
  const table = "| Sender | Emails |\n| --- | ---: |\n| Acme | 4 |";

  it("keeps a chat line inside the bubble cap", () => {
    expect(botReplyWidth(true, "Done.")).toContain("--chat-bubble-max");
  });

  it("widens a table to the card measure in Simple mode", () => {
    expect(botReplyWidth(true, table)).toContain("--chat-card-pct");
  });

  it("leaves Advanced mode's own cap alone", () => {
    expect(botReplyWidth(false, "Done.")).toContain("--chat-bubble-max");
  });
});
