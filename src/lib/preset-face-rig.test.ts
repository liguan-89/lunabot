import { describe, expect, it } from "vitest";

import { blinkPulse, facePose, lookAt, mix, moodForState, seedOf, winkPulse } from "./preset-face-rig";

describe("the preset face rig", () => {
  it("holds the resting pose when the face is still", () => {
    const pose = facePose(12_345, 7, "idle", "still");
    expect(pose).toMatchObject({ openLeft: 1, openRight: 1, gazeX: 0, gazeY: 0, scale: 1, squash: 0, roll: 0 });
  });

  it("closes a lid fast, holds, then opens slowly", () => {
    expect(blinkPulse(-1)).toBe(0);
    expect(blinkPulse(40)).toBeCloseTo(0.5);
    expect(blinkPulse(95)).toBe(1);
    expect(blinkPulse(320)).toBe(0);
    expect(blinkPulse(400)).toBe(0);
  });

  it("winks quicker and holds longer than it blinks", () => {
    expect(winkPulse(-1)).toBe(0);
    expect(winkPulse(50)).toBeCloseTo(50 / 70);
    expect(winkPulse(200)).toBe(1);
    expect(winkPulse(620)).toBe(0);
  });

  it("hashes the same seed the same way, and different seeds differently", () => {
    expect(mix(1234)).toBe(mix(1234));
    expect(mix(1234)).not.toBe(mix(1235));
    expect(seedOf("bot-a")).toBe(seedOf("bot-a"));
    expect(seedOf("bot-a")).not.toBe(seedOf("bot-b"));
  });

  it("keeps a glancing row inside a believable range", () => {
    for (const seed of [0, 42, -7]) {
      for (const now of [0, 1_000, 9_000, 61_000]) {
        const pose = facePose(now, seed, "idle", "glance");
        expect(pose.openLeft).toBeGreaterThanOrEqual(0.04);
        expect(pose.openLeft).toBeLessThanOrEqual(1.13);
        expect(pose.openRight).toBeGreaterThanOrEqual(0.04);
        expect(Math.abs(pose.gazeX)).toBeLessThan(0.12);
        expect(Math.abs(pose.gazeY)).toBeLessThan(0.12);
        expect(pose.scale).toBe(1);
      }
    }
  });

  it("breathes only the alive portrait, and lifts two seeds apart", () => {
    expect(facePose(1_000, 3, "idle", "glance").scale).toBe(1);
    expect(facePose(1_000, 3, "idle", "alive").scale).not.toBe(1);
    expect(facePose(1_000, 3, "idle", "glance").gazeX).not.toBe(facePose(1_000, 4, "idle", "glance").gazeX);
  });

  it("reads a bot's state as attention", () => {
    expect(moodForState("working")).toBe("working");
    expect(moodForState("searching")).toBe("working");
    expect(moodForState("thinking")).toBe("thinking");
    expect(moodForState("listening")).toBe("listening");
    expect(moodForState("sleeping")).toBe("drowsy");
    expect(moodForState(undefined)).toBe("idle");
    expect(moodForState("happy")).toBe("idle");
  });

  it("follows a finger at a distance, and ignores one on the face", () => {
    expect(lookAt(100, 100, 100, 100, 0)).toEqual([0, 0]);
    const [x, y] = lookAt(100, 100, 220, 100, 0);
    expect(x).toBeGreaterThan(0);
    expect(y).toBe(0);
    expect(lookAt(100, 100, 220, 100, 2_000)).toEqual([0, 0]);
  });
});