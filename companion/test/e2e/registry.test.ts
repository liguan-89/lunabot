import { rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DeviceRegistry, UNCONFIRMED_DEVICE_MS } from "../../src/devices.ts";
import { admission, admissionHash, credentialHash } from "../../src/e2e/credentials.ts";
import { generateKeyPair } from "../../src/e2e/noise.ts";
import { E2ERegistry, type E2EContext } from "../../src/e2e/registry.ts";
import { DATA_DIR } from "../../src/state.ts";

describe("E2ERegistry admission", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("keeps a just-restricted device admitted for the hold, then lets the set shrink and says so", async () => {
    vi.useFakeTimers();
    try {
      const devices = new DeviceRegistry();
      const registry = new E2ERegistry(devices);
      const hostId = randomBytes(16);
      registry.setKey(generateKeyPair());
      registry.setRelay({ hostId, nodes: ["relay1.openmausbot.com"] });
      const { code } = devices.openPairing();
      const paired = devices.redeem(code, "Phone");
      if ("error" in paired) throw new Error(paired.error);
      devices.closePairing();
      const hash = admissionHash(admission(credentialHash(paired.token), hostId));
      expect(registry.admissionSet()).toEqual([hash]);
      let changes = 0;
      registry.onAdmissionChange(() => (changes += 1));

      devices.setRoutes(paired.device.id, "local");
      const held = registry.holdAdmission(paired.device.id, 300);
      expect(registry.admissionSet()).toEqual([hash]);
      vi.advanceTimersByTime(299);
      expect(registry.admissionSet()).toEqual([hash]);
      expect(changes).toBe(0);
      vi.advanceTimersByTime(1);
      await held;
      expect(registry.admissionSet()).toEqual([]);
      expect(changes).toBe(1);
      expect(registry.descriptor(paired.device.id)).toMatchObject({ h: expect.any(String), r: ["relay1.openmausbot.com"], routes: "local" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("E2ERegistry pairing keeps the device", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  /** A pairing session that redeemed the window is a phone that already holds its token; the unconfirmed-device timer
   * must not revoke it five minutes later. Regression: `paired()` marked the device encrypted without confirming it, so
   * every phone paired through the encrypted connection was deleted while it was in use. */
  it("confirms the device it paired, so the five-minute drop never fires", () => {
    vi.useFakeTimers();
    try {
      const devices = new DeviceRegistry();
      const registry = new E2ERegistry(devices);
      registry.setKey(generateKeyPair());
      const dropped: string[] = [];
      devices.onDropped((id) => dropped.push(id));
      const { code } = devices.openPairing();
      const paired = devices.redeem(code, "Phone");
      if ("error" in paired) throw new Error(paired.error);

      const context: E2EContext = { peer: { kind: "pairing", admHash: null }, route: "wifi" };
      registry.paired(context, paired.device.id);

      expect(context.peer).toEqual({ kind: "device", id: paired.device.id });
      expect(devices.list()[0]).toMatchObject({ id: paired.device.id });
      expect(devices.list()[0]?.e2eAt).toEqual(expect.any(Number));

      vi.advanceTimersByTime(UNCONFIRMED_DEVICE_MS * 2);
      expect(dropped).toEqual([]);
      expect(devices.list().map((device) => device.id)).toEqual([paired.device.id]);
      // The token still works: the phone keeps the session it paired with.
      expect(devices.authenticate(paired.token)?.id).toBe(paired.device.id);
    } finally {
      vi.useRealTimers();
    }
  });

  /** The other side of the same rule: a device nobody ever used is still dropped, so a lost pairing reply cannot hold
   * a slot on the computer forever. */
  it("still drops a device its phone never used", () => {
    vi.useFakeTimers();
    try {
      const devices = new DeviceRegistry();
      const dropped: string[] = [];
      devices.onDropped((id) => dropped.push(id));
      const { code } = devices.openPairing();
      const paired = devices.redeem(code, "Lost reply");
      if ("error" in paired) throw new Error(paired.error);

      vi.advanceTimersByTime(UNCONFIRMED_DEVICE_MS);
      expect(dropped).toEqual([paired.device.id]);
      expect(devices.list()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
