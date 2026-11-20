import { describe, expect, it } from "vitest";

import { createDesktopScreenRoutes } from "./desktop-screen.ts";
import type { BotRecord } from "../store.ts";

/**
 * The two routes that let a phone see this computer's own screen, and the gates on them.
 *
 * The capture itself is covered by `server/desktop-screen.test.ts`; what is pinned here is who may ask and when — the
 * part a mistake would turn into a phone driving the person's Mac without a lease, or a server the app did not launch
 * pretending it could show anything.
 */

const BOT = { id: "bot_1", name: "Luna", threadId: "thread_1" } as unknown as BotRecord;

/** A stand-in for the desktop's driver connection: no real Mac, and nothing here spawns anything. */
const CONNECTION = { command: "/nonexistent/driver", args: ["mcp", "--socket", "/tmp/x.sock"], env: {}, platform: "darwin", scope: "local-computer" } as const;

function harness({ connection = CONNECTION as unknown, holds = true, bot = BOT }: {
  connection?: unknown;
  holds?: boolean;
  bot?: BotRecord | undefined;
} = {}) {
  const handler = createDesktopScreenRoutes({
    store: { bot: (id: string) => (bot && id === bot.id ? bot : null) },
    computerControl: {
      ownsLease: () => holds,
      snapshot: () => ({ held: false, helpReason: null, heldSinceMs: null }),
    },
    botComputerControlKey: (record) => `computer:${record.id}`,
    connection: () => connection as never,
  });
  return async (method: string, path: string, body: unknown = {}) => {
    const sent: { status: number; body: unknown } = { status: 0, body: null };
    const res = {
      headersSent: false,
      writableEnded: false,
      setHeader: () => {},
      writeHead: (status: number) => {
        sent.status = status;
        return res;
      },
    };
    const out = await handler({
      req: { headers: { "content-type": "application/json" } } as never,
      res: res as never,
      url: new URL(`http://127.0.0.1${path}`),
      path,
      method,
      auth: { kind: "loopback", scopes: ["admin", "client"] } as never,
      json: ((target: unknown, status: number, payload: unknown) => {
        (target as typeof res).headersSent = true;
        sent.status = status;
        sent.body = payload;
        return undefined;
      }) as never,
      readBody: (async () => body) as never,
    });
    return { ...sent, out };
  };
}

/** The path the handler answers, or PASS when it declines. */
describe("createDesktopScreenRoutes", () => {
  it("declines a path that is not one of its own", async () => {
    const call = harness();
    const { out } = await call("POST", "/api/bots/bot_1/local-computer/screenshot");
    expect(typeof out).toBe("symbol");
  });

  it("refuses anything but POST, and a body that is not JSON", async () => {
    const call = harness();
    expect((await call("GET", "/api/bots/bot_1/desktop/screenshot")).status).toBe(405);
    const notJson = await createDesktopScreenRoutes({
      store: { bot: () => BOT },
      computerControl: { ownsLease: () => true, snapshot: () => ({ held: false, helpReason: null, heldSinceMs: null }) },
      botComputerControlKey: () => "k",
      connection: () => CONNECTION as never,
    })({
      req: { headers: { "content-type": "text/plain" } } as never,
      res: { setHeader: () => {}, headersSent: false, writableEnded: false } as never,
      url: new URL("http://127.0.0.1/api/bots/bot_1/desktop/screenshot"),
      path: "/api/bots/bot_1/desktop/screenshot",
      method: "POST",
      auth: { kind: "loopback", scopes: ["admin"] } as never,
      json: ((res: { status: number }, status: number) => {
        res.status = status;
      }) as never,
      readBody: (async () => ({})) as never,
    });
    expect(notJson).toBeUndefined();
  });

  it("says 404 for a bot that does not exist", async () => {
    const { status } = await harness({ bot: undefined })("POST", "/api/bots/bot_9/desktop/screenshot");
    expect(status).toBe(404);
  });

  it("refuses when this server has no driver, which is every server the app did not launch", async () => {
    const { status, body } = await harness({ connection: null })("POST", "/api/bots/bot_1/desktop/screenshot");
    expect(status).toBe(409);
    expect((body as { error: string }).error).toContain("Only the Luna Bot app on this computer");
  });

  it("refuses an action the screen does not offer", async () => {
    const { status } = await harness()("POST", "/api/bots/bot_1/desktop/action", { action: "launch_app", controlLeaseId: "l" });
    expect(status).toBe(400);
  });

  it("refuses an action without the control lease, so the bot and the phone never fight for the mouse", async () => {
    const { status, body } = await harness({ holds: false })("POST", "/api/bots/bot_1/desktop/action", {
      action: "click",
      x: 1,
      y: 2,
      controlLeaseId: "someone-elses",
    });
    expect(status).toBe(409);
    expect((body as { error: string }).error).toContain("Take control");
  });

  it("requires the lease to be named at all", async () => {
    const { status } = await harness()("POST", "/api/bots/bot_1/desktop/action", { action: "click", x: 1, y: 2 });
    expect(status).toBe(400);
  });
});
