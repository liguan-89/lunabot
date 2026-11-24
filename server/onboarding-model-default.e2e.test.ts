// Onboarding's model default, on the one engine this build runs: a blank starter takes the default as soon as the
// engine's CLI can be run, and never overrides a model somebody chose. pi manages its own credentials, so "not ready"
// here is a CLI that cannot run or an engine switched off — there is no sign-in to be out of.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLunabot, verificationServerEnvironment } from "../scripts/control-lunabot.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { piDumpPath, piModelsSet, piTurns } from "./testing/pi-dump.ts";

const EMPTY = { instanceId: "", model: "" };
const DEFAULT = { instanceId: "pi", model: "ollama-cloud/glm-5.2" };
const CHOSEN = { instanceId: "pi", model: "openai/gpt-4o" };
const FAKE_PI = fileURLToPath(new URL("./testing/fake-pi-cli.ts", import.meta.url));

type Fixture = {
  api: (method: string, path: string, body?: unknown) => Promise<any>;
  request: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  control: (...args: string[]) => Promise<any>;
  restart: (options?: { clearStarter?: boolean; enabled?: boolean }) => Promise<void>;
  connect: () => Promise<void>;
  makeCliAvailable: (holdProbe?: boolean) => { started: () => boolean; release: () => void; dispatched: (text: string) => boolean };
  saved: () => any[];
  receipt: () => { model: string; prompt: string };
};

async function withUnselectedStarter(check: (fixture: Fixture) => Promise<void>) {
  const fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  const configPath = join(dataDir, "config.json");
  const botsPath = join(dataDir, "bots.json");
  const lateCli = join(dataDir, "late-pi.mjs");
  const starterId = JSON.parse(readFileSync(botsPath, "utf8"))[0].id;
  let server: ChildProcess | undefined;
  const request: Fixture["request"] = async (method, path, body) => {
    const response = await fetch(url + path, { method,
      headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, body: await response.json() };
  };
  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const result = await request(method, path, body);
    expect(result.status >= 200 && result.status < 300, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result.body;
  };
  const saved = (): any[] => JSON.parse(readFileSync(botsPath, "utf8"));
  const restart: Fixture["restart"] = async (options = {}) => {
    await waitForExit(server ?? fixture.child, { signal: "SIGTERM" });
    if (options.clearStarter) {
      const bots = saved();
      bots.find((bot) => bot.id === starterId).modelSelection = EMPTY;
      writeFileSync(botsPath, JSON.stringify(bots));
    }
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    // The CLI the next start points at does not exist yet: the engine reads as unavailable until a test installs one.
    config.instances.pi = { ...config.instances.pi, enabled: options.enabled ?? true, config: { ...config.instances.pi.config, cli: lateCli } };
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
  };
  const dumpPath = piDumpPath(dataDir);
  try {
    await check({ api, request, saved, restart,
      control: (...args) => runControlLunabot([...args, "--url", url]) as Promise<any>,
      connect: async () => { await api("PATCH", "/api/instances/pi", { cli: FAKE_PI }); },
      makeCliAvailable: (holdProbe = false) => {
        const gate = join(dataDir, "probe-release");
        const probes = join(dataDir, "probe-log");
        // A wrapper around the fake pi: with `holdProbe`, its `--version` writes the probe line and then waits for the
        // gate, so a send's provider discovery can be held mid-probe while the test changes the bot.
        writeFileSync(lateCli, ["#!/usr/bin/env node",
          `import { appendFileSync, existsSync } from "node:fs";`,
          `import { setTimeout as sleep } from "node:timers/promises";`,
          `if (process.argv.includes("--version") || process.argv.includes("-v")) {`,
          ...(holdProbe ? [
            `  appendFileSync(${JSON.stringify(probes)}, "version\\n");`,
            `  while (!existsSync(${JSON.stringify(gate)})) await sleep(50);`,
          ] : []),
          "}",
          `await import(${JSON.stringify(new URL("./testing/fake-pi-cli.ts", import.meta.url).href)});`,
        ].join("\n"), { mode: 0o700 });
        return {
          started: () => existsSync(probes),
          release: () => writeFileSync(gate, "ready"),
          // A turn dispatched with this text would be in the pi dump; none is when the guard refused the send.
          dispatched: (text: string) => piTurns(dumpPath).some((turn) => turn.prompt.includes(text)),
        };
      },
      receipt: () => {
        // Do not retain the fake provider's environment or MCP credentials: the model it was switched to, and the
        // words the turn was given.
        const model = piModelsSet(dumpPath).at(-1);
        return { model: model ? `${model.provider}/${model.modelId}` : "", prompt: piTurns(dumpPath).at(-1)?.prompt ?? "" };
      },
    });
  } finally {
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath }));
  }
}

