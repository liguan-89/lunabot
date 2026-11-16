// Browser clicks: the decision model picks one element from the candidates the page already offers. It never clicks
// anything itself; any failure, `none` or an unsure answer leaves the caller to use a ref or the existing error.
//
// The option keys are the elements' own accessible names, not their refs: measured against the Local Laya model, a
// ref-keyed question was answered by position (e1 for every intent), while a name-keyed one answered every case right.
import type { Decider } from "./index.ts";
import type { DeciderFailure, DeciderProvider } from "./types.ts";

export const BROWSER_CLICK_MIN_PROBABILITY = 0.6;
export const BROWSER_CLICK_TIMEOUT_MS = 1_500;
export const BROWSER_CLICK_MAX_CANDIDATES = 200;
/** An unnamed element's option key; never an element's own name, which is always quoted in its meaning. */
const UNNAMED = "unnamed element";

export interface BrowserClickCandidate {
  ref: string;
  role?: string;
  name?: string;
}

export interface BrowserClickInput {
  /** What the bot is trying to click, when it named an intent instead of a ref. */
  intent?: string;
  /** The selector that matched several elements, when that is why the model is asked. */
  selector?: string;
  /** The person's request, already scrubbed of secrets. */
  request?: string;
  url?: string;
  title?: string;
  candidates: readonly BrowserClickCandidate[];
}

export type BrowserClickDecision =
  | { kind: "pick"; ref: string; pTop: number; provider: DeciderProvider }
  | { kind: "fallback"; reason: DeciderFailure | "unsure" | "none" | "no_candidates" };

const clip = (value: string, max: number): string => value.length > max ? `${value.slice(0, max - 1)}…` : value;

/** Option key → candidate, with a repeated name told apart by its position ("Save (2)"). */
function keyed(candidates: readonly BrowserClickCandidate[]): { options: Record<string, string>; byKey: Map<string, BrowserClickCandidate> } {
  const options: Record<string, string> = {};
  const byKey = new Map<string, BrowserClickCandidate>();
  const used = new Set<string>(["none"]);
  for (const candidate of candidates) {
    const role = candidate.role?.trim() || "element";
    const name = candidate.name?.trim() ? clip(candidate.name.trim(), 160) : "";
    const base = name || UNNAMED;
    let key = base;
    for (let index = 2; used.has(key); index++) key = `${base} (${index})`;
    used.add(key);
    options[key] = name ? `${role} "${name}"` : `${role} (no accessible name)`;
    byKey.set(key, candidate);
  }
  options.none = "None of these elements matches; do not click.";
  return { options, byKey };
}

/** One choice over the page's elements plus `none`; 0.6 is the same threshold room routing uses. */
export async function decideBrowserClick(
  decider: Pick<Decider, "choose">,
  input: BrowserClickInput,
  options: { timeoutMs?: number } = {},
): Promise<BrowserClickDecision> {
  const seen = new Set<string>();
  const candidates = input.candidates.filter((candidate) => {
    if (!candidate.ref || seen.has(candidate.ref)) return false;
    seen.add(candidate.ref);
    return true;
  }).slice(0, BROWSER_CLICK_MAX_CANDIDATES);
  if (!candidates.length) return { kind: "fallback", reason: "no_candidates" };
  const { options: choices, byKey } = keyed(candidates);
  const asked = input.intent?.trim()
    ? `The person wants to ${clip(input.intent.trim(), 1_000)}. Which of these elements does that? Pick the element whose label says it.`
    : input.selector
      ? `The selector \`${clip(input.selector, 500)}\` matched several elements. Which one should be clicked?`
      : "Which of these elements should be clicked?";
  const result = await decider.choose("browserClicks", {
    ...(input.request ? { request: clip(input.request, 1_500) } : {}),
    ...(input.intent ? { intent: clip(input.intent, 1_000) } : {}),
    ...(input.selector ? { selector: clip(input.selector, 500) } : {}),
    ...(input.url || input.title ? { page: { ...(input.url ? { url: clip(input.url, 500) } : {}), ...(input.title ? { title: clip(input.title, 300) } : {}) } } : {}),
  }, { instructions: asked, options: choices }, { timeoutMs: options.timeoutMs ?? BROWSER_CLICK_TIMEOUT_MS }).catch(() => null);
  if (!result) return { kind: "fallback", reason: "malformed" };
  if (!result.ok) return { kind: "fallback", reason: result.reason };
  const answer = result.answers;
  if (answer.choice === "none") return { kind: "fallback", reason: "none" };
  if (answer.pTop < BROWSER_CLICK_MIN_PROBABILITY) return { kind: "fallback", reason: "unsure" };
  const picked = byKey.get(answer.choice);
  if (!picked) return { kind: "fallback", reason: "no_candidates" };
  return { kind: "pick", ref: picked.ref, pTop: answer.pTop, provider: result.provider };
}
