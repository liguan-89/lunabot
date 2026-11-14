import { describe, expect, it, vi } from "vitest";

import type { Decider } from "./decider/index.ts";
import type { DeciderResult, DeciderAnswer } from "./decider/types.ts";
import { reviewToolApproval } from "./approval-review.ts";

const yes = { type: "yesno", p: 0.95 } as const;
const no = { type: "yesno", p: 0.05 } as const;
const unsure = { type: "yesno", p: 0.6 } as const;

function deciderReturning(result: DeciderResult<Record<string, DeciderAnswer>>) {
  return { ask: vi.fn(async () => result) as unknown as Decider["ask"] };
}

const REQUEST = { tool: "bash", summary: "Allow bash? — ls -la", commandLine: "ls -la" };

describe("reviewToolApproval", () => {
  it("approves an action the helper calls clearly safe", async () => {
    const decider = deciderReturning({ ok: true, provider: "jev", answers: { refuse: no, safe: yes }, latencyMs: 5 });
    expect(await reviewToolApproval({ decider, request: REQUEST })).toBe("approve");
  });

  it("denies an action the helper says must be refused", async () => {
    const decider = deciderReturning({ ok: true, provider: "jev", answers: { refuse: yes, safe: yes }, latencyMs: 5 });
    expect(await reviewToolApproval({ decider, request: REQUEST })).toBe("deny");
  });

  it("escalates when neither question is clearly answered", async () => {
    const decider = deciderReturning({ ok: true, provider: "jev", answers: { refuse: no, safe: unsure }, latencyMs: 5 });
    expect(await reviewToolApproval({ decider, request: REQUEST })).toBe("escalate");
  });

  it("escalates rather than answers when the helper call fails", async () => {
    const decider = deciderReturning({ ok: false, reason: "timeout" });
    expect(await reviewToolApproval({ decider, request: REQUEST })).toBe("escalate");
  });

  it("hands the request and the person's rules to the helper as state", async () => {
    const decider = deciderReturning({ ok: true, provider: "jev", answers: { refuse: no, safe: yes }, latencyMs: 5 });
    const rules = { allow: ["reading files"], deny: ["pushing to main"] };
    await reviewToolApproval({ decider, request: REQUEST, rules });
    expect(decider.ask).toHaveBeenCalledWith("botDecide",
      expect.objectContaining({ tool: "bash", commandLine: "ls -la", allowRules: ["reading files"], denyRules: ["pushing to main"] }),
      expect.objectContaining({ refuse: expect.objectContaining({ type: "yesno" }), safe: expect.objectContaining({ type: "yesno" }) }),
      expect.objectContaining({ timeoutMs: expect.any(Number) }));
  });

  it("asks the review model when one is configured", async () => {
    const decider = deciderReturning({ ok: true, provider: "openrouter", answers: { refuse: no, safe: yes }, latencyMs: 5 });
    await reviewToolApproval({ decider, request: REQUEST, model: "openai/gpt-4o-mini" });
    expect(decider.ask).toHaveBeenCalledWith("botDecide", expect.anything(), expect.anything(),
      expect.objectContaining({ model: "openai/gpt-4o-mini" }));
  });
});
