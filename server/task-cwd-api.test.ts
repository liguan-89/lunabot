import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { piDumpPath, piTurns, piTurnText } from "./testing/pi-dump.ts";

it("pins an explicitly chosen new-thread folder without moving existing sessions or the bot default", async () => {
  const fixture = await launchVerificationServer({ ...process.env, LUNABOT_TEST_FIXTURE_ENGINE: "pi" },
    undefined, undefined, undefined, undefined, { scripted: true });
  const evidence: unknown[] = [];
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() as any };
    // Pairing credentials stay inside this disposable test, never in evidence.
    if (!path.startsWith("/api/auth/")) evidence.push({ method, path, body, result });
    return result;
  };
  const control = async (args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  try {
    const original = join(fixture.info.dataDir, "original");
    const chosen = join(fixture.info.dataDir, "chosen");
    const later = join(fixture.info.dataDir, "later");
    for (const folder of [original, chosen, later]) mkdirSync(folder);
    const file = join(chosen, "README.md");
    writeFileSync(file, "Fixture project\n");
    const { bot } = (await api("POST", "/api/bots", { name: "Folder fixture" })).body;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { cwd: original })).status).toBe(200);
    const ordinary = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Default at first turn" });
    expect(ordinary.status).toBe(201);
    expect(ordinary.body.task).not.toHaveProperty("cwd");
    const explicit = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Chosen before first turn", cwd: `  ${chosen}  ` });
    expect(explicit.status).toBe(201);
    expect(explicit.body.task.cwd).toBe(chosen);
    expect(explicit.body.bot.cwd).toBe(original);
    const threadId = explicit.body.task.threadId;
    const persisted = () => JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8")).find((item: any) => item.id === bot.id);
    expect(persisted().tasks.find((task: any) => task.threadId === threadId).cwd).toBe(chosen);

    const beforeInvalid = persisted().tasks.length;
    for (const cwd of ["relative/path", join(chosen, "missing"), file, 7, [], null, ""]) {
      expect((await api("POST", `/api/bots/${bot.id}/tasks`, { cwd })).status).toBe(400);
    }
    expect(persisted().tasks).toHaveLength(beforeInvalid);
    expect(persisted().threadId).toBe(threadId);
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { cwd: later })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { cwd: later })).status).toBe(200);

    // The fake pi writes its proof into its own working folder, so each turn names the folder the server pinned.
    const PROOF = "cwd-proof.txt";
    writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify({
      [bot.id]: { script: [{ key: "mark-cwd", match: [], repeat: true, writeFiles: { [PROOF]: "pinned" } }] },
    }));
    const dumpPath = piDumpPath(fixture.info.dataDir);
    const run = async (task: string, text: string, expectedCwd: string) => {
      for (const folder of [original, chosen, later]) rmSync(join(folder, PROOF), { force: true });
      await control(["send", "--bot", bot.id, "--task", task, "--text", text]);
      expect((await control(["wait", "--bot", bot.id, "--task", task, "--timeout", "30"])).status).toBe("settled");
      expect(existsSync(join(expectedCwd, PROOF)), `the turn must run in ${expectedCwd}`).toBe(true);
      const turn = piTurns(dumpPath).at(-1);
      evidence.push({ receipt: { cwd: expectedCwd, prompt: turn ? piTurnText(turn) : null } });
    };
    await run(threadId, "Check the explicitly chosen project", chosen);
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { cwd: original })).status).toBe(400);
    await run(threadId, "Continue in the same project", chosen);
    await run(ordinary.body.task.threadId, "Use the current bot default", later);
    expect(persisted().tasks.find((task: any) => task.threadId === threadId).cwd).toBe(chosen);
    expect(persisted().cwd).toBe(later);
    await control(["messages", "--bot", bot.id, "--task", threadId, "--limit", "10"]);

    const pairing = (await api("POST", "/api/auth/pairing", { scopes: ["client"] })).body;
    const session = (await api("POST", "/api/auth/pair", { code: pairing.code, label: "Chat-only fixture" })).body;
    expect(typeof session.token).toBe("string");
    const beforeClient = persisted().tasks.length;
    expect((await api("POST", `/api/bots/${bot.id}/tasks`, { cwd: chosen }, session.token)).status).toBe(403);
    expect((await api("POST", `/api/bots/${bot.id}/tasks`, { cwd: "missing" }, session.token)).status).toBe(403);
    expect(persisted().tasks).toHaveLength(beforeClient);
    expect((await api("POST", `/api/bots/${bot.id}/tasks`, {}, session.token)).status).toBe(201);
  } finally {
    const evidencePath = `${fixture.info.logPath}.task-cwd.json`;
    writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, evidence }, null, 2));
    console.info(JSON.stringify({ evidencePath, logPath: fixture.info.logPath }));
    await fixture.close();
  }
}, 90_000);
