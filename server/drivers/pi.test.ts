import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../config.ts";
import { TurnNotStartedError, type ProviderInstance, type RuntimeEvent } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { encodeInjectId, localHost } from "./local-inject.ts";
import { buildMcpServers } from "./pi-mcp-servers.ts";
import { ensurePiInstanceAgentDir } from "./pi-model-catalog.ts";
import {
  applyPiLocalCatalog,
  decodePiFrame,
  ensurePiCustomProvider,
  ensurePiInjectModel,
  fetchPiModels,
  parsePiCatalog,
  PiDriver,
  PiRpcChunks,
  piLineReader,
  preferPiInjectRows,
  splitPiModel,
  updatePiModelCatalog,
} from "./pi.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-pi-cli.ts");
const MODELS_LINE =
  '{"type":"response","command":"get_available_models","success":true,"data":{"models":[{"provider":"ollama-cloud","id":"glm-5.2","name":"glm-5.2"},{"provider":"openai","id":"gpt-4o","name":"GPT-4o"}]}}';

describe("parsePiCatalog", () => {
  it("turns a get_available_models response into custom composite-id options", () => {
    const catalog = parsePiCatalog(MODELS_LINE + "\n");
    expect(catalog.default).toBe("ollama-cloud/glm-5.2");
    expect(catalog.options).toEqual([
      { id: "ollama-cloud/glm-5.2", label: "glm-5.2", custom: true, provider: "ollama-cloud" },
      { id: "openai/gpt-4o", label: "GPT-4o", custom: true, provider: "openai" },
    ]);
  });

  it("uses the fallback default when the response omits one and a settings file is absent", () => {
    const catalog = parsePiCatalog(MODELS_LINE + "\n", "openai/gpt-4o");
    expect(catalog.default).toBe("openai/gpt-4o");
  });

  it("reports the provider so BYOK duplicates of one model stay distinguishable", () => {
    const line =
      '{"type":"response","command":"get_available_models","success":true,"data":{"models":[' +
      '{"provider":"zai","id":"glm-5.3","name":"GLM-5.3"},' +
      '{"provider":"nous","id":"glm-5.3","name":"GLM-5.3"}]}}\n';
    const catalog = parsePiCatalog(line);
    expect(catalog.options.map((o) => [o.id, o.provider])).toEqual([
      ["zai/glm-5.3", "zai"],
      ["nous/glm-5.3", "nous"],
    ]);
  });

  it("keeps an empty catalog when the probe fails or reports no models", () => {
    expect(parsePiCatalog("not json\n")).toEqual({ default: "", options: [] });
    expect(parsePiCatalog('{"type":"response","command":"get_available_models","success":false}\n')).toEqual({
      default: "",
      options: [],
    });
    expect(
      parsePiCatalog('{"type":"response","command":"get_available_models","success":true,"data":{"models":[]}}\n'),
    ).toEqual({ default: "", options: [] });
  });

  it("ignores non-response lines (pi emits TUI bookkeeping on stdout too)", () => {
    const stdout =
      '{"type":"extension_ui_request","id":"x","method":"setStatus","statusKey":"loops"}\n' + MODELS_LINE + "\n";
    const catalog = parsePiCatalog(stdout);
    expect(catalog.options).toHaveLength(2);
  });
});

describe("PiRpcChunks", () => {
  const split = (json: string, at: number, chunkId = "c1") => {
    const bytes = Buffer.from(json, "utf8");
    const data = (start: number, end: number) => bytes.subarray(start, end).toString("base64");
    return [
      { type: "rpc_chunk", chunkId, index: 0, count: 2, byteLength: bytes.length, data: data(0, at) },
      { type: "rpc_chunk", chunkId, index: 1, count: 2, byteLength: bytes.length, data: data(at, bytes.length) },
    ];
  };

  it("reassembles a split frame and passes plain frames through", () => {
    const chunks = new PiRpcChunks();
    const json = JSON.stringify({ type: "turn_end", usage: { input: 1, output: 2 } });
    const [head, tail] = split(json, 7);
    expect(decodePiFrame(JSON.stringify(head), chunks)).toBeNull();
    expect(decodePiFrame(JSON.stringify(tail), chunks)).toEqual({ type: "turn_end", usage: { input: 1, output: 2 } });
    expect(decodePiFrame(JSON.stringify({ type: "agent_end" }), chunks)).toEqual({ type: "agent_end" });
  });

  it.each([
    ["a mismatched count", { count: 3 }],
    ["a mismatched byteLength", { byteLength: 1 }],
    ["a skipped index", { index: 2 }],
  ])("drops the sequence on %s and recovers on the next one", (_label, overrides) => {
    const chunks = new PiRpcChunks();
    const json = JSON.stringify({ type: "turn_end" });
    const [head, tail] = split(json, 4);
    expect(decodePiFrame(JSON.stringify(head), chunks)).toBeNull();
    expect(decodePiFrame(JSON.stringify({ ...tail, ...overrides }), chunks)).toBeNull();
    const [head2, tail2] = split(json, 4, "c2");
    expect(decodePiFrame(JSON.stringify(head2), chunks)).toBeNull();
    expect(decodePiFrame(JSON.stringify(tail2), chunks)).toEqual({ type: "turn_end" });
  });

  it("ignores single-chunk, incomplete and non-JSON frames", () => {
    const chunks = new PiRpcChunks();
    expect(decodePiFrame(JSON.stringify({ type: "rpc_chunk", chunkId: "c", index: 0, count: 1, byteLength: 2, data: "e30=" }), chunks)).toBeNull();
    expect(decodePiFrame(JSON.stringify({ type: "rpc_chunk", chunkId: "c", index: 0, count: 2, byteLength: 2 }), chunks)).toBeNull();
    expect(decodePiFrame("not json", chunks)).toBeNull();
  });

  it("does not return a frame whose reassembled bytes are not JSON", () => {
    const chunks = new PiRpcChunks();
    const [head, tail] = split("not json at all", 4);
    expect(decodePiFrame(JSON.stringify(head), chunks)).toBeNull();
    expect(decodePiFrame(JSON.stringify(tail), chunks)).toBeNull();
  });

  it("rejects empty, oversized and too-many pieces without keeping the sequence", () => {
    const piece = (overrides: Record<string, unknown>) =>
      JSON.stringify({ type: "rpc_chunk", chunkId: "c", index: 0, count: 2, byteLength: 2, data: "e30=", ...overrides });
    const oversized = "A".repeat(Math.ceil(PiRpcChunks.MAX_PIECE_BYTES / 3) * 4 + 4);
    for (const overrides of [{ data: "" }, { data: "=" }, { data: oversized }, { count: PiRpcChunks.MAX_COUNT + 1 }]) {
      const chunks = new PiRpcChunks();
      expect(decodePiFrame(piece(overrides), chunks)).toBeNull();
      expect(decodePiFrame(piece({ ...overrides, index: 1, data: "e30=" }), chunks)).toBeNull();
    }
  });
});