async function send(fixture: Fixture, botId: string, threadId: string, text: string) {
  await fixture.control("send", "--bot", botId, "--task", threadId, "--text", text);
  expect((await fixture.control("wait", "--bot", botId, "--task", threadId, "--timeout", "30")).status).toBe("settled");
  const messages = (await fixture.api("GET", `/api/threads/${threadId}/messages?limit=20`)).messages;
  expect(messages.findLast((message: any) => message.role === "bot" && message.kind === "text")).toMatchObject({ turnSucceeded: true });
  expect(fixture.receipt().model).toBe(DEFAULT.model);
  expect(fixture.receipt().prompt).toContain(text);
}

it("connecting a provider selects a blank starter and future bot defaults without replacing chosen models", async () => {
  await withUnselectedStarter(async (fixture) => {
    const starter = (await fixture.api("GET", "/api/bots")).bots[0];
    const pinned = (await fixture.api("POST", `/api/bots/${starter.id}/tasks`, { title: "Pinned model" })).task;
    await fixture.api("PATCH", `/api/bots/${starter.id}/tasks/${pinned.threadId}`, { modelSelection: CHOSEN });
    const intentional = (await fixture.api("POST", "/api/bots", { name: "Chosen model", modelSelection: CHOSEN })).bot;
    await fixture.restart({ clearStarter: true });
    const missing = (await fixture.api("GET", "/api/instances")).instances.find((instance: any) => instance.instanceId === "pi");
    expect(missing.snapshot.state).not.toBe("available");
    expect((await fixture.api("GET", "/api/bots")).bots.find((bot: any) => bot.id === starter.id).modelSelection).toEqual(EMPTY);

    await fixture.connect();
    const bots = (await fixture.api("GET", "/api/bots")).bots;
    const connected = bots.find((bot: any) => bot.id === starter.id);
    expect(connected.modelSelection).toEqual(DEFAULT);
    expect(connected.tasks.find((task: any) => task.threadId === starter.threadId)).toMatchObject({ modelSelection: DEFAULT, followsBotModel: true });
    expect(connected.tasks.find((task: any) => task.threadId === pinned.threadId)).toMatchObject({ modelSelection: CHOSEN, followsBotModel: false });
    expect(bots.find((bot: any) => bot.id === intentional.id).modelSelection).toEqual(CHOSEN);
    expect(fixture.saved().find((bot) => bot.id === starter.id).modelSelection).toEqual(DEFAULT);
    expect((await fixture.api("GET", "/api/bot-defaults")).modelSelection).toEqual(DEFAULT);
    expect((await fixture.control("new-bot", "--name", "New default")).bot.modelSelection).toEqual(DEFAULT);
    await send(fixture, starter.id, starter.threadId, "AUTOMATIC_FIRST_CHAT_8P");

    // Restart without altering the persisted bot choices.
    fixture.makeCliAvailable();
    await fixture.restart();
    const reloaded = (await fixture.api("GET", "/api/bots")).bots;
    expect(reloaded.find((bot: any) => bot.id === starter.id).modelSelection).toEqual(DEFAULT);
    expect(reloaded.find((bot: any) => bot.id === intentional.id).modelSelection).toEqual(CHOSEN);
    expect(reloaded.find((bot: any) => bot.id === starter.id).tasks.find((task: any) => task.threadId === pinned.threadId))
      .toMatchObject({ modelSelection: CHOSEN, followsBotModel: false });
  });
}, 120_000);

it("first send discovers a provider installed after startup without requiring the model picker", async () => {
  await withUnselectedStarter(async (fixture) => {
    const starter = (await fixture.api("GET", "/api/bots")).bots[0];
    await fixture.restart({ clearStarter: true });
    expect((await fixture.api("GET", "/api/bots")).bots[0].modelSelection).toEqual(EMPTY);
    fixture.makeCliAvailable();
    // No inventory refresh or provider-setting write between availability and send.
    await send(fixture, starter.id, starter.threadId, "LATE_PROVIDER_FIRST_CHAT_9Q");
    expect((await fixture.api("GET", "/api/bots")).bots[0].modelSelection).toEqual(DEFAULT);
    expect(fixture.saved()[0].modelSelection).toEqual(DEFAULT);
  });
}, 120_000);

// pi has no sign-in of its own, so the two ways its engine is not ready are a CLI that cannot run and one switched off.
it.each(["missing", "disabled"] as const)("does not select a provider that is %s for a blank starter", async (state) => {
  await withUnselectedStarter(async (fixture) => {
    if (state === "disabled") fixture.makeCliAvailable();
    await fixture.restart({ clearStarter: true, enabled: state !== "disabled" });
    const pi = (await fixture.api("GET", "/api/instances")).instances.find((instance: any) => instance.instanceId === "pi");
    if (state === "missing") expect(pi.snapshot.state).not.toBe("available");
    else expect(pi.enabled).toBe(false);
    expect((await fixture.api("GET", "/api/bots")).bots[0].modelSelection).toEqual(EMPTY);
    expect(fixture.saved()[0].modelSelection).toEqual(EMPTY);
  });
}, 120_000);

