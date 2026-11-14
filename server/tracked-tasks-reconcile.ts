import type { TrackedItem } from "../shared/wire.ts";
import type { Decider } from "./decider/index.ts";
import type { DeciderQuestion } from "./decider/types.ts";

const MAX_ITEMS = 8; // botDecide answers at most 8 questions a call.
const TRANSITIONS: Readonly<Record<TrackedItem["state"], readonly TrackedItem["state"][]>> = {
  open: ["needs-you", "done"],
  "needs-you": ["done"],
  done: [],
};
const OPTIONS = {
  keep: "unchanged: the turn did not settle this item",
  "needs-you": "needs you: blocked until the person does or says something",
  done: "done: finished or no longer needed",
} as const;
const TIMEOUT_MS = 15_000;

/**
 * Re-reads a bot's open items against what the turn just did and returns forward state moves.
 * Done items never reopen here: only the bot's own tracked_tasks calls can revive them. The helper
 * sees item text as data in `state`, never as instructions. A failed or partial call returns null
 * and the list stays as the bot left it.
 */
export async function reconcileTrackedTasks(deps: {
  decider: Pick<Decider, "ask">;
  model?: string;
  items: readonly TrackedItem[];
  turnText: string;
}): Promise<ReadonlyMap<string, TrackedItem["state"]> | null> {
  const candidates = deps.items.filter((item) => item.state !== "done")
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_ITEMS);
  if (!candidates.length || !deps.turnText.trim()) return null;
  const questions = Object.fromEntries(candidates.map((item) => [
    `item.${item.id.replace(/[^A-Za-z0-9_.-]/g, "_")}`,
    { type: "choice" as const, instructions: "After this turn, this item is:", options: OPTIONS },
  ]));
  const state = {
    items: candidates.map((item) => `${item.id}: ${item.title}${item.note ? ` — ${item.note}` : ""}`).join("\n").slice(0, 2_000),
    turn: deps.turnText.slice(0, 4_000),
  };
  const result = await deps.decider.ask("botDecide", state, questions as Record<string, DeciderQuestion>, { timeoutMs: TIMEOUT_MS, ...(deps.model ? { model: deps.model } : {}) });
  if (!result.ok) return null;
  const moves = new Map<string, TrackedItem["state"]>();
  for (const item of candidates) {
    const answer = result.answers[`item.${item.id.replace(/[^A-Za-z0-9_.-]/g, "_")}`];
    if (!answer || answer.type !== "choice") continue;
    const next = answer.choice;
    if (next === "keep" || !Object.hasOwn(OPTIONS, next)) continue;
    if (TRANSITIONS[item.state].includes(next as TrackedItem["state"])) moves.set(item.id, next as TrackedItem["state"]);
  }
  return moves;
}