describe("piLineReader", () => {
  it("drops a line longer than the frame cap and resumes at the next newline", () => {
    const lines: string[] = [];
    const read = piLineReader((line) => void lines.push(line));
    read('{"a":1}\n');
    read("x".repeat(PiRpcChunks.MAX_BYTES + 1));
    read('{"type":"forged"}\n\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe("buildMcpServers", () => {
  it("mounts a selected custom mail server without unrelated built-ins", () => {
    const servers = buildMcpServers({ threadId: "selected", text: "Read mail", toolScope: { allow: ["mcp:mail:*"] }, integrations: {
      agents: { command: "node", args: ["agents"], env: {} },
      localComputer: { command: "node", args: ["computer"], env: {} },
      custom: { mail: { command: "node", args: ["mail"], env: { SYNTHETIC: "1" } } },
    } });
    expect(Object.keys(servers ?? {})).toEqual(["mail"]);
    expect(servers?.mail).toMatchObject({ scope: "custom" });
  });

  it("rejects malformed policy and mounts nothing for native-only selection", () => {
    expect(() => buildMcpServers({ threadId: "bad", text: "Stop", toolScope: { allow: null } as never })).toThrow(/tool selection/i);
    expect(buildMcpServers({ threadId: "native", text: "Draft", toolScope: { allow: ["native:read", "native:write"] }, integrations: { agents: { command: "node", args: [], env: {} } } })).toBeNull();
  });
  it("gates a URL server that has its own result limit, and only that one", () => {
    const url = { type: "http" as const, url: "https://mcp.example.test/mcp", headers: {} };
    const servers = buildMcpServers({ threadId: "t", text: "hi", integrations: {
      custom: { motion: { ...url }, shop: { ...url } },
      customResultBudgets: { motion: 40_000 },
    } }) as Record<string, { args: string[]; env: Record<string, string> }>;
    expect(servers.motion.env.OMB_GATE_BUDGET).toBe("40000");
    expect(servers.motion.args[0]).toContain("mcp-gate");
    expect(servers.shop.env).not.toHaveProperty("OMB_GATE_BUDGET");
    expect(servers.shop.args[0]).toContain("mcp-remote-proxy");
  });

  it("returns null when there are no integrations", () => {
    expect(buildMcpServers({ threadId: "t", text: "hi" })).toBeNull();
  });

  it("passes composio/agents/phone through as stdio servers", () => {
    const servers = buildMcpServers({
      threadId: "t",
      text: "hi",
      integrations: {
        composio: { command: "node", args: ["c"], env: { A: "1" } },
        agents: { command: "node", args: ["a"], env: { B: "2" } },
        phone: { command: "node", args: ["p"], env: {} },
      },
    });
    expect(servers).toEqual({
      composio: { command: "node", args: ["c"], env: { A: "1" } },
      agents: { command: "node", args: ["a"], env: { B: "2" } },
      phone: { command: "node", args: ["p"], env: {} },
    });
  });

  it("passes a local computer (Cua/VPS) through as a direct stdio server", () => {
    const servers = buildMcpServers({
      threadId: "t",
      text: "hi",
      integrations: {
        localComputer: { command: "node", args: ["mcp"], env: { X: "y" } },
      },
    });
    expect(servers?.computer).toEqual({ command: "node", args: ["mcp"], env: { X: "y" } });
  });

  it("searches a URL server's catalog through the remote proxy, behind the gate when selected", () => {
    const whop = { type: "http" as const, url: "https://mcp.example.test/mcp", headers: { Authorization: "Bearer disposable-pi-token" } };
    const servers = buildMcpServers({ threadId: "t", text: "hi", integrations: { custom: { whop, notes: { command: "node", args: ["notes"], env: {} } } } });
    const mounted = servers?.whop as { command: string; args: string[]; env: Record<string, string> };
    expect(mounted).toMatchObject({ command: process.execPath, scope: "custom", directory: true });
    expect(mounted.args[0]).toContain("mcp-remote-proxy");
    expect(JSON.parse(mounted.env.OMB_REMOTE_MCP_DIRECTORY)).toEqual({ name: "whop" });
    expect(JSON.stringify(mounted.args)).not.toContain("disposable-pi-token");
    expect(servers?.notes).not.toHaveProperty("directory");
    const toolScope = { allow: ["mcp:whop:*"], deny: ["mcp:whop:payments_create"] };
    const scoped = buildMcpServers({ threadId: "t", text: "hi", toolScope, integrations: { custom: { whop } } })?.whop as { args: string[]; env: Record<string, string> };
    expect(scoped).toMatchObject({ directory: true });
    expect(scoped.args[0]).toContain("mcp-gate");
    expect(scoped.env.OMB_GATE_DIRECTORY).toBe("1");
    expect(JSON.parse(JSON.parse(scoped.env.OMB_GATE_UPSTREAM).env.OMB_REMOTE_MCP_DIRECTORY)).toEqual({ name: "whop", toolScope });
  });

  it("mounts none of the owner's custom connectors for a guest-confined turn", () => {
    const servers = buildMcpServers({
      threadId: "t-guest", text: "hi", guestConfined: true,
      integrations: { custom: { whop: { type: "http" as const, url: "https://mcp.example.test/mcp", headers: {} }, notes: { command: "node", args: ["notes"], env: {} } } },
    });
    expect(servers?.whop).toBeUndefined();
    expect(servers?.notes).toBeUndefined();
  });

  it("marks a host computer with scope so the extension gates its tools", () => {
    const servers = buildMcpServers({
      threadId: "t",
      text: "hi",
      integrations: {
        localComputer: { command: "node", args: ["mcp"], env: {}, scope: "local-computer" },
      },
    });
    expect(servers?.computer).toMatchObject({ scope: "local-computer" });
  });
});

describe("PiDriver config + install", () => {
  it("defaults to the `pi` binary", () => {
    expect(PiDriver.decodeConfig({})).toEqual({ cli: "pi", fullAuto: false });
    expect(PiDriver.decodeConfig(undefined)).toEqual({ cli: "pi", fullAuto: false });
    expect(PiDriver.decodeConfig(null)).toEqual({ cli: "pi", fullAuto: false });
    expect(PiDriver.decodeConfig({ cli: "  " })).toEqual({ cli: "pi", fullAuto: false });
  });

  it("rejects invalid config (throws → shadow snapshot)", () => {
    expect(() => PiDriver.decodeConfig(5)).toThrow(/object/);
    expect(() => PiDriver.decodeConfig({ cli: 5 })).toThrow(/string/);
    expect(() => PiDriver.decodeConfig({ fullAuto: "yes" })).toThrow(/boolean/);
  });

  it("publishes the npm installer on every platform and points docs at pi.dev", () => {
    expect(PiDriver.install).toMatchObject({
      command: {
        darwin: "npm install -g @earendil-works/pi-coding-agent",
        linux: "npm install -g @earendil-works/pi-coding-agent",
        win32: "npm install -g @earendil-works/pi-coding-agent",
      },
      docsUrl: "https://pi.dev",
      needsNode: true,
    });
    expect(PiDriver.metadata).toMatchObject({ displayName: "pi", access: "custom" });
  });
});

describe("PiDriver catalog (fake CLI)", () => {
  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
  });

  it("probes the live catalog and flags every option custom", async () => {
    const catalog = await fetchPiModels(FAKE_CLI, { PATH: process.env.PATH ?? "", HOME: join(tmpdir(), "omb-pi-no-settings") });
    expect(catalog.options).toEqual([
      { id: "ollama-cloud/glm-5.2", label: "glm-5.2", custom: true, provider: "ollama-cloud" },
      { id: "openai/gpt-4o", label: "gpt-4o", custom: true, provider: "openai" },
    ]);
    // no ~/.pi/agent/settings.json in the throwaway home → first option wins
    expect(catalog.default).toBe("ollama-cloud/glm-5.2");
  });

  it("keeps an empty catalog when the probe reports no models", async () => {
    const catalog = await fetchPiModels(FAKE_CLI, {
      PATH: process.env.PATH ?? "",
      HOME: join(tmpdir(), "omb-pi-empty"),
      FAKE_PI_MODE: "no-models",
    });
    expect(catalog.options).toEqual([]);
  });

  it("reassembles the chunked catalog from a protocol-v2 runtime", async () => {
    const catalog = await fetchPiModels(FAKE_CLI, {
      PATH: process.env.PATH ?? "",
      HOME: join(tmpdir(), "omb-pi-omp-chunk"),
      FAKE_PI_MODE: "omp-chunk",
    });
    // The runtime stubs the catalog unless protocol 2 was negotiated first, so a catalog pins the order.
    expect(catalog.options).toEqual([
      { id: "ollama-cloud/glm-5.2", label: "glm-5.2", custom: true, provider: "ollama-cloud" },
      { id: "openai/gpt-4o", label: "gpt-4o", custom: true, provider: "openai" },
    ]);
    expect(catalog.default).toBe("ollama-cloud/glm-5.2");
  });

  it("updates pi's catalog only on explicit refresh, then probes it again", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-pi-update-"));
    const dump = join(home, "launches.jsonl");
    const instance = await PiDriver.create({
      instanceId: "pi-refresh",
      displayName: undefined,
      environment: { HOME: home, FAKE_PI_DUMP: dump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      const startup = readFileSync(dump, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(startup.some((entry) => entry.argv?.[0] === "update")).toBe(false);

      writeFileSync(dump, "");
      await instance.refreshModels?.();
      const refresh = readFileSync(dump, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(refresh.map((entry) => entry.argv)).toEqual([
        ["update", "--models", "--no-approve"],
        ["--mode", "rpc", "--no-session"],
      ]);
    } finally {
      await instance.dispose();
    }
  });

  it("reports update failure without preventing a cached catalog probe", async () => {
    expect(await updatePiModelCatalog(FAKE_CLI, {
      PATH: process.env.PATH ?? "",
      FAKE_PI_MODE: "update-error",
    })).toBe(false);
    const catalog = await fetchPiModels(FAKE_CLI, {
      PATH: process.env.PATH ?? "",
      HOME: join(tmpdir(), "omb-pi-update-error"),
      FAKE_PI_MODE: "update-error",
    });
    expect(catalog.options).toHaveLength(2);
  });
});

describe("PiDriver turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  const create = async (
    mode?: string,
    environment: Record<string, string> = {},
    fullAuto = false,
  ) => {
    instance = await PiDriver.create({
      instanceId: "pi-test",
      displayName: "pi Test",
      environment: { ...environment, ...(mode ? { FAKE_PI_MODE: mode } : {}) },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
  });

  it("refuses a restricted turn when the loaded extension has not confirmed enforcement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-missing-scope-"));
    const dump = join(dir, "rpc.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    await expect(instance.adapter.sendTurn({ threadId: "missing-enforcement", text: "Must not reach a provider", toolScope: { allow: [] } })).rejects.toThrow(/tool selection.*enforcement/i);
    const rows = readFileSync(dump, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.some((row) => row.argv?.includes("-e"))).toBe(true);
    expect(rows.find((row) => row.argv?.includes("-e"))?.mcpConfig?.toolScope).toEqual({ allow: [] });
    expect(rows.some((row) => row.prompt !== undefined)).toBe(false);
  });

  it("confines a guest turn: every native tool denied on the wire, and fail-closed without enforcement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-guest-"));
    const dump = join(dir, "rpc.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    await expect(instance.adapter.sendTurn({
      threadId: "t-guest", text: "hi", guestConfined: true,
      toolScope: { deny: ["native:write"] },
    })).rejects.toThrow(/enforcement/i);
    const rows = readFileSync(dump, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.find((row) => row.argv?.includes("-e"))?.mcpConfig?.toolScope).toEqual({ deny: ["native:write", "native:*"] });
    expect(rows.some((row) => row.prompt !== undefined)).toBe(false);
    expect(instance.adapter.capabilities.guestTurns).toBe("confined");
  });

  it("rejects a startup-recovery turn whose child died before the prompt, and publishes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-exit-early-"));
    const dump = join(dir, "dump.jsonl");
    await create("exit-early", { FAKE_PI_DUMP: dump });
    const pending = instance.adapter.sendTurn({
      threadId: "t-exit-early", text: "hi", model: "ollama-cloud/glm-5.2", startupRecovery: true,
    });
    await expect(pending).rejects.toBeInstanceOf(TurnNotStartedError);
    // Quiet: the harness's recovery owns the failure row, so the driver
    // published neither a completion nor a runtime error of its own.
    expect(recorder.events.some((e) => e.type === "turn.completed")).toBe(false);
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(false);
    // And the prompt never reached the CLI the harness would replay onto.
    expect(readFileSync(dump, "utf8").includes('"prompt"')).toBe(false);
  });

  it("still reports a pre-prompt exit as a failed turn when recovery is off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-exit-early-no-recovery-"));
    const dump = join(dir, "dump.jsonl");
    await create("exit-early", { FAKE_PI_DUMP: dump });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-exit-plain", text: "hi", model: "ollama-cloud/glm-5.2" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "failed" });
    expect(readFileSync(dump, "utf8").includes('"prompt"')).toBe(false);
  });

  it("never replays a prompt the preflight rejected, even under startup recovery", async () => {
    await create("prompt-reject");
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-prompt-reject", text: "hi", model: "ollama-cloud/glm-5.2", startupRecovery: true,
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    // The frame went out, so the refusal is the turn's own failure, not a
    // start-up one: reported once, with no quiet window and no replay.
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "failed" });
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(true);
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
  });

  it("normalizes a full turn into the canonical event sequence", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-happy",
      text: "hi",
      model: "ollama-cloud/glm-5.2",
    });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "content.delta",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "piAgent")).toBe(true);

    const session = recorder.events.find((e) => e.type === "session.started")!;
    expect((session as { sessionId: string }).sessionId).toMatch(/\/fake\/pi-session-\d+\.json/);

    const text = recorder.events.find(
      (e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text",
    )!;
    expect((text as { text: string }).text).toBe("Hello from pi");

    const done = recorder.events.at(-1)!;
    expect(done).toMatchObject({ type: "turn.completed", ok: true, stopReason: "end_turn", usage: { input: 12, output: 3 } });
    expect(instance.adapter.hasSession("t-happy")).toBe(false);
  });

  it("reassembles chunked turn frames from a protocol-v2 runtime", async () => {
    await create("omp-chunk");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-omp-chunk", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    const text = recorder.events.find(
      (e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text",
    )!;
    expect((text as { text: string }).text).toBe("Hello from pi");
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true, stopReason: "end_turn" });
  });

  it("sends images as native base64 prompt content without copying bytes into diagnostics", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-image-"));
    const dump = join(dir, "dump.jsonl");
    const imagePath = join(dir, "tiny.png");
    const bytes = Buffer.from("private-image-bytes");
    const base64 = bytes.toString("base64");
    writeFileSync(imagePath, bytes);
    await create(undefined, { FAKE_PI_DUMP: dump });

    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-pi-native-image",
      text: "What is this?",
      images: [{ path: imagePath, mime: "image/png", bytes: bytes.length }],
    });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);

    const rows = readFileSync(dump, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { prompt?: { message?: string; images?: unknown[] } });
    expect(rows.find((row) => row.prompt)?.prompt).toEqual({
      message: "What is this?",
      images: [{ type: "image", data: base64, mimeType: "image/png" }],
    });

    const nativeLog = readFileSync(join(NATIVE_DIR, "t-pi-native-image.ndjson"), "utf8");
    expect(nativeLog).not.toContain(base64);
    expect(nativeLog).toContain(`[image data: ${base64.length} base64 chars]`);
  });

  it("resumes a prior pi session using the sessionFile resume cursor", async () => {
    await create();
    const first = await instance.adapter.sendTurn({ threadId: "t-resume", text: "first" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    const firstSession = recorder.events.find((e) => e.type === "session.started" && e.turnId === first.turnId) as
      | { sessionId: string }
      | undefined;
    expect(firstSession?.sessionId).toMatch(/\/fake\/pi-session-\d+\.json/);

    const second = await instance.adapter.sendTurn({
      threadId: "t-resume",
      text: "second",
      resumeCursor: firstSession!.sessionId,
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    const secondSession = recorder.events.find((e) => e.type === "session.started" && e.turnId === second.turnId) as
      | { sessionId: string }
      | undefined;
    expect(secondSession?.sessionId).toBe(firstSession?.sessionId);
  });

  it("respawns when the approval mode changes, so a stale grant is never reused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-approval-"));
    const dump = join(dir, "dump.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    writeFileSync(dump, "");
    const rows = () =>
      readFileSync(dump, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const spawns = () => rows().filter((row) => "argv" in row).length;
    const threadId = "t-pi-approval-" + randomUUID();

    const first = await instance!.adapter.sendTurn({ threadId, text: "first", approvalMode: "full" });
    await recorder!.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    expect(spawns()).toBe(1);

    // The MCP extension reads the approval mode at boot: a turn under a
    // different policy must get its own child, never the previous grant.
    const second = await instance!.adapter.sendTurn({ threadId, text: "second", approvalMode: "ask" });
    await recorder!.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    expect(spawns()).toBe(2);
  });

  it("keeps one child for a follow-up turn instead of paying pi's boot again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-pool-"));
    const dump = join(dir, "dump.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    // create() probes the catalog in its own short-lived child; the dump is
    // about the turn children only.
    writeFileSync(dump, "");
    const rows = () =>
      readFileSync(dump, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const spawns = () => rows().filter((row) => "argv" in row).length;
    const threadId = "t-pi-pool-" + randomUUID();

    const first = await instance.adapter.sendTurn({ threadId, text: "first", model: "ollama-cloud/glm-5.2" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    const firstSession = recorder.events.find((e) => e.type === "session.started" && e.turnId === first.turnId) as {
      sessionId: string;
    };
    expect(spawns()).toBe(1);
    expect(rows().filter((row) => row.newSession)).toHaveLength(1);

    const second = await instance.adapter.sendTurn({
      threadId,
      text: "second",
      model: "ollama-cloud/glm-5.2",
      resumeCursor: firstSession.sessionId,
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);

    // One process, one handshake: the session was already open in the child.
    expect(spawns()).toBe(1);
    expect(rows().filter((row) => row.newSession)).toHaveLength(1);
    expect(rows().filter((row) => row.switchSession)).toHaveLength(0);
    // The pool path still announces the session, so the harness cursor stays
    // authoritative for the next turn.
    const secondSession = recorder.events.find((e) => e.type === "session.started" && e.turnId === second.turnId) as {
      sessionId: string;
    };
    expect(secondSession.sessionId).toBe(firstSession.sessionId);
  });

  it("respawns the child when the spawn contract changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-respawn-"));
    const dump = join(dir, "dump.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    // create() probes the catalog in its own short-lived child; the dump is
    // about the turn children only.
    writeFileSync(dump, "");
    const rows = () =>
      readFileSync(dump, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const threadId = "t-pi-respawn-" + randomUUID();

    const first = await instance.adapter.sendTurn({ threadId, text: "first", model: "ollama-cloud/glm-5.2" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    const firstSession = recorder.events.find((e) => e.type === "session.started" && e.turnId === first.turnId) as {
      sessionId: string;
    };

    // A different model changes the inject file the child booted with, so the
    // old process must not be reused — and the new one resumes by cursor.
    const second = await instance.adapter.sendTurn({
      threadId,
      text: "second",
      model: "openai/gpt-4o",
      resumeCursor: firstSession.sessionId,
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);

    expect(rows().filter((row) => "argv" in row)).toHaveLength(2);
    expect(rows().filter((row) => row.switchSession)).toEqual([{ switchSession: firstSession.sessionId }]);
  });

  it("respawns after an explicit session reset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-reset-"));
    const dump = join(dir, "dump.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    // create() probes the catalog in its own short-lived child; the dump is
    // about the turn children only.
    writeFileSync(dump, "");
    const rows = () =>
      readFileSync(dump, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const threadId = "t-pi-reset-" + randomUUID();

    const first = await instance.adapter.sendTurn({ threadId, text: "first" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    const second = await instance.adapter.sendTurn({ threadId, text: "second", sessionReset: true });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);

    expect(rows().filter((row) => "argv" in row)).toHaveLength(2);
    // A reset starts a new session rather than resuming the old one.
    expect(rows().filter((row) => row.newSession)).toHaveLength(2);
    expect(rows().filter((row) => row.switchSession)).toHaveLength(0);
  });

  it("hands a prewarmed child to the matching turn instead of spawning again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-prewarm-"));
    const dump = join(dir, "dump.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    await instance.startupModelRefresh;
    writeFileSync(dump, "");
    const rows = () =>
      readFileSync(dump, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const spawns = () => rows().filter((row) => "argv" in row);
    const threadId = "t-pi-prewarm-" + randomUUID();

    instance.adapter.prewarm?.({ threadId, model: "ollama-cloud/glm-5.2" });
    // The boot really overlapped setup: the child exists before its turn arrives.
    await vi.waitFor(() => expect(spawns()).toHaveLength(1));
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "hi", model: "ollama-cloud/glm-5.2" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(spawns()).toHaveLength(1);
  });

  it("kills a prewarmed child whose contract the turn no longer matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-prewarm-mismatch-"));
    const dump = join(dir, "dump.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    await instance.startupModelRefresh;
    writeFileSync(dump, "");
    const rows = () =>
      readFileSync(dump, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const spawns = () => rows().filter((row) => "argv" in row);
    const threadId = "t-pi-prewarm-mismatch-" + randomUUID();

    instance.adapter.prewarm?.({ threadId, model: "ollama-cloud/glm-5.2" });
    // The fake's node boot is ~300 ms on an idle machine and longer on a shard running several files at once: the
    // child's argv row is the only sign it launched, so wait past that.
    await vi.waitFor(() => expect(spawns()).toHaveLength(1), { timeout: 10_000 });
    const pid = spawns()[0].pid as number;
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "hi", model: "openai/gpt-4o" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    // The mismatched child was never handed a prompt: it is killed, and the turn boots its own.
    expect(spawns()).toHaveLength(2);
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    expect(rows().some((row) => "prompt" in row)).toBe(true);
  });

  it("expires a prewarmed child its turn never claimed, and removes its credential dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-prewarm-expire-"));
    const dump = join(dir, "dump.jsonl");
    // An isolated TMPDIR shows the mcp temp dir appear at prewarm and disappear at expiry.
    const childTmp = join(dir, "child-tmp");
    mkdirSync(childTmp);
    const savedTtl = process.env.OMB_PI_PREWARM_MS;
    const savedTmp = process.env.TMPDIR;
    // Past the fake's node boot (~300 ms) so the child logs its argv row before the expiry lands; slow Windows
    // runners also need room for the spawn's credential dir to appear before anything is read.
    process.env.OMB_PI_PREWARM_MS = "4000";
    process.env.TMPDIR = childTmp;
    try {
      await create(undefined, { FAKE_PI_DUMP: dump });
      await instance.startupModelRefresh;
      writeFileSync(dump, "");
      const rows = () =>
        readFileSync(dump, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      const spawns = () => rows().filter((row) => "argv" in row);
      const mcpDirs = () => readdirSync(childTmp).filter((name) => name.startsWith("omb-pi-mcp-"));
      const threadId = "t-pi-prewarm-expire-" + randomUUID();

      instance.adapter.prewarm?.({ threadId });
      // The credential dir is made with the spawn, before the child boots: poll for it rather than reading at once,
      // so a slower Windows runner's file system cannot race the read — still well before the expiry above.
      await vi.waitFor(() => expect(mcpDirs()).toHaveLength(1), { timeout: 2_500 });
      await vi.waitFor(() => expect(spawns()).toHaveLength(1), { timeout: 10_000 });
      const pid = spawns()[0].pid as number;
      // sendTurn never ran: the expiry killed the child and removed its credential dir.
      await vi.waitFor(() => {
        expect(() => process.kill(pid, 0)).toThrow();
        expect(mcpDirs()).toHaveLength(0);
      }, { timeout: 10_000 });
      const { turnId } = await instance.adapter.sendTurn({ threadId, text: "hi" });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      expect(spawns()).toHaveLength(2);
    } finally {
      if (savedTtl === undefined) delete process.env.OMB_PI_PREWARM_MS;
      else process.env.OMB_PI_PREWARM_MS = savedTtl;
      if (savedTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmp;
    }
  });

  it("prewarms nothing while a matching warm child can serve the turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-prewarm-warm-"));
    const dump = join(dir, "dump.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    await instance.startupModelRefresh;
    writeFileSync(dump, "");
    const rows = () =>
      readFileSync(dump, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const spawns = () => rows().filter((row) => "argv" in row);
    const threadId = "t-pi-prewarm-warm-" + randomUUID();

    const first = await instance.adapter.sendTurn({ threadId, text: "first" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    expect(spawns()).toHaveLength(1);
    instance.adapter.prewarm?.({ threadId });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(spawns()).toHaveLength(1);
  });

  it("prewarms nothing for a session-reset turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-prewarm-reset-"));
    const dump = join(dir, "dump.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    await instance.startupModelRefresh;
    writeFileSync(dump, "");
    const rows = () =>
      readFileSync(dump, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const spawns = () => rows().filter((row) => "argv" in row);
    const threadId = "t-pi-prewarm-reset-" + randomUUID();

    instance.adapter.prewarm?.({ threadId, sessionReset: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(spawns()).toHaveLength(0);
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "hi", sessionReset: true });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(spawns()).toHaveLength(1);
  });

  it("delivers the full prompt once per session and rides volatile changes as notes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-split-"));
    const dump = join(dir, "dump.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    // Receipts are keyed by thread and session file, so a unique thread keeps the run hermetic.
    const threadId = "t-pi-prompt-split-" + randomUUID();
    const prompts = () =>
      readFileSync(dump, "utf8").split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as { prompt?: { message?: string } })
        .filter((row) => row.prompt).map((row) => row.prompt!.message!);
    const send = async (text: string, volatile: string, cursor?: string) => {
      const { turnId } = await instance.adapter.sendTurn({
        threadId,
        text,
        system: "Standing rules.\n\n" + volatile,
        systemStable: "Standing rules.",
        systemVolatile: volatile,
        ...(cursor ? { resumeCursor: cursor } : {}),
      });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      const session = recorder.events.find((e) => e.type === "session.started" && e.turnId === turnId) as { sessionId: string };
      return { message: prompts().at(-1)!, cursor: session.sessionId };
    };

    const first = await send("first", "Memory: likes quiet hours.");
    expect(first.message).toBe("Standing rules.\n\nMemory: likes quiet hours.\n\nfirst");
    const second = await send("second", "Memory: likes quiet hours.", first.cursor);
    expect(second.message).toBe("second");
    const third = await send("third", "Memory: moved to Toronto.", first.cursor);
    expect(third.message)
      .toBe("Context from Luna Bot updated since this conversation started; it replaces any earlier copy:\n\nMemory: moved to Toronto.\n\nthird");
  });

  it("re-establishes the full prompt after pi compaction summarizes the session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-compaction-"));
    const dump = join(dir, "dump.jsonl");
    await create("compaction", { FAKE_PI_DUMP: dump });
    // Receipts are keyed by thread and session file, so a unique thread keeps the run hermetic.
    const threadId = "t-pi-compaction-" + randomUUID();
    const prompts = () =>
      readFileSync(dump, "utf8").split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as { prompt?: { message?: string } })
        .filter((row) => row.prompt).map((row) => row.prompt!.message!);
    const send = async (text: string, cursor?: string) => {
      const { turnId } = await instance.adapter.sendTurn({
        threadId,
        text,
        system: "Standing rules.\n\nMemory: likes quiet hours.",
        systemStable: "Standing rules.",
        systemVolatile: "Memory: likes quiet hours.",
        ...(cursor ? { resumeCursor: cursor } : {}),
      });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      const session = recorder.events.find((e) => e.type === "session.started" && e.turnId === turnId) as { sessionId: string };
      return { message: prompts().at(-1)!, cursor: session.sessionId };
    };

    const first = await send("first");
    expect(first.message).toBe("Standing rules.\n\nMemory: likes quiet hours.\n\nfirst");
    const second = await send("second", first.cursor);
    expect(second.message).toBe("Standing rules.\n\nMemory: likes quiet hours.\n\nsecond");
    // Each turn condensed the session once; the chat marks each one.
    const mine = recorder.events.filter((e) => e.threadId === threadId);
    expect(mine.filter((e) => e.type === "context.compacted")).toHaveLength(2);
    // Text streamed before the compaction is saved ahead of the marker, not joined to later text.
    const before = mine.findIndex((e) => e.type === "item.completed" && (e as { text?: string }).text === "before");
    expect(before).toBeGreaterThan(-1);
    expect(before).toBeLessThan(mine.findIndex((e) => e.type === "context.compacted"));
  });

  it("adds no condensed marker when pi's compaction fails or is skipped", async () => {
    await create("compaction", { FAKE_PI_COMPACTION_FAILS_ONLY: "1" });
    const threadId = "t-pi-compaction-fails-" + randomUUID();
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "first", system: "Standing rules." });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(recorder.events.filter((e) => e.type === "context.compacted" && e.threadId === threadId)).toHaveLength(0);
  });

  it("keeps pi alive through post-run compaction recovery and re-establishes the full prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-compaction-recovery-"));
    const dump = join(dir, "dump.jsonl");
    await create("compaction-recovery", { FAKE_PI_DUMP: dump });
    const threadId = "t-pi-compaction-recovery-" + randomUUID();
    const prompts = () =>
      readFileSync(dump, "utf8").split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as { prompt?: { message?: string } })
        .filter((row) => row.prompt).map((row) => row.prompt!.message!);
    const send = async (text: string, cursor?: string) => {
      const { turnId } = await instance.adapter.sendTurn({
        threadId,
        text,
        system: "Standing rules.\n\nMemory: likes quiet hours.",
        systemStable: "Standing rules.",
        systemVolatile: "Memory: likes quiet hours.",
        ...(cursor ? { resumeCursor: cursor } : {}),
      });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      const session = recorder.events.find((e) => e.type === "session.started" && e.turnId === turnId) as { sessionId: string };
      return { message: prompts().at(-1)!, cursor: session.sessionId };
    };

    const first = await send("first");
    expect(first.message).toBe("Standing rules.\n\nMemory: likes quiet hours.\n\nfirst");
    const second = await send("second", first.cursor);
    expect(second.message).toBe("Standing rules.\n\nMemory: likes quiet hours.\n\nsecond");
  });

  it("honors upstream willRetry agent_end frames through post-run compaction recovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-compaction-recovery-upstream-"));
    const dump = join(dir, "dump.jsonl");
    await create("compaction-recovery-upstream", { FAKE_PI_DUMP: dump });
    const threadId = "t-pi-compaction-recovery-upstream-" + randomUUID();
    const prompts = () =>
      readFileSync(dump, "utf8").split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as { prompt?: { message?: string } })
        .filter((row) => row.prompt).map((row) => row.prompt!.message!);
    const send = async (text: string, cursor?: string) => {
      const { turnId } = await instance.adapter.sendTurn({
        threadId,
        text,
        system: "Standing rules.\n\nMemory: likes quiet hours.",
        systemStable: "Standing rules.",
        systemVolatile: "Memory: likes quiet hours.",
        ...(cursor ? { resumeCursor: cursor } : {}),
      });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      const session = recorder.events.find((e) => e.type === "session.started" && e.turnId === turnId) as { sessionId: string };
      return { message: prompts().at(-1)!, cursor: session.sessionId };
    };

    const first = await send("first");
    expect(first.message).toBe("Standing rules.\n\nMemory: likes quiet hours.\n\nfirst");
    const second = await send("second", first.cursor);
    expect(second.message).toBe("Standing rules.\n\nMemory: likes quiet hours.\n\nsecond");
  });

  it("re-anchors the full prompt after eight bare turns on one session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-reanchor-"));
    const dump = join(dir, "dump.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    const threadId = "t-pi-reanchor-" + randomUUID();
    const messages: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const { turnId } = await instance.adapter.sendTurn({
        threadId,
        text: "turn " + i,
        system: "Standing rules.\n\nMemory: likes quiet hours.",
        systemStable: "Standing rules.",
        systemVolatile: "Memory: likes quiet hours.",
        ...(cursor ? { resumeCursor: cursor } : {}),
      });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      const session = recorder.events.find((e) => e.type === "session.started" && e.turnId === turnId) as { sessionId: string };
      cursor ??= session.sessionId;
      const row = readFileSync(dump, "utf8").split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as { prompt?: { message?: string } })
        .filter((r) => r.prompt).at(-1);
      messages.push(row!.prompt!.message!);
    }
    const full = "Standing rules.\n\nMemory: likes quiet hours.";
    expect(messages[0]).toBe(full + "\n\nturn 0");
    for (let i = 1; i <= 8; i++) expect(messages[i]).toBe("turn " + i);
    expect(messages[9]).toBe(full + "\n\nturn 9");
  });

  it("fails the turn and writes no receipt when pi rejects the prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-prompt-reject-"));
    const dump = join(dir, "dump.jsonl");
    await create("prompt-reject", { FAKE_PI_DUMP: dump });
    const threadId = "t-pi-prompt-reject-" + randomUUID();
    const { turnId } = await instance.adapter.sendTurn({
      threadId,
      text: "first",
      system: "Standing rules.\n\nMemory: likes quiet hours.",
      systemStable: "Standing rules.",
      systemVolatile: "Memory: likes quiet hours.",
    });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(done).toMatchObject({ ok: false, stopReason: "failed" });
    expect(recorder.events.find((e) => e.type === "runtime.error")).toMatchObject({
      message: "pi prompt failed",
    });
    recorder.stop();
    await instance.dispose();
    await create(undefined, { FAKE_PI_DUMP: dump });
    const second = await instance.adapter.sendTurn({
      threadId,
      text: "second",
      system: "Standing rules.\n\nMemory: likes quiet hours.",
      systemStable: "Standing rules.",
      systemVolatile: "Memory: likes quiet hours.",
      resumeCursor: "/fake/pi-session-1.json",
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    const row = readFileSync(dump, "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { prompt?: { message?: string } })
      .filter((r) => r.prompt).at(-1);
    expect(row?.prompt?.message).toBe("Standing rules.\n\nMemory: likes quiet hours.\n\nsecond");
  });

  it("keeps the full prompt when no session could be established", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-split-error-"));
    const dump = join(dir, "dump.jsonl");
    await create("session-error", { FAKE_PI_DUMP: dump });
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-pi-prompt-split-error-" + randomUUID(),
      text: "bare",
      system: "Standing rules.\n\nMemory: likes quiet hours.",
      systemStable: "Standing rules.",
      systemVolatile: "Memory: likes quiet hours.",
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    const message = readFileSync(dump, "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { prompt?: { message?: string } })
      .find((row) => row.prompt)?.prompt?.message;
    expect(message).toBe("Standing rules.\n\nMemory: likes quiet hours.\n\nbare");
  });

  it("waits for a slow new_session reply before it sends the prompt, and says so in the chat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-session-slow-"));
    const dump = join(dir, "dump.jsonl");
    await create("session-slow", { FAKE_PI_DUMP: dump });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const sent = instance.adapter.sendTurn({ threadId: "t-pi-session-slow-" + randomUUID(), text: "hi", model: "openai/gpt-4o" });
      await recorder.until((e) => e.type === "turn.started");
      await vi.advanceTimersByTimeAsync(20_001);
      const { turnId } = await sent;
      const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      expect(done).toMatchObject({ ok: true });
      const order = readFileSync(dump, "utf8").split("\n").filter(Boolean)
        .map((line) => Object.keys(JSON.parse(line) as object).find((key) => key !== "pid"))
        .filter((key) => key !== undefined && ["sessionReplied", "setModel", "prompt"].includes(key));
      expect(order).toEqual(["sessionReplied", "setModel", "prompt"]);
      expect(recorder.events.find((e) => e.type === "runtime.notice" && e.turnId === turnId)).toMatchObject({ message: expect.stringMatching(/Pi is taking longer than usual/) });
    } finally {
      vi.useRealTimers();
      removeTempDir(dir);
    }
  });

  it("stops waiting for the session reply when the turn is stopped, and sends nothing after", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-session-stop-"));
    const dump = join(dir, "dump.jsonl");
    await create("session-slow", { FAKE_PI_DUMP: dump, FAKE_PI_SESSION_DELAY_MS: "60000" });
    const threadId = "t-pi-session-stop-" + randomUUID();
    const sent = instance.adapter.sendTurn({ threadId, text: "hi", model: "openai/gpt-4o" });
    await recorder.until((e) => e.type === "turn.started");
    await instance.adapter.interruptTurn(threadId);
    const { turnId } = await sent;
    expect(recorder.events.find((e) => e.type === "turn.completed" && e.turnId === turnId)).toMatchObject({ stopReason: "cancelled" });
    const rows = readFileSync(dump, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as object);
    expect(rows.some((row) => "setModel" in row || "prompt" in row)).toBe(false);
    removeTempDir(dir);
  });

  it("fails promptly when the pi process exits before replying", async () => {
    await create("exit-early");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-exit", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(done).toMatchObject({ ok: false, stopReason: "failed" });
    expect(instance.adapter.hasSession("t-exit")).toBe(false);
  });

  it("surfaces a pi turn error instead of reporting an empty success", async () => {
    await create("turn-error");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-turn-error", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(done).toMatchObject({ ok: false, stopReason: "failed", usage: { input: 0, output: 0 } });
    expect(recorder.events.find((e) => e.type === "runtime.error")).toMatchObject({
      message: "Invalid schema for function 'computer_browser_prepare'",
    });
    expect(instance.adapter.hasSession("t-turn-error")).toBe(false);
  });

  it("advertises images and every harness effort level", async () => {
    await create();
    expect(instance.adapter.capabilities.images).toBe(true);
    expect(instance.adapter.capabilities.effortLevels).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  });

  it("pins reasoning effort via set_thinking_level after the model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-effort-"));
    const dump = join(dir, "dump.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-effort",
      text: "hi",
      model: "ollama-cloud/glm-5.2",
      effort: "high",
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    const levels = readFileSync(dump, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { thinkingLevel?: string })
      .filter((record) => record.thinkingLevel !== undefined)
      .map((record) => record.thinkingLevel!);
    expect(levels).toEqual(["high"]);
  });

  it("maps the none effort to pi's off and sends nothing without effort", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-effort-"));
    const dump = join(dir, "dump.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    const none = await instance.adapter.sendTurn({ threadId: "t-none", text: "hi", effort: "none" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === none.turnId);
    const plain = await instance.adapter.sendTurn({ threadId: "t-plain", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === plain.turnId);
    const levels = readFileSync(dump, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { thinkingLevel?: string })
      .filter((record) => record.thinkingLevel !== undefined)
      .map((record) => record.thinkingLevel!);
    expect(levels).toEqual(["off"]);
  });

  it("scrubs provider and workspace credentials from every pi child env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-dump-"));
    const dump = join(dir, "dump.jsonl");
    // The leak path is `...process.env`, not just input.environment.
    const savedBoat = process.env.BOX_TOKEN;
    const savedXai = process.env.XAI_API_KEY;
    process.env.BOX_TOKEN = "boat-secret-value";
    process.env.XAI_API_KEY = "xai-secret-value";
    try {
      await create(undefined, {
        FAKE_PI_DUMP: dump,
        ANTHROPIC_API_KEY: "anthropic-secret-value",
        OPENAI_API_KEY: "openai-secret-value",
      });
      await instance.dispose();
    } finally {
      if (savedBoat === undefined) delete process.env.BOX_TOKEN;
      else process.env.BOX_TOKEN = savedBoat;
      if (savedXai === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = savedXai;
    }

    const rows = readFileSync(dump, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[]; envConfigured: string[] });
    expect(rows.some((row) => row.argv.join(" ") === "--mode rpc --no-session")).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.envConfigured).toContain("PATH");
      expect(row.envConfigured).not.toContain("ANTHROPIC_API_KEY");
      expect(row.envConfigured).not.toContain("OPENAI_API_KEY");
      expect(row.envConfigured).not.toContain("XAI_API_KEY");
      expect(row.envConfigured).not.toContain("BOX_TOKEN");
    }
    expect(JSON.stringify(rows)).not.toContain("anthropic-secret-value");
    expect(JSON.stringify(rows)).not.toContain("openai-secret-value");
  });

  it("loads the extension's ask_user on a plain turn unless the tool selection excludes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-ask-user-"));
    const dump = join(dir, "dump.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-ask-user", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    await expect(instance.adapter.sendTurn({ threadId: "t-ask-user-scoped", text: "hi", toolScope: { allow: ["native:read"] } })).rejects.toThrow(/enforcement/i);
    const rows = readFileSync(dump, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { argv?: string[]; mcpConfig?: { askUser?: boolean; mcpServers?: object } | null })
      .filter((row) => row.argv?.includes("-e"));
    expect(rows.map((row) => row.mcpConfig?.askUser)).toEqual([true, false]);
    expect(rows[0].mcpConfig?.mcpServers).toEqual({});
    await removeTempDir(dir);
  });

  it("mounts integrations as stdio MCP servers and loads the pi-mcp-extension", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-mcp-dump-"));
    const dump = join(dir, "dump.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-mcp",
      text: "hi",
      integrations: {
        composio: { command: "node", args: ["connector-proxy.js"], env: { COMPOSIO_KEY: "ck" } },
      },
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    const rows = readFileSync(dump, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[]; mcpConfig?: { mcpServers?: Record<string, any> } | null });
    const mcpRow = rows.find((r) => r.mcpConfig != null);
    expect(mcpRow).toBeTruthy();

    const extIndex = mcpRow!.argv.indexOf("-e");
    expect(extIndex).toBeGreaterThanOrEqual(0);
    expect(mcpRow!.argv[extIndex + 1]).toContain("pi-mcp-extension");

    const servers = mcpRow!.mcpConfig!.mcpServers!;
    expect(servers.composio).toMatchObject({ command: "node", args: ["connector-proxy.js"], env: { COMPOSIO_KEY: "ck" } });
  });

  it("reports pi's priced cost and cached tokens summed over the whole run", async () => {
    await create("priced");
    await instance.adapter.sendTurn({ threadId: "t-priced", text: "run it", model: "synthetic/hf:moonshotai/Kimi-K3" });
    const done = await recorder.until((e) => e.type === "turn.completed");

    expect(done).toMatchObject({ ok: true });
    // input counts every prompt token, cached ones included, as the other drivers do.
    expect((done as { usage: unknown }).usage).toEqual({ input: 257, output: 3, cachedInput: 220 });
    expect((done as { cost: number }).cost).toBeCloseTo(0.0025, 10);
  });

  it("books a model call's cost when the turn is stopped while its tool runs", async () => {
    await create("priced-stop");
    await instance.adapter.sendTurn({ threadId: "t-priced-stop", text: "run it", model: "synthetic/hf:moonshotai/Kimi-K3" });
    await recorder.until((e) => e.type === "item.started");
    await instance.adapter.interruptTurn("t-priced-stop");
    const done = await recorder.until((e) => e.type === "turn.completed");

    expect(done).toMatchObject({ ok: true, stopReason: "cancelled", usage: { input: 125, output: 1, cachedInput: 100 } });
    expect((done as { cost: number }).cost).toBeCloseTo(0.0021, 10);
  });

  it("rides the toolUse auto-continue and only settles on the final end_turn", async () => {
    await create("tooluse");
    await instance.adapter.sendTurn({ threadId: "t-tool", text: "run it" });
    const done = await recorder.until((e) => e.type === "turn.completed");

    expect(recorder.events.filter((e) => e.type === "item.started").length).toBe(1);
    expect(recorder.events.filter((e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "tool").length).toBe(1);
    expect(recorder.events.find((event) => event.type === "item.started")).toMatchObject({ summary: "echo hi", input: expect.stringContaining("echo hi") });
    expect(recorder.events.find((event) => event.type === "item.completed" && event.itemType === "tool")).toMatchObject({ output: expect.stringContaining('"text": "hi"') });
    expect(JSON.stringify(recorder.events)).not.toContain("pi-input-secret");
    expect(JSON.stringify(recorder.events)).not.toContain("pi-output-secret");
    expect(done).toMatchObject({ ok: true, stopReason: "end_turn" });
    expect((done as { usage: { input: number; output: number } }).usage).toEqual({ input: 17, output: 3 });
    const text = recorder.events.find(
      (e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text",
    ) as { text: string } | undefined;
    expect(text?.text).toBe("done");
    expect(instance.adapter.hasSession("t-tool")).toBe(false);
  });

  it("attaches an image a tool returned to the turn", async () => {
    await create("image-tool");
    await instance.adapter.sendTurn({ threadId: "t-image", text: "chart it" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(recorder.events.find((e) => e.type === "item.completed" && e.itemType === "assistant_image"))
      .toMatchObject({ fromTool: true, data: expect.stringContaining("iVBORw0KGgo") });
    expect(recorder.events.find((e) => e.type === "item.completed" && e.itemType === "tool")).toMatchObject({ ok: true });
  });

  it("emits each assistant text block before the tool that follows it", async () => {
    await create("interleave");
    await instance.adapter.sendTurn({ threadId: "t-interleave", text: "go", model: "ollama-cloud/glm-5.2" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.completed",
      "item.started",
      "item.completed",
      "content.delta",
      "item.completed",
      "item.started",
      "item.completed",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    const texts = recorder.events
      .filter((e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text")
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["before one", "before two", "after"]);
  });

  it("brokers a permission ask through request.opened → respondToRequest", async () => {
    await create("permission");
    await instance.adapter.sendTurn({ threadId: "t-perm", text: "go" });
    await recorder.until((e) => e.type === "request.opened");
    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(true);

    const outcome = await instance.adapter.respondToRequest("t-perm", "ask-1", { behavior: "allow" });
    expect(outcome).toBe("allowed-once");

    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: "end_turn" });
    expect(recorder.events.some((e) => e.type === "request.resolved")).toBe(true);
  });

  it("surfaces a gated confirm's detail, tool name and bash command for exact grants", async () => {
    await create(undefined, {
      FAKE_PI_PERMISSION_ON: "perm-marker",
      FAKE_PI_CONFIRM_TITLE: "Allow bash?",
      FAKE_PI_CONFIRM_MESSAGE: JSON.stringify({ command: "echo hi" }),
    });
    const cwd = mkdtempSync(join(tmpdir(), "omb-pi-cwd-"));
    try {
      await instance.adapter.sendTurn({ threadId: "t-perm-gated", text: "perm-marker", cwd });
      const opened = await recorder.until((e) => e.type === "request.opened");
      expect(opened).toMatchObject({
        requestType: "permission",
        tool: "bash",
        summary: expect.stringContaining("echo hi"),
        command: { command: "echo hi", cwd },
        commandLine: "echo hi",
      });
    } finally {
      removeTempDir(cwd);
    }
  });

  it("per-bot Ask restores host approval on a legacy full-auto instance", async () => {
    await create("permission", {}, true);
    expect(instance.adapter.capabilities.localComputerMcp).toBe(true);
    const localComputer = {
      command: "/cua-driver",
      args: ["mcp"],
      env: {},
      platform: "linux" as const,
      scope: "local-computer" as const,
    };

    await expect(instance.adapter.sendTurn({
      threadId: "t-pi-legacy-full-auto",
      text: "go",
      integrations: { localComputer },
    })).rejects.toThrow(/interactive approval broker/);

    await instance.adapter.sendTurn({
      threadId: "t-pi-ask-override",
      text: "go",
      approvalMode: "ask",
      integrations: { localComputer },
    });
    const opened = await recorder.until((e) => e.type === "request.opened");
    await instance.adapter.respondToRequest(
      "t-pi-ask-override",
      (opened as { requestId: string }).requestId,
      { behavior: "allow" },
    );
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("registers an ask before emitting it so synchronous auto-approval works", async () => {
    await create("permission");
    let unsubscribe = () => {};
    const outcome = new Promise<string>((resolve) => {
      unsubscribe = instance.adapter.onEvent((event) => {
        if (event.type !== "request.opened" || !event.requestId) return;
        // Like the harness's auto-approve listener, which emit() invokes synchronously.
        void instance.adapter
          .respondToRequest(event.threadId, event.requestId, { behavior: "allow" })
          .then(resolve);
      });
    });
    await instance.adapter.sendTurn({ threadId: "t-sync-auto", text: "go" });
    expect(await outcome).toBe("allowed-once");
    unsubscribe();
    const done = await recorder.until((event) => event.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: "end_turn" });
  });

  it("renders a select ask as a question with choices and returns the picked value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-question-"));
    const dump = join(dir, "dump.jsonl");
    await create("question-select", { FAKE_PI_DUMP: dump });
    await instance.adapter.sendTurn({ threadId: "t-pi-select", text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({
      requestType: "question",
      summary: "Which color?",
      choices: ["Blue", "Green"],
      questions: [{ question: "Which color?", options: [{ label: "Blue" }, { label: "Green" }] }],
    });
    // Exactly what the tabbed QuestionCard submits: one Q:/A: block, not a bare option label.
    const outcome = await instance.adapter.respondToRequest("t-pi-select", (opened as { requestId: string }).requestId, {
      behavior: "answer",
      message: "The user answered your questions.\n\nQ: Which color?\nA: Green",
    });
    expect(outcome).toBe("answered");
    await recorder.until((e) => e.type === "turn.completed");
    const rows = readFileSync(dump, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { uiResponse?: { id?: string; value?: string; cancelled?: boolean } });
    expect(rows.find((row) => row.uiResponse)?.uiResponse).toMatchObject({ id: "ask-select", value: "Green" });
  });

  it("returns typed text verbatim for a free-text input ask", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-input-"));
    const dump = join(dir, "dump.jsonl");
    await create("question-input", { FAKE_PI_DUMP: dump });
    await instance.adapter.sendTurn({ threadId: "t-pi-input", text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "question", summary: "Which city?" });
    expect(opened).not.toHaveProperty("choices");
    await instance.adapter.respondToRequest("t-pi-input", (opened as { requestId: string }).requestId, {
      behavior: "answer",
      message: "  Toronto  ",
    });
    await recorder.until((e) => e.type === "turn.completed");
    const rows = readFileSync(dump, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { uiResponse?: { id?: string; value?: string } });
    expect(rows.find((row) => row.uiResponse)?.uiResponse).toMatchObject({ id: "ask-input", value: "  Toronto  " });
  });

  it.each([false, true])("returns original capped options, refusing ambiguous display labels (%s)", async collision => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-capped-question-"));
    const dump = join(dir, "dump.jsonl");
    const label = "  Green ".repeat(30);
    await create("question-select", { FAKE_PI_DUMP: dump,
      FAKE_PI_QUESTION_OPTIONS: JSON.stringify([label, collision ? label + "other" : "Blue"]) });
    await instance.adapter.sendTurn({ threadId: "t-pi-capped", text: "go" });
    const opened = await recorder.until(e => e.type === "request.opened");
    await instance.adapter.respondToRequest("t-pi-capped", (opened as { requestId: string }).requestId, {
      behavior: "answer", message: `The user answered your questions.\n\nQ: Which color?\nA: ${label.trim().slice(0, 120)}`,
    });
    await recorder.until(e => e.type === "turn.completed");
    const rows = readFileSync(dump, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    expect(rows.find(row => row.uiResponse)?.uiResponse).toMatchObject(collision
      ? { id: "ask-select", cancelled: true } : { id: "ask-select", value: label });
  });

  it("denies an ask by cancelling the protocol request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-deny-"));
    const dump = join(dir, "dump.jsonl");
    await create("question-select", { FAKE_PI_DUMP: dump });
    await instance.adapter.sendTurn({ threadId: "t-pi-deny", text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    const outcome = await instance.adapter.respondToRequest("t-pi-deny", (opened as { requestId: string }).requestId, {
      behavior: "deny",
    });
    expect(outcome).toBe("rejected");
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "deny", source: "user" });
    await recorder.until((e) => e.type === "turn.completed");
    const rows = readFileSync(dump, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { uiResponse?: { id?: string; cancelled?: boolean } });
    expect(rows.find((row) => row.uiResponse)?.uiResponse).toMatchObject({ id: "ask-select", cancelled: true });
  });

  it("keeps an unanswered question open for days and still takes the person's answer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-timeout-"));
    const dump = join(dir, "dump.jsonl");
    await create("question-select", { FAKE_PI_DUMP: dump });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let opened: RuntimeEvent;
    try {
      await instance.adapter.sendTurn({ threadId: "t-pi-timeout", text: "go" });
      opened = await recorder.until((e) => e.type === "request.opened");
      await vi.advanceTimersByTimeAsync(72 * 60 * 60_000);
      expect(recorder.events.some((e) => e.type === "request.resolved")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    await instance.adapter.respondToRequest("t-pi-timeout", opened.requestId!, { behavior: "deny" });
    expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({ behavior: "deny", source: "user" });
  });

  it("respondToRequest is unavailable for an ask that is not pending", async () => {
    await create();
    await expect(instance.adapter.respondToRequest("t-none", "nope", { behavior: "allow" })).resolves.toBe("unavailable");
  });

  it("interruptTurn cancels a running turn", async () => {
    await create("permission");
    await instance.adapter.sendTurn({ threadId: "t-interrupt", text: "go" });
    await recorder.until((e) => e.type === "request.opened");
    await instance.adapter.interruptTurn("t-interrupt");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
  });

  it("writes models.json and set_model for a host::model inject pick", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-pi-turn-inject-"));
    const dump = join(home, "dump.jsonl");
    await create(undefined, { HOME: home, FAKE_PI_DUMP: dump });
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-inject",
      text: "hi",
      model: encodeInjectId("omlx", "MiniMax-M3-4bit"),
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    const dumps = readFileSync(dump, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { setModel?: { provider: string; modelId: string } });
    expect(dumps.some((row) => row.setModel?.provider === "omlx" && row.setModel?.modelId === "MiniMax-M3-4bit")).toBe(
      true,
    );
    const written = JSON.parse(readFileSync(join(home, ".pi", "instances", "pi-test", "models.json"), "utf8")) as {
      providers: { omlx: { baseUrl: string; models: Array<{ id: string }> } };
    };
    expect(written.providers.omlx.baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(written.providers.omlx.models.some((m) => m.id === "MiniMax-M3-4bit")).toBe(true);
  });
});

