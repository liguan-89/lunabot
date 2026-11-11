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
