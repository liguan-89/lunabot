import { describe, expect, it } from "vitest";

import { DemoWatch } from "../demo-watch.ts";
import type { Surface } from "../../shared/wire.ts";
import type { BotRecord } from "../store.ts";
import { createWatchMeTurn, type WatchMeTurnDeps, type WatchPrompt } from "./watch-me-turn.ts";

const turn = { botId: "b1", threadId: "t1", generation: "g1" };
const bot = { id: "b1", name: "Learner", browser: true } as unknown as BotRecord;
const spec = { command: "agent-browser", env: {} };

type Deferred = { answer: "allow" | "deny" | "timeout" };

function harness(over: Partial<WatchMeTurnDeps> & { at?: Surface | null } = {}) {
  const demoWatch = new DemoWatch(0);
  const cards: Array<{ state: string }> = [];
  const evaluated: string[] = [];
  let pending: { resolve(answer: Deferred["answer"]): void } | null = null;
  const deps: WatchMeTurnDeps = {
    place: () => (over.at === undefined ? "browser" : over.at),
    current: (b) => b,
    builtInBrowserOn: () => true,
    target: async () => ({ session: "bot-b1", spec, env: {} }),
    demoWatch,
    evalPage: async (_session, _spec, _env, script) => { evaluated.push(script); return { entries: [], href: "https://shop.test/" }; },
    prompt: () => {
      const state = { state: "open" };
      cards.push(state);
      return {
        answer: new Promise<Deferred["answer"]>((resolve) => { pending = { resolve }; }),
        finishCard: (next: string) => { state.state = next; },
      } satisfies WatchPrompt;
    },
    timeoutMs: 60_000,
    turnActive: () => true,
    pollMs: 5,
    ...over,
  };
  const turn_ = createWatchMeTurn(deps);
  const settle = (answer: Deferred["answer"]) => pending?.resolve(answer);
  return { watch: turn_.watchMeForTurn, demoWatch, cards, evaluated, settle };
}

describe("watch_me guards", () => {
  it("refuses when the conversation is not on the browser", async () => {
    const { watch } = harness({ at: "local" });
    const outcome = await watch(bot, turn);
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("none open");
  });

  it("refuses when the built-in browser is off", async () => {
    const { watch } = harness({ builtInBrowserOn: () => false });
    expect((await watch(bot, turn)).ok).toBe(false);
  });

  it("refuses a second watch on the same session", async () => {
    const { watch, demoWatch } = harness();
    demoWatch.begin("bot-b1");
    const outcome = await watch(bot, turn);
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("already recording");
  });
});

describe("watch_me records the person's demo", () => {
  it("finishes into a transcript when the person taps Done", async () => {
    const { watch, demoWatch, settle } = harness();
    const pending = watch(bot, turn, { goal: "order tea" });
    await new Promise((resolve) => setImmediate(resolve));
    demoWatch.append("bot-b1", { entries: [{ k: "click", t: 'button "Buy"', url: "https://shop.test/" }] });
    settle("allow");
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('Clicked button "Buy"');
  });

  it("hands the recording off when the person releases the browser", async () => {
    const { watch, demoWatch, cards } = harness();
    const pending = watch(bot, turn);
    await new Promise((resolve) => setImmediate(resolve));
    demoWatch.append("bot-b1", { entries: [{ k: "fill", t: 'input "q"', v: "tea", url: "https://shop.test/" }] });
    demoWatch.notifyHandedBack("bot-b1");
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('Typed "tea" into input "q"');
    expect(cards[0]?.state).toBe("allow");
  });

  it("discards the recording when the person denies the card", async () => {
    const { watch, demoWatch, settle } = harness();
    const pending = watch(bot, turn);
    await new Promise((resolve) => setImmediate(resolve));
    demoWatch.append("bot-b1", { entries: [{ k: "click", t: "a", url: "https://shop.test/" }] });
    settle("deny");
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("chose not to show");
    expect(demoWatch.watching("bot-b1")).toBe(false);
  });

  it("discards the recording on timeout and expires the card", async () => {
    const { watch, settle, cards } = harness();
    const pending = watch(bot, turn);
    await new Promise((resolve) => setImmediate(resolve));
    settle("timeout");
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("in time");
    expect(cards[0]?.state).toBe("unavailable");
  });

  it("stops when its own turn ends", async () => {
    const { watch, cards } = harness({ turnActive: () => false });
    const outcome = await watch(bot, turn);
    expect(outcome.ok).toBe(false);
    expect(cards[0]?.state).toBe("deny");
  });
});