describe("splitPiModel", () => {
  it("splits native provider/model composites, including slashes in the model id", () => {
    expect(splitPiModel("ollama-cloud/glm-5.2")).toEqual({ provider: "ollama-cloud", modelId: "glm-5.2" });
    expect(splitPiModel("openai/gpt-4o")).toEqual({ provider: "openai", modelId: "gpt-4o" });
    expect(splitPiModel("openrouter/qwen/qwen3-coder-next")).toEqual({
      provider: "openrouter",
      modelId: "qwen/qwen3-coder-next",
    });
  });

  it("splits live-host inject ids on ::, not /", () => {
    expect(splitPiModel("omlx::MiniMax-M3-4bit")).toEqual({ provider: "omlx", modelId: "MiniMax-M3-4bit" });
    expect(splitPiModel("ollama::llama3.1:70b")).toEqual({ provider: "ollama", modelId: "llama3.1:70b" });
    expect(splitPiModel("unsloth::unsloth/gemma-4-26B-A4B-it-GGUF")).toEqual({
      provider: "unsloth",
      modelId: "unsloth/gemma-4-26B-A4B-it-GGUF",
    });
  });

  it("returns null for empty or unstructured ids", () => {
    expect(splitPiModel("")).toBeNull();
    expect(splitPiModel("glm-5.2")).toBeNull();
  });
});

