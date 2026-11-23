import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { piDumpPath, piInstructionsFor, piModelsSet, piTurns } from "./testing/pi-dump.ts";

const BOAT_TOKEN = "box_verification_fixture";
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q==", "base64");

function mcpClient(server: { command: string; args: string[]; env: Record<string, string> }) {
  const child: ChildProcessWithoutNullStreams = spawn(server.command, server.args, {
    env: { ...server.env, PATH: process.env.PATH ?? "" }, stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let nextId = 1;
  const waiting = new Map<number, (message: any) => void>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  const request = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 15_000);
    waiting.set(id, message => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await new Promise<void>(resolve => child.once("close", () => resolve()));
  };
  return { request, close };
}

it("keeps the bot's own engine on the cloud computer, and a failed place never breaks the bot", async () => {
  const rows: Array<{ id: string; name: string; state: string }> = [];
  const commands: string[] = [];
  let prompts = 0;
  let boxesCreated = 0;
  let boatCalls = 0;
  /** A new Boat whose desktop link can't be made and whose rollback delete fails, leaving a deletion fence. */
  let failNewBoat = false;
  const upstream = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    let raw = ""; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (path.startsWith("/sandboxes")) boatCalls++;
    if (path === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "tools-off-model" }] }));
    if (path === "/v1/chat/completions") {
      res.setHeader("content-type", "text/event-stream");
      return res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "Fixture reply" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    }
    // Boat's own runner: the one thing a Hosted desktop turn must never reach.
    if (path.endsWith("/prompt")) {
      prompts++;
      res.statusCode = 409;
      return res.end(JSON.stringify({ ok: false, code: "provider_not_configured", message: "Prompting is locked until Claude Code is configured on the Agents page." }));
    }
    if (path === "/sandboxes" && req.method === "POST") {
      boxesCreated++;
      const row = { id: ["bx_23456789", "bx_3456789a"][rows.length]!, name: body.name, state: "idle" }; rows.push(row);
      return res.end(JSON.stringify({ sandbox: row }));
    }
    if (path === "/sandboxes") return res.end(JSON.stringify({ sandboxes: rows }));
    if (path.endsWith("/commands")) { commands.push(String(body.command)); return res.end(JSON.stringify({ exitCode: 0, stdout: "captured", stderr: "" })); }
    if (path.endsWith("/artifacts")) { res.setHeader("content-type", "image/jpeg"); return res.end(JPEG); }
    if (path.endsWith("/desktop")) return res.end(JSON.stringify(failNewBoat ? {} : { desktopUrl: "https://desktop.fixture.invalid" }));
    const row = rows.find(entry => path === "/sandboxes/" + entry.id);
    if (row) {
      if (req.method === "DELETE" && failNewBoat) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, message: "fixture refused delete" })); }
      if (req.method === "PATCH" && typeof body.name === "string") row.name = body.name;
      return res.end(JSON.stringify({ sandbox: row }));
    }
    res.end("{}");
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("fixture failed to bind");
  const origin = `http://127.0.0.1:${address.port}`;
  const gate = join(await import("node:os").then(os => os.tmpdir()), `omb-hosted-desktop-gate-${process.pid}-${Date.now()}`);
  // Each turn uses the cloud computer as a real model would: its scripted screenshot call creates or wakes the Boat.
  // The fake pi's `slow` turn answers once the gate exists, so a turn's launch can be read while it runs.
  const fixture = await launchVerificationServer({ FAKE_PI_MODE: "slow", FAKE_PI_SLOW_FINISH_GATE: gate,
    FAKE_PI_MOUNT_TOOLS: "1", FAKE_PI_TOOL_CALLS: JSON.stringify([{ server: "computer", name: "screenshot", input: {} }]) },
    undefined, undefined, undefined, undefined, undefined, [], origin).catch(async error => {
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); throw error;
  });
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const apiOk = async (method: string, path: string, body?: unknown) => {
    const result = await api(method, path, body);
    expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBeLessThan(400);
    return result.body;
  };
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const lastRows = async (thread: string) => (await apiOk("GET", `/api/threads/${thread}/messages?limit=30`)).messages
    .filter((message: any) => message.kind !== "digest")
    .map((message: any) => message.kind === "activity" ? String(message.tool?.name) : `${message.role}:${message.kind}`);
  const task = async (botId: string, threadId: string) =>
    (await apiOk("GET", "/api/bots")).bots.find((bot: any) => bot.id === botId).tasks.find((entry: any) => entry.threadId === threadId);
  const dumpPath = piDumpPath(fixture.info.dataDir);
  /** The turn sent since `since` (or the last one) as the launch it ran on, with its instructions. */
  const dump = async (since = 0) => {
    let found: { argv: string[]; cwd?: string; envConfigured: string[]; mcpConfig: { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> }; systemPrompt: string; model?: string } | null = null;
    await expect.poll(() => {
      const turns = piTurns(dumpPath);
      const index = turns.findLastIndex((_turn, at) => at >= since);
      if (index < 0 || !turns[index]!.launch) return false;
      const launch = turns[index]!.launch!;
      const model = piModelsSet(dumpPath).at(-1);
      found = {
        argv: launch.argv,
        cwd: launch.cwd,
        envConfigured: launch.envConfigured,
        mcpConfig: { mcpServers: (launch.mcpConfig?.mcpServers ?? {}) as Record<string, { command: string; args: string[]; env: Record<string, string> }> },
        systemPrompt: piInstructionsFor(turns, index),
        model: model ? `${model.provider}/${model.modelId}` : undefined,
      };
      return true;
    }, { timeout: 15_000 }).toBe(true);
    return found!;
  };
  const finish = async (botId: string, threadId: string) => {
    writeFileSync(gate, "finish");
    expect((await control(["wait", "--bot", botId, "--task", threadId, "--timeout", "30"])).status).toBe("settled");
    rmSync(gate, { force: true });
  };
  const hostedTurn = async (botId: string, threadId: string, model: string) => {
    const since = piTurns(dumpPath).length;
    const before = commands.length;
    await control(["send", "--bot", botId, "--task", threadId, "--text", "Take a screenshot of the hosted desktop."]);
    await expect.poll(() => piTurns(dumpPath).length > since || prompts > 0, { timeout: 15_000 }).toBe(true);
    expect(prompts, "the turn was handed to Boat's own runner").toBe(0);
    const sent = await dump(since);
    expect(sent.model).toBe(model);
    expect(sent.systemPrompt).toContain("You control the assigned cloud computer");
    const computer = sent.mcpConfig.mcpServers.computer;
    expect(computer.args).toEqual([expect.stringMatching(/harness-mcp-proxy\.(?:ts|js)$/), "computer"]);
    expect(computer.env.LUNABOT_MCP_TOKEN_COMPUTER).toEqual(expect.any(String));
    expect(computer.env.LUNABOT_HARNESS_URL).toBe(fixture.info.url);
    expect(JSON.stringify(sent)).not.toContain(BOAT_TOKEN);
    // The launch carries no Cloud or Boat credential: only the names the sealed fixture keeps.
    expect(sent.envConfigured.filter(key => /BOAT|BOX_TOKEN|LUNABOT_CLOUD/.test(key))).toEqual([]);
    const client = mcpClient(computer);
    try {
      expect((await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } })).result.serverInfo.name).toBe("lunabot-computer");
      const listed = (await client.request("tools/list")).result.tools;
      expect(listed).toHaveLength(13);
      expect(listed.find((tool: { name: string }) => tool.name === "exec").description)
        .toContain("Completion does not automatically resume this turn or notify a delegator");
      const shot = await client.request("tools/call", { name: "screenshot", arguments: {} });
      expect(shot.result.content[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
      const exec = await client.request("tools/call", { name: "exec", arguments: { command: "printf hosted-desktop" } });
      expect(exec.result.isError).not.toBe(true);
      expect(commands.slice(before).some(command => command.includes(".model.jpg"))).toBe(true);
      expect(commands.slice(before).some(command => command.includes("printf hosted-desktop"))).toBe(true);
      const bad = await client.request("tools/call", { name: "click", arguments: { x: "1; touch /tmp/owned", y: 2 } });
      expect(bad.result.isError).toBe(true);
      expect(commands.slice(before).some(command => command.includes("touch /tmp/owned"))).toBe(false);
      await finish(botId, threadId);
      const afterTurn = commands.length;
      const late = await client.request("tools/call", { name: "exec", arguments: { command: "printf too-late" } });
      expect(late.result.isError).toBe(true);
      expect(commands.length).toBe(afterTurn);
    } finally { await client.close(); }
    expect(prompts).toBe(0);
  };

  try {
    const { bot } = await control(["new-bot", "--name", "Hosted fixture"]);
    const model = (await apiOk("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).modelSelection.model as string;
    expect(model).not.toBe("claude-fable-5");

    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" });
    await hostedTurn(bot.id, bot.activeTaskId, model);
    expect(boxesCreated).toBe(1);
    const fresh = (await apiOk("POST", `/api/bots/${bot.id}/tasks`, {})).task.threadId as string;
    await hostedTurn(bot.id, fresh, model);
    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: null });
    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${bot.activeTaskId}`, { surface: "cloud" });
    await hostedTurn(bot.id, bot.activeTaskId, model);
    expect(boxesCreated).toBe(1);

    const autoThread = (await apiOk("POST", `/api/bots/${bot.id}/tasks`, {})).task.threadId as string;
    const callsBeforeAuto = boatCalls;
    const autoSince = piTurns(dumpPath).length;
    await control(["send", "--bot", bot.id, "--task", autoThread, "--text", "what is 2+2?"]);
    expect((await dump(autoSince)).mcpConfig.mcpServers.computer?.args?.[1]).not.toBe("computer");
    await finish(bot.id, autoThread);
    expect(boatCalls - callsBeforeAuto, "an Auto turn read the Boat account").toBe(0);
    expect((await task(bot.id, autoThread)).surface).toBeUndefined();
    rows.length = 0;
    await control(["send", "--bot", bot.id, "--task", autoThread, "--text", "and 3+3?"]);
    await finish(bot.id, autoThread);
    expect(boxesCreated).toBe(1);
    expect(boatCalls - callsBeforeAuto).toBe(0);

    failNewBoat = true;
    const { bot: fenced } = await control(["new-bot", "--name", "Fenced fixture"]);
    await apiOk("PATCH", `/api/bots/${fenced.id}`, { computer: "cloud" });
    await control(["send", "--bot", fenced.id, "--task", fenced.activeTaskId, "--text", "Use the hosted desktop."]);
    expect((await control(["wait", "--bot", fenced.id, "--task", fenced.activeTaskId, "--timeout", "30"])).status).toBe("failed");
    expect((await lastRows(fenced.activeTaskId)).at(-1)).toBe("error: Fenced fixture's cloud desktop didn't start. Try again.");
    const failedRow = (await apiOk("GET", `/api/threads/${fenced.activeTaskId}/messages?limit=30`)).messages
      .filter((message: any) => message.kind !== "digest").at(-1);
    expect(failedRow.tool.place).toEqual({ state: "cc-no-start", params: { bot: "Fenced fixture" }, source: "works-on" });
    await control(["send", "--bot", fenced.id, "--task", fenced.activeTaskId, "--text", "Try the hosted desktop again."]);
    expect((await control(["wait", "--bot", fenced.id, "--task", fenced.activeTaskId, "--timeout", "30"])).status).toBe("failed");
    expect((await lastRows(fenced.activeTaskId)).at(-1)).toBe("error: Fenced fixture's previous cloud desktop is still being removed. Try again.");
    await apiOk("PATCH", `/api/bots/${fenced.id}`, { computer: null });
    const callsBeforeFencedAuto = boatCalls;
    await control(["send", "--bot", fenced.id, "--task", fenced.activeTaskId, "--text", "what is 2+2?"]);
    await finish(fenced.id, fenced.activeTaskId);
    expect(boatCalls).toBe(callsBeforeFencedAuto);
    failNewBoat = false;
    expect(boxesCreated).toBe(2);

    // This build runs one engine, and it always has computer tools: the "can't use a desktop" refusal below has no
    // engine to fire on, and the instance a second one used to be saved under is gone.
    const instances = (await apiOk("GET", "/api/instances")).instances as Array<{ instanceId: string; capabilities?: { computerMcp?: boolean } }>;
    expect(instances.map((instance) => instance.instanceId)).toEqual(["pi"]);
    expect(instances.find((instance) => instance.instanceId === "pi")!.capabilities?.computerMcp).toBe(true);
    expect((await api("PATCH", "/api/instances/openaiCompat", { tools: false })).status).toBeGreaterThanOrEqual(400);
    expect(boxesCreated).toBe(2);
    expect(prompts).toBe(0);
  } finally {
    rmSync(gate, { force: true });
    await fixture.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
}, 180_000);
