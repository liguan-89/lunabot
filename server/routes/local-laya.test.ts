import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import { LAYA_DEFAULT_MODEL, type LocalLayaService, type LocalLayaStatus } from "../decider/local-laya.ts";
import { json } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { RouteContext } from "./table.ts";
import { createLocalLayaRoutes } from "./local-laya.ts";
import { PASS } from "./table.ts";

const auth: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
function service(overrides: Partial<LocalLayaService> = {}) {
  let status: LocalLayaStatus = {
    available: true, installed: false, running: false, busy: false, error: null,
    progress: null, model: LAYA_DEFAULT_MODEL,
  };
  let verified = false;
  const local: LocalLayaService = {
    supported: true,
    status: () => ({ ...status }),
    installed: () => status.installed,
    start: vi.fn(async () => { status = { ...status, installed: true, running: true, busy: false }; return { ...status }; }),
    test: vi.fn(async () => { verified = true; return { ok: true as const }; }),
    verified: () => verified,
    stop: vi.fn(async () => { status = { ...status, running: false, busy: false, progress: null }; verified = false; return { ...status }; }),
    credential: () => verified ? { baseUrl: "http://127.0.0.1:49152", key: "never-return-this-token" } : null,
    ...overrides,
  };
  return { local, setStatus: (patch: Partial<LocalLayaStatus>) => { status = { ...status, ...patch }; }, verified: (value: boolean) => { verified = value; } };
}
function context(path: string, method: string, options: {
  auth?: RequestAuth; body?: unknown; headers?: Record<string, string>;
} = {}) {
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    setHeader: vi.fn(),
  }) as unknown as ServerResponse;
  const reply = vi.fn();
  const ctx: RouteContext = {
    req: {} as IncomingMessage,
    res,
    url: new URL(`http://127.0.0.1${path}`),
    path,
    method,
    auth: options.auth ?? auth,
    json: reply as typeof json,
    readBody: vi.fn(async () => options.body ?? {}) as RouteContext["readBody"],
  };
  return { ctx, reply, res };
}
async function invoke(handler: ReturnType<typeof createLocalLayaRoutes>, path: string, method: string, options?: Parameters<typeof context>[2]) {
  const call = context(path, method, options);
  const result = await handler(call.ctx);
  const body = call.reply.mock.calls.at(-1)?.[2] as Record<string, unknown> | undefined;
  return { ...call, result, status: call.reply.mock.calls.at(-1)?.[1], body };
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
afterEach(() => vi.restoreAllMocks());

describe("local Laya routes", () => {
  it("keeps the endpoints owner-loopback-only and declines unknown paths", async () => {
    const fixture = service();
    const handler = createLocalLayaRoutes({ local: fixture.local, desktopManaged: true, config: () => ({}), saveProvider: vi.fn(), useLocal: () => false });
    expect((await invoke(handler, "/api/decider/laya", "GET", { auth: { ...auth, trust: "service" } })).status).toBe(404);
    expect((await invoke(handler, "/api/decider/laya/start", "POST", { auth: { kind: "session", scopes: ["admin"], session: {} as never, via: "bearer" } })).status).toBe(404);
    expect((await invoke(createLocalLayaRoutes({ local: fixture.local, desktopManaged: false, config: () => ({}), saveProvider: vi.fn(), useLocal: () => false }), "/api/decider/laya", "GET")).status).toBe(404);
    const unknown = await invoke(handler, "/api/decider/laya/other", "GET");
    expect(unknown.result).toBe(PASS);
  });

  it("returns a private status with no token, port or internal process output", async () => {
    const fixture = service();
    fixture.setStatus({ running: true, installed: true, error: "uv failed with secret /private/path" });
    const handler = createLocalLayaRoutes({ local: fixture.local, desktopManaged: true, config: () => ({}), saveProvider: vi.fn(), useLocal: () => false });
    const response = await invoke(handler, "/api/decider/laya", "GET");
    expect(response.status).toBe(200);
    expect(response.res.setHeader).toHaveBeenCalledWith("cache-control", "no-store");
    expect(response.body).toMatchObject({ available: true, installed: true, running: true, model: LAYA_DEFAULT_MODEL, error: "Local Laya setup failed. Try again." });
    expect(JSON.stringify(response.body)).not.toMatch(/never-return-this-token|49152|private\/path|uv failed/);
  });

  it("returns 202 before startup finishes and saves Laya only after the contract check", async () => {
    let resolveStart!: (value: LocalLayaStatus) => void;
    const fixture = service({ start: vi.fn(() => new Promise<LocalLayaStatus>((resolve) => { resolveStart = resolve; })) });
    const config: AppConfig = {};
    const saveProvider = vi.fn((provider: "laya" | "jev") => { config.decider = { ...config.decider, provider }; });
    const handler = createLocalLayaRoutes({ local: fixture.local, desktopManaged: true, config: () => config, saveProvider, useLocal: () => false });
    const accepted = await invoke(handler, "/api/decider/laya/start", "POST");
    expect(accepted.status).toBe(202);
    expect(accepted.body).toMatchObject({ operation: "starting", busy: true });
    expect(saveProvider).not.toHaveBeenCalled();

    resolveStart({ available: true, installed: true, running: true, busy: false, error: null, progress: null, model: LAYA_DEFAULT_MODEL });
    await tick();
    expect(fixture.local.test).toHaveBeenCalledOnce();
    expect(saveProvider).toHaveBeenCalledExactlyOnceWith("laya");
    expect(config.decider?.provider).toBe("laya");
    expect((await invoke(handler, "/api/decider/laya", "GET")).body?.operation).toBe("ready");
  });

  it("switches back to Jev before stopping, and preserves Laya if switching fails", async () => {
    const fixture = service();
    const config: AppConfig = { decider: { provider: "laya", enabled: true } };
    const order: string[] = [];
    fixture.local.stop = vi.fn(async () => { order.push("stop"); return fixture.local.status(); });
    const saveProvider = vi.fn((provider: "laya" | "jev") => { order.push(`save:${provider}`); config.decider!.provider = provider; });
    const handler = createLocalLayaRoutes({ local: fixture.local, desktopManaged: true, config: () => config, saveProvider, useLocal: () => false });
    expect((await invoke(handler, "/api/decider/laya/stop", "POST")).status).toBe(200);
    expect(order).toEqual(["save:jev", "stop"]);

    config.decider!.provider = "laya";
    saveProvider.mockImplementation(() => { throw new Error("config disk full"); });
    const refused = await invoke(handler, "/api/decider/laya/stop", "POST");
    expect(refused.status).toBe(500);
    expect(fixture.local.stop).toHaveBeenCalledTimes(1);
    expect(config.decider!.provider).toBe("laya");
  });

  it("invalidates a late installation when cancelled and does not switch provider", async () => {
    let resolveStart!: (value: LocalLayaStatus) => void;
    const fixture = service({ start: vi.fn(() => new Promise<LocalLayaStatus>((resolve) => { resolveStart = resolve; })) });
    const saveProvider = vi.fn();
    const handler = createLocalLayaRoutes({ local: fixture.local, desktopManaged: true, config: () => ({}), saveProvider, useLocal: () => false });
    expect((await invoke(handler, "/api/decider/laya/start", "POST")).status).toBe(202);
    expect((await invoke(handler, "/api/decider/laya/stop", "POST")).status).toBe(200);
    resolveStart({ available: true, installed: true, running: true, busy: false, error: null, progress: null, model: LAYA_DEFAULT_MODEL });
    await tick();
    expect(saveProvider).not.toHaveBeenCalled();
    expect(fixture.local.stop).toHaveBeenCalled();
  });

  it("rejects options and a failed local contract without storing Laya", async () => {
    const fixture = service({ test: vi.fn(async () => ({ ok: false as const, reason: "malformed" })) });
    const saveProvider = vi.fn();
    const handler = createLocalLayaRoutes({ local: fixture.local, desktopManaged: true, config: () => ({}), saveProvider, useLocal: () => false });
    expect((await invoke(handler, "/api/decider/laya/start", "POST", { body: { model: "attacker-choice" } })).status).toBe(400);
    expect((await invoke(handler, "/api/decider/laya/start", "POST")).status).toBe(202);
    await tick();
    expect(saveProvider).not.toHaveBeenCalled();
    expect((await invoke(handler, "/api/decider/laya", "GET")).body).toMatchObject({ operation: "error", error: "Local Laya setup failed. Try again." });
  });
});
