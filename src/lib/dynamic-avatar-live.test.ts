import { describe, expect, it } from "vitest";
import { computePcmRms } from "./live-call-media";
import { resolveAvatarStateMediaUrl } from "@/components/DynamicAvatarMedia";
import { resolveLiveCardState } from "@/components/LiveCallFloatCard";

describe("dynamic avatar & live voice state mapping", () => {
  it("computes PCM RMS amplitude accurately", () => {
    expect(computePcmRms(new Float32Array(0))).toBe(0);
    expect(computePcmRms(new Float32Array([0, 0, 0, 0]))).toBe(0);
    expect(computePcmRms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5, 5);
  });

  it("resolves avatar state clips with sensible fallbacks", () => {
    const states = {
      idle: "/api/attachments/idle.mp4",
      working: "/api/attachments/work.mp4",
      talking: "/api/attachments/talk.mp4",
    };
    expect(resolveAvatarStateMediaUrl(states, "working", "/api/attachments/base.png")).toEqual({
      url: "/api/attachments/work.mp4",
      matchedState: "working",
    });
    expect(resolveAvatarStateMediaUrl(states, "thinking", "/api/attachments/base.png")).toEqual({
      url: "/api/attachments/work.mp4",
      matchedState: "working",
    });
    expect(resolveAvatarStateMediaUrl(states, "listening", "/api/attachments/base.png")).toEqual({
      url: "/api/attachments/idle.mp4",
      matchedState: "idle",
    });
    expect(resolveAvatarStateMediaUrl(states, "talking", "/api/attachments/base.png")).toEqual({
      url: "/api/attachments/talk.mp4",
      matchedState: "talking",
    });
  });

  it("maps Live Call runtime state to working / talking / listening / idle", () => {
    expect(resolveLiveCardState({ phase: "live", speaking: true, busy: true })).toBe("working");
    expect(resolveLiveCardState({ phase: "live", speaking: true, busy: false })).toBe("talking");
    expect(resolveLiveCardState({ phase: "live", speaking: false, busy: false })).toBe("listening");
    expect(resolveLiveCardState({ phase: "starting", speaking: false, busy: false })).toBe("idle");
  });
});
