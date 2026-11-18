// Real server, the fake pi CLI, and a loopback Boat that fails the test on any call to Boat's own agent
// (/prompt, /prompts/{id}, /events, /interrupt).
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runControlOmb } from "../scripts/control-omb.ts";
import { piModelsSet, piTurns, type PiTurn } from "./testing/pi-dump.ts";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_PI = join(ROOT, "server/testing/fake-pi-cli.ts");
const ENGINE_NAME = "Verification pi";
const REMOVED = "The Computer choice in the model list was removed.";
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q==", "base64");

function install(home: string, boatPort: () => number) {
  const data = join(home, "data");
  const dumpFile = join(home, "fake-pi-dump.jsonl");
  let child: ChildProcess | null = null;
  let base = "";
  let output = "";
  mkdirSync(data, { recursive: true });
  mkdirSync(join(home, "static", "assets"), { recursive: true });
  writeFileSync(join(home, "static", "index.html"), "<title>Computer engine removal</title>");
  writeFileSync(join(home, "static", "assets", "test.css"), "body{}");

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBeLessThan(400);
    return result;
  };
  const control = (args: string[]) => runControlOmb([...args, "--url", base]) as Promise<any>;
  const send = (botId: string, threadId: string, text: string) => fetch(`${base}/api/bots/${botId}/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, threadId }),
  }).then(response => response.status);
  const bots = async (): Promise<any[]> => (await api("GET", "/api/bots?messages=0")).bots;
  const bot = async (botId: string) => (await bots()).find(entry => entry.id === botId);
  const savedBots = (): any[] => JSON.parse(readFileSync(join(data, "bots.json"), "utf8"));
  const editSavedBot = (botId: string, edit: (bot: any) => void) => {
    const saved = savedBots();
    edit(saved.find(entry => entry.id === botId));
    writeFileSync(join(data, "bots.json"), JSON.stringify(saved, null, 2));
  };
  const editConfig = (edit: (config: any) => void) => {
    const path = join(data, "config.json");
    const config = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    edit(config);
    writeFileSync(path, JSON.stringify(config, null, 2));
  };
  const lines = async (threadId: string): Promise<string[]> =>
    (await api("GET", `/api/threads/${threadId}/messages?limit=50`)).messages
      .filter((message: any) => message.kind === "activity").map((message: any) => String(message.tool?.name));
  const moveLines = async (threadId: string) => (await lines(threadId)).filter(line => line.includes(REMOVED));
  /** The pi launch and prompt a turn ran on: the fake appends one launch line per process and one per prompt. */
  const turn = async (botId: string, threadId: string, text: string) => {
    const before = piTurns(dumpFile).length;
    await control(["send", "--bot", botId, "--task", threadId, "--text", text]);
    const settled = await control(["wait", "--bot", botId, "--task", threadId, "--timeout", "30"]);
    expect(settled.status, JSON.stringify(settled)).toBe("settled");
    let found: PiTurn | undefined;
    await expect.poll(() => {
      const turns = piTurns(dumpFile);
      if (turns.length <= before) return false;
      found = turns.at(-1);
      return Boolean(found?.launch);
    }, { timeout: 15_000 }).toBe(true);
    return { launch: found!.launch!, prompt: found!.prompt };
  };
  async function start() {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    output = "";
    const proc = spawn(process.execPath, [join(ROOT, "server/index.ts")], {
      cwd: ROOT, env: {
        PATH: dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home, USERPROFILE: home, OMB_DATA_DIR: data,
        APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
        TEMP: home, TMP: home, TMPDIR: home,
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: join(home, "static"),
        OMB_BOAT_API: `http://127.0.0.1:${boatPort()}`,
        OMB_USER_DATA: join(home, "user-data"),
        // A turn's first computer call is what creates the Boat, as with a real model. The fake pi
        // scripts that call through the turn's real computer MCP server (it has no built-in one); a
        // slow turn plays its scripted calls and then answers, with no finish gate to wait on.
        FAKE_PI_MODE: "slow",
        FAKE_PI_MOUNT_TOOLS: "1",
        FAKE_PI_TOOL_CALLS: JSON.stringify([{ server: "computer", name: "screenshot", input: {} }]),
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    proc.stdout!.on("data", chunk => { output += chunk; });
    proc.stderr!.on("data", chunk => { output += chunk; });
    await expect.poll(async () => {
      if (proc.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
      try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
    }, { timeout: 20_000, interval: 50 }).toBe(true);
  }
  async function stop() {
    if (!child) return;
    const proc = child;
    child = null;
    await waitForExit(proc, { signal: "SIGTERM" });
  }
  return { data, dumpFile, api, send, bots, bot, editSavedBot, editConfig, lines, moveLines, turn, start, stop, log: () => output };
}

