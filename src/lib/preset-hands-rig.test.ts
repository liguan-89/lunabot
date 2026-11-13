import { describe, expect, it } from "vitest";

import { Hands, handIsMirrored, handsPose } from "./preset-hands-rig";

describe("the preset hands rig", () => {
  it("shows no hands on a glancing row", () => {
    const hands = handsPose(0, 3, "idle", "glance", 0, new Hands());
    expect(hands.shown).toBe(false);
    expect(hands.left.alpha).toBe(0);
    expect(hands.right.alpha).toBe(0);
  });

  it("brings a hand out for a thinking face, and springs it into place", () => {
    const hands = new Hands();
    handsPose(0, 3, "thinking", "alive", 0, hands);
    expect(hands.shown).toBe(true);
    expect(hands.right.alpha).toBe(1);
    expect(hands.right.x).toBeCloseTo(0.18, 1);
    expect(hands.right.y).toBeGreaterThan(0.7);
    handsPose(120, 3, "thinking", "alive", 0, hands);
    expect(hands.right.alpha).toBeGreaterThan(0.9);
  });

  it("holds both palms up while working and lets them go when the mood ends", () => {
    const hands = new Hands();
    handsPose(0, 5, "working", "alive", 0, hands);
    expect(hands.left.alpha).toBe(1);
    expect(hands.right.alpha).toBe(1);
    expect(hands.left.x).toBeLessThan(-0.4);
    expect(hands.right.x).toBeGreaterThan(0.4);

    for (let now = 100; now < 30_000; now += 120) handsPose(now, 5, "idle", "alive", 0, hands);
    handsPose(30_120, 5, "idle", "alive", 0, hands);
    expect(hands.right.alpha).toBeLessThan(0.5);
  });

  it("knows which table draws a hand that reads as the right way round", () => {
    expect(handIsMirrored(true, false)).toBe(true);
    expect(handIsMirrored(false, false)).toBe(false);
    expect(handIsMirrored(false, true)).toBe(true);
    expect(handIsMirrored(true, true)).toBe(false);
  });
});