import { describe, expect, it } from "vitest";

import {
  COORDINATE_GRID,
  PHONE_GUARD_LIMITS,
  actionSignature,
  checkAction,
  noteAction,
  noteScreen,
  reset,
  type GuardAction,
  type GuardState,
  type GuardVerdict,
} from "./phone-guards.ts";

function action(signature: string, changed: boolean, screenFingerprint: string | null): GuardAction {
  return { signature, changed, screenFingerprint };
}

/** Feed actions in order, keeping the state, and collect the verdicts that were not null. */
function run(start: GuardState, actions: readonly GuardAction[]) {
  let state = start;
  const verdicts: GuardVerdict[] = [];
  for (const next of actions) {
    const check = checkAction(state, next);
    state = check.state;
    if (check.verdict) verdicts.push(check.verdict);
  }
  return { state, verdicts };
}

describe("actionSignature", () => {
  it("drops the free-text reason", () => {
    const withReason = actionSignature("PHONE_UI_TAP", { ref: "e3", reason: "open the search box" });
    const otherReason = actionSignature("PHONE_UI_TAP", { ref: "e3", reason: "try again" });
    expect(withReason).toBe(otherReason);
    expect(withReason).toBe(actionSignature("PHONE_UI_TAP", { ref: "e3" }));
  });

  it("does not care about key order", () => {
    const left = actionSignature("PHONE_UI_TYPE", { text: "hello", ref: "e7" });
    const right = actionSignature("PHONE_UI_TYPE", { ref: "e7", text: "hello" });
    expect(left).toBe(right);
  });

  it("rounds a tap onto a coarse grid, so a jittered tap is the same action", () => {
    const near = actionSignature("PHONE_UI_TAP_AT", { x: 100, y: 200 });
    const jittered = actionSignature("PHONE_UI_TAP_AT", { x: 110, y: 205 });
    const far = actionSignature("PHONE_UI_TAP_AT", { x: 300, y: 200 });
    expect(COORDINATE_GRID).toBe(50);
    expect(near).toBe(jittered);
    expect(far).not.toBe(near);
  });

  it("records only a swipe's direction, not its endpoints", () => {
    const short = actionSignature("PHONE_UI_SWIPE", { startX: 500, startY: 800, endX: 500, endY: 300 });
    const long = actionSignature("PHONE_UI_SWIPE", { startX: 480, startY: 1400, endX: 520, endY: 200 });
    const opposite = actionSignature("PHONE_UI_SWIPE", { startX: 500, startY: 300, endX: 500, endY: 800 });
    const sideways = actionSignature("PHONE_UI_SWIPE", { startX: 900, startY: 600, endX: 100, endY: 600 });
    expect(short).toBe(long);
    expect(opposite).not.toBe(short);
    expect(sideways).not.toBe(short);
    // A finger moving up is the negative vertical direction, and sideways-left the negative horizontal one.
    expect(short).toContain("V-");
    expect(opposite).toContain("V+");
    expect(sideways).toContain("H-");
  });

  it("keeps different tools apart", () => {
    expect(actionSignature("PHONE_UI_TAP", { ref: "e1" })).not.toBe(actionSignature("PHONE_UI_TYPE", { ref: "e1" }));
  });
});

