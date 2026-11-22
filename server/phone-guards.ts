// Guards for a bot that drives a phone: fingerprint each action, notice one that repeats without changing the
// screen, and return either a warning with concrete ways out or a stop. Adapted from Mika's OperationGuards,
// GuardRules and Fingerprints (Apache-2.0).
//
// Not ported: the off-screen guard and its quotas (browsers, sandboxes), the read-loop guard, the tool-failure
// ladder, and the separate same-state visit counter. The off-screen, read-loop and failure rules decide whether a
// browser or sandbox call is worth making, and this repo reports tool errors elsewhere; a return to one screen is
// already covered by the cycle rule. The diagnostic-tool repeat ladder and the step-budget-scaled stops are dropped
// too: our phone reads are not counted as actions, and the stop counts here are fixed rather than derived from a
// task budget. Mika counts a repeated action anywhere in its last LOOP_WINDOW actions; here only a run of
// consecutive identical actions counts, because a repeat broken by a different action is already counted by the
// unchanged ladder.

/**
 * Taps are floored onto this many pixels before they are compared, so a jittered tap on the same button counts as
 * the same action. 50 is about a fingertip and small next to a phone display (Mika uses the same grid).
 */
export const COORDINATE_GRID = 50;

/**
 * Mika's thresholds, not measured against our tools: treat them as provisional until a real run says otherwise.
 * Every ladder is ascending and its last rung is the stop.
 */
export const PHONE_GUARD_LIMITS = {
  /** Taps are floored onto this many pixels before they are compared. */
  coordinateGrid: COORDINATE_GRID,
  /** The same action on an unchanged screen: warn, warn, stop. */
  repeatLadder: [3, 6, 12],
  /** Actions with no screen change, whatever their signature: warn, warn, warn, stop. */
  unchangedLadder: [3, 6, 9, 12],
  /**
   * Whole rounds through the same screens: warn, warn, stop (Mika's 60-step default budget, divided by 5). The
   * first rung is 3 since Mika's 2026-11-21 fix moved it off 2, so a stray A B A B does not warn as soon as a
   * repeat does.
   */
  cycleLadder: [3, 4, 12],
  /** A loop may pass through at most this many screens; a longer walk is not called a cycle. */
  maxCycleStates: 3,
  /** Actions kept for the log. Bounded so a long run cannot grow without limit; 64 holds the longest cycle with a
   * margin. */
  historyCap: 64,
  /** Screen fingerprints kept for cycle detection, bounded for the same reason; Mika's trail cap. */
  trailCap: 64,
} as const;

export type GuardSeverity = "warn" | "stop";

export type GuardCode = "repeating_action" | "no_progress" | "state_cycle";

/** The counts the rule saw, for the log. */
export type GuardEvidence = Readonly<Record<string, number>>;

/** A warn carries a nudge; a stop has no way out to offer, so it cannot carry one. */
export type GuardVerdict =
  | { code: GuardCode; severity: "warn"; evidence: GuardEvidence; nudge: string }
  | { code: GuardCode; severity: "stop"; evidence: GuardEvidence };

/** One action as the guards read it. */
export interface GuardAction {
  /** `actionSignature(tool, args)` of the action that ran. */
  signature: string;
  /** Whether the phone reported the screen changed after it. */
  changed: boolean;
  /** The screen's fingerprint after it; null when the caller has none. */
  screenFingerprint: string | null;
}

export interface GuardState {
  /** The most recent actions, oldest first, capped at historyCap. */
  readonly history: readonly GuardAction[];
  /** Screen fingerprints in order, adjacent repeats dropped, capped at trailCap. */
  readonly trail: readonly string[];
  /** No-change actions in a row carrying the same signature as the latest action. */
  readonly repeated: number;
  /** The repeat rung already warned at; 0 when none. */
  readonly repeatedWarnedAt: number;
  /** No-change actions in a row, whatever their signature. */
  readonly unchanged: number;
  /** The unchanged rung already warned at; 0 when none. */
  readonly unchangedWarnedAt: number;
  /** Rounds already warned about in the current cycle; 0 when none. */
  readonly cycleWarnedAt: number;
  /** The verdict that stopped the run, if it stopped. */
  readonly stop: GuardVerdict | null;
}

export interface GuardCheck {
  state: GuardState;
  verdict: GuardVerdict | null;
}

const SWIPE_KEYS = ["startX", "startY", "endX", "endY"] as const;

