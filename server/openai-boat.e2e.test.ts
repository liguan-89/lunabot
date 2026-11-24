// Boat is still a live path: a cloud bot's first computer call claims (creates or wakes) its sandbox
// through the harness's `computer` MCP server, which the pi driver mounts like any other integration.
// The scripted fake pi makes the computer call; the fake Boat upstream stays the same. Assertions about
// the retired OpenAI-compatible driver are gone: the model is asserted over pi's RPC (each `set_model`
// paired with its launch) and the screenshot is asserted as the Boat command it ran, because the fixture
// does not forward a mounted tool's image content to the driver.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLunabot } from "../scripts/control-lunabot.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { piDumpPath, piTurnsForThread } from "./testing/pi-dump.ts";

const MODEL = "chosen-vision-model";
const PI_MODEL = `luna/${MODEL}`;
const SCREENSHOT = { server: "computer", name: "screenshot", input: {} };

it("keeps the selected model for direct, group and scheduled Boat turns, runs the computer tool and preserves human control", async () => {
  const rows: Array<{ id: string; name: string; state: string }> = [];
  const commands: string[] = [];
  let creates = 0;
  let artifactReads = 0;
  let nativePrompts = 0;
  let boatOffline = false;
  let boatReadsGate: { entered: boolean; resumed: Promise<void>; release: () => void } | undefined;
  const pauseBoatReads = () => {
    let release!: () => void;
    const resumed = new Promise<void>(resolve => { release = resolve; });
    const gate = { entered: false, resumed, release };
    boatReadsGate = gate;
    return gate;
  };
  const upstream = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    let raw = ""; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    const gate = boatReadsGate;
    if (gate && req.method === "GET" && path.startsWith("/sandboxes")) {
      gate.entered = true;
      await gate.resumed;
    }
    if (path === "/v1/models") return res.end(JSON.stringify({ data: [{ id: MODEL }, { id: "other-default" }] }));
    if (boatOffline && path.startsWith("/sandboxes")) { res.statusCode = 503; return res.end(JSON.stringify({ error: "Fixture Boat unavailable" })); }
    if (path === "/sandboxes" && req.method === "POST") {
      creates += 1;
      const row = { id: creates === 1 ? "bx_23456789" : "bx_3456789a", name: body.name, state: "idle" }; rows.push(row);
      return res.end(JSON.stringify({ sandbox: row }));
    }
    if (path === "/sandboxes") return res.end(JSON.stringify({ sandboxes: rows }));
    if (path.endsWith("/commands")) { commands.push(body.command); return res.end(JSON.stringify({ exitCode: 0, stdout: "captured", stderr: "" })); }
    if (path.endsWith("/artifacts")) { artifactReads += 1; res.setHeader("content-type", "image/jpeg"); return res.end(Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q==", "base64")); }
    if (path.endsWith("/desktop")) return res.end(JSON.stringify({ desktopUrl: "https://desktop.fixture.invalid" }));
    if (path.endsWith("/prompt")) { nativePrompts++; return res.end(JSON.stringify({ promptRun: { id: "unexpected-native" } })); }
    const row = rows.find(row => path === "/sandboxes/" + row.id);
    if (row) {
      if (req.method === "PATCH" && typeof body.name === "string") row.name = body.name;
      return res.end(JSON.stringify({ sandbox: row }));
    }
    res.end("{}");
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("fixture failed to bind");
  const origin = `http://127.0.0.1:${address.port}`;
  const scratch = mkdtempSync(join(tmpdir(), "omb-openai-boat-"));
  const callsFile = join(scratch, "tool-calls.json");
  const replyFile = join(scratch, "reply.txt");
  const releaseFile = join(scratch, "release");
  const script = (calls: unknown[]) => writeFileSync(callsFile, JSON.stringify(calls));
  const reply = (text: string) => writeFileSync(replyFile, text);
  script([]);
  reply("Fixture completed.");
  // A permission card is driven per prompt; the computer call itself has no pi permission card because the
  // extension gates only `local-computer`/`custom` servers, and a cloud computer mounts without a scope.
  const fixture = await launchVerificationServer({
    FAKE_PI_CLAUDE_COMPAT: "1",
    FAKE_PI_MOUNT_TOOLS: "1",
    FAKE_PI_TOOL_CALLS_FILE: callsFile,
    FAKE_PI_REPLY_FILE: replyFile,
    FAKE_PI_RELEASE: releaseFile,
    FAKE_PI_PERMISSION_ON: "Confirm before acting",
  }, undefined, undefined, undefined, undefined, undefined, [], origin).catch(async error => {
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); throw error;
  });
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  const control = (args: string[]) => runControlLunabot([...args, "--url", fixture.info.url]) as Promise<any>;
  const messages = async (threadId: string) => ((await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[]);
  try {
    await api("PATCH", "/api/config", { openaiCompat: { key: "synthetic-model-key", url: origin + "/v1", model: MODEL } });
    const { bot } = await control(["new-bot", "--name", "Boat API fixture"]);
    // The config PATCH above folds the custom provider's model into pi's catalog asynchronously; on a slow runner an
    // immediate set-model races that merge, so retry until the catalog offers it.
    await expect.poll(async () => {
      try {
        await control(["set-model", "--bot", bot.id, "--instance", "pi", "--model", PI_MODEL]);
        return true;
      } catch {
        return false;
      }
    }, { timeout: 15_000, interval: 500 }).toBe(true);
    // On Ask, so pi's own permission card is offered when a prompt asks for it.
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud", browser: false, approvalMode: "ask" });
    const direct = ["--bot", bot.id, "--task", bot.activeTaskId];

    // Direct: the first computer call creates the Boat's sandbox and takes a native-resolution screenshot.
    script([SCREENSHOT]);
    await control(["send", ...direct, "--text", "Inspect the assigned cloud desktop."]);
    expect((await control(["wait", ...direct, "--timeout", "30"])).status).toBe("settled");
    expect(creates).toBe(1);
    expect(commands.some(command => command.includes(".model.jpg"))).toBe(true);
    expect(artifactReads).toBeGreaterThan(0);

    // Human control: the person takes the desktop while a call is about to run; the call is refused, nothing runs.
    script([
      { name: "Read", input: { file_path: "notes.txt" }, hold: true, output: "held" },
      SCREENSHOT,
    ]);
    const commandsBefore = commands.length;
    await control(["send", ...direct, "--text", "Pause, then use the desktop."]);
    await expect.poll(async () => (await messages(bot.activeTaskId)).some(message => message.tool?.name === "Read"), { timeout: 15_000 }).toBe(true);
    await api("POST", `/api/bots/${bot.id}/computer/control`, { action: "take" });
    writeFileSync(releaseFile, "release");
    await new Promise(resolve => setTimeout(resolve, 1_000));
    // Panel previews may still capture the desktop; the model's own screenshot is the native-resolution command.
    expect(commands.slice(commandsBefore).filter(command => command.includes(".model.jpg"))).toEqual([]);
    await api("POST", `/api/bots/${bot.id}/computer/control`, { action: "release" });
    expect((await control(["wait", ...direct, "--timeout", "30"])).status).toBe("settled");
    expect(commands.slice(commandsBefore).filter(command => command.includes(".model.jpg"))).toEqual([]);
    expect(JSON.stringify(await messages(bot.activeTaskId))).toContain("This call was NOT performed");

    // Group: a member's turn takes the same cloud desktop and keeps its model.
    const { group } = await api("POST", "/api/groups", { name: "Boat fixture room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
    script([SCREENSHOT]);
    const channel = ["--channel", group.id, "--task", group.threadId];
    const groupCommandsBefore = commands.length;
    await control(["send-channel", ...channel, "--text", "Inspect the assigned cloud desktop."]);
    expect((await control(["wait", ...channel, "--timeout", "20"])).status).toBe("settled");
    expect(commands.length).toBeGreaterThan(groupCommandsBefore);
    expect(commands.some(command => command.includes(".model.jpg"))).toBe(true);

    // Scheduled: a cloud routine waits on Boat readiness, then runs the same computer call.
    script([SCREENSHOT]);
    const { routine } = await api("POST", "/api/routines", { name: "Cloud fixture", botId: bot.id,
      prompt: "Inspect the assigned cloud desktop.", runOn: "cloud", enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
    const readiness = pauseBoatReads();
    const { run } = await api("POST", `/api/routines/${routine.id}/run`, {});
    let routineThread = "";
    await expect.poll(async () => {
      routineThread = (await api("GET", "/api/routines")).runs.find((entry: any) => entry.id === run.id)?.threadId ?? "";
      return routineThread;
    }, { timeout: 15_000 }).not.toBe("");
    await expect.poll(() => readiness.entered, { timeout: 15_000 }).toBe(true);
    const destination = ["--bot", bot.id, "--task", routineThread];
    const preparing = (await api("GET", "/api/bots")).bots.find((item: any) => item.id === bot.id)
      .tasks.find((task: any) => task.threadId === routineThread);
    expect(preparing).toMatchObject({ busy: true, activity: "working" });
    expect((await control(["wait", ...destination, "--timeout", "1"])).status).toBe("timed-out");
    boatReadsGate = undefined;
    readiness.release();
    expect((await control(["wait", ...destination, "--timeout", "30"])).status).toBe("settled");
    expect(commands.some(command => command.includes(".model.jpg"))).toBe(true);

    // Cancelled before dispatch: readiness never resolves into a turn, so nothing reaches the Boat.
    const cancelledReadiness = pauseBoatReads();
    const createsBeforeCancel = creates;
    const commandsBeforeCancel = commands.length;
    const { run: cancelled } = await api("POST", `/api/routines/${routine.id}/run`, {});
    let cancelledThread = "";
    await expect.poll(async () => {
      cancelledThread = (await api("GET", "/api/routines")).runs.find((entry: any) => entry.id === cancelled.id)?.threadId ?? "";
      return cancelledThread;
    }, { timeout: 15_000 }).not.toBe("");
    await expect.poll(() => cancelledReadiness.entered, { timeout: 15_000 }).toBe(true);
    expect((await api("POST", `/api/routine-runs/${cancelled.id}/cancel`, {})).run.status).toBe("cancelled");
    boatReadsGate = undefined;
    cancelledReadiness.release();
    expect((await control(["wait", "--bot", bot.id, "--task", cancelledThread, "--timeout", "20"])).status).toBe("settled");
    expect(creates).toBe(createsBeforeCancel);
    expect(commands).toHaveLength(commandsBeforeCancel);
    expect(piTurnsForThread(piDumpPath(fixture.info.dataDir), cancelledThread)).toHaveLength(0);

    // The old empty-key refusal ("the target bot's model is not ready") has no successor: pi's snapshot is
    // always available and the custom provider's key is not part of cloud readiness, so that run would start
    // and fail inside the provider instead. Only a Boat outage is still refused before dispatch.
    const expectBlockedRun = async (reason: RegExp, retried?: "provider") => {
      const createsBefore = creates;
      const { run: blocked } = await api("POST", `/api/routines/${routine.id}/run`, {});
      const latest = async () => (await api("GET", "/api/routines")).runs.find((entry: any) => entry.id === blocked.id);
      // A passing failure starts the run once more after a short wait, and the second failure keeps the same reason.
      if (retried) await expect.poll(latest, { timeout: 15_000 }).toMatchObject({ status: "queued", retried, attention: expect.stringMatching(reason) });
      await expect.poll(async () => {
        const run = await latest();
        return run?.status === "failed" ? run.error : "";
      }, { timeout: retried ? 45_000 : 15_000 }).toMatch(retried ? new RegExp(`^Failed after one automatic retry: .*${reason.source}`, reason.flags) : reason);
      expect(creates).toBe(createsBefore);
      expect(nativePrompts).toBe(0);
    };
    boatOffline = true;
    // A Boat that answers 503 is a temporary outage, not something only the owner can fix.
    await expectBlockedRun(/cloud computer could not be checked/i, "provider");

    // A pi permission card: the person allows it and the turn continues. Kept last: the marker's text becomes
    // part of the bot's recent-work context, which room and routine prompts also carry.
    const { task } = await api("POST", `/api/bots/${bot.id}/tasks`, {});
    script([]);
    await control(["send", "--bot", bot.id, "--task", task.threadId, "--text", "Confirm before acting."]);
    expect((await control(["wait", "--bot", bot.id, "--task", task.threadId, "--timeout", "20"])).status).toBe("needs-user");
    const card = (await messages(task.threadId)).find(message => message.card?.requestId && !message.card.answered)?.card;
    expect(card?.requestId).toBeTruthy();
    await api("POST", `/api/threads/${task.threadId}/respond`, { requestId: card.requestId, behavior: "allow" });
    expect((await control(["wait", "--bot", bot.id, "--task", task.threadId, "--timeout", "20"])).status).toBe("settled");

    // Every turn pi ran with the cloud computer was told the selected model. A background coordination
    // turn (no computer integration) may run on pi's own default, so pair each `set_model` with its launch.
    const dumpPath = piDumpPath(fixture.info.dataDir);
    const computerTurnModels: Array<{ provider: string; modelId: string }> = [];
    let launch: any = null;
    for (const line of readFileSync(dumpPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.argv) { launch = row; continue; }
      if (row.setModel && launch?.mcpConfig?.mcpServers?.computer) computerTurnModels.push(row.setModel);
    }
    expect(computerTurnModels.length).toBeGreaterThanOrEqual(4);
    expect(computerTurnModels.every(entry => entry.provider === "luna" && entry.modelId === MODEL), JSON.stringify(computerTurnModels)).toBe(true);
    expect(nativePrompts).toBe(0);
  } finally {
    boatReadsGate?.release();
    await fixture.close(); upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await removeTempDir(scratch);
  }
}, 150_000);
