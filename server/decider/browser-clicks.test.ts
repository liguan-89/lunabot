import { describe, expect, it, vi } from "vitest";

import type { Decider } from "./index.ts";
import { BROWSER_CLICK_MIN_PROBABILITY, decideBrowserClick } from "./browser-clicks.ts";

const CANDIDATES = [
  { ref: "e1", role: "button", name: "Save" },
  { ref: "e2", role: "link", name: "Save draft" },
  { ref: "e3", role: "button", name: "Cancel" },
];

function fake(answer: unknown) {
  return { choose: vi.fn(async () => answer) } as unknown as Pick<Decider, "choose">;
}

const input = { intent: "save the draft", request: "Save my work", url: "https://example.test/edit", title: "Edit", candidates: CANDIDATES };

describe("decideBrowserClick", () => {
  it("picks a candidate by ref and keeps the page facts small", async () => {
    const choose = fake({ ok: true, provider: "laya", latencyMs: 5, answers: { type: "choice", choice: "e2", pTop: 0.9, margin: 0.8, probabilities: { e2: 0.9, e1: 0.1 } } });
    await expect(decideBrowserClick(choose, input)).resolves.toEqual({ kind: "pick", ref: "e2", pTop: 0.9, provider: "laya" });
    const [, state, question, options] = (choose.choose as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(state).toEqual({ request: "Save my work", intent: "save the draft", page: { url: "https://example.test/edit", title: "Edit" } });
    expect(Object.keys((question as { options: Record<string, string> }).options)).toEqual(["none", "e1", "e2", "e3"]);
    expect(options).toEqual({ timeoutMs: 1_500 });
  });

  it("falls back when the model says none matches", async () => {
    const choose = fake({ ok: true, provider: "jev", latencyMs: 5, answers: { type: "choice", choice: "none", pTop: 0.9, margin: 0.8, probabilities: {} } });
    await expect(decideBrowserClick(choose, input)).resolves.toEqual({ kind: "fallback", reason: "none" });
  });

  it("falls back when the model is unsure", async () => {
    const choose = fake({ ok: true, provider: "jev", latencyMs: 5, answers: { type: "choice", choice: "e2", pTop: BROWSER_CLICK_MIN_PROBABILITY - 0.01, margin: 0.1, probabilities: {} } });
    await expect(decideBrowserClick(choose, input)).resolves.toEqual({ kind: "fallback", reason: "unsure" });
  });

  it("does not ask without candidates, and dedupes refs", async () => {
    const choose = fake({ ok: true, provider: "jev", latencyMs: 5, answers: { type: "choice", choice: "e1", pTop: 0.9, margin: 0.8, probabilities: {} } });
    await expect(decideBrowserClick(choose, { ...input, candidates: [] })).resolves.toEqual({ kind: "fallback", reason: "no_candidates" });
    expect(choose.choose).not.toHaveBeenCalled();
    await decideBrowserClick(choose, { ...input, candidates: [...CANDIDATES, CANDIDATES[0]!] });
    const question = (choose.choose as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![2] as { options: Record<string, string> };
    expect(Object.keys(question.options)).toEqual(["none", "e1", "e2", "e3"]);
  });

  it("passes a model failure back as a fallback", async () => {
    await expect(decideBrowserClick(fake({ ok: false, reason: "timeout" }), input)).resolves.toEqual({ kind: "fallback", reason: "timeout" });
  });
});
