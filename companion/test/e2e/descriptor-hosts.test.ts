import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { b64u } from "../../src/e2e/credentials.ts";
import { encodeDescriptor, parseDescriptor } from "../../src/e2e/descriptor.ts";
import { generateKeyPair } from "../../src/e2e/noise.ts";

const descriptor = (relays: string[]): string =>
  encodeDescriptor({ v: 1, k: b64u(generateKeyPair().publicKey), h: b64u(randomBytes(16)), r: relays });

describe("relay host allow-list", () => {
  // Every family the fleet answers on: the node the control plane issues today, the name a renamed descriptor
  // writes, and the name a phone paired before the rename holds pinned.
  it.each([
    "cloud.dexai.vip",
    "relay1.dexai.vip",
    "relay99.dexai.vip",
    "relay1.lunabot.com",
    "relay12.lunabot.com",
    "relay1.openmausbot.com",
  ])("accepts %s", (host) => {
    expect(parseDescriptor(descriptor([host])).outcome).toBe("ok");
  });

  it.each([
    "relay0.dexai.vip",
    "cloud.dexai.vip.evil.com",
    "relay1.openmausbot.com.evil.com",
    "relay1.lunabot.com.evil.com",
    "relay0.lunabot.com",
    "lunabot.com",
    "cloud.lunabot.com",
  ])("refuses %s", (host) => {
    expect(parseDescriptor(descriptor([host]))).toMatchObject({ outcome: "reject", reason: "relay_host" });
  });
});