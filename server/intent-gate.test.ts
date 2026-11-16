import { describe, expect, it, vi } from "vitest";

import {
  INTENT_CONTEXT_HEADER, INTENT_GATE_INSTRUCTIONS, INTENT_GATE_OPTIONS, INTENT_MIN_PROBABILITY, MAX_CONTEXT_TOKENS, MAX_CONTEXT_TURNS,
  assessIntent, estimateTokens, intentGateRequest, parseIntent, parseJudge,
} from "./intent-gate.ts";
import type { ChoiceAnswer, DeciderResult } from "./decider/types.ts";

const answer = (choice: string, pTop: number): ChoiceAnswer => ({ type: "choice", choice, pTop, margin: pTop - 0.05, probabilities: { [choice]: pTop } });
const ok = (choice: string, pTop: number): DeciderResult<ChoiceAnswer> => ({ ok: true, provider: "jev", latencyMs: 120, answers: answer(choice, pTop) });
const failed: DeciderResult<ChoiceAnswer> = { ok: false, reason: "timeout" };

describe("intent gate request", () => {
  it("offers exactly Mika's three options with Mika's meanings", () => {
    const { question } = intentGateRequest({ message: "what is this?" });
    expect(Object.keys(question.options)).toEqual(["DISCUSS", "READ", "ACT"]);
    expect(question.options).toEqual({
      DISCUSS: "Explain, assess, plan, or discuss. No current app or website state is needed.",
      READ: "Fetch current information from an app, website, file, or other live source. Navigation to read is allowed.",
      ACT: "Create, change, send, purchase, schedule, or otherwise perform an action now.",
    });
    expect(question.instructions).toBe(INTENT_GATE_INSTRUCTIONS);
    expect(question.options).toEqual(INTENT_GATE_OPTIONS);
  });

  it("puts the cleaned current message in `currentMessage`", () => {
    const { state } = intentGateRequest({ message: "  what  does\n\nthis\tdo?  " });
    expect(state.currentMessage).toBe("what does this do?");
  });

  it("has no context when none was given", () => {
    expect(intentGateRequest({ message: "hi" }).state.recentContext).toBe("");
    expect(intentGateRequest({ message: "hi", recentContext: "  \n " }).state.recentContext).toBe("");
  });

  it("keeps the last three turns, in order, under the header", () => {
    const recentContext = ["one", "two", "three", "four", "five"].join("\n");
    const { state } = intentGateRequest({ message: "now", recentContext });
    expect(MAX_CONTEXT_TURNS).toBe(3);
    expect(state.recentContext.split("\n")).toEqual([INTENT_CONTEXT_HEADER, "three", "four", "five"]);
  });

  it("cleans each turn onto one line and drops blank lines", () => {
    const { state } = intentGateRequest({ message: "now", recentContext: "  a\t\tb  \n\n   \n c " });
    expect(state.recentContext.split("\n").slice(1)).toEqual(["a b", "c"]);
  });

  it("drops older turns until the 800-token budget fits", () => {
    const recentContext = [0, 1, 2].map((index) => `turn ${index} ${"a".repeat(1_100)}`).join("\n");
    const { state } = intentGateRequest({ message: "now", recentContext });
    const turns = state.recentContext.split("\n").slice(1);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.startsWith("turn 1 ")).toBe(true);
    expect(turns[1]!.startsWith("turn 2 ")).toBe(true);
    expect(estimateTokens(state.recentContext)).toBeLessThanOrEqual(MAX_CONTEXT_TOKENS);
  });

  it("clips a single turn that alone is over budget, with an ellipsis", () => {
    const { state } = intentGateRequest({ message: "now", recentContext: "汉".repeat(2_000) });
    expect(state.recentContext.startsWith(INTENT_CONTEXT_HEADER)).toBe(true);
    expect(state.recentContext.endsWith("…")).toBe(true);
    expect(estimateTokens(state.recentContext)).toBeLessThanOrEqual(MAX_CONTEXT_TOKENS);
  });

  it("counts wide characters at Mika's weight and the rest at a quarter", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("汉汉汉汉")).toBe(3);
    expect(estimateTokens("汉a")).toBe(1);
  });
});

