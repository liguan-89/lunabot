// Real isolated server with the fake pi engine: pi raises its own confirmation card, the person answers it once, and the
// decision log records who answered. pi offers no structured command approvals, so there is no command rule to save,
// scope or revoke: this recipe proves that absence and that the card still waits for the person either way.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-lunabot.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { piDumpPath, piTurns } from "./testing/pi-dump.ts";

it("never saves a command rule on this engine, and its approval card waits for the person and keeps their answer", async () => {
  const fixture = await launchVerificationServer({ FAKE_PI_PERMISSION_ON: "Hold this verification task" });
  const { url, dataDir, logPath } = fixture.info;
  const dumpPath = piDumpPath(dataDir);
  let restarted: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200, token?: string) => {
    const response = await fetch(url + path, { method, headers: {
      origin: url, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    return result;
  };
  const messages = async (thread: string): Promise<any[]> => (await api("GET", `/api/threads/${thread}/messages?limit=100`)).messages;
  const openCard = async (thread: string) => {
    let found: any;
    await expect.poll(async () => {
      found = (await messages(thread)).filter((message) => message.card?.requestId && !message.card.answered).at(-1);
      return Boolean(found);
    }, { timeout: 15_000 }).toBe(true);
    return found.card;
  };
  /** One held turn: the approval card it asks with, and the decision rows the answer left. */
  const start = async (bot: any, thread = bot.threadId ?? bot.activeTaskId) => {
    const since = piTurns(dumpPath).length;
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: thread, text: "Hold this verification task while its native command approvals are exercised." }, 202);
    await expect.poll(() => piTurns(dumpPath).length > since, { timeout: 15_000 }).toBe(true);
    return openCard(thread);
  };
  const stop = (bot: any, thread = bot.threadId ?? bot.activeTaskId) => api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: thread });
  try {
    const bot = (await api("POST", "/api/bots", { name: "Command rules fixture" }, 201)).bot as { id: string; threadId?: string; activeTaskId: string };
    const main = bot.threadId ?? bot.activeTaskId;
    // The bot on Ask, so every thread it opens asks before acting.
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" });
    const rulesPath = `/api/bots/${bot.id}/command-allowlist`;
    // pi supplies no structured command approvals: the app says so, saves no rule, and offers no rule on a card.
    const listed = await api("GET", rulesPath);
    expect(listed).toMatchObject({ rules: [], supported: false });
    expect(listed.context.providerInstanceId).toBe("pi");
    expect((await api("POST", rulesPath, { command: "printf 'allowlist fixture'", cwd: listed.context.cwd, providerInstanceId: "pi" }, 400)).error)
      .toContain("does not supply structured command approvals");

    const first = await start(bot);
    expect(first).toMatchObject({ requestType: "permission" });
    expect(first.commandAllowlist).toBeUndefined();
    // Asking to remember one is refused plainly: there is nothing structured to remember.
    expect((await api("POST", `/api/threads/${main}/respond`, { requestId: first.requestId, behavior: "allow", rememberCommand: true }, 403)).error)
      .toContain("Allow it once instead");
    expect((await api("POST", `/api/threads/${main}/respond`, { requestId: first.requestId, behavior: "allow" })).outcome).toBe("allowed-once");
    expect((await api("GET", rulesPath)).rules).toEqual([]);
    for (const profile of (await api("GET", "/api/bots")).bots) expect(profile).not.toHaveProperty("commandAllowlist");
    await stop(bot);

    // The person's own answer is on the record, under the card they answered.
    const decisions = async () => (await api("GET", "/api/decisions")).decisions as Array<{ requestId: string; decision: string; source?: string }>;
    await expect.poll(async () => (await decisions()).some((row) => row.requestId === first.requestId && row.decision === "user-approved")).toBe(true);
    expect((await decisions()).find((row) => row.requestId === first.requestId && row.decision === "user-approved")?.source).not.toBe("command-allowlist");

    // A second ask is a second card: nothing carried over from the first answer.
    const sibling = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Different folder" }, 201)).task;
    const other = await start(bot, sibling.threadId);
    expect(other.requestId).toBeDefined();
    expect(other.commandAllowlist).toBeUndefined();
    expect((await api("POST", `/api/threads/${sibling.threadId}/respond`, { requestId: other.requestId, behavior: "deny" })).outcome).toBe("rejected");
    await expect.poll(async () => (await decisions()).some((row) => row.requestId === other.requestId && row.decision === "user-denied")).toBe(true);
    await stop(bot, sibling.threadId);

    // Across a restart nothing is remembered, because nothing was ever saved.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({ FAKE_PI_PERMISSION_ON: "Hold this verification task" }, dataDir, Number(new URL(url).port)),
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    expect(await api("GET", rulesPath)).toMatchObject({ rules: [], supported: false });
    const restored = await start(bot);
    expect(restored.commandAllowlist).toBeUndefined();
    expect((await api("POST", `/api/threads/${main}/respond`, { requestId: restored.requestId, behavior: "allow" })).outcome).toBe("allowed-once");
    await stop(bot);
    console.info(`Command allowlist verification passed on pi; isolated log: ${logPath}`);
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 90_000);
