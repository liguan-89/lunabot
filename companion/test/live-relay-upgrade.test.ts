import { createServer, type Server } from "node:http";
import { createConnection, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createProxyHandler } from "../src/proxy.ts";

const servers: Server[] = [];
const sockets: Duplex[] = [];

const listen = (server: Server) => new Promise<number>((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
});
const close = (server: Server) => new Promise<void>((resolve) => {
  server.closeAllConnections();
  server.close(() => resolve());
});

// `server.close()` never resolves while an upgraded socket is open.
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map(close));
});

const openUpgrade = (port: number, path: string, token: string | undefined) => new Promise<{
  client: Socket;
  response: string;
}>((resolve) => {
  const client = createConnection({ host: "127.0.0.1", port });
  sockets.push(client);
  let response = "";
  client.setEncoding("utf8");
  client.on("error", () => {});
  client.on("data", (chunk) => {
    response += chunk;
    if (response.includes("\r\n\r\n") || response.includes("\n")) resolve({ client, response });
  });
  client.write(
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
      + `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n`
      + (token ? `Authorization: Bearer ${token}\r\n` : "")
      + "\r\n",
  );
});

const fixture = async () => {
  let upstreamUpgrade: { url: string; device: string | undefined } | null = null;
  const harness = createServer();
  harness.on("upgrade", (req, socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    upstreamUpgrade = {
      url: req.url ?? "",
      device: req.headers["x-lunabot-companion-device"] as string | undefined,
    };
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        + "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n",
    );
    socket.on("data", (chunk) => socket.write(chunk));
  });
  servers.push(harness);
  const harnessPort = await listen(harness);

  const handler = createProxyHandler({
    harnessPort,
    authenticate: (token) => token === "fixture-token"
      ? { id: "fixture-phone", cloudDesktopAccess: false, browserControlAccess: false }
      : null,
    redeem: () => ({ error: "offline fixture" }),
    serverName: () => "Synthetic computer",
  });
  const relay = createServer(handler);
  relay.on("upgrade", handler.upgrade);
  servers.push(relay);
  const relayPort = await listen(relay);
  return { relayPort, upstream: () => upstreamUpgrade };
};

describe("allowlisted API upgrades through the proxy", () => {
  it("forwards the live-call relay upgrade to the harness and pipes bytes", async () => {
    const f = await fixture();
    const { client, response } = await openUpgrade(
      f.relayPort,
      "/api/live/relay?threadId=th_1&client=android",
      "fixture-token",
    );
    expect(response).toContain("101 Switching Protocols");
    expect(response.toLowerCase()).toContain("sec-websocket-accept:");
    const upstream = f.upstream();
    expect(upstream).not.toBeNull();
    expect(upstream?.url).toBe("/api/live/relay?threadId=th_1&client=android");
    expect(upstream?.device).toBe("fixture-phone");

    const echoed = new Promise<string>((resolve) => {
      let data = "";
      client.on("data", (chunk) => {
        data += chunk;
        resolve(data);
      });
    });
    client.write("ping");
    expect(await echoed).toBe("ping");
  });

  it("refuses an unauthenticated upgrade before the harness sees it", async () => {
    const f = await fixture();
    const { response } = await openUpgrade(f.relayPort, "/api/live/relay", "wrong-token");
    expect(response).toContain("401");
    expect(f.upstream()).toBeNull();
  });

  it("refuses an upgrade to a path outside the allowlist", async () => {
    const f = await fixture();
    const { response } = await openUpgrade(f.relayPort, "/api/live/relays", "fixture-token");
    expect(response).toContain("404");
    expect(f.upstream()).toBeNull();
  });
});
