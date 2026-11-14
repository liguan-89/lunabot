import { describe, expect, it, vi } from "vitest";

import type { BotRecord } from "../store.ts";
import { createInternalTrackedTaskRoutes } from "./internal-tracked-tasks.ts";

const bot = { id: "bot-1", name: "Ops", trackedItems: [] } as unknown as BotRecord;

function route(ownsThread: (botId: string, threadId: string) => boolean = () => true) {
  const patchBot = vi.fn((_id: string, patch: Partial<BotRecord>) => { Object.assign(bot, patch); return bot; });
  const handler = createInternalTrackedTaskRoutes({
    store: { patchBot } as never,
    from: bot,
    fromThreadId: "t-own",
    ownsThread,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    let status = 0; let payload: unknown;
    await handler({ res: {}, path, method, readBody: async () => body ?? {}, json: (_r: unknown, s: number, value: never) => { status = s; payload = value; } } as never);
    return { status, payload: payload as Record<string, unknown> };
  };
  return { call, patchBot };
}

describe("tracked_tasks internal routes", () => {
  it("creates, lists and updates an item", async () => {
    bot.trackedItems = [];
    const { call } = route();
    const created = await call("POST", "/api/internal/tracked-tasks", { title: "Check overnight invoices", note: "waiting on finance", threadId: "t-own" });
    expect(created.status).toBe(200);
    const id = (created.payload.item as { id: string }).id;
    expect(bot.trackedItems).toMatchObject([{ id, title: "Check overnight invoices", state: "open", threadId: "t-own" }]);

    expect((await call("GET", "/api/internal/tracked-tasks")).payload.items).toHaveLength(1);

    expect((await call("PATCH", `/api/internal/tracked-tasks/${id}`, { state: "needs-you", note: "needs the person's answer" })).status).toBe(200);
    expect(bot.trackedItems?.[0]).toMatchObject({ state: "needs-you", note: "needs the person's answer" });

    expect((await call("PATCH", `/api/internal/tracked-tasks/${id}`, { state: "done", note: null })).status).toBe(200);
    expect(bot.trackedItems?.[0]).toMatchObject({ state: "done" });
    expect(bot.trackedItems?.[0]?.note).toBeUndefined();
  });

  it("rejects a conversation that is not the caller's", async () => {
    bot.trackedItems = [];
    const { call, patchBot } = route(() => false);
    expect((await call("POST", "/api/internal/tracked-tasks", { title: "x" })).status).toBe(403);
    expect((await call("GET", "/api/internal/tracked-tasks")).status).toBe(403);
    expect(patchBot).not.toHaveBeenCalled();
  });

  it("refuses a bad title, a bad state and a thread link that is not the bot's own", async () => {
    bot.trackedItems = [];
    const ownOnly = (_botId: string, threadId: string) => threadId !== "t-foreign";
    const { call } = route(ownOnly);
    expect((await call("POST", "/api/internal/tracked-tasks", { title: " " })).status).toBe(400);
    expect((await call("POST", "/api/internal/tracked-tasks", { title: "x".repeat(161) })).status).toBe(400);
    expect((await call("POST", "/api/internal/tracked-tasks", { title: "ok", threadId: "t-foreign" })).status).toBe(400);
    const created = await call("POST", "/api/internal/tracked-tasks", { title: "ok" });
    const id = (created.payload.item as { id: string }).id;
    expect((await call("PATCH", `/api/internal/tracked-tasks/${id}`, { state: "bogus" })).status).toBe(400);
    expect((await call("PATCH", "/api/internal/tracked-tasks/no-such", { state: "done" })).status).toBe(404);
  });

  it("caps the list", async () => {
    bot.trackedItems = Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, title: `item ${i}`, state: "open", createdAt: i, updatedAt: i })) as never;
    const { call } = route();
    expect((await call("POST", "/api/internal/tracked-tasks", { title: "one more" })).status).toBe(429);
  });
});
