import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LiveReplyBubble } from "./LiveReplyBubble";

// The live bubble is the reply as it streams in, before the server persists
// it. Two things matter: the words are on screen (the whole point — a slow
// engine otherwise looks frozen), and it carries no settled-message
// affordances a half-written reply cannot honour.
describe("LiveReplyBubble", () => {
  const render = (text: string) => renderToStaticMarkup(createElement(LiveReplyBubble, { text }));

  it("renders the streaming text as a bot bubble", () => {
    const html = render("Hello from pi");
    expect(html).toContain('data-live-reply="true"');
    expect(html).toContain("Hello from pi");
    expect(html).toContain("chat-md");
  });

  it("renders nothing before the first token", () => {
    expect(render("")).toBe("");
    expect(render("   ")).toBe("");
  });

  it("offers no message actions or timestamp while the text is still moving", () => {
    const html = render("partial answer");
    expect(html).not.toContain("data-mid");
    expect(html).not.toContain("group-hover:opacity-100");
  });
});

// The settled row's surface is the streaming bubble's, or the handover is a
// jump: Simple mode's structured long reply has no bubble, and this component
// used to wrap it in one until the turn landed.
describe("LiveReplyBubble surfaces", () => {
  const list = "1. One is the start.\n2. Two comes right after.\n3. Three is a small crowd.\n4. Four fills a table.\n5. Five is a hand.";
  const render = (text: string, simple: boolean) => renderToStaticMarkup(createElement(LiveReplyBubble, { text, simple }));

  it("streams a structured long reply without a bubble in Simple mode, like its settled row", () => {
    const html = render(list, true);
    expect(html).toContain("bg-transparent");
    expect(html).not.toContain("bg-card");
  });

  it("keeps a chat line in the bubble in Simple mode", () => {
    const html = render("Done. I will look every morning at 8.", true);
    expect(html).toContain("bg-card");
  });

  it("keeps Advanced mode's card for both shapes", () => {
    for (const text of ["Done.", list]) expect(render(text, false)).toContain("bg-card");
  });
});
