// Real server, the one engine this build runs (the fake pi): new bots and threads start at Full access, the stored bot
// record keeps no explicit mode for it, and a person's own Ask stays theirs across a restart and on the threads they open.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-lunabot.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("starts new bots and threads at Full access on the one engine, and keeps a person's Ask", async () => {
  const fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  let server: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const start = async () => {
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
  };
  const stored = (botId: string) => JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")).find((bot: any) => bot.id === botId);
  try {
    // The launcher's own config carries one engine: pi, on the fake CLI.
    const instances = (await api("GET", "/api/instances")).instances as any[];
    expect(instances.map((instance) => instance.instanceId)).toEqual(["pi"]);
    const model = { instanceId: "pi", model: instances[0].models.default };

    // A new bot starts at Full access, and the record keeps no explicit mode for it.
    const bot = (await api("POST", "/api/bots", { name: "Default full", modelSelection: model }, 201)).bot;
    expect(bot.approvalMode).toBe("full");
    expect(stored(bot.id).approvalMode).toBeUndefined();
    const task = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "New full thread" }, 201)).task;
    expect(task.approvalMode).toBe("full");

    // The install's own first bot, and every new thread of it, starts at Full access too.
    const starter = (await api("GET", "/api/bots?messages=0")).bots.find((entry: any) => entry.id !== bot.id);
    expect(starter.approvalMode).toBe("full");
    expect(stored(starter.id).approvalMode).toBeUndefined();

    // The person picks Ask for the bot: it is stored, survives a restart, and its next thread opens at Ask.
    expect((await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask", applyToAllThreads: true })).bot.approvalMode).toBe("ask");
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    await start();
    expect(stored(bot.id).approvalMode).toBe("ask");
    expect((await api("GET", "/api/bots?messages=0")).bots.find((entry: any) => entry.id === bot.id).approvalMode).toBe("ask");
    const askThread = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Ask thread" }, 201)).task;
    expect(askThread.approvalMode).toBe("ask");
    // The bot the person never touched stays at Full access.
    expect((await api("GET", "/api/bots?messages=0")).bots.find((entry: any) => entry.id === starter.id).approvalMode).toBe("full");
  } finally {
    if (server) await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, fixtureRemoved: !existsSync(dataDir) }));
  }
}, 120_000);