describe("checkAction", () => {
  const tap = actionSignature("PHONE_UI_TAP", { ref: "e3" });
  const screen = "screen-1";

  it("warns on the third repeat and stops on the twelfth", () => {
    const actions = Array.from({ length: PHONE_GUARD_LIMITS.repeatLadder[2]! }, () => action(tap, false, screen));
    const { state, verdicts } = run(reset(), actions);

    expect(verdicts.map((verdict) => [verdict.code, verdict.severity, verdict.evidence.count])).toEqual([
      ["repeating_action", "warn", 3],
      ["repeating_action", "warn", 6],
      ["repeating_action", "stop", 12],
    ]);
    expect(state.stop?.severity).toBe("stop");
    expect(state.stop?.code).toBe("repeating_action");
  });

  it("gives a warn a nudge and a stop none", () => {
    const actions = Array.from({ length: PHONE_GUARD_LIMITS.repeatLadder[2]! }, () => action(tap, false, screen));
    const { verdicts } = run(reset(), actions);
    const warn = verdicts[0]!;
    const stop = verdicts[verdicts.length - 1]!;
    expect(warn.severity).toBe("warn");
    if (warn.severity !== "warn") throw new Error("the first verdict should be a warn");
    expect(warn.nudge).toContain("Ways out:");
    expect(warn.nudge).toContain("re-read the screen");
    expect(warn.nudge).toContain("ask the person");
    expect(stop.severity).toBe("stop");
    expect("nudge" in stop).toBe(false);
  });

  it("stops a long run of different actions that change nothing", () => {
    const actions = Array.from({ length: PHONE_GUARD_LIMITS.unchangedLadder[3]! }, (_, index) =>
      action(actionSignature("PHONE_UI_TAP", { ref: `e${index}` }), false, screen),
    );
    const { verdicts } = run(reset(), actions);

    expect(verdicts.map((verdict) => [verdict.code, verdict.severity, verdict.evidence.unchanged])).toEqual([
      ["no_progress", "warn", 3],
      ["no_progress", "warn", 6],
      ["no_progress", "warn", 9],
      ["no_progress", "stop", 12],
    ]);
  });

  it("does not warn a two-screen walk until its third full round", () => {
    const first = action(actionSignature("PHONE_UI_TAP", { ref: "e1" }), true, "screen-a");
    const second = action(actionSignature("PHONE_UI_TAP", { ref: "e2" }), true, "screen-b");
    // Two rounds (A B A B) stay quiet since Mika's 2026-11-21 fix moved the first rung to 3.
    const { verdicts } = run(reset(), [first, second, first, second]);
    expect(verdicts).toHaveLength(0);

    const third = run(reset(), [first, second, first, second, first, second]);
    expect(third.verdicts).toHaveLength(1);
    const verdict = third.verdicts[0]!;
    expect(verdict).toMatchObject({
      code: "state_cycle",
      severity: "warn",
      evidence: { states: 2, rounds: 3 },
    });
    if (verdict.severity !== "warn") throw new Error("a cycle should warn first");
    expect(verdict.nudge).toContain("2 screens");
    expect(third.state.stop).toBeNull();
  });

  it("does not speak a cycle the action did not advance", () => {
    // A read between actions can complete the walk; an unchanged action that
    // grows the trail not at all must not report the cycle on top of its own
    // no-progress story (Mika speaks a cycle only when the page changed).
    let state = noteScreen(reset(), "screen-a");
    state = noteScreen(state, "screen-b");
    state = noteScreen(state, "screen-a");
    state = noteScreen(state, "screen-b");
    const after = checkAction(state, action(actionSignature("PHONE_UI_TAP", { ref: "e9" }), false, "screen-b"));
    expect(after.verdict).toBeNull();
  });

  it("starts over when an action changes the screen", () => {
    const failed = action(tap, false, screen);
    const { state } = run(reset(), [failed, failed, action(tap, true, "screen-2")]);
    expect(state.repeated).toBe(0);
    expect(state.unchanged).toBe(0);
  });

  it("ignores actions after a stop", () => {
    const actions = Array.from({ length: PHONE_GUARD_LIMITS.repeatLadder[2]! }, () => action(tap, false, screen));
    const stopped = run(reset(), actions).state;
    const after = checkAction(stopped, action(tap, false, screen));
    expect(after.state).toBe(stopped);
    expect(after.verdict).toBeNull();
  });
});

describe("state upkeep", () => {
  it("caps the history", () => {
    const actions = Array.from({ length: PHONE_GUARD_LIMITS.historyCap + 20 }, (_, index) =>
      action(actionSignature("PHONE_UI_TAP", { ref: `e${index}` }), true, `screen-${index}`),
    );
    const { state } = run(reset(), actions);
    expect(state.history).toHaveLength(PHONE_GUARD_LIMITS.historyCap);
    expect(state.history[state.history.length - 1]).toEqual(actions[actions.length - 1]);
    expect(state.trail).toHaveLength(PHONE_GUARD_LIMITS.trailCap);
  });

  it("records an action without returning a verdict", () => {
    const state = noteAction(reset(), action("PHONE_UI_BACK|{}", false, "screen-1"));
    expect(state.history).toHaveLength(1);
    expect(state.trail).toEqual(["screen-1"]);
  });

  it("leaves everything alone when a read shows the same screen", () => {
    const started = noteScreen(reset(), "screen-1");
    expect(noteScreen(started, "screen-1")).toBe(started);
  });

  it("ends a run of no-change actions when a read shows a new screen", () => {
    const repeated = action(actionSignature("PHONE_UI_TAP", { ref: "e3" }), false, "screen-1");
    const { state } = run(reset(), [repeated, repeated, repeated]);
    expect(state.repeated).toBe(3);
    const after = noteScreen(state, "screen-2");
    expect(after.repeated).toBe(0);
    expect(after.unchanged).toBe(0);
    expect(after.trail).toEqual(["screen-1", "screen-2"]);
  });

  it("resets to a fresh state", () => {
    const repeated = action(actionSignature("PHONE_UI_TAP", { ref: "e3" }), false, "screen-1");
    const { state } = run(reset(), [repeated, repeated, repeated]);
    const fresh = reset();
    expect(fresh.history).toEqual([]);
    expect(fresh.trail).toEqual([]);
    expect(fresh.stop).toBeNull();
    expect(fresh.repeated).toBe(0);
    expect(fresh.unchanged).toBe(0);
    expect(state.history.length).toBeGreaterThan(0);
  });
});
