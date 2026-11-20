import "../testing/scrub-ambient-omb-env.ts";

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";

import type { HeadlessIo } from "./output.ts";
import { runHeadless } from "./main.ts";

type Rec = Record<string, any>;
const KEY = "sk-test-0123456789abcdefghijklmnopqrstuvwx";
const URL = "https://gw.example.com/v1";

// The pi-only build keeps one configurable engine: openai-compatible. The other kinds (claude, openai, mistral, …)
// were removed with their engines.
function workspace(seed: { configured?: boolean; url?: string; available?: string[] } = {}) {
  const config: Rec = { openaiCompat: { configured: Boolean(seed.configured), ...(seed.url !== undefined ? { url: seed.url } : {}) } };
  const writes: Array<{ path: string; body?: Rec }> = [];
  const instances = () => ["pi", "openaiCompat"].map((instanceId) => ({
    instanceId, driverKind: instanceId === "pi" ? "piAgent" : "openai-compat",
    snapshot: { state: seed.available?.includes(instanceId) ? "available" : "unavailable" },
  }));
  const request = vi.fn(async (path: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if ((init.method ?? "GET") !== "GET") writes.push({ path, ...(body ? { body } : {}) });
    if (path === "/api/config" && init.method === "PUT") {
      for (const [name, value] of Object.entries(body as Rec)) {
        config[name] = { ...config[name], ...(value.key ? { configured: true } : {}), ...(value.url !== undefined ? { url: value.url } : {}) };
      }
      return { ok: true };
    }
    if (path === "/api/config") return config;
    if (path === "/api/instances") return { instances: instances() };
    throw new Error(`unexpected ${init.method ?? "GET"} ${path}`);
  });
  const callTool = vi.fn(async (name: string) => {
    if (name === "list_available_models") return { instances: instances() };
    throw new Error(`unexpected tool ${name}`);
  });
  const run = async (argv: string[], env: Rec = { ENGINE_KEY: KEY }) => {
    const out: string[] = [];
    const err: string[] = [];
    const io: HeadlessIo = { out: (text) => out.push(text), err: (text) => err.push(text), readStdin: async () => "" };
    const code = await runHeadless(argv, { io, env: { LUNABOT_URL: "http://127.0.0.1:19997", ...env }, request: request as any, callTool: callTool as any });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  return { config, writes, run };
}

describe("engine set", () => {
  it("writes a key and base URL once, never prints them, and leaves them alone on the next run unless --rotate", async () => {
    const w = workspace();
    const first = await w.run(["engine", "set", "openai-compatible", "--key-env", "ENGINE_KEY", "--base-url", URL, "--json"]);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.out)).toMatchObject({ ok: true, kind: "openai-compatible", instanceId: "openaiCompat", configured: true, changed: ["key", "baseUrl"] });
    expect(w.writes).toEqual([{ path: "/api/config", body: { openaiCompat: { key: KEY, url: URL } } }]);
    expect(first.out + first.err).not.toContain(KEY);

    w.writes.length = 0;
    const again = await w.run(["engine", "set", "openai-compatible", "--key-env", "ENGINE_KEY", "--base-url", URL]);
    expect(again.out).toBe("openai-compatible was already set up; nothing changed (pass --rotate to replace its key). Bots use it as openaiCompat/MODEL (lunabot models).");
    expect(w.writes).toEqual([]);
    expect((await w.run(["engine", "set", "openai-compatible", "--key-env", "ENGINE_KEY", "--base-url", `${URL}/v2`, "--rotate", "--json"])).code).toBe(0);
    expect(w.writes).toEqual([{ path: "/api/config", body: { openaiCompat: { key: KEY, url: `${URL}/v2` } } }]);
  });

  it("updates a changed base URL without touching a kept key", async () => {
    const w = workspace({ configured: true, url: URL });
    const moved = await w.run(["engine", "set", "openai-compatible", "--key-env", "ENGINE_KEY", "--base-url", "https://other.example/v1", "--json"]);
    expect(JSON.parse(moved.out)).toMatchObject({ changed: ["baseUrl"], configured: true });
    expect(w.writes).toEqual([{ path: "/api/config", body: { openaiCompat: { url: "https://other.example/v1" } } }]);
  });

  it("warns instead of guessing when a kept key's base URL is not visible to compare with", async () => {
    const w = workspace({ configured: true });
    const hidden = await w.run(["engine", "set", "openai-compatible", "--key-env", "ENGINE_KEY", "--base-url", URL]);
    expect(hidden.out).toContain("warning: openai-compatible already has a key and the server does not show its base URL, so --base-url was not written: pass --rotate to write both");
    expect(w.writes).toEqual([]);
  });

  it("installs the engine's command only when it is not running already", async () => {
    const ready = workspace({ configured: true, url: URL, available: ["openaiCompat"] });
    const kept = await ready.run(["engine", "set", "openai-compatible", "--key-env", "ENGINE_KEY", "--base-url", URL, "--rotate", "--install", "--json"]);
    expect(JSON.parse(kept.out)).toMatchObject({ installed: "already" });
    // Only the key rotation reached the server; no install call.
    expect(ready.writes).toEqual([{ path: "/api/config", body: { openaiCompat: { key: KEY, url: URL } } }]);
  });

  it("waits for an install that takes longer than an ordinary request may, as a fresh sandbox's npm install does", async () => {
    // The server answers the install only once npm is done, which outlasts LUNABOT_MCP_TIMEOUT_MS (1 s here).
    const asked: string[] = [];
    let state = "unavailable";
    const server = createServer((req, res) => {
      asked.push(`${req.method} ${req.url}`);
      const reply = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      const instances = () => ({ instances: [{ instanceId: "openaiCompat", driverKind: "openai-compat", snapshot: { state }, cli: "/srv/engines/openaiCompat" }] });
      if (req.url === "/api/config") return reply({ openaiCompat: { configured: true, url: URL } });
      if (req.url === "/api/instances") return reply(instances());
      if (req.url === "/api/instances/openaiCompat/install" && req.method === "POST") {
        setTimeout(() => { state = "available"; reply(instances()); }, 1_600);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const previous = process.env.LUNABOT_MCP_TIMEOUT_MS;
    process.env.LUNABOT_MCP_TIMEOUT_MS = "1000";
    try {
      const out: string[] = [];
      const err: string[] = [];
      const io: HeadlessIo = { out: (text) => out.push(text), err: (text) => err.push(text), readStdin: async () => "" };
      const code = await runHeadless(["engine", "set", "openai-compatible", "--key-env", "ENGINE_KEY", "--base-url", URL, "--rotate", "--install", "--json"],
        { io, env: { LUNABOT_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ENGINE_KEY: KEY } });
      expect(code, out.join("\n")).toBe(0);
      const result = JSON.parse(out.join("\n"));
      expect(result).toMatchObject({ ok: true, installed: "now", state: "available" });
      expect(out.join("\n")).not.toContain("/srv/engines");
      expect(err.map((line) => JSON.parse(line))).toEqual([{ event: "installing", engine: "openaiCompat" }]);
      expect(asked).toContain("POST /api/instances/openaiCompat/install");
    } finally {
      if (previous === undefined) delete process.env.LUNABOT_MCP_TIMEOUT_MS;
      else process.env.LUNABOT_MCP_TIMEOUT_MS = previous;
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  });

  it("takes the base URL only where the engine has one, and refuses the removed engines", async () => {
    const w = workspace();
    const missing = await w.run(["engine", "set", "openai-compatible", "--key-env", "ENGINE_KEY", "--json"]);
    expect(JSON.parse(missing.out)).toMatchObject({ ok: false, exitCode: 2, error: "openai-compatible needs --base-url" });
    const scheme = await w.run(["engine", "set", "openai-compatible", "--key-env", "ENGINE_KEY", "--base-url", "ftp://x.example", "--json"]);
    expect(JSON.parse(scheme.out)).toMatchObject({ exitCode: 2, error: "the base URL must start with http:// or https://" });
    const retired = await w.run(["engine", "set", "claude", "--key-env", "ENGINE_KEY", "--json"]);
    expect(JSON.parse(retired.out)).toMatchObject({ exitCode: 2, error: "unknown engine claude: use one of openai-compatible" });
    const onlyApi = await w.run(["engine", "set", "openai-compatible", "--key-env", "ENGINE_KEY", "--base-url", URL, "--only-claude-api", "--json"]);
    expect(JSON.parse(onlyApi.out)).toMatchObject({ exitCode: 2, error: "--only-claude-api is for the claude engine" });
  });

  it("refuses a key it cannot read, and a dry run writes nothing", async () => {
    const w = workspace();
    const unset = await w.run(["engine", "set", "openai-compatible", "--key-env", "NOT_SET", "--base-url", URL, "--json"], {});
    expect(JSON.parse(unset.out)).toMatchObject({ exitCode: 2, error: "the openai-compatible key: the environment variable NOT_SET is not set" });
    const both = await w.run(["engine", "set", "openai-compatible", "--key-env", "A", "--key-file", "B", "--json"]);
    expect(JSON.parse(both.out)).toMatchObject({ exitCode: 2, error: "give the key one way: --key-env VAR or --key-file FILE" });
    const dry = await w.run(["engine", "set", "openai-compatible", "--key-env", "ENGINE_KEY", "--base-url", URL, "--dry-run", "--json"]);
    expect(JSON.parse(dry.out)).toMatchObject({ dryRun: true, changed: ["key", "baseUrl"] });
    expect(w.writes).toEqual([]);
  });
});

describe("engine list", () => {
  it("shows each engine and which keys are set, never their values", async () => {
    const w = workspace({ configured: true, available: ["pi"] });
    const listed = await w.run(["engine", "list", "--json"]);
    expect(JSON.parse(listed.out).keys).toEqual({ "openai-compatible": true });
    const human = await w.run(["engine", "list"]);
    expect(human.out).toContain("pi · piAgent · available");
    expect(human.out).toContain("Keys set: openai-compatible");
  });
});