const WAYS_OUT =
  "Ways out: re-read the screen before acting again; try a clearly different control or entry point, such as a " +
  "menu, a search box or the app's own back button; ask the person if a choice or something only they can provide " +
  "is missing; or stop and report what is done and what is still blocked.";

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** JSON with object keys sorted at every depth, so the same call reads the same however it was built. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/**
 * A stable string per action: the free-text `reason` is dropped, a tap's x and y are floored onto COORDINATE_GRID,
 * a swipe's endpoints collapse to its direction, and key order in args does not matter. Two actions that differ
 * only in wording or by a few pixels are therefore the same action.
 */
export function actionSignature(tool: string, args: Readonly<Record<string, unknown>>): string {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key !== "reason") normalized[key] = value;
  }
  const x = numeric(normalized.x);
  const y = numeric(normalized.y);
  if (x !== null && y !== null) {
    normalized.x = Math.floor(x / COORDINATE_GRID);
    normalized.y = Math.floor(y / COORDINATE_GRID);
  }
  const [startX, startY, endX, endY] = SWIPE_KEYS.map((key) => numeric(normalized[key]));
  if (startX !== null && startY !== null && endX !== null && endY !== null) {
    const dx = endX - startX;
    const dy = endY - startY;
    const vertical = Math.abs(dy) >= Math.abs(dx);
    normalized.swipeDirection = `${vertical ? "V" : "H"}${(vertical ? dy : dx) < 0 ? "-" : "+"}`;
    for (const key of SWIPE_KEYS) delete normalized[key];
  }
  return `${tool}|${canonicalJson(normalized)}`;
}

function capped<T>(items: readonly T[], cap: number): readonly T[] {
  return items.length <= cap ? items : items.slice(items.length - cap);
}

interface Rung {
  threshold: number;
  severity: GuardSeverity;
}

/** The highest rung `count` has reached, unless this ladder already warned at it; the last rung is the stop. */
function climb(count: number, ladder: readonly number[], warnedAt: number): Rung | null {
  const threshold = ladder.findLast((rung) => count >= rung);
  if (threshold === undefined || threshold <= warnedAt) return null;
  return { threshold, severity: threshold === ladder[ladder.length - 1] ? "stop" : "warn" };
}

interface Loop {
  period: number;
  rounds: number;
}

/**
 * Whether the trail ends in a walk through 2 to maxCycleStates screens: A B A B is two rounds of two, A B C A B C
 * two rounds of three. Null when the walk does not repeat at least one step; of several periods that fit, the
 * longest walk wins.
 */
function cycleOf(trail: readonly string[]): Loop | null {
  let best: { period: number; length: number } | null = null;
  for (let period = 2; period <= PHONE_GUARD_LIMITS.maxCycleStates; period += 1) {
    if (trail.length < period + 1) continue;
    if (new Set(trail.slice(-period)).size !== period) continue;
    let length = period;
    let index = trail.length - 1;
    while (index - period >= 0 && trail[index] === trail[index - period]) {
      length += 1;
      index -= 1;
    }
    if (length > period && (best === null || length > best.length)) best = { period, length };
  }
  return best === null ? null : { period: best.period, rounds: Math.floor(best.length / best.period) };
}

function nudgeFor(code: GuardCode, evidence: GuardEvidence): string {
  if (code === "repeating_action") {
    return `You have done the same action on the same screen ${evidence.count} times and nothing changed, so it may already have taken effect. ${WAYS_OUT}`;
  }
  if (code === "state_cycle") {
    return `You are going round the same ${evidence.states} screens (${evidence.rounds} rounds) without reaching anything new. ${WAYS_OUT}`;
  }
  return `The last ${evidence.unchanged} actions changed nothing on the screen. ${WAYS_OUT}`;
}

function makeVerdict(code: GuardCode, severity: GuardSeverity, evidence: GuardEvidence): GuardVerdict {
  return severity === "warn" ? { code, severity, evidence, nudge: nudgeFor(code, evidence) } : { code, severity, evidence };
}

/** A fresh state for a new task: no history, no screen, no stop. */
export function reset(): GuardState {
  return {
    history: [],
    trail: [],
    repeated: 0,
    repeatedWarnedAt: 0,
    unchanged: 0,
    unchangedWarnedAt: 0,
    cycleWarnedAt: 0,
    stop: null,
  };
}

