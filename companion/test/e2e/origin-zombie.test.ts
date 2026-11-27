import { describe, expect, it } from "vitest";

import { createE2EOrigin } from "../../src/e2e/origin.ts";

/** The tunnel side of one origin connection dying must end the server side too.
 * A duplexPair does not propagate destroy; without an explicit bridge the
 * memory server never learns the peer is gone, the proxy's res close never
 * fires, and the harness SSE behind it lives forever — the zombie streams that
 * eat tunnel bandwidth in the field. */
describe("e2e origin zombie propagation", () => {
  it("destroying the tunnel-side end closes the server-side response", async () => {
    let responseClose = false;
    let sawRequest = false;
    const origin = createE2EOrigin(
      (_req, res) => {
        sawRequest = true;
        // The SSE shape: headers out at once, then a response that never ends.
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": keepalive\n\n");
        res.on("close", () => {
          responseClose = true;
        });
      },
      () => {},
    );

    const near = await origin.connect({ peer: { kind: "pairing", admHash: null }, route: "wifi" });
    near.write("GET /api/events HTTP/1.1\r\nHost: origin\r\n\r\n");

    // Let the request cross the in-memory pipe and the handler run.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(sawRequest).toBe(true);
    expect(responseClose).toBe(false);

    // What a dead yamux stream does to its bridge socket: destroy, no end.
    near.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(responseClose).toBe(true);
  });
});
