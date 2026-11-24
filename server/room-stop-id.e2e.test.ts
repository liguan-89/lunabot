// Real server, the repository's fake pi holding each room turn on a gate until it is written, so the first turn can be
// stopped and the second one is under way when the phone resends its Stop.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-lunabot.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { piDumpPath, piTurnsForThread } from "./testing/pi-dump.ts";
import { openSse } from "./testing/sse.ts";

it("stops a room's turn once per stopId: a resent Stop leaves the turn that started since running", async () => {
  const fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  // Every turn of this room's bot waits for this file (server/testing/fake-pi-cli.ts, FAKE_PI_MODE=slow): the first is
  // stopped while it waits, the second runs once the test writes it.
  const gate = join(dataDir, "slow-finish-gate");
  let server: ChildProcess | undefined;
  let stream: Awaited<ReturnType<typeof openSse>> | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    // The fake pi, waiting on this turn's gate instead of replying at once. This build runs pi only, so the room's bot
    // runs on it rather than on the retired ACP engine.
    const cli = fileURLToPath(new URL("./testing/fake-pi-cli.ts", import.meta.url));
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.pi = {
      driver: "piAgent", displayName: "pi", config: { cli },
      environment: { FAKE_PI_MODE: "slow", FAKE_PI_SLOW_FINISH_GATE: gate },
    };
    writeFileSync(configPath, JSON.stringify(config));
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    stream = await openSse(`${url}/api/events`, { origin: url });

    const { bot } = await api("POST", "/api/bots", { name: "Stopper" }, 201);
    const { group } = await api("POST", "/api/groups", { name: "Stop room", memberIds: [bot.id] }, 201);
    await api("PATCH", `/api/groups/${group.id}/setup`, { action: "complete", cwd: null, bulletin: "", defaultResponder: { kind: "member", botId: bot.id } });
    const threadId = group.threadId;
    await api("POST", `/api/groups/${group.id}/messages`, { threadId, text: "Hold this one, please." }, 202);
    // A stop before the prompt reaches the engine is a cancellation of a turn that never started; the test stops the
    // turn the fake is really holding, so it waits for the prompt row in the engine's own log (server/testing/pi-dump.ts).
    await expect.poll(() => piTurnsForThread(piDumpPath(dataDir), threadId).length, { timeout: 20_000 }).toBeGreaterThan(0);
    const first = (await stream.until((frame) => frame.kind === "runtime" && frame.event?.type === "turn.started" && frame.event.threadId === threadId)).event.turnId;

    const stopId = "stop_room_0123456789abcdef";
    await api("POST", `/api/groups/${group.id}/interrupt`, { threadId, stopId });
    await stream.until((frame) => frame.kind === "runtime" && frame.event?.type === "turn.completed" && frame.event.turnId === first);
    await expect.poll(async () => (await api("GET", "/api/bots")).groups.find((room: any) => room.id === group.id)?.working ?? false, { timeout: 20_000 }).toBe(false);

    await api("POST", `/api/groups/${group.id}/messages`, { threadId, text: "Second message" }, 202);
    const second = (await stream.until((frame) => frame.kind === "runtime" && frame.event?.type === "turn.started"
      && frame.event.threadId === threadId && frame.event.turnId !== first)).event.turnId;

    // The phone's connection died before it read the answer, so it sends the same Stop again.
    expect(await api("POST", `/api/groups/${group.id}/interrupt`, { threadId, stopId })).toEqual({ ok: true });
    writeFileSync(gate, "go");
    const done = await stream.until((frame) => frame.kind === "runtime" && frame.event?.type === "turn.completed" && frame.event.turnId === second);
    expect(done.event.stopReason, "the resent Stop cancelled the second turn").not.toBe("cancelled");
    await expect.poll(async () => (await messages(threadId)).some((message) => message.kind === "text" && /^reply to: .*Second message/s.test(message.text ?? "")), { timeout: 20_000 }).toBe(true);

    expect(await api("POST", `/api/groups/${group.id}/interrupt`, { threadId, stopId: "not an id" }, 400)).toEqual({ error: "stopId must be a client-generated id" });
  } finally {
    stream?.close();
    if (server) await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 120_000);
