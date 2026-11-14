import { describe, expect, it } from "vitest";

import type { Decider } from "./decider/index.ts";
import type { TrackedItem } from "../shared/wire.ts";
import { reconcileTrackedTasks } from "./tracked-tasks-reconcile.ts";

const item = (id: string, state: TrackedItem["state"], updatedAt = 1): TrackedItem =>
  ({ id, title: `title ${id}`, state, createdAt: 0, updatedAt });

const choice = (pick: string) => ({ type: "choice" as const, choice: pick, pTop: 0.9, margin: 0.5, probabilities: {} });

function deciderWith(answers: Record<string, ReturnType<typeof choice>>): Pick<Decider, "ask"> {
  return {
    ask: (async (_seam: string, _state: unknown, _questions: unknown) => ({ ok: true, provider: "openrouter", answers, latencyMs: 1 })) as Decider["ask"],
  };
}

describe("reconcileTrackedTasks", () => {
  it("returns forward moves for open and needs-you items", async () => {
    const moves = await reconcileTrackedTasks({
      decider: deciderWith({ "item.a": choice("done"), "item.b": choice("needs-you") }),
      items: [item("a", "open"), item("b", "open")],
      turnText: "person: ship it\nbot: shipped",
    });
    expect(moves?.get("a")).toBe("done");
    expect(moves?.get("b")).toBe("needs-you");
  });

  it("never reopens a done item or downgrades needs-you to open", async () => {
    const moves = await reconcileTrackedTasks({
      decider: deciderWith({ "item.a": choice("keep"), "item.b": choice("needs-you") }),
      items: [item("a", "done"), item("b", "needs-you")],
      turnText: "turn text",
    });
    // a is a done item: not even asked. b stays (needs-you cannot move to needs-you).
    expect(moves?.size ?? 0).toBe(0);
  });

  it("returns null when the helper fails or there is nothing to ask about", async () => {
    const failing: Pick<Decider, "ask"> = { ask: (async () => ({ ok: false, reason: "timeout" })) as Decider["ask"] };
    expect(await reconcileTrackedTasks({ decider: failing, items: [item("a", "open")], turnText: "x" })).toBeNull();
    expect(await reconcileTrackedTasks({ decider: deciderWith({}), items: [item("a", "done")], turnText: "x" })).toBeNull();
    expect(await reconcileTrackedTasks({ decider: deciderWith({}), items: [item("a", "open")], turnText: "  " })).toBeNull();
  });

  it("caps the questions at the most recent 8 items and sanitizes ids", async () => {
    const items = Array.from({ length: 10 }, (_, i) => item(`i ${i}`, "open", i));
    let seen: Record<string, unknown> = {};
    const spy: Pick<Decider, "ask"> = {
      ask: (async (_s: string, _st: unknown, q: Record<string, unknown>) => { seen = q; return { ok: true, provider: "openrouter", answers: {}, latencyMs: 1 }; }) as Decider["ask"],
    };
    await reconcileTrackedTasks({ decider: spy, items, turnText: "x" });
    expect(Object.keys(seen)).toHaveLength(8);
    expect(Object.keys(seen).every((key) => /^item\.[A-Za-z0-9_.-]+$/.test(key))).toBe(true);
  });
});
