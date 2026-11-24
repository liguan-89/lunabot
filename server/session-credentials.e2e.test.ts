// One pi process per conversation, kept warm across turns: its launch log (server/testing/pi-dump.ts) says which process
// ran each turn and what it mounted, and the agents capability that launch carried is live only while its turn runs.
// This build runs one engine (pi); the retired ACP half of this check went with the ACP engines.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlLunabot, verificationServerEnvironment } from "../scripts/control-lunabot.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { piDumpPath, piTurns, type PiTurn } from "./testing/pi-dump.ts";

// The stand-in browser is a node script run through its shebang.
const withBrowser = process.platform !== "win32";
// Auto may land on this computer only on macOS and Windows.
const itAutoThisComputer = process.platform === "linux" ? it.skip : it;

async function fixture(test: (f: any) => Promise<void>, { thisComputer = false } = {}) {
  const session = await launchVerificationServer();
  const { dataDir, url, logPath } = session.info;
  let server: ChildProcess | undefined;
  try {
    const userData = join(dataDir, "user-data");
    const release = join(dataDir, "release");
    const browser = join(dataDir, "agent-browser.mjs");
    writeFileSync(browser, [
      "#!/usr/bin/env node",
      'if (process.argv[2] === "session" && process.argv[3] === "list") process.stdout.write(JSON.stringify({ success: true, data: { sessions: [] } }));',
    ].join("\n"), { mode: 0o700 });
    if (thisComputer) {
      // What the desktop app hands its own server once its driver is running.
      mkdirSync(userData, { recursive: true });
      writeFileSync(join(userData, "cua-connection.json"), JSON.stringify({
        mode: "embedded", status: "ready", socketPath: join(dataDir, "cua.sock"),
        mcpCommand: "/fixture/cua-driver", mcpArgs: ["mcp"], mcpEnv: {},
      }), { mode: 0o600 });
    }
    // The launcher's own server only wrote the fixture's config and its fake pi; this recipe starts its own, with the
    // knobs its turns need.
    await waitForExit(session.child, { signal: "SIGTERM" });
    const log = openSync(logPath, "a", 0o600);
    // With this computer, started as the desktop app starts its own server, which hears the driver record over its parent port.
    server = spawn(process.execPath, ["--experimental-strip-types",
      ...(thisComputer ? ["--import", pathToFileURL(fileURLToPath(new URL("./testing/desktop-parent.mjs", import.meta.url))).href] : []),
      fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        // Each turn runs until `release` exists (the retired fixture's `hang`), so a warm process can be watched across
        // turns and a held turn keeps its agents capability live.
        ...verificationServerEnvironment({ FAKE_PI_CLAUDE_COMPAT: "1", FAKE_PI_MODE: "hang", FAKE_PI_RELEASE: release }, dataDir, Number(new URL(url).port)),
        ...(withBrowser ? { LUNABOT_AGENT_BROWSER_PATH: browser } : {}),
        ...(thisComputer ? { LUNABOT_TEST_DESKTOP_CUA_CONNECTION: join(userData, "cua-connection.json") } : {}),
      },
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);

    const dump = () => piDumpPath(dataDir);
    /** The turns this conversation's pi child was given, in order; each carries the launch it ran on. */
    const turnsOf = (threadId: string): PiTurn[] => piTurns(dump())
      .filter((turn) => turn.launch?.mcpConfig?.mcpServers?.agents?.env?.LUNABOT_THREAD_ID === threadId);
    /** The pi processes that served the conversation: a warm child keeps its pid across the turns it runs. */
    const processes = (threadId: string): number[] => [...new Set(turnsOf(threadId).map((turn) => turn.launch?.pid).filter((pid): pid is number => typeof pid === "number"))];
    const lastOf = (threadId: string) => turnsOf(threadId).at(-1)?.launch;
    const mountedOf = (threadId: string) => Object.keys(lastOf(threadId)?.mcpConfig?.mcpServers ?? {});
    const tokenOf = (threadId: string) => lastOf(threadId)?.mcpConfig?.mcpServers?.agents?.env?.LUNABOT_COMMS_TOKEN as string | undefined;
    const controlOf = (threadId: string) => lastOf(threadId)?.mcpConfig?.mcpServers?.computer?.env?.LUNABOT_CONTROL_TOKEN as string | undefined;
    const cli = (...args: string[]) => runControlLunabot([...args, "--url", url]) as Promise<any>;
    const api = async (method: string, path: string, body?: unknown, token?: string) => {
      const response = await fetch(url + path, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : { origin: url }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
      return { status: response.status, body: await response.json().catch(() => ({})) as any };
    };
    const busy = async (bot: any, threadId: string) => (await api("GET", "/api/bots")).body.bots
      .find((entry: any) => entry.id === bot.id)?.tasks.find((task: any) => task.threadId === threadId)?.busy === true;
    const turn = async (bot: any, threadId: string, text: string) => {
      writeFileSync(release, "go");
      await cli("send", "--bot", bot.id, "--task", threadId, "--text", text);
      expect((await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    };
    const hold = async (bot: any, threadId: string, text: string) => {
      rmSync(release, { force: true });
      await cli("send", "--bot", bot.id, "--task", threadId, "--text", text);
      await expect.poll(() => busy(bot, threadId), { timeout: 15_000 }).toBe(true);
    };
    const finish = async (bot: any, threadId: string) => {
      writeFileSync(release, "go");
      expect((await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    };
    const agents = async (token: string) => (await api("GET", "/api/internal/agents", undefined, token)).status;
    await test({ dataDir, cli, api, turn, hold, finish, agents, processes, mountedOf, tokenOf, controlOf });
  } finally {
    if (server) await waitForExit(server, { signal: "SIGTERM" });
    await session.close();
  }
}

it("keeps a thread's pi process across turns, with agents and the browser mounted", () => fixture(async (f) => {
  const { bot } = await f.cli("new-bot", "--name", "Warm pi");
  const thread = bot.activeTaskId;
  for (const text of ["First question.", "Second question.", "Third question.", "Fourth question."]) await f.turn(bot, thread, text);
  expect(f.processes(thread), "one process ran every turn").toHaveLength(1);
  expect(f.mountedOf(thread)).toEqual(expect.arrayContaining(withBrowser ? ["agents", "browser"] : ["agents"]));
}), 120_000);

it("honours a thread's credential only while its turns run, and retires it on Stop, a lower approval level and bot deletion", () => fixture(async (f) => {
  const { bot } = await f.cli("new-bot", "--name", "Credential holder");
  const thread = bot.activeTaskId;
  await f.turn(bot, thread, "Warm up.");
  const token = f.tokenOf(thread);
  expect(token).toMatch(/^[a-f0-9]{48}$/);
  expect(await f.agents(token)).toBe(401);
  await f.hold(bot, thread, "Next question.");
  expect(f.tokenOf(thread)).toBe(token);
  expect(await f.agents(token)).toBe(200);
  await f.finish(bot, thread);
  expect(await f.agents(token)).toBe(401);

  await f.hold(bot, thread, "Something long.");
  expect(await f.agents(token)).toBe(200);
  expect((await f.api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: thread })).status).toBe(200);
  expect(await f.agents(token)).toBe(401);
  const stopped = f.processes(thread).length;
  await f.hold(bot, thread, "Start again.");
  await expect.poll(() => f.processes(thread).length, { timeout: 15_000 }).toBeGreaterThan(stopped);
  const restarted = f.tokenOf(thread);
  expect(restarted).not.toBe(token);
  expect(await f.agents(token)).toBe(401);
  expect(await f.agents(restarted)).toBe(200);
  await f.finish(bot, thread);

  // This build's levels are Ask, Auto, Full and Custom (the retired "accept edits" mode was the Claude CLI's own).
  expect((await f.api("PATCH", `/api/bots/${bot.id}/tasks/${thread}`, { approvalMode: "auto" })).status).toBe(200);
  await f.turn(bot, thread, "Edit freely.");
  const raised = f.tokenOf(thread);
  expect((await f.api("PATCH", `/api/bots/${bot.id}/tasks/${thread}`, { approvalMode: "ask" })).status).toBe(200);
  const before = f.processes(thread).length;
  await f.hold(bot, thread, "Ask first now.");
  // A different approval level is a different boot contract, so the warm child is replaced and its credential retires.
  await expect.poll(() => f.processes(thread).length, { timeout: 15_000 }).toBeGreaterThan(before);
  const lowered = f.tokenOf(thread);
  expect(lowered).not.toBe(raised);
  expect(await f.agents(raised)).toBe(401);
  expect(await f.agents(lowered)).toBe(200);

  expect((await f.api("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
  expect(await f.agents(lowered)).toBe(401);
}), 120_000);

itAutoThisComputer("keeps a thread's pi process across turns on Auto with this computer mounted", () => fixture(async (f) => {
  const { bot } = await f.cli("new-bot", "--name", "Warm desktop");
  const thread = bot.activeTaskId;
  for (const text of ["First question.", "Second question.", "Third question.", "Fourth question."]) await f.turn(bot, thread, text);
  expect(f.processes(thread), "one process ran every turn").toHaveLength(1);
  expect(f.mountedOf(thread)).toEqual(expect.arrayContaining(["agents", "computer"]));
  expect(f.controlOf(thread)).toMatch(/^[a-f0-9]{48}$/);
}, { thisComputer: true }), 120_000);