it.each(["permissions", "branch"] as const)("rechecks guarded %s after held first-run provider discovery", async (change) => {
  await withUnselectedStarter(async (fixture) => {
    const starter = (await fixture.api("GET", "/api/bots")).bots[0];
    let otherLeaf: string | undefined;
    if (change === "branch") {
      await send(fixture, starter.id, starter.threadId, "EARLIER_BRANCH_BEFORE_DISCOVERY_2S");
      const original = await fixture.api("GET", `/api/threads/${starter.threadId}/messages?limit=100`);
      otherLeaf = original.activeLeafId;
      const user = original.messages.find((message: any) => message.role === "user");
      await fixture.api("POST", `/api/bots/${starter.id}/messages/${user.id}/edit`, {
        threadId: starter.threadId, text: "NEW_BRANCH_BEFORE_DISCOVERY_4U",
      });
      expect((await fixture.control("wait", "--bot", starter.id, "--task", starter.threadId, "--timeout", "30")).status).toBe("settled");
    }
    await fixture.restart({ clearStarter: true });
    await fixture.api("PATCH", `/api/bots/${starter.id}/tasks/${starter.threadId}`, { approvalMode: "ask" });
    const page = () => fixture.api("GET", `/api/threads/${starter.threadId}/messages?limit=100`);
    const before = await page();
    const probe = fixture.makeCliAvailable(true);
    const held = fixture.request("POST", `/api/bots/${starter.id}/messages/guarded`, {
      threadId: starter.threadId, sendId: randomUUID(), text: "STALE_GUARDED_DISCOVERY_MUST_NOT_DISPATCH_3T",
      expectedActiveLeafId: before.activeLeafId, expectedApprovalMode: "ask",
    });
    try {
      await expect.poll(probe.started, { timeout: 10_000 }).toBe(true);
      if (change === "permissions") {
        await fixture.api("PATCH", `/api/bots/${starter.id}/tasks/${starter.threadId}`, { approvalMode: "auto" });
      } else {
        await fixture.api("POST", `/api/bots/${starter.id}/active-branch`, { threadId: starter.threadId, messageId: otherLeaf });
      }
      const current = await page();
      if (change === "branch") expect(current.activeLeafId).not.toBe(before.activeLeafId);
      probe.release();
      expect(await held).toMatchObject({ status: 409, body: { code: `guarded_${change}` } });
      expect((await page()).messages).toEqual(current.messages);
      expect(probe.dispatched("STALE_GUARDED_DISCOVERY_MUST_NOT_DISPATCH_3T")).toBe(false);
      expect((await fixture.api("GET", "/api/bots?messages=0")).botQueuedMessages?.[starter.threadId] ?? []).toEqual([]);
    } finally {
      probe.release();
      await held;
    }
  });
}, 120_000);

it("a genuine first install stays unset until its provider CLI can run", async () => {
  const fixture = await launchVerificationServer();
  const { url, dataDir, logPath } = fixture.info;
  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  try {
    // As a machine with nothing installed: the engine's CLI is not there, so no bot gets a model.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const botsPath = join(dataDir, "bots.json");
    const bots = JSON.parse(readFileSync(botsPath, "utf8"));
    bots[0].modelSelection = EMPTY;
    writeFileSync(botsPath, JSON.stringify(bots));
    config.instances.pi = { ...config.instances.pi, config: { ...config.instances.pi.config, cli: join(dataDir, "no-pi-installed.mjs") } };
    writeFileSync(configPath, JSON.stringify(config));
    const log = openSync(logPath, "a", 0o600);
    const server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    try {
      await expect.poll(async () => {
        try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
      }, { timeout: 20_000 }).toBe(true);
      const starter = (await api("GET", "/api/bots")).bots[0];
      expect(starter.modelSelection).toEqual(EMPTY);
      // Installing the CLI is what makes the engine ready; the blank starter takes the default without a picker.
      await api("PATCH", "/api/instances/pi", { cli: FAKE_PI });
      expect((await api("GET", "/api/bots")).bots[0].modelSelection).toEqual(DEFAULT);
      const target = ["--bot", starter.id, "--task", starter.threadId, "--url", url];
      await runControlLunabot(["send", ...target, "--text", "FIRST_INSTALL_PROVIDER_READY_1R"]);
      expect((await runControlLunabot(["wait", ...target, "--timeout", "30"]) as any).status).toBe("settled");
      expect((await api("GET", `/api/threads/${starter.threadId}/messages?limit=20`)).messages
        .findLast((message: any) => message.role === "bot" && message.kind === "text")).toMatchObject({ turnSucceeded: true });
    } finally {
      await waitForExit(server, { signal: "SIGTERM" });
    }
  } finally {
    await fixture.close();
    console.info(JSON.stringify({ logPath }));
  }
}, 120_000);