describe("parseIntent", () => {
  it("accepts each option at exactly the threshold", () => {
    expect(INTENT_MIN_PROBABILITY).toBe(0.85);
    expect(parseIntent(answer("DISCUSS", 0.85))).toBe("discuss");
    expect(parseIntent(answer("READ", 0.85))).toBe("read");
    expect(parseIntent(answer("ACT", 0.85))).toBe("act");
    expect(parseIntent(answer("ACT", 1))).toBe("act");
  });

  it("rejects each option just below the threshold", () => {
    expect(parseIntent(answer("DISCUSS", 0.8499))).toBeNull();
    expect(parseIntent(answer("READ", 0.8499))).toBeNull();
    expect(parseIntent(answer("ACT", 0.8499))).toBeNull();
  });

  it("rejects an option it did not offer", () => {
    expect(parseIntent(answer("MAYBE", 0.99))).toBeNull();
    expect(parseIntent(answer("act", 0.99))).toBeNull();
    expect(parseIntent(answer("", 0.99))).toBeNull();
  });

  it("rejects a probability that is not a finite number in range", () => {
    for (const pTop of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.01, 1.5, -0.1]) {
      expect(parseIntent(answer("ACT", pTop))).toBeNull();
    }
  });

  it("rejects no answer at all", () => {
    expect(parseIntent(null)).toBeNull();
    expect(parseIntent(undefined)).toBeNull();
  });
});

describe("parseJudge", () => {
  it("accepts the word bare, folded, backticked or padded", () => {
    expect(parseJudge("ACT")).toBe("act");
    expect(parseJudge("act")).toBe("act");
    expect(parseJudge("`ACT`")).toBe("act");
    expect(parseJudge("`act`")).toBe("act");
    expect(parseJudge("  DISCUSS \n")).toBe("discuss");
    expect(parseJudge("\tread  ")).toBe("read");
  });

  it("rejects anything else", () => {
    expect(parseJudge("DO")).toBeNull();
    expect(parseJudge("")).toBeNull();
    expect(parseJudge("   ")).toBeNull();
    expect(parseJudge("The user wants to act.")).toBeNull();
    expect(parseJudge("ACTION")).toBeNull();
  });

  it("strips one backtick from each end, as Mika does", () => {
    expect(parseJudge("``ACT``")).toBeNull();
    expect(parseJudge("`ACT")).toBe("act");
  });
});

describe("assessIntent", () => {
  it("a decision answer at the threshold wins, and the judge is not asked", async () => {
    const judge = vi.fn(async () => "ACT");
    await expect(assessIntent(async () => ok("READ", 0.9), judge)).resolves.toEqual({ intent: "read", via: "decision" });
    expect(judge).not.toHaveBeenCalled();
  });

  it("a decision answer under the threshold falls through to the judge", async () => {
    await expect(assessIntent(async () => ok("READ", 0.6), async () => "ACT")).resolves.toEqual({ intent: "act", via: "judge" });
  });

  it("a decision answer for an option it did not offer falls through to the judge", async () => {
    await expect(assessIntent(async () => ok("MAYBE", 0.99), async () => "DISCUSS")).resolves.toEqual({ intent: "discuss", via: "judge" });
  });

  it("a failed decision call falls through to the judge", async () => {
    await expect(assessIntent(async () => failed, async () => "`READ`")).resolves.toEqual({ intent: "read", via: "judge" });
  });

  it("nothing usable on either side is none", async () => {
    await expect(assessIntent(async () => failed, async () => null)).resolves.toEqual({ intent: null, via: "none" });
    await expect(assessIntent(async () => ok("ACT", 0.2), async () => "not a word")).resolves.toEqual({ intent: null, via: "none" });
  });

  it("a cancellation from the decision call propagates instead of becoming none", async () => {
    const cancelled = new Error("The person stopped this turn.");
    cancelled.name = "AbortError";
    await expect(assessIntent(async () => { throw cancelled; }, async () => "ACT")).rejects.toBe(cancelled);
  });

  it("a cancellation from the judge propagates too", async () => {
    const cancelled = new Error("The person stopped this turn.");
    cancelled.name = "AbortError";
    await expect(assessIntent(async () => failed, async () => { throw cancelled; })).rejects.toBe(cancelled);
  });
});
