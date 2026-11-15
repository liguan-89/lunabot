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
  it("keys the choice by each element's own name, and maps the answer back to its ref", async () => {
    const choose = fake({ ok: true, provider: "laya", latencyMs: 5, answers: { type: "choice", choice: "Save draft", pTop: 0.9, margin: 0.8, probabilities: { "Save draft": 0.9, Save: 0.1 } } });
    await expect(decideBrowserClick(choose, input)).resolves.toEqual({ kind: "pick", ref: "e2", pTop: 0.9, provider: "laya" });
    const [, state, question, options] = (choose.choose as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(state).toMatchObject({ request: "Save my work", intent: "save the draft", page: { url: "https://example.test/edit", title: "Edit" } });
    expect(Object.keys((question as { options: Record<string, string> }).options)).toEqual(["Save", "Save draft", "Cancel", "none"]);
    expect((question as { instructions: string }).instructions).toContain("save the draft");
    expect(options).toEqual({ timeoutMs: 1_500 });
  });

  it("tells a repeated name apart by position, and still maps each to its own ref", async () => {
    const choose = fake({ ok: true, provider: "jev", latencyMs: 5, answers: { type: "choice", choice: "Delete (2)", pTop: 0.9, margin: 0.8, probabilities: {} } });
    const result = await decideBrowserClick(choose, { ...input, intent: undefined, selector: "text=Delete", candidates: [
      { ref: "e1", role: "button", name: "Delete" },
      { ref: "e2", role: "button", name: "Delete" },
    ] });
    expect(result).toEqual({ kind: "pick", ref: "e2", pTop: 0.9, provider: "jev" });
    const question = (choose.choose as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![2] as { options: Record<string, string> };
    expect(Object.keys(question.options)).toEqual(["Delete", "Delete (2)", "none"]);
  });

  it("names an unnamed element without letting its key collide with none", async () => {
    const choose = fake({ ok: true, provider: "jev", latencyMs: 5, answers: { type: "choice", choice: "unnamed element", pTop: 0.9, margin: 0.8, probabilities: {} } });
    await expect(decideBrowserClick(choose, { ...input, candidates: [{ ref: "e9", role: "button" }] })).resolves.toEqual({ kind: "pick", ref: "e9", pTop: 0.9, provider: "jev" });
  });

  it("falls back when the model says none matches", async () => {
    const choose = fake({ ok: true, provider: "jev", latencyMs: 5, answers: { type: "choice", choice: "none", pTop: 0.9, margin: 0.8, probabilities: {} } });
    await expect(decideBrowserClick(choose, input)).resolves.toEqual({ kind: "fallback", reason: "none" });
  });

  it("falls back when the model is unsure", async () => {
    const choose = fake({ ok: true, provider: "jev", latencyMs: 5, answers: { type: "choice", choice: "Save draft", pTop: BROWSER_CLICK_MIN_PROBABILITY - 0.01, margin: 0.1, probabilities: {} } });
    await expect(decideBrowserClick(choose, input)).resolves.toEqual({ kind: "fallback", reason: "unsure" });
  });

  it("does not ask without candidates, and dedupes refs", async () => {
    const choose = fake({ ok: true, provider: "jev", latencyMs: 5, answers: { type: "choice", choice: "Save", pTop: 0.9, margin: 0.8, probabilities: {} } });
    await expect(decideBrowserClick(choose, { ...input, candidates: [] })).resolves.toEqual({ kind: "fallback", reason: "no_candidates" });
    expect(choose.choose).not.toHaveBeenCalled();
    await decideBrowserClick(choose, { ...input, candidates: [...CANDIDATES, CANDIDATES[0]!] });
    const question = (choose.choose as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![2] as { options: Record<string, string> };
    expect(Object.keys(question.options)).toEqual(["Save", "Save draft", "Cancel", "none"]);
  });

  it("passes a model failure back as a fallback", async () => {
    await expect(decideBrowserClick(fake({ ok: false, reason: "timeout" }), input)).resolves.toEqual({ kind: "fallback", reason: "timeout" });
  });
});
