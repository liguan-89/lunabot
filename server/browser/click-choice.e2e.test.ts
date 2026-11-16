// Browser clicks against real Chrome: the decision model's pick is a real ref from a real snapshot, and the click it
// causes is a real click. The model is a fake that answers like Jev; no network.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { hostTimeout } from "../testing/host-timeout.ts";
import { FixtureServer } from "./cdp/testing/fixtures.ts";
import { CHROME } from "./cdp/testing/real-chrome.ts";
import type { ClickChoiceInput } from "./click-choice.ts";
import type { BrowserTarget } from "./service.ts";
import { startService, type RealService } from "./testing/real-service.ts";

const suite = CHROME ? describe : describe.skip;

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

suite("browser clicks on real Chrome", () => {
  let fx: FixtureServer;
  let bots = 0;
  const bot = (): BrowserTarget => ({ session: `clicks-${++bots}`, key: `bot:clicks-${bots}` });
  const page = (path: string, body: string) => fx.page(path, `<!doctype html><meta charset="utf-8"><title>${path.slice(1)}</title>${body}`);

  beforeAll(async () => {
    fx = await FixtureServer.start();
  }, hostTimeout(240_000));

  afterAll(async () => {
    await fx?.close();
  });

  async function withChoice(choose: (session: string, input: ClickChoiceInput) => Promise<{ ref: string; pTop: number } | null>) {
    const real: RealService = await startService({ chooseClick: { enabled: () => true, choose } });
    const call = (target: BrowserTarget, name: string, args: Record<string, unknown> = {}) =>
      real.service.agentRpc(target, "tools/call", { name, arguments: args }) as Promise<ToolResult>;
    const text = (result: ToolResult) => result.content.map((part) => part.text ?? `[${part.type}]`).join("\n");
    return { real, call, text };
  }

  it("clicks the element an intent picks, and offers it every visible named control", async () => {
    const target = bot();
    const url = page("/intent", `<button onclick="document.querySelector('#out').textContent='saved'">Save draft</button>
      <button onclick="document.querySelector('#out').textContent='published'">Publish</button><p id="out"></p>`);
    const choose = vi.fn(async (_session: string, input: ClickChoiceInput) => {
      const match = input.candidates.find((candidate) => candidate.name === "Publish");
      return match ? { ref: match.ref, pTop: 0.93 } : null;
    });
    const { real, call, text } = await withChoice(choose);
    try {
      await call(target, "agent_browser_open", { url });
      const clicked = text(await call(target, "agent_browser_click", { intent: "publish the draft" }));
      expect(clicked).toContain("picked by the decision model, 93%");
      expect(await real.peek<string>(target, "document.querySelector('#out').textContent")).toBe("published");
      expect(choose).toHaveBeenCalledWith(target.session, expect.objectContaining({ intent: "publish the draft" }));
      const offered = choose.mock.calls[0]![1].candidates.map((candidate) => candidate.name);
      expect(offered).toEqual(expect.arrayContaining(["Save draft", "Publish"]));
    } finally {
      await real.close();
    }
  }, hostTimeout(180_000));

  it("breaks a real ambiguous selector tie, and refuses without clicking when the model cannot pick", async () => {
    const target = bot();
    const url = page("/dup", `<ul>
      <li><button onclick="document.querySelector('#out').textContent='first'">Delete</button></li>
      <li><button onclick="document.querySelector('#out').textContent='second'">Delete</button></li>
    </ul><p id="out"></p>`);
    const choose = vi.fn(async (_session: string, input: ClickChoiceInput) => {
      const second = input.candidates[1];
      return second ? { ref: second.ref, pTop: 0.88 } : null;
    });
    const { real, call, text } = await withChoice(choose);
    try {
      const opened = text(await call(target, "agent_browser_open", { url }));
      expect(opened).toContain(`button "Delete"`);
      const clicked = text(await call(target, "agent_browser_click", { selector: "text=Delete" }));
      expect(clicked).toContain("matched 2");
      expect(await real.peek<string>(target, "document.querySelector('#out').textContent")).toBe("second");

      choose.mockResolvedValueOnce(null);
      const unsure = await call(target, "agent_browser_click", { selector: "text=Delete" });
      expect(unsure.isError).toBe(true);
      expect(text(unsure)).toMatch(/ambiguous|matches 2 elements/);
      expect(await real.peek<string>(target, "document.querySelector('#out').textContent")).toBe("second");
    } finally {
      await real.close();
    }
  }, hostTimeout(180_000));

  it("does not click at all when the job is off", async () => {
    const real: RealService = await startService({});
    const target = bot();
    const url = page("/off", `<button onclick="document.querySelector('#out').textContent='clicked'">Go</button><p id="out"></p>`);
    const call = (name: string, args: Record<string, unknown> = {}) =>
      real.service.agentRpc(target, "tools/call", { name, arguments: args }) as Promise<ToolResult>;
    const text = (result: ToolResult) => result.content.map((part) => part.text ?? `[${part.type}]`).join("\n");
    try {
      await call("agent_browser_open", { url });
      const refused = await call("agent_browser_click", { intent: "click Go" });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain("Intent clicks need the local decision model");
      expect(await real.peek<string>(target, "document.querySelector('#out').textContent")).toBe("");
    } finally {
      await real.close();
    }
  }, hostTimeout(180_000));
});
