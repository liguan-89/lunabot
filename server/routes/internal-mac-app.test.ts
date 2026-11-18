import { describe, expect, it, vi } from "vitest";

import { runMacApp, type MacAppExec } from "../mac-app.ts";
import { createInternalMacAppRoutes } from "./internal-mac-app.ts";
import type { BotRecord } from "../store.ts";

const bot = { id: "b1" } as BotRecord;

const route = (over: { ownsThread?: boolean; approvalMode?: "ask" | "full"; autoApprove?: boolean; run?: typeof runMacApp } = {}) =>
  createInternalMacAppRoutes({
    store: { taskByThread: () => ({ approvalMode: over.approvalMode ?? "ask", autoApprove: over.autoApprove ?? false }) as never },
    from: bot,
    fromThreadId: "t1",
    ownsThread: () => over.ownsThread !== false,
    run: over.run,
  });

const call = async (handler: ReturnType<typeof route>, body: unknown) => {
  let status = 0, payload: unknown = null;
  await handler({
    req: {} as never, res: {} as never, path: "/api/internal/mac-app", method: "POST",
    auth: {} as never, url: {} as never,
    json: (_res: unknown, s: number, p: unknown) => { status = s; payload = p; return undefined as never; },
    readBody: async () => body,
  } as never);
  return { status, payload } as { status: number; payload: { ok?: boolean; error?: string; result?: unknown } };
};

describe("internal mac-app route", () => {
  it("rejects a caller that does not own the thread and a bad action", async () => {
    expect((await call(route({ ownsThread: false }), { action: "notes_list" })).status).toBe(403);
    expect((await call(route(), { action: "nope" })).status).toBe(400);
    expect((await call(route(), {})).status).toBe(400);
  });

  it("refuses writes under ask approval so bash can raise the card", async () => {
    const run = vi.fn();
    const answer = await call(route({ run: run as never }), { action: "reminders_add", input: { name: "milk" } });
    expect(answer.payload.ok).toBe(false);
    expect(answer.payload.error).toContain("bash");
    expect(run).not.toHaveBeenCalled();
  });

  it("runs writes under full approval or auto-approve, and reads always", async () => {
    const run = vi.fn(async () => ({ ok: true, result: { added: "milk" } }));
    expect((await call(route({ approvalMode: "full", run: run as never }), { action: "reminders_add", input: { name: "milk" } })).payload).toEqual({ ok: true, result: { added: "milk" } });
    expect((await call(route({ autoApprove: true, run: run as never }), { action: "calendar_add", input: { title: "x", start: "2026-01-01T10:00:00Z" } })).payload.ok).toBe(true);
    expect((await call(route({ run: run as never }), { action: "notes_list" })).payload.ok).toBe(true);
  });
});

// runMacApp answers "mac_app needs macOS" before it spawns anything, so the script-and-answer tests need a Mac; they
// run on the macOS shard (host-tests) and are skipped where osascript cannot exist.
describe.skipIf(process.platform !== "darwin")("runMacApp", () => {
  const execOk: MacAppExec = async () => ({ stdout: JSON.stringify([{ name: "a" }]), stderr: "" });

  it("parses the JXA JSON result and surfaces osascript errors", async () => {
    expect(await runMacApp("notes_list", {}, execOk)).toEqual({ ok: true, result: [{ name: "a" }] });
    expect((await runMacApp("notes_list", {}, async () => ({ stdout: "", stderr: "App isn't running" }))).error).toBe("App isn't running");
    expect((await runMacApp("notes_list", {}, async () => ({ stdout: JSON.stringify({ error: "no note with that name" }), stderr: "" }))).error).toBe("no note with that name");
    expect((await runMacApp("notes_list", {}, async () => { throw Object.assign(new Error("spawn failed"), { stderr: "denied" }); })).error).toBe("denied");
  });

  it("embeds inputs into the script", async () => {
    let script = "";
    const exec: MacAppExec = async (_f, args) => { script = args[3]!; return { stdout: "[]", stderr: "" }; };
    await runMacApp("notes_read", { name: "shopping" }, exec);
    expect(script).toContain('"shopping"');
  });
});