describe("preferPiInjectRows", () => {
  it("drops host/model rows when the same live host::model is present", () => {
    const catalog = preferPiInjectRows({
      default: "omlx/MiniMax-M3-4bit",
      options: [
        { id: "omlx/MiniMax-M3-4bit", label: "MiniMax-M3-4bit", custom: true },
        { id: "openai/gpt-4o", label: "GPT-4o", custom: true },
        { id: "omlx::MiniMax-M3-4bit", label: "MiniMax-M3-4bit (oMLX)", custom: true, loaded: true },
      ],
    });
    expect(catalog.options.map((o) => o.id)).toEqual(["openai/gpt-4o", "omlx::MiniMax-M3-4bit"]);
    expect(catalog.default).toBe("omlx::MiniMax-M3-4bit");
  });

  it("leaves the catalog alone when there are no inject rows", () => {
    const catalog = {
      default: "omlx/keep",
      options: [{ id: "omlx/keep", label: "keep", custom: true as const }],
    };
    expect(preferPiInjectRows(catalog)).toEqual(catalog);
  });
});

describe("ensurePiInjectModel", () => {
  it("upserts a provider into ~/.pi/agent/models.json without dropping existing models", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-pi-inject-"));
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "models.json"),
      JSON.stringify({
        providers: {
          omlx: {
            baseUrl: "http://127.0.0.1:8080/v1",
            api: "openai-completions",
            apiKey: "omlx",
            compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
            models: [{ id: "keep-me", name: "Keep me", contextWindow: 8192, maxTokens: 1024 }],
          },
        },
      }),
    );
    const split = ensurePiInjectModel("omlx::MiniMax-M3-4bit", { HOME: home });
    expect(split).toEqual({ provider: "omlx", modelId: "MiniMax-M3-4bit" });
    const written = JSON.parse(readFileSync(join(home, ".pi", "agent", "models.json"), "utf8")) as {
      providers: {
        omlx: {
          baseUrl: string;
          api: string;
          apiKey: string;
          models: Array<{ id: string; contextWindow?: number }>;
        };
      };
    };
    expect(written.providers.omlx.baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(written.providers.omlx.api).toBe("openai-completions");
    expect(written.providers.omlx.apiKey).toBe("omlx");
    expect(written.providers.omlx.models.map((m) => m.id)).toEqual(["keep-me", "MiniMax-M3-4bit"]);
    expect(written.providers.omlx.models[0]).toMatchObject({ id: "keep-me", contextWindow: 8192 });
  });

  it("writes Unsloth's studio token, not the placeholder", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-pi-unsloth-"));
    const split = ensurePiInjectModel("unsloth::Qwen3.8-27B", {
      HOME: home,
      UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret",
    });
    expect(split).toEqual({ provider: "unsloth", modelId: "Qwen3.8-27B" });
    const written = JSON.parse(readFileSync(join(home, ".pi", "agent", "models.json"), "utf8")) as {
      providers: { unsloth: { apiKey: string; baseUrl: string } };
    };
    expect(written.providers.unsloth.apiKey).toBe("unsloth-secret");
    expect(written.providers.unsloth.baseUrl).toBe(localHost("unsloth")!.baseUrl);
  });

  it("leaves official slugs and the models.json file untouched", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-pi-cloud-"));
    expect(ensurePiInjectModel("openai/gpt-4o", { HOME: home })).toEqual({ provider: "openai", modelId: "gpt-4o" });
    expect(() => readFileSync(join(home, ".pi", "agent", "models.json"))).toThrow();
  });

  it("does not destroy a malformed models.json", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-pi-badjson-"));
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    const path = join(home, ".pi", "agent", "models.json");
    writeFileSync(path, "not json");
    expect(ensurePiInjectModel("omlx::MiniMax-M3-4bit", { HOME: home })).toEqual({
      provider: "omlx",
      modelId: "MiniMax-M3-4bit",
    });
    expect(readFileSync(path, "utf8")).toBe("not json");
  });
});

