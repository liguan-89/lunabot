import { describe, expect, it, vi } from "vitest";

import type { BotRecord } from "../store.ts";
import { createGrantRoutes, createInternalGrantRoutes } from "./grants.ts";

const bot = { id: "bot-1", name: "Ops" } as unknown as BotRecord;
const owner = { kind: "loopback", scopes: ["admin", "client"] } as never;

function call(handler: ReturnType<typeof createGrantRoutes> | ReturnType<typeof createInternalGrantRoutes>, method: string, path: string, body?: unknown, auth: unknown = owner) {
  let status = 0; let payload: unknown;
  return handler({ req: {}, res: {}, path, method, auth: auth as never, readBody: async () => body ?? {}, json: (_r: unknown, s: number, value: never) => { status = s; payload = value; } } as never).then(() => ({ status, payload: payload as Record<string, unknown> }));
}

describe("grants answer route", () => {
  it("passes a valid answer through and maps each outcome", async () => {
    const answer = vi.fn(() => "granted" as const);
    const route = createGrantRoutes({ answer });
    expect(await call(route, "POST", "/api/grants/answer", { threadId: "t1", messageId: "m1", answer: "granted" })).toEqual({ status: 200, payload: { ok: true, outcome: "granted" } });
    expect(answer).toHaveBeenCalledWith({ threadId: "t1", messageId: "m1", auth: owner, answer: "granted" });

    for (const [outcome, status] of [["refused", 200], ["not-owner", 403], ["unknown", 404], ["expired", 410]] as const) {
      answer.mockReturnValueOnce(outcome as never);
      expect((await call(route, "POST", "/api/grants/answer", { threadId: "t1", messageId: "m1", answer: "granted" })).status).toBe(status);
    }
    expect((await call(route, "POST", "/api/grants/answer", { threadId: "t1", messageId: "m1", answer: "bogus" })).status).toBe(400);
    expect((await call(route, "GET", "/api/grants/answer", {})).status).toBe(0);
  });
});

describe("internal grants route", () => {
  it("validates and proposes in the caller's own conversation", async () => {
    const propose = vi.fn(() => ({ proposal: { id: "p1" } }));
    const route = createInternalGrantRoutes({
      store: {} as never, from: bot, fromThreadId: "t-own",
      ownsThread: (_b, t) => t === "t-own",
      propose, now: () => 1_000_000,
    });
    const posted = await call(route, "POST", "/api/internal/grants", { text: "billing mails may be sent", hours: 4 });
    expect(posted).toEqual({ status: 200, payload: { ok: true, proposalId: "p1" } });
    expect(propose).toHaveBeenCalledWith({ bot, threadId: "t-own", text: "billing mails may be sent", expiresAt: 1_000_000 + 4 * 3_600_000 });
  });

  it("rejects bad input and foreign conversations", async () => {
    const propose = vi.fn(() => ({ proposal: { id: "p1" } }));
    const route = createInternalGrantRoutes({
      store: {} as never, from: bot, fromThreadId: "t-foreign",
      ownsThread: (_b, t) => t === "t-own",
      propose, now: () => 1_000_000,
    });
    expect((await call(route, "POST", "/api/internal/grants", { text: "x", hours: 4 })).status).toBe(403);

    const own = createInternalGrantRoutes({
      store: {} as never, from: bot, fromThreadId: "t-own",
      ownsThread: () => true, propose, now: () => 1_000_000,
    });
    for (const body of [{ text: " " }, { text: "x".repeat(301), hours: 1 }, { text: "x", hours: 0 }, { text: "x", hours: 200 }, { hours: 4 }, { text: "x" }]) {
      expect((await call(own, "POST", "/api/internal/grants", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(propose).toHaveBeenCalledTimes(0);
  });
});
