import { describe, expect, it } from "vitest";

import { credentialHash, keyId, psk } from "../../src/e2e/credentials.ts";
import { generateKeyPair, TRANSPORT_DIRECT } from "../../src/e2e/noise.ts";
import { createE2EOrigin, E2E_ORIGIN_DEADLINES } from "../../src/e2e/origin.ts";
import { E2ESession, type RecordTransport } from "../../src/e2e/session.ts";

const TOKEN = "omb_stream_probe";
const MAX_STREAMS = 64;

/** Two ends of one session over in-memory transports, drained continuously so a reset reaches the phone. `deadlines`
 * undefined leaves the origin on its default, which is what the desktop sidecar does. */
async function session(deadlines?: { headersMs: number; requestMs: number } | null, pumpTick: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 1))) {
  const key = generateKeyPair();
  const toComputer: Uint8Array[] = [];
  const toPhone: Uint8Array[] = [];
  const transport = (inbox: Uint8Array[]): RecordTransport => ({
    send: (message) => inbox.push(message),
    close: () => {},
    bufferedAmount: 0,
    onceDrained: (listener) => setTimeout(listener, 0),
  });
  const origin = createE2EOrigin(
    (_req, res) => res.writeHead(200, { "content-type": "text/plain" }).end("ok"),
    () => {},
    deadlines,
  );
  const computer = E2ESession.computer({
    transport: transport(toPhone),
    transportByte: TRANSPORT_DIRECT,
    staticKey: key,
    candidates: () => [{ id: "device", psk: psk(credentialHash(TOKEN), keyId(key.publicKey)) }],
    connectOrigin: () => origin.connect({ peer: { kind: "pairing", admHash: null }, route: "wifi" }),
    pingIntervalMs: 60_000,
  });
  const phone = E2ESession.phone({
    transport: transport(toComputer),
    transportByte: TRANSPORT_DIRECT,
    remoteStatic: key.publicKey,
    psk: psk(credentialHash(TOKEN), keyId(key.publicKey)),
    app: "test/1",
    pingIntervalMs: 60_000,
  });
  let stopped = false;
  const pump = (async () => {
    while (!stopped) {
      while (toComputer.length) computer.receive(toComputer.shift()!, true);
      while (toPhone.length) phone.receive(toPhone.shift()!, true);
      await pumpTick();
    }
  })();
  await Promise.all([computer.ready, phone.ready]);
  return {
    computer,
    phone,
    async close() {
      stopped = true;
      await pump;
      origin.close();
      computer.close(1000);
      phone.close(1000);
    },
  };
}

/** A phone that opens a stream and never writes: a killed app, a hung library, a connection abandoned mid-request. */
function stall(phone: E2ESession<never>, count: number): number {
  let opened = 0;
  for (let index = 0; index < count; index += 1) {
    try {
      phone.openStream();
      opened += 1;
    } catch {
      break;
    }
  }
  return opened;
}

/** One well-formed request on its own stream. True when the reply's first bytes arrive. */
async function goodRequest(phone: E2ESession<never>): Promise<boolean> {
  try {
    const stream = phone.openStream();
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 1_500);
      stream.on("data", () => {
        clearTimeout(timer);
        resolve(true);
      });
      stream.write(Buffer.from("GET /api/health HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n"));
    });
  } catch {
    return false;
  }
}

describe("an origin stream the phone never writes to", () => {
  /** A phone gets one stream per HTTP connection and 64 per session. A stream nobody ever writes to holds its slot:
   * without a deadline, 64 of them lock the session out (`yamux: too_many_streams`) until it reconnects. */
  it("is reclaimed when the caller names no deadline, which is what the desktop sidecar does", async () => {
    // The shipped default is 30 s for headers. Waiting that long would make the suite slow, so the shared object is
    // shrunk for this one test — the path under test (no argument ⇒ the default is armed) stays the real one.
    const saved = { ...E2E_ORIGIN_DEADLINES };
    E2E_ORIGIN_DEADLINES.headersMs = 300;
    E2E_ORIGIN_DEADLINES.requestMs = 300;
    const { phone, close } = await session(undefined);
    try {
      expect(stall(phone, MAX_STREAMS)).toBe(MAX_STREAMS);
      expect(phone.activeStreams).toBe(MAX_STREAMS);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(phone.activeStreams).toBe(0);
      expect(await goodRequest(phone)).toBe(true);
    } finally {
      await close();
      Object.assign(E2E_ORIGIN_DEADLINES, saved);
    }
  });

  /** The other side of the rule: with no deadlines at all — what a rig that wants raw behaviour asks for — the same
   * 64 stalls do lock the session, which is what makes the test above prove something. */
  it("locks the session out when deadlines are off", async () => {
    const { phone, close } = await session(null);
    try {
      expect(stall(phone, MAX_STREAMS)).toBe(MAX_STREAMS);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(phone.activeStreams).toBe(MAX_STREAMS);
      expect(await goodRequest(phone)).toBe(false);
    } finally {
      await close();
    }
  });
});
