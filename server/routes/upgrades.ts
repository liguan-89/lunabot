// WebSocket upgrades go through the same request handler as HTTP, so they pass the same authentication,
// hosted-workspace and maintenance gates; the route that owns the path then answers the handshake.
import { ServerResponse, type IncomingMessage, type Server } from "node:http";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";

import { SOCKET_LIKE } from "../../companion/src/e2e/origin.ts";

const HANDSHAKE_MS = 10_000;
const EARLY_BYTES = 64 * 1024;

export interface PendingUpgrade {
  /** A TCP socket, or the socket-like duplex a relayed E2E stream presents: both answer the calls below (see
   * `answerable`). */
  readonly socket: Socket;
  /** Bytes the client sent before its handshake was answered. */
  head: Buffer;
  /** The route answers the handshake now: from here on it reads the socket itself. */
  release(): void;
}

export interface Upgrades {
  /** Upgrades to a path `owns` accepts reach the request handler; any other is answered 404. */
  route(owns: (path: string) => boolean): void;
  /**
   * A raw upgrade handler consulted before the path gate, for a listener that answers its own handshake (the E2E
   * listener has its own subprotocol and record framing). Returning true means it took the socket.
   */
  intercept(handle: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean): void;
  attach(server: Server, handle: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>): void;
  /**
   * One upgrade from any listener. A listening server reaches this through `attach`; the relay calls it directly, with
   * the stream it decrypted, so a phone's WebSocket passes the same gate as its HTTP requests.
   */
  handle(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  pending(req: IncomingMessage): PendingUpgrade | undefined;
  /** Refuses new upgrades and drops every one not answered yet. */
  close(): void;
}

/** A real TCP socket, or a duplex that declares itself socket-like (`SOCKET_LIKE`). Anything else is not something
 * `ServerResponse` can be attached to, and is dropped rather than guessed at. */
function answerable(socket: Duplex): boolean {
  return socket instanceof Socket || (socket as unknown as Record<symbol, unknown>)[SOCKET_LIKE] === true;
}

export function createUpgrades(): Upgrades {
  const owners: Array<(path: string) => boolean> = [];
  const interceptors: Array<(req: IncomingMessage, socket: Duplex, head: Buffer) => boolean> = [];
  const pending = new Map<IncomingMessage, PendingUpgrade>();
  let stopped = false;
  let request: ((req: IncomingMessage, res: ServerResponse) => Promise<unknown>) | null = null;

  const handle = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (stopped) { socket.destroy(); return; }
    for (const intercept of interceptors) if (intercept(req, socket, head)) return;
    if (!answerable(socket)) { socket.destroy(); return; }
    const res = new ServerResponse(req);
    // Node types `assignSocket` for a net.Socket, but it only needs a writable duplex: a relayed E2E stream is one, and
    // `server/phone-relay.test.ts` pins that a route's answer written through it reaches the phone.
    res.assignSocket(socket as unknown as Socket);
    // Rejected upgrades end this socket; do not let HTTP clients pool it.
    res.setHeader("connection", "close");
    socket.on("error", () => socket.destroy());
    res.once("finish", () => socket.end(() => socket.destroy()));
    let path: string;
    try { path = new URL(req.url ?? "", "http://localhost").pathname; }
    catch { res.writeHead(400).end(); return; }
    if (!owners.some((owns) => owns(path))) { res.writeHead(404).end(); return; }
    // Keep reading while auth awaits, so a closed tab's FIN is observed; buffer any eagerly sent WebSocket bytes.
    // `socket` is a Duplex that answered `answerable`, so it carries every method the route and `detachSocket` call.
    const upgrade: PendingUpgrade = { socket: socket as unknown as Socket, head, release: () => socket.off("data", buffer) };
    const buffer = (data: Buffer) => {
      if (upgrade.head.length + data.length > EARLY_BYTES) socket.destroy();
      else upgrade.head = Buffer.concat([upgrade.head, data]);
    };
    socket.on("data", buffer);
    socket.once("end", () => socket.destroy());
    socket.once("close", () => { upgrade.release(); pending.delete(req); });
    pending.set(req, upgrade);
    const timeout = setTimeout(() => socket.destroy(), HANDSHAKE_MS);
    timeout.unref();
    socket.once("close", () => clearTimeout(timeout));
    if (!request) { socket.destroy(); return; }
    void request(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
      else socket.destroy();
    }).finally(() => clearTimeout(timeout));
  };

  return {
    route(owns) {
      owners.push(owns);
    },
    intercept(handler) {
      interceptors.push(handler);
    },
    attach(server, handler) {
      request = handler;
      server.on("upgrade", (req: IncomingMessage, socket, head: Buffer) => handle(req, socket, head));
    },
    handle,
    pending(req) {
      return pending.get(req);
    },
    close() {
      stopped = true;
      for (const upgrade of pending.values()) upgrade.socket.destroy();
    },
  };
}