/** The one agent this build runs; its real fake CLI records each launch and prompt. */
const piEntry = (dumpFile: string) => ({
  driver: "piAgent", displayName: ENGINE_NAME, config: { cli: FAKE_PI }, environment: { FAKE_PI_DUMP: dumpFile },
});
/** A saved entry for an engine this build no longer has; the startup migration retargets it to pi. */
const retiredEntry = () => ({ driver: "claudeAgent", displayName: "Retired Claude" });
const onEngine = (model: string) => ({ instanceId: "computer", model });
/** A bot (and each of its conversations) as v0.1.94 saved it on the engine. */
const savedOnEngine = (saved: any) => {
  saved.modelSelection = onEngine("claude-fable-5");
  for (const task of saved.tasks) task.modelSelection = onEngine("claude-fable-5");
};

describe("removing the Computer engine", () => {
  const homes: string[] = [];
  const running: Array<{ stop: () => Promise<void> }> = [];
  let boatServer: Server;
  const rows: Array<{ id: string; name: string; state: string }> = [];
  let boatCalls = 0;
  let boxesCreated = 0;
  /** Calls to Boat's own agent: the place no turn may ever go. */
  const agentCalls: string[] = [];
  const boatPort = () => (boatServer.address() as { port: number }).port;
  const fresh = () => {
    const home = mkdtempSync(join(tmpdir(), "omb-computer-engine-"));
    homes.push(home);
    const server = install(home, boatPort);
    running.push(server);
    return { home, server };
  };

  beforeAll(async () => {
    boatServer = createServer(async (req, res) => {
      const path = new URL(req.url ?? "/", "http://box.fixture").pathname;
      let raw = ""; for await (const part of req) raw += part;
      const body = raw ? JSON.parse(raw) : {};
      res.setHeader("content-type", "application/json");
      boatCalls++;
      if (/\/(prompt|events|interrupt)$|\/prompts\//.test(path)) {
        agentCalls.push(`${req.method} ${path}`);
        res.statusCode = 409;
        return res.end(JSON.stringify({ ok: false, code: "provider_not_configured", message: "Claude login required" }));
      }
      if (path === "/sandboxes" && req.method === "POST") {
        boxesCreated++;
        const row = { id: `bx_2345678${"abcdefgh"[rows.length]}`, name: body.name, state: "idle" }; rows.push(row);
        return res.end(JSON.stringify({ sandbox: row }));
      }
      if (path === "/sandboxes") return res.end(JSON.stringify({ sandboxes: rows }));
      if (path.endsWith("/commands")) return res.end(JSON.stringify({ exitCode: 0, stdout: "captured", stderr: "" }));
      if (path.endsWith("/artifacts")) { res.setHeader("content-type", "image/jpeg"); return res.end(JPEG); }
      if (path.endsWith("/desktop")) return res.end(JSON.stringify({ desktopUrl: "https://desktop.fixture.invalid" }));
      const row = rows.find(entry => path === "/sandboxes/" + entry.id);
      if (row) {
        if (req.method === "PATCH" && typeof body.name === "string") row.name = body.name;
        return res.end(JSON.stringify({ sandbox: row }));
      }
      res.end("{}");
    });
    await new Promise<void>(resolve => boatServer.listen(0, "127.0.0.1", resolve));
  });
  afterAll(async () => {
    for (const server of running) await server.stop();
    if (boatServer) { boatServer.closeAllConnections(); await new Promise<void>(resolve => boatServer.close(() => resolve())); }
    for (const home of homes) await removeTempDir(home);
  });

  it("moves bots off it once, keeps each conversation where it worked, and never hands a turn to Boat's own agent", async () => {
    const { server } = fresh();
    // The one agent this build runs. It uses the cloud computer through its own turn integration,
    // as a real model does, so the first computer call creates the Boat.
    server.editConfig(config => Object.assign(config, { box: { token: "box_verification_fixture" }, instances: { pi: piEntry(server.dumpFile) } }));
    await server.start();
    const [starter] = await server.bots();
    const { task: opened } = await server.api("POST", `/api/bots/${starter.id}/tasks`, {});
    const main = opened.threadId;
    const other = starter.threadId;
    const { bot: auto } = await server.api("POST", "/api/bots", { name: "Atlas" });
    const { bot: mixed } = await server.api("POST", "/api/bots", { name: "Iris" });
    const { task: mixedConversation } = await server.api("POST", `/api/bots/${mixed.id}/tasks`, {});
    await server.stop();

    // Everything as v0.1.94 saved it. The fleet, the new-bot defaults and the
    // automatic-recovery backup name the engine. `retired` is another engine
    // this build no longer has; the pi migration retargets it too.
    server.editConfig(config => Object.assign(config, {
      instances: { pi: piEntry(server.dumpFile), retired: retiredEntry(), computer: { driver: "boxAgent" } },
      defaultModelSelection: { instanceId: "computer", model: "claude-fable-5" },
      newBotDefaults: { profile: { modelSelection: { instanceId: "computer", model: "claude-fable-5" } } },
      automaticRecovery: { enabled: true, backup: { instanceId: "computer", model: "sonnet" } },
    }));
    // The starter: on the engine with Works on Cloud, another conversation
    // and a backup on it, and Boat's run id.
    server.editSavedBot(starter.id, saved => {
      saved.modelSelection = onEngine("claude-fable-5");
      saved.computer = "cloud";
      saved.fallback = [onEngine("sonnet")];
      saved.resumeCursors = { computer: "boat-prompt-run" };
      for (const task of saved.tasks) task.modelSelection = onEngine(task.threadId === other ? "gpt-5.4" : "claude-fable-5");
    });
    // Atlas: on the engine with Works on Auto, the default for new bots.
    server.editSavedBot(auto.id, saved => {
      saved.modelSelection = onEngine("claude-fable-5");
      delete saved.computer;
      for (const task of saved.tasks) task.modelSelection = onEngine("claude-fable-5");
    });
    // Iris: on the retired Claude and Auto, with its open conversation switched to the engine.
    server.editSavedBot(mixed.id, saved => {
      saved.modelSelection = { instanceId: "retired", model: "claude-fable-5" };
      saved.tasks.find((task: any) => task.threadId === mixedConversation.threadId).modelSelection = onEngine("claude-fable-5");
    });

    await server.start();
    const { instances } = await server.api("GET", "/api/instances");
    expect(instances.map((instance: any) => instance.instanceId)).not.toContain("computer");
    expect(instances.map((instance: any) => instance.instanceId)).not.toContain("retired");
    expect(instances.map((instance: any) => instance.driverKind)).not.toContain("boxAgent");
    const replacement = { instanceId: "pi", model: instances.find((instance: any) => instance.instanceId === "pi").models.default };

    const movedStarter = await server.bot(starter.id);
    expect(movedStarter.modelSelection).toEqual(replacement);
    expect(movedStarter.computer).toBe("cloud");
    expect(movedStarter.fallback ?? []).toEqual([]);
    expect(movedStarter.threadId).toBe(main);
    expect(movedStarter.tasks.find((task: any) => task.threadId === other).modelSelection).toEqual(replacement);
    const starterLine = `${starter.name} now uses ${ENGINE_NAME}. ${REMOVED} ${starter.name} still works on its cloud desktop.`;
    const otherLine = `This conversation now uses ${ENGINE_NAME}. ${REMOVED} It still works on ${starter.name}'s cloud desktop.`;
    expect(await server.moveLines(main)).toEqual([starterLine]);
    expect(await server.moveLines(other)).toEqual([otherLine]);

    const movedAuto = await server.bot(auto.id);
    expect(movedAuto.modelSelection).toEqual(replacement);
    expect(movedAuto.computer).toBe("cloud");
    expect(await server.moveLines(auto.threadId)).toEqual([`Atlas now uses ${ENGINE_NAME}. ${REMOVED} Atlas still works on its cloud desktop.`]);

    const movedMixed = await server.bot(mixed.id);
    // The bot was on another engine this build no longer has: the pi migration moved it silently.
    expect(movedMixed.modelSelection).toEqual(replacement);
    expect(movedMixed.computer).toBeUndefined();
    expect(await server.moveLines(mixed.threadId)).toEqual([]);
    expect(await server.moveLines(mixedConversation.threadId))
      .toEqual([`This conversation now uses ${ENGINE_NAME}. ${REMOVED} It still works on Iris's cloud desktop.`]);
    const mixedTask = movedMixed.tasks.find((task: any) => task.threadId === mixedConversation.threadId);
    expect(mixedTask.modelSelection).toEqual(replacement);
    expect(mixedTask).toMatchObject({ surface: "cloud", surfaceAuto: true });

    const defaults = await server.api("GET", "/api/bot-defaults");
    expect(defaults.defaults.profile.modelSelection).toEqual(replacement);
    expect(defaults.modelSelection).toEqual(replacement);
    const { bot: created } = await server.api("POST", "/api/bots", { name: "Nova" });
    expect(created.modelSelection).toEqual(replacement);
    expect(created.computer).toBeUndefined();
    expect((await server.api("GET", "/api/config")).automaticRecovery).toEqual({ enabled: false });

    await server.stop();
    await server.start();
    expect(await server.moveLines(main)).toEqual([starterLine]);
    expect(await server.moveLines(other)).toEqual([otherLine]);
    expect(await server.moveLines(auto.threadId)).toHaveLength(1);
    expect(await server.moveLines(mixedConversation.threadId)).toHaveLength(1);

    const cloudTurn = await server.turn(starter.id, main, "Take a screenshot of the cloud computer.");
    // pi is told its model over RPC, not argv: the launch log carries the switch.
    expect(piModelsSet(server.dumpFile).map(model => `${model.provider}/${model.modelId}`)).toContain(replacement.model);
    expect(cloudTurn.launch.mcpConfig?.mcpServers?.computer?.args).toEqual([expect.stringMatching(/harness-mcp-proxy\.(?:ts|js)$/), "computer"]);
    expect(boxesCreated).toBe(1);
    expect(agentCalls).toEqual([]);

    const { task: atlasNew } = await server.api("POST", `/api/bots/${auto.id}/tasks`, {});
    const autoMovedTurn = await server.turn(auto.id, atlasNew.threadId, "Take a screenshot of the cloud computer.");
    expect(autoMovedTurn.launch.mcpConfig?.mcpServers?.computer?.args).toEqual([expect.stringMatching(/harness-mcp-proxy\.(?:ts|js)$/), "computer"]);
    expect(boxesCreated).toBe(2);
    expect(agentCalls).toEqual([]);

    await server.api("PATCH", `/api/bots/${starter.id}`, { computer: null });
    const callsBeforeAuto = boatCalls;
    const autoTurn = await server.turn(starter.id, other, "what is 2+2?");
    expect(autoTurn.launch.mcpConfig?.mcpServers?.computer?.args?.[1]).not.toBe("computer");
    expect(boatCalls - callsBeforeAuto, "an Auto turn reached the Boat account").toBe(0);
    expect(agentCalls).toEqual([]);
    await server.stop();
  }, 180_000);

  // A "moves a bot later, as soon as an engine is there to move it to" subtest was removed: it
  // installed a second engine's CLI after boot and waited for model discovery to see it. pi is the
  // one engine and is always there, so there is no "no engine yet, one arrives" state to exercise.

  it("keeps serving when the Computer move fails at start, and the pi migration still carries the bots", async () => {
    const { server } = fresh();
    const teams = join(server.data, "section-contexts.json");
    server.editConfig(config => Object.assign(config, { box: { token: "box_verification_fixture" }, instances: { pi: piEntry(server.dumpFile) } }));
    await server.start();
    const [starter] = await server.bots();
    await server.stop();
    server.editConfig(config => Object.assign(config, { instances: { pi: piEntry(server.dumpFile), computer: { driver: "boxAgent" } } }));
    server.editSavedBot(starter.id, savedOnEngine);
    // An unreadable teams file stops every save of the bots, the move's too.
    writeFileSync(teams, "not json");

    await server.start();
    expect(server.log()).toContain("[engines] moving bots off the removed Computer engine failed");
    // The one-agent migration runs after it and needs no teams save: the bot still reaches pi and
    // keeps working, without the Computer choice line the failed move would have written.
    expect((await server.bot(starter.id)).modelSelection.instanceId).toBe("pi");
    expect(await server.moveLines(starter.threadId)).toEqual([]);

    rmSync(teams);
    await server.send(starter.id, starter.threadId, "hello");
    expect((await server.bot(starter.id)).modelSelection.instanceId).toBe("pi");
    // The failed Computer move never wrote the "Works on: Cloud" the successful path keeps; the
    // pi migration only retargets the model, so the bot stays on Auto.
    expect((await server.bot(starter.id)).computer).toBeUndefined();
    expect(await server.moveLines(starter.threadId)).toEqual([]);
    await server.stop();
  }, 120_000);

  // A "keeps a bot on Auto when the engine it moves to can't use a computer" subtest was removed:
  // it used an OpenAI-compatible instance with tools off as a second, computer-less engine. That
  // engine instance no longer exists (pi is the only one, and it can use a computer), so the
  // computerEngineMoveText noComputer wording stays covered by the unit recipe instead.
});
