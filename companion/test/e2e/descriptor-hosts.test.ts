import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { b64u } from "../../src/e2e/credentials.ts";
import { encodeDescriptor, parseDescriptor } from "../../src/e2e/descriptor.ts";
import { generateKeyPair } from "../../src/e2e/noise.ts";

const descriptor = (relays: string[]): string =>
  encodeDescriptor({ k: b64u(generateKeyPair().publicKey), h: b64u(randomBytes(16)), r: relays });

describe("relay host allow-list", () => {
  it.each(["cloud.dexai.vip", "relay1.dexai.vip", "relay99.dexai.vip", "relay1.openmausbot.com"])(
    "accepts %s",
    (host) => {
      expect(parseDescriptor(descriptor([host])).outcome).toBe("ok");
    },
  );

  it.each(["relay0.dexai.vip", "cloud.dexai.vip.evil.com", "relay1.openmausbot.com.evil.com"])(
    "refuses %s",
    (host) => {
      expect(parseDescriptor(descriptor([host]))).toMatchObject({ outcome: "reject", reason: "relay_host" });
    },
  );
});