import { describe, expect, it } from "vitest";

import { SPEECH_CLAIM_TTL_MS, SPEECH_LISTENER_TTL_MS, SpeechArbitration } from "./speech-arbitration.ts";

describe("speech arbitration", () => {
  it("lets the same claimant renew and refuses another device for the turn", () => {
    let now = 1_000;
    const arbitration = new SpeechArbitration(() => now);
    expect(arbitration.claim("thread", "turn", { kind: "desktop" })).toMatchObject({ ok: true });
    expect(arbitration.claim("thread", "turn", { kind: "desktop" })).toMatchObject({ ok: true });
    expect(arbitration.claim("thread", "turn", { kind: "phone", deviceId: "phone" })).toEqual({ ok: false, reason: "claimed" });
    now += SPEECH_CLAIM_TTL_MS + 1;
    expect(arbitration.claim("thread", "turn", { kind: "phone", deviceId: "phone" })).toMatchObject({ ok: true });
  });

  it("makes desktop speech yield only while a phone listener is fresh", () => {
    let now = 1_000;
    const arbitration = new SpeechArbitration(() => now);
    arbitration.phoneListener("phone");
    expect(arbitration.claim("thread", "turn", { kind: "desktop" })).toEqual({ ok: false, reason: "phone-listening" });
    expect(arbitration.claim("thread", "turn", { kind: "phone", deviceId: "phone" })).toMatchObject({ ok: true });
    now += SPEECH_LISTENER_TTL_MS + 1;
    expect(arbitration.claim("other", "turn", { kind: "desktop" })).toMatchObject({ ok: true });
  });

  it("drops a listener when the phone reports inactive", () => {
    const arbitration = new SpeechArbitration(() => 1_000);
    arbitration.phoneListener("phone");
    arbitration.phoneListener("phone", false);
    expect(arbitration.claim("thread", "turn", { kind: "desktop" })).toMatchObject({ ok: true });
  });
});