/**
 * Record one action and return the state with it, plus the verdict it earns if any. Once a stop has been recorded,
 * later actions get no verdict and are not recorded, because the run should already have ended.
 *
 * At most one verdict per action. The repeat rule is the more specific one, so while the same action keeps failing
 * only its ladder climbs and the run reports `repeating_action`; a run of different no-change actions climbs the
 * unchanged ladder and reports `no_progress`. A cycle is reported only when neither ladder fired for this action
 * and the action itself moved the screen to a state not already last in the trail (Mika's 2026-11-21 placement).
 */
export function checkAction(state: GuardState, action: GuardAction): GuardCheck {
  if (state.stop) return { state, verdict: null };

  const previous = state.history[state.history.length - 1];
  const repeated = action.changed ? 0 : previous?.signature === action.signature ? state.repeated + 1 : 1;
  const unchanged = action.changed ? 0 : state.unchanged + 1;
  const lastScreen = state.trail[state.trail.length - 1];
  const trail =
    action.screenFingerprint !== null && action.screenFingerprint !== lastScreen
      ? capped([...state.trail, action.screenFingerprint], PHONE_GUARD_LIMITS.trailCap)
      : state.trail;
  const history = capped([...state.history, action], PHONE_GUARD_LIMITS.historyCap);

  // A new run starts its ladder over, so an earlier warning cannot silence the next one.
  let repeatedWarnedAt = repeated <= 1 ? 0 : state.repeatedWarnedAt;
  let unchangedWarnedAt = unchanged <= 1 ? 0 : state.unchangedWarnedAt;
  let cycleWarnedAt = state.cycleWarnedAt;
  let verdict: GuardVerdict | null = null;

  // The repeat rule is the more specific one: while the same action keeps failing, only its ladder climbs, so the
  // run reads as a repeat rather than as a mixed no-progress run.
  const repeatRung = repeated >= 2 ? climb(repeated, PHONE_GUARD_LIMITS.repeatLadder, repeatedWarnedAt) : null;
  const unchangedRung = repeated < 2 ? climb(unchanged, PHONE_GUARD_LIMITS.unchangedLadder, unchangedWarnedAt) : null;
  if (repeatRung) {
    repeatedWarnedAt = repeatRung.threshold;
    verdict = makeVerdict("repeating_action", repeatRung.severity, { count: repeated });
  } else if (unchangedRung) {
    unchangedWarnedAt = unchangedRung.threshold;
    verdict = makeVerdict("no_progress", unchangedRung.severity, { unchanged });
  }

  const loop = cycleOf(trail);
  if (loop === null) {
    cycleWarnedAt = 0;
  } else if (verdict === null && trail !== state.trail) {
    // Mika reports a cycle only when the page changed for this action (`out += cycle()` runs inside its `!same`
    // branch), so an unchanged screen keeps its own ladders and never re-speaks the cycle. `trail !== state.trail`
    // is exactly "this action arrived on a screen not already last in the trail" — the same trigger.
    const cycleRung = climb(loop.rounds, PHONE_GUARD_LIMITS.cycleLadder, cycleWarnedAt);
    if (cycleRung) {
      cycleWarnedAt = cycleRung.threshold;
      verdict = makeVerdict("state_cycle", cycleRung.severity, { states: loop.period, rounds: loop.rounds });
    }
  }

  return {
    state: {
      history,
      trail,
      repeated,
      repeatedWarnedAt,
      unchanged,
      unchangedWarnedAt,
      cycleWarnedAt,
      stop: verdict?.severity === "stop" ? verdict : null,
    },
    verdict,
  };
}

/** The state with one action recorded, for a caller that only needs to keep the counters. */
export function noteAction(state: GuardState, action: GuardAction): GuardState {
  return checkAction(state, action).state;
}

/**
 * A screen read between actions. The same fingerprint leaves every counter alone, since a reread is neither
 * progress nor a repetition. A different one means the screen moved on its own: it joins the trail, and the runs of
 * repeated and unchanged actions end.
 */
export function noteScreen(state: GuardState, fingerprint: string): GuardState {
  if (state.stop || state.trail[state.trail.length - 1] === fingerprint) return state;
  const trail = capped([...state.trail, fingerprint], PHONE_GUARD_LIMITS.trailCap);
  return {
    ...state,
    trail,
    repeated: 0,
    repeatedWarnedAt: 0,
    unchanged: 0,
    unchangedWarnedAt: 0,
    // A walk that is no longer a loop starts its cycle ladder over.
    cycleWarnedAt: cycleOf(trail) === null ? 0 : state.cycleWarnedAt,
  };
}