describe("ensurePiInstanceAgentDir", () => {
  it("seeds a per-instance dir with only the operator's auth and models, not their instructions", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-pi-instance-"));
    try {
      const operator = join(home, ".pi", "agent");
      mkdirSync(operator, { recursive: true });
      writeFileSync(join(operator, "auth.json"), '{"token":"operator"}');
      writeFileSync(join(operator, "models.json"), JSON.stringify({ providers: {} }));
      writeFileSync(join(operator, "AGENTS.md"), "operator-only instructions");
      const dir = ensurePiInstanceAgentDir("inst-one", operator, { HOME: home });
      expect(dir).toBe(join(home, ".pi", "instances", "inst-one"));
      expect(readFileSync(join(dir, "auth.json"), "utf8")).toBe('{"token":"operator"}');
      expect(existsSync(join(dir, "models.json"))).toBe(true);
      expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    } finally {
      removeTempDir(home);
    }
  });

  it("keeps an instance's own files when it already has them", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-pi-instance-own-"));
    try {
      const operator = join(home, ".pi", "agent");
      mkdirSync(operator, { recursive: true });
      writeFileSync(join(operator, "auth.json"), '{"token":"operator"}');
      const dir = ensurePiInstanceAgentDir("inst-two", operator, { HOME: home });
      writeFileSync(join(dir, "auth.json"), '{"token":"instance"}');
      expect(ensurePiInstanceAgentDir("inst-two", operator, { HOME: home })).toBe(dir);
      expect(readFileSync(join(dir, "auth.json"), "utf8")).toBe('{"token":"instance"}');
    } finally {
      removeTempDir(home);
    }
  });

  it("writes the custom provider into the instance dir, leaving the operator's models.json alone", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-pi-instance-provider-"));
    try {
      const operator = join(home, ".pi", "agent");
      mkdirSync(operator, { recursive: true });
      const operatorModels = JSON.stringify({ providers: { keep: { baseUrl: "https://operator", models: [] } } });
      writeFileSync(join(operator, "models.json"), operatorModels);
      const dir = ensurePiInstanceAgentDir("inst-three", operator, { HOME: home });
      ensurePiCustomProvider({
        HOME: home, PI_CODING_AGENT_DIR: dir,
        DEXBOT_PI_CUSTOM_BASE_URL: "https://gateway.example/v1", DEXBOT_PI_CUSTOM_MODELS: "model-a",
      });
      expect(readFileSync(join(operator, "models.json"), "utf8")).toBe(operatorModels);
      const written = JSON.parse(readFileSync(join(dir, "models.json"), "utf8")) as { providers: Record<string, { models?: Array<{ id: string }> }> };
      expect(Object.values(written.providers).some((provider) => provider.models?.some((model) => model.id === "model-a"))).toBe(true);
    } finally {
      removeTempDir(home);
    }
  });
});

