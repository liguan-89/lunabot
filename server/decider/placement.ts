// Where work runs: the decision model picks among the computer surfaces that are available for an Auto turn.
// It never overrides a pin, Works on, Off, a routine's cloud placement, a team computer or a handoff; any failure
// or an unsure answer leaves the app's existing Auto choice in place.
import type { Surface } from "../../shared/wire.ts";
import type { Decider } from "./index.ts";
import type { DeciderFailure, DeciderProvider } from "./types.ts";

export const PLACEMENT_MIN_PROBABILITY = 0.6;
export const PLACEMENT_TIMEOUT_MS = 1_200;

export type PlacementSurface = Exclude<Surface, "browser">;

export interface PlacementOption {
  surface: Surface;
  label: string;
  available: boolean;
  ready: boolean;
  canStart: boolean;
  canCreate: boolean;
  reason?: string;
}

export interface PlacementInput {
  /** The person's request, already scrubbed of secrets. */
  request: string;
  bot: { name: string; title?: string; description?: string };
  options: readonly PlacementOption[];
  current?: Surface;
}

export type PlacementDecision =
  | { kind: "pick"; surface: PlacementSurface; pTop: number; provider: DeciderProvider }
  | { kind: "fallback"; reason: DeciderFailure | "unsure" | "keep" | "no_candidates" };

const clip = (value: string, max: number): string => value.length > max ? `${value.slice(0, max - 1)}…` : value;

/** One choice over the available computers plus `keep`, today's Auto choice. */
export async function decidePlacement(
  decider: Pick<Decider, "choose">,
  input: PlacementInput,
  options: { timeoutMs?: number } = {},
): Promise<PlacementDecision> {
  const candidates = input.options.filter((option): option is PlacementOption & { surface: PlacementSurface } =>
    option.available && (option.surface === "cloud" || option.surface === "vm" || option.surface === "local"));
  if (candidates.length < 2) return { kind: "fallback", reason: "no_candidates" };
  const choices: Record<string, string> = {
    keep: "Keep today's automatic choice.",
  };
  for (const option of candidates) {
    const state = option.ready ? "ready now" : option.canStart ? "can start" : option.canCreate ? "can create" : "available";
    choices[option.surface] = `${option.label} — ${state}${option.reason ? ` (${clip(option.reason, 160)})` : ""}`;
  }
  const result = await decider.choose("placement", {
    request: clip(input.request, 2_000),
    bot: { name: input.bot.name, ...(input.bot.title ? { title: clip(input.bot.title, 200) } : {}), ...(input.bot.description ? { description: clip(input.bot.description, 500) } : {}) },
    ...(input.current ? { current: input.current } : {}),
  }, {
    instructions: "Choose where this bot should run the request. Keep means the app's current automatic choice. Prefer local only when the request needs the person's own files, apps or screen; prefer vm for isolated or risky work; use cloud when the person's computer is unavailable or the work should continue elsewhere.",
    options: choices,
  }, { timeoutMs: options.timeoutMs ?? PLACEMENT_TIMEOUT_MS }).catch(() => null);
  if (!result) return { kind: "fallback", reason: "malformed" };
  if (!result.ok) return { kind: "fallback", reason: result.reason };
  const answer = result.answers;
  if (answer.choice === "keep") return { kind: "fallback", reason: "keep" };
  if (answer.pTop < PLACEMENT_MIN_PROBABILITY) return { kind: "fallback", reason: "unsure" };
  const picked = candidates.find((option) => option.surface === answer.choice);
  if (!picked) return { kind: "fallback", reason: "no_candidates" };
  return { kind: "pick", surface: picked.surface, pTop: answer.pTop, provider: result.provider };
}
