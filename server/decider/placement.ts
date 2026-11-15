// Placement: a deterministic cue proposes a place; the decision model only confirms or vetoes it.
import type { Surface } from "../../shared/wire.ts";
import type { Decider } from "./index.ts";
import type { DeciderFailure, DeciderProvider } from "./types.ts";

export const PLACEMENT_MIN_PROBABILITY = 0.6;
export const PLACEMENT_TIMEOUT_MS = 1_500;

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
  | { kind: "fallback"; reason: DeciderFailure | "unsure" | "keep" | "no_candidates" | "ambiguous" };

const clip = (value: string, max: number): string => value.length > max ? `${value.slice(0, max - 1)}…` : value;

/** What each place is for, as the sentence the model confirms. */
const WHY: Record<PlacementSurface, string> = {
  local: "the person's own computer, with their own files, apps or screen",
  vm: "an isolated virtual machine, because the work is untrusted or risky",
  cloud: "a cloud computer, because the work must keep running after the person's computer sleeps or closes",
};

/** The words that say a request needs a particular place. Deliberately narrow: a miss only means today's Auto choice.
 * Measured against the Local Laya model, the model alone answered this badly; with the cue fixed, it vetoed the
 * wrong places (a bare "my files" it read as no) and confirmed the right ones. */
const CUES: ReadonlyArray<readonly [RegExp, PlacementSurface]> = [
  [/\b(downloads?|my (?:own )?files?|my folder|desktop app|my screen|this computer|my computer|my laptop|screenshot)\b/iu, "local"],
  [/\b(untrusted|risky|sandbox|isolated|suspicious)\b/iu, "vm"],
  [/\b(while i (?:close|leave|sleep)|keep (?:checking|running|watching)|overnight|after i leave|in the background)\b/iu, "cloud"],
];

/** The place a request names, when it names exactly one. */
export function placementCue(request: string): PlacementSurface | null {
  const hits = new Set(CUES.filter(([pattern]) => pattern.test(request)).map(([, surface]) => surface));
  return hits.size === 1 ? [...hits][0]! : null;
}

/** The cue proposes, the model confirms: one yes/no, and only a sure yes moves the work. */
export async function decidePlacement(
  decider: Pick<Decider, "yesNo">,
  input: PlacementInput,
  options: { timeoutMs?: number } = {},
): Promise<PlacementDecision> {
  const candidates = input.options.filter((option): option is PlacementOption & { surface: PlacementSurface } =>
    option.available && (option.surface === "cloud" || option.surface === "vm" || option.surface === "local"));
  if (candidates.length < 2) return { kind: "fallback", reason: "no_candidates" };
  const request = clip(input.request.trim(), 2_000);
  if (!request) return { kind: "fallback", reason: "keep" };
  const surface = placementCue(request);
  if (!surface) return { kind: "fallback", reason: "keep" };
  const wanted = candidates.find((candidate) => candidate.surface === surface);
  if (!wanted) return { kind: "fallback", reason: "no_candidates" };
  const result = await decider.yesNo("placement", { request }, `Does this request need ${WHY[surface]}? The person asked: ${request}`, { timeoutMs: options.timeoutMs ?? PLACEMENT_TIMEOUT_MS }).catch(() => null);
  if (!result) return { kind: "fallback", reason: "malformed" };
  if (!result.ok) return { kind: "fallback", reason: result.reason };
  if (result.answers.p < PLACEMENT_MIN_PROBABILITY) return { kind: "fallback", reason: "unsure" };
  return { kind: "pick", surface, pTop: result.answers.p, provider: result.provider };
}