describe("applyPiLocalCatalog", () => {
  it("merges live inject rows onto the probed catalog", async () => {
    const catalog = await applyPiLocalCatalog(
      {
        default: "openai/gpt-4o",
        options: [
          { id: "openai/gpt-4o", label: "GPT-4o", custom: true },
          { id: "omlx/MiniMax-M3-4bit", label: "MiniMax-M3-4bit", custom: true },
        ],
      },
      { VITEST: "true", OPENMAUSBOT_PROBE_LOCAL_INJECT: "1" },
      async (url) => {
        if (String(url).includes(":8080")) {
          return new Response(JSON.stringify({ data: [{ id: "MiniMax-M3-4bit" }] }), { status: 200 });
        }
        return new Response("nope", { status: 500 });
      },
    );
    expect(catalog.options.some((o) => o.id === "omlx::MiniMax-M3-4bit")).toBe(true);
    expect(catalog.options.some((o) => o.id === "omlx/MiniMax-M3-4bit")).toBe(false);
    expect(catalog.options.some((o) => o.id === "openai/gpt-4o")).toBe(true);
  });
});

describe("PiDriver mid-turn steer (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  const create = async (environment: Record<string, string> = {}) => {
    instance = await PiDriver.create({
      instanceId: "pi-steer-test",
      displayName: "pi Steer Test",
      environment,
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
  });

  it("declares queueing so the harness offers the mid-turn seam", async () => {
    await create();
    expect(instance.adapter.capabilities.queueing).toBe(true);
  });

  it("refuses steer on a thread with no running turn", async () => {
    await create();
    await expect(instance.adapter.steer!("t-idle", "peer context")).resolves.toBe("refused");
  });

  it("steers a running turn through the native steer frame and refuses once settled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-steer-"));
    const dump = join(dir, "dump.jsonl");
    await create({ FAKE_PI_DUMP: dump, FAKE_PI_MODE: "permission" });
    await instance.adapter.sendTurn({ threadId: "t-steer", text: "go" });
    await recorder.until((e) => e.type === "request.opened");
    const envelope = "[aside from @Peer — peer context, not steering]\nheads up\n[end aside]";
    await expect(instance.adapter.steer!("t-steer", envelope)).resolves.toBe("steered");
    const rows = readFileSync(dump, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { steer?: { id?: string; message?: string } });
    const frame = rows.find((row) => row.steer)?.steer;
    expect(frame?.message).toBe(envelope);
    expect(typeof frame?.id).toBe("string");
    await instance.adapter.respondToRequest("t-steer", "ask-1", { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");
    await expect(instance.adapter.steer!("t-steer", "late")).resolves.toBe("refused");
  });

  it("maps an explicit runtime refusal to refused so the words stay queued", async () => {
    await create({ FAKE_PI_MODE: "permission", FAKE_PI_STEER_REFUSE: "1" });
    await instance.adapter.sendTurn({ threadId: "t-refuse", text: "go" });
    await recorder.until((e) => e.type === "request.opened");
    await expect(instance.adapter.steer!("t-refuse", "peer context")).resolves.toBe("refused");
    await instance.adapter.respondToRequest("t-refuse", "ask-1", { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("correlates concurrent steers by frame id so a refusal lands only on its own caller", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-steer-"));
    const dump = join(dir, "dump.jsonl");
    await create({ FAKE_PI_DUMP: dump, FAKE_PI_MODE: "permission", FAKE_PI_STEER_OUT_OF_ORDER: "1" });
    await instance.adapter.sendTurn({ threadId: "t-race", text: "go" });
    await recorder.until((e) => e.type === "request.opened");
    // Keyed by command name alone, the first steer's refusal would reject the second caller.
    const first = instance.adapter.steer!("t-race", "first aside");
    const second = instance.adapter.steer!("t-race", "second aside");
    await expect(first).resolves.toBe("refused");
    await expect(second).resolves.toBe("steered");
    const frames = readFileSync(dump, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { steer?: { id?: string } })
      .flatMap((row) => (row.steer ? [row.steer] : []));
    expect(frames).toHaveLength(2);
    expect(new Set(frames.map((frame) => frame.id)).size).toBe(2);
    await instance.adapter.respondToRequest("t-race", "ask-1", { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");
  });
});

describe("PiDriver snapshot", () => {
  beforeEach(() => chmodSync(FAKE_CLI, 0o755));

  it("reports available with the CLI version against the fake", async () => {
    const instance = await PiDriver.create({
      instanceId: "pi-snap",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("available");
    expect(snap.version).toBe("pi 0.84.2 (fake)");
    expect(snap.authenticated).toBe(true);
    await instance.dispose();
  });

  it("reports unavailable with a reason when the CLI is missing", async () => {
    const instance = await PiDriver.create({
      instanceId: "pi-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: "pi-definitely-not-on-path-xyz", fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
    expect(snap.reason).toMatch(/not found/);
    await instance.dispose();
  });
});
