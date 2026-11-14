import { describe, expect, it, vi } from "vitest";

import type { BotRecord } from "../store.ts";
import { createInternalProactivityRoutes, type ProactivityLevel } from "./internal-proactivity.ts";

const bot = { id: "bot-1", name: "Ops" } as unknown as BotRecord;

function route(ownsThread: (botId: string, threadId: string) => boolean = () => true, level: ProactivityLevel = "standard") {
  let current = level;
  const set = vi.fn((next: ProactivityLevel) => { current = next; });
  const handler = createInternalProactivityRoutes({
    store: {} as never,
    from: bot,
    fromThreadId: "t-own",
    ownsThread,
    level: () => current,
    set,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    let status = 0; let payload: unknown;
    await handler({ res: {}, path, method, readBody: async () => body ?? {}, json: (_r: unknown, s: number, value: never) => { status = s; payload = value; } } as never);
    return { status, payload: payload as Record<string, unknown> };
  };
  return { call, set, current: () => current };
}

describe("proactivity internal routes", () => {
  it("reads the level and sets it", async () => {
    const { call, set, current } = route();
    expect(await call("GET", "/api/internal/proactivity")).toEqual({ status: 200, payload: { level: "standard" } });
    expect(await call("PUT", "/api/internal/proactivity", { level: "quiet" })).toEqual({ status: 200, payload: { level: "quiet" } });
    expect(set).toHaveBeenCalledWith("quiet");
    expect(current()).toBe("quiet");
    expect((await call("GET", "/api/internal/proactivity")).payload).toEqual({ level: "quiet" });
  });

  it("refuses an unknown level and leaves the current one alone", async () => {
    const { call, set, current } = route();
    expect((await call("PUT", "/api/internal/proactivity", { level: "loud" })).status).toBe(400);
    expect((await call("PUT", "/api/internal/proactivity", {})).status).toBe(400);
    expect(set).not.toHaveBeenCalled();
    expect(current()).toBe("standard");
  });

  it("rejects a conversation that is not the caller's", async () => {
    const { call, set } = route(() => false);
    expect((await call("GET", "/api/internal/proactivity")).status).toBe(403);
    expect((await call("PUT", "/api/internal/proactivity", { level: "quiet" })).status).toBe(403);
    expect(set).not.toHaveBeenCalled();
  });
});
