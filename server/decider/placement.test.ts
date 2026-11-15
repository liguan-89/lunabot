import { describe, expect, it, vi } from "vitest";

import type { Decider } from "./index.ts";
import { decidePlacement, PLACEMENT_MIN_PROBABILITY, type PlacementOption } from "./placement.ts";

const OPTIONS: PlacementOption[] = [
  { surface: "cloud", label: "Cloud computer", available: true, ready: true, canStart: false, canCreate: false },
  { surface: "vm", label: "Local VM", available: true, ready: false, canStart: true, canCreate: false },
  { surface: "local", label: "This computer", available: false, ready: false, canStart: false, canCreate: false, reason: "not connected" },
];

function fake(answer: unknown) {
  return { choose: vi.fn(async () => answer) } as unknown as Pick<Decider, "choose">;
}

const input = { request: "Check the invoice in my Downloads folder", bot: { name: "Scout", title: "Researcher" }, options: OPTIONS };

describe("decidePlacement", () => {
  it("picks an available computer and leaves unavailable ones out of the question", async () => {
    const choose = fake({ ok: true, provider: "jev", latencyMs: 5, answers: { type: "choice", choice: "vm", pTop: 0.82, margin: 0.6, probabilities: { vm: 0.82, cloud: 0.18 } } });
    await expect(decidePlacement(choose, input)).resolves.toEqual({ kind: "pick", surface: "vm", pTop: 0.82, provider: "jev" });
    const [, state, question, options] = (choose.choose as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(state).toMatchObject({ request: input.request, bot: { name: "Scout", title: "Researcher" } });
    expect(Object.keys((question as { options: Record<string, string> }).options)).toEqual(["keep", "cloud", "vm"]);
    expect(options).toEqual({ timeoutMs: 1_200 });
  });

  it("falls back when the model is not sure", async () => {
    const choose = fake({ ok: true, provider: "jev", latencyMs: 5, answers: { type: "choice", choice: "vm", pTop: PLACEMENT_MIN_PROBABILITY - 0.01, margin: 0.1, probabilities: {} } });
    await expect(decidePlacement(choose, input)).resolves.toEqual({ kind: "fallback", reason: "unsure" });
  });

  it("falls back when the model keeps today's choice", async () => {
    const choose = fake({ ok: true, provider: "jev", latencyMs: 5, answers: { type: "choice", choice: "keep", pTop: 0.9, margin: 0.8, probabilities: {} } });
    await expect(decidePlacement(choose, input)).resolves.toEqual({ kind: "fallback", reason: "keep" });
  });

  it("does not ask when fewer than two computers are available", async () => {
    const choose = fake({ ok: true, provider: "jev", latencyMs: 5, answers: { type: "choice", choice: "cloud", pTop: 0.9, margin: 0.8, probabilities: {} } });
    await expect(decidePlacement(choose, { ...input, options: OPTIONS.slice(0, 1) })).resolves.toEqual({ kind: "fallback", reason: "no_candidates" });
    expect(choose.choose).not.toHaveBeenCalled();
  });

  it("passes a model failure back as a fallback", async () => {
    const choose = fake({ ok: false, reason: "timeout" });
    await expect(decidePlacement(choose, input)).resolves.toEqual({ kind: "fallback", reason: "timeout" });
  });
});
