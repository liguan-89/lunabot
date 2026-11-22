import { describe, expect, it } from "vitest";

import { credentialHash, keyId, psk } from "../../src/e2e/credentials.ts";
import { generateKeyPair, TRANSPORT_DIRECT } from "../../src/e2e/noise.ts";
import { createE2EOrigin } from "../../src/e2e/origin.ts";
import { E2ESession, type RecordTransport } from "../../src/e2e/session.ts";

const TOKEN = "omb_test_credential";

/** Two ends of one session with no sockets in between: each `send` queues into the peer's inbox, and the test drains
 * both until the exchange settles. */
function pair() {
  const toComputer: Uint8Array[] = [];
  const toPhone: Uint8Array[] = [];
  const transport = (inbox: Uint8Array[]): RecordTransport => ({
    send: (message) => inbox.push(message),
    close: () => {},
    bufferedAmount: 0,
    onceDrained: (listener) => setTimeout(listener, 0),
  });
  return { toComputer, toPhone, computer: transport(toPhone), phone: transport(toComputer) };
}

/** A client that writes the request, half-closes (FIN) and then reads — what `E2eHttp.request` does on the phone. */
function halfClosingRequest(session: E2ESession<never>, path: string, body: string): Promise<string> {
  const stream = session.openStream();
  const chunks: Buffer[] = [];
  const text = () => Buffer.concat(chunks).toString("utf8");
  return new Promise<string>((resolve) => {
    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      // The reply is complete once the body has arrived; `end` comes from the mux FIN, which this harness does not send.
      if (Buffer.concat(chunks).toString("utf8").includes('"ok":true')) resolve(text());
    });
    stream.on("end", () => resolve(text()));
    stream.on("close", () => resolve(text()));

    stream.write(Buffer.from(`POST ${path} HTTP/1.1\r\nHost: origin\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
    stream.end();
  });
}

describe("a request whose phone half-closed after the body", () => {
  it("still receives the reply", async () => {
    const key = generateKeyPair();
    const origin = createE2EOrigin(
      (req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        // Deferred by one turn, the shape every `readJson(req).then(...)` handler has — and the shape that loses its
        // reply when the phone half-closed.
        req.on("end", () => setImmediate(() => {
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, body }));
        }));
      },
      () => {},
    );

    const wire = pair();
    const computer = E2ESession.computer({
      transport: wire.computer,
      transportByte: TRANSPORT_DIRECT,
      staticKey: key,
      candidates: () => [{ id: "device", psk: psk(credentialHash(TOKEN), keyId(key.publicKey)) }],
      connectOrigin: () => origin.connect({ peer: { kind: "pairing", admHash: null }, route: "wifi" }),
      pingIntervalMs: 60_000,
    });
    const phone = E2ESession.phone({
      transport: wire.phone,
      transportByte: TRANSPORT_DIRECT,
      remoteStatic: key.publicKey,
      psk: psk(credentialHash(TOKEN), keyId(key.publicKey)),
      app: "test/1",
      pingIntervalMs: 60_000,
    });

    const draining = (async () => {
      for (let i = 0; i < 400; i += 1) {
        while (wire.toComputer.length) computer.receive(wire.toComputer.shift()!, true);
        while (wire.toPhone.length) phone.receive(wire.toPhone.shift()!, true);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();
    await Promise.all([computer.ready, phone.ready]);

    const reply = await Promise.race([
      halfClosingRequest(phone, "/api/pair", "{}"),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 3_000)),
    ]);
    origin.close();
    computer.close(1000);
    phone.close(1000);
    await draining;

    expect(reply).toContain("201");
    expect(reply).toContain('"ok":true');
  });
});
