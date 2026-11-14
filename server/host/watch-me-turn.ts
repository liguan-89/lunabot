// watch_me for one turn: the bot asks the person to show a task in the browser. While the person
// holds it, their own input is recorded through the live view; tapping Done on the card — or simply
// handing the browser back — closes the recording into a step transcript.
import type { Surface } from "../../shared/wire.ts";
import { DEMO_HARVEST, type DemoWatch } from "../demo-watch.ts";
import type { BotRecord } from "../store.ts";

type Spec = { command: string; env: Record<string, string> };
type Turn = { botId: string; threadId: string; generation: string };
type Answer = { ok: boolean; text: string };

export interface WatchPrompt {
  /** Settles when the person taps the card or the card times out: "allow" is Done, "deny" is Deny. */
  answer: Promise<"allow" | "deny" | "timeout">;
  /** Marks the card when the recording ended another way (hand-back, dead turn), so a late tap cannot revive it. */
  finishCard(state: "allow" | "deny" | "unavailable"): void;
}

export interface WatchMeTurnDeps {
  place(bot: BotRecord, threadId: string): Surface | null;
  current(bot: BotRecord, threadId: string): BotRecord;
  builtInBrowserOn(): boolean;
  target(bot: BotRecord, threadId: string): Promise<{ session: string; spec: Spec; env: NodeJS.ProcessEnv } | null>;
  demoWatch: Pick<DemoWatch, "begin" | "finish" | "waitForHandBack">;
  /** An eval through the agent engine channel; null while the person holds the browser or it is gone. */
  evalPage(session: string, spec: Spec, env: NodeJS.ProcessEnv, script: string): Promise<unknown | null>;
  /** Shows the "show me" card and exposes its answer. */
  prompt(input: { bot: BotRecord; threadId: string; goal?: string; timeoutMs: number }): WatchPrompt;
  /** How long the card waits before the demo gives up. */
  timeoutMs: number;
  /** False once the turn that asked has ended. */
  turnActive?(turn: Turn): boolean;
  /** How often a dead turn is noticed; tests shorten it. */
  pollMs?: number;
}

export function createWatchMeTurn(deps: WatchMeTurnDeps) {
  const pollMs = deps.pollMs ?? 400;

  async function watchMeForTurn(bot: BotRecord, turn: Turn, rawGoal?: unknown): Promise<Answer> {
    const threadId = turn.threadId;
    const goal = typeof rawGoal === "string" && rawGoal.trim() ? rawGoal.trim().slice(0, 200) : undefined;
    const current = deps.current(bot, threadId);
    if (deps.place(bot, threadId) !== "browser") {
      return { ok: false, text: "watch_me records the person only in your own browser, and this conversation has none open. Move it to the browser first." };
    }
    if (current.browser === false || current.computer === "off" || !deps.builtInBrowserOn()) {
      return { ok: false, text: "The built-in browser is off for you here, so watch_me has nowhere to record. Ask the person to describe the steps instead." };
    }
    const browser = await deps.target(current, threadId);
    if (!browser) {
      return { ok: false, text: "The browser is not available on this computer right now. Ask the person to describe the steps instead." };
    }
    const { session, spec, env } = browser;
    if (!deps.demoWatch.begin(session)) {
      return { ok: false, text: "This browser is already recording a demo. Finish that one first." };
    }
    let prompt: WatchPrompt;
    try {
      prompt = deps.prompt({ bot: current, threadId, goal, timeoutMs: deps.timeoutMs });
    } catch (error) {
      deps.demoWatch.finish(session);
      throw error;
    }
    const verdict = await waitForEnd(turn, session, prompt);
    if (verdict === "deny" || verdict === "timeout" || verdict === "ended") {
      deps.demoWatch.finish(session); // discards whatever was captured
      if (verdict !== "deny") prompt.finishCard(verdict === "ended" ? "deny" : "unavailable");
      const text =
        verdict === "deny" ? "The person chose not to show the demo. Ask them what they would like instead."
        : verdict === "timeout" ? "Nobody showed the demo in time. Ask the person before trying again."
        : "The demo recording stopped when this turn ended.";
      return { ok: false, text };
    }
    if (verdict === "handed-back") prompt.finishCard("allow");
    const harvested = await deps.evalPage(session, spec, env, DEMO_HARVEST).catch(() => null);
    return deps.demoWatch.finish(session, harvested ?? undefined);
  }

  /** Resolves when the card is answered, the person's hold on the browser ends, or the turn dies. */
  function waitForEnd(turn: Turn, session: string, prompt: WatchPrompt): Promise<"allow" | "deny" | "timeout" | "handed-back" | "ended"> {
    return new Promise((resolve) => {
      const done = (verdict: "allow" | "deny" | "timeout" | "handed-back" | "ended") => { clearInterval(poll); resolve(verdict); };
      const poll = setInterval(() => { if (deps.turnActive?.(turn) === false) done("ended"); }, pollMs);
      poll.unref?.();
      void prompt.answer.then((answer) => done(answer === "allow" ? "allow" : answer === "timeout" ? "timeout" : "deny"));
      void deps.demoWatch.waitForHandBack(session).then(() => done("handed-back"));
    });
  }

  return { watchMeForTurn };
}
