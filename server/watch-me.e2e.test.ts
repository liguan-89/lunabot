// watch_me end to end: a person takes the stand-in browser through its live view, shows a task, and hands it back; the
// harvested steps reach the bot as the tool's answer. Nothing reaches a real browser or the user's data.
import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";

import { runControlLunabot } from "../scripts/control-lunabot.ts";
import { browserFixture } from "./testing/fake-browser-fixture.ts";

const ORDER = `
  <form action="/order" method="post">
    <label>What to order <input id="q" name="q"></label>
    <button type="submit">Place order</button>
  </form>`;

/** Reads one SSE stream until `event: ready` hands back the viewer id. */
async function liveViewer(base: string, path: string): Promise<{ viewerId: string; close(): void }> {
  const response = await fetch(base + path, { headers: { origin: base } });
  if (!response.ok || !response.body) throw new Error(`live view failed: ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const ready = buffer.match(/event: ready\ndata: (\{[^\n]*\})/);
    if (ready) {
      return {
        viewerId: JSON.parse(ready[1]!).viewerId as string,
        close: () => { void reader.cancel().catch(() => {}); },
      };
    }
  }
  throw new Error("the live view never sent ready");
}

it.skipIf(process.platform === "win32")("watch_me records the person's demo and hands the steps back", async () => {
  const browser = await browserFixture("https://shop.example.com/order", undefined, ORDER);
  const { page, api, answered } = browser;
  try {
    expect((await api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Learner" })).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "browser", browserProfile: "guest" })).status).toBe(200);

    writeFileSync(browser.planPath, JSON.stringify({ [bot.id]: { turns: [
      { steps: [{ tool: "watch_me", arguments: { goal: "order tea" } }], reply: "I watched. Now I can do it myself." },
    ] } }));

    const messages = async () => (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages as any[];
    await runControlLunabot(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Show me how you order tea.", "--url", browser.base]);
    await expect.poll(async () => (await messages()).some((message) => message.card?.tool === "watch_me" && !message.card.answered), { timeout: 20_000 }).toBe(true);
    const card = (await messages()).find((message) => message.card?.tool === "watch_me")!;
    expect(card.card.title).toContain("Watch");
    expect(card.card.subtitle).toContain("order tea");
    expect(card.card.options).toEqual(["Done", "Deny"]);

    const viewer = await liveViewer(browser.base, `/api/bots/${bot.id}/browser/live?threadId=${bot.threadId}`);
    try {
      const act = async (body: Record<string, unknown>) => {
        const response = await api("POST", `/api/bots/${bot.id}/browser/action`, { viewerId: viewer.viewerId, ...body });
        expect(response.status).toBe(200);
        return response.body;
      };
      await act({ type: "take" });
      (page.window.document.querySelector("#q") as unknown as { focus(): void }).focus();
      await act({ type: "input_keyboard", eventType: "char", text: "tea" });
      await act({ type: "input_keyboard", eventType: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await act({ type: "input_mouse", eventType: "mousePressed", x: 4, y: 4, button: "left", clickCount: 1 });
      await act({ type: "input_mouse", eventType: "mouseReleased", x: 4, y: 4, button: "left", clickCount: 1 });
      await act({ type: "release" });
    } finally {
      viewer.close();
    }

    expect(await runControlLunabot(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "30", "--url", browser.base])).toMatchObject({ status: "settled" });
    const [watched] = answered(0, "watch_me");
    expect(watched.isError).toBeFalsy();
    const text = watched.content[0].text;
    expect(text).toContain("Opened https://shop.example.com/order");
    expect(text).toContain('Typed "tea" into input');
    expect(text).toContain("Pressed Enter");
    expect(text).toContain("Clicked");
    // Handing the browser back ended the demo and settled the card as Done.
    const settled = (await messages()).find((message) => message.card?.tool === "watch_me")!;
    expect(settled.card.answered).toBe("allow");
    expect(page.typed).toEqual(["tea"]);
    expect(page.mouse).toEqual(["mousePressed 4,4", "mouseReleased 4,4"]);
  } finally {
    await browser.close();
  }
}, 120_000);
