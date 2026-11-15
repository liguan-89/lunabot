import { describe, expect, it, vi } from "vitest";

import type { Decider } from "./index.ts";
import { decidePlacement, placementCue, PLACEMENT_MIN_PROBABILITY, type PlacementOption } from "./placement.ts";

const OPTIONS: PlacementOption[] = [
  { surface: "cloud", label: "Cloud computer", available: true, ready: true, canStart: false, canCreate: false },
  { surface: "vm", label: "Local VM", available: true, ready: false, canStart: true, canCreate: false },
  { surface: "local", label: "This computer", available: true, ready: true, canStart: false, canCreate: false },
];

function fake(p: number) {
  return { yesNo: vi.fn(async () => ({ ok: true, provider: "jev", latencyMs: 5, answers: { type: "yesno", p } })) } as unknown as Pick<Decider, "yesNo">;
}

const input = { request: "Rename the invoices in my Downloads folder", bot: { name: "Scout", title: "Researcher" }, options: OPTIONS };

describe("placementCue", () => {
  it.each([
    ["Rename the invoices in my Downloads folder", "local"],
    ["Open my desktop app and export the report", "local"],
    ["Take a screenshot of my screen", "local"],
    ["Run this untrusted script", "vm"],
    ["Test this suspicious file in a sandbox", "vm"],
    ["Run this job overnight after I leave", "cloud"],
    ["Keep watching this page in the background", "cloud"],
  ] as const)("reads %s as %s", (request, surface) => {
    expect(placementCue(request)).toBe(surface);
  });

  it("stays out of the way when no cue fires, or two of them do", () => {
    expect(placementCue("Summarise this text in three bullet points")).toBeNull();
    expect(placementCue("What is the capital of France?")).toBeNull();
    // Both local and cloud: the model is not asked to break a tie it was not given.
    expect(placementCue("Keep checking my Downloads folder while I close my laptop")).toBeNull();
  });
});

describe("decidePlacement", () => {
  it("confirms the cued place with one yes/no and picks it", async () => {
    const decider = fake(0.93);
    await expect(decidePlacement(decider, input)).resolves.toEqual({ kind: "pick", surface: "local", pTop: 0.93, provider: "jev" });
    const [seam, state, instructions, options] = (decider.yesNo as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(seam).toBe("placement");
    // Measured on the real model: the bot's own description in the state lowered every yes, so only the request is sent.
    expect(state).toEqual({ request: input.request });
    expect(String(instructions)).toContain("the person's own computer");
    expect(String(instructions)).toContain("Rename the invoices");
    expect(options).toEqual({ timeoutMs: 1_500 });
  });

  it("leaves today's Auto choice when the model vetoes the cue", async () => {
    await expect(decidePlacement(fake(PLACEMENT_MIN_PROBABILITY - 0.01), input)).resolves.toEqual({ kind: "fallback", reason: "unsure" });
  });

  it("does not ask when no cue fires", async () => {
    const decider = fake(0.99);
    await expect(decidePlacement(decider, { ...input, request: "Summarise this text" })).resolves.toEqual({ kind: "fallback", reason: "keep" });
    expect(decider.yesNo).not.toHaveBeenCalled();
  });

  it("does not ask when the cued place is not available", async () => {
    const decider = fake(0.99);
    await expect(decidePlacement(decider, { ...input, options: OPTIONS.filter((option) => option.surface !== "local") })).resolves.toEqual({ kind: "fallback", reason: "no_candidates" });
    expect(decider.yesNo).not.toHaveBeenCalled();
  });

  it("does not ask when fewer than two computers are available", async () => {
    const decider = fake(0.99);
    await expect(decidePlacement(decider, { ...input, options: OPTIONS.slice(0, 1) })).resolves.toEqual({ kind: "fallback", reason: "no_candidates" });
    expect(decider.yesNo).not.toHaveBeenCalled();
  });

  it("passes a model failure back as a fallback", async () => {
    const decider = { yesNo: vi.fn(async () => ({ ok: false, reason: "timeout" })) } as unknown as Pick<Decider, "yesNo">;
    await expect(decidePlacement(decider, input)).resolves.toEqual({ kind: "fallback", reason: "timeout" });
  });
});
