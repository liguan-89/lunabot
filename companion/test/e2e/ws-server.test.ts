import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { describe, expect, it } from "vitest";

import { acceptWebSocket } from "../../src/e2e/ws-server.ts";

const waitFor = async (check: () => boolean, ms = 800): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("the e2e WebSocket server", () => {
  it("treats a peer's bare TCP close as a closed transport", async () => {
    let closed: number | null = null;
    const server = createServer();
    const upgraded: Socket[] = [];
    server.on("upgrade", (req, socket, head) => {
      upgraded.push(socket as Socket);
      acceptWebSocket(req, socket, head, { protocol: "probe", maxPayload: 1024 }, () => ({
        message: () => {},
        close: (code) => {
          closed = code;
        },
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no test port");
    let client: Socket | null = null;
    try {
      const key = Buffer.alloc(16, 1).toString("base64");
      client = connect(address.port, "127.0.0.1");
      client.write(
        "GET / HTTP/1.1\r\n" +
          "Host: probe\r\n" +
          "Connection: upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          "Sec-WebSocket-Protocol: probe\r\n\r\n",
      );
      await new Promise<void>((resolve) => {
        let received = Buffer.alloc(0);
        client!.on("data", (chunk: Buffer) => {
          received = Buffer.concat([received, chunk]);
          if (received.toString("latin1").includes("\r\n\r\n")) resolve();
        });
      });
      // A force-stopped phone does not send a WebSocket close frame: its kernel
      // just closes TCP. HTTP upgrade sockets are allowHalfOpen, so the server
      // sees only `end` unless it explicitly treats that as transport death.
      client.destroy();
      await waitFor(() => closed !== null);
      expect(closed).toBe(1006);
    } finally {
      client?.destroy();
      for (const socket of upgraded) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
