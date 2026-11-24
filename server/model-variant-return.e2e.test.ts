// The one agent this build runs (pi) has no model variants: a choice saved with one — as an older build could save for
// an engine that was offline at the time — blocks the direct and the group turn that would run it, and no turn reaches
// the fake provider. A restartable home lets the recipe seed that saved choice between boots.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-lunabot.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { piDumpPath, piTurns } from "./testing/pi-dump.ts";

it("blocks direct and group turns when the saved model variant cannot be applied", async () => {
  const fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  const dumpPath = piDumpPath(dataDir);
  let restarted: ChildProcess | undefined;
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5_000),
    });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const created = await api("POST", "/api/bots", { name: "Returning engine fixture" });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    const peer = await api("POST", "/api/bots", { name: "Idle peer fixture" });
    expect(peer.status).toBe(201);
    const createdGroup = await api("POST", "/api/groups", {
      name: "Returning engine group", memberIds: [bot.id, peer.body.bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    });
    expect(createdGroup.status).toBe(201);
    const group = createdGroup.body.group;
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    // The saved choice an older build could keep while its engine was away: a variant on pi's own model.
    const selection = { instanceId: "pi", model: bot.modelSelection.model, variant: "low" };
    const botsPath = join(dataDir, "bots.json");
    const bots = JSON.parse(readFileSync(botsPath, "utf8")) as any[];
    const saved = bots.find((entry) => entry.id === bot.id);
    saved.modelSelection = selection;
    for (const task of saved.tasks) task.modelSelection = selection;
    writeFileSync(botsPath, JSON.stringify(bots, null, 2));
    const env: NodeJS.ProcessEnv = {
      HOME: dataDir, USERPROFILE: dataDir, LUNABOT_DATA_DIR: dataDir,
      APPDATA: join(dataDir, "AppData", "Roaming"), LOCALAPPDATA: join(dataDir, "AppData", "Local"),
      XDG_CONFIG_HOME: join(dataDir, ".config"), XDG_CACHE_HOME: join(dataDir, ".cache"),
      XDG_DATA_HOME: join(dataDir, ".local", "share"), HERMES_HOME: join(dataDir, ".hermes"),
      TEMP: join(dataDir, "tmp"), TMP: join(dataDir, "tmp"), TMPDIR: join(dataDir, "tmp"),
      LUNABOT_PORT: new URL(url).port, LUNABOT_WEBHOOK_PORT: String(Number(new URL(url).port) + 1),
      PATH: dirname(process.execPath), FAKE_PI_DUMP: dumpPath,
    };
    for (const key of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await api("GET", "/api/bots")).status; } catch { return 0; }
    }, { timeout: 20_000 }).toBe(200);
    const instances = (await api("GET", "/api/instances")).body.instances;
    const returning = instances.find((entry: any) => entry.instanceId === selection.instanceId);
    expect(returning.capabilities.modelVariants).toBe(false);
    const current = (await api("GET", "/api/bots")).body.bots.find((entry: any) => entry.id === bot.id);
    expect(current.modelSelection).toEqual(selection);
    expect(piTurns(dumpPath)).toEqual([]);
    const direct = await api("POST", `/api/bots/${bot.id}/messages`, { text: "Direct guard fixture", threadId: current.threadId });
    expect(direct.status).toBe(409);
    expect(direct.body.error).toContain("saved model variant cannot be applied");
    const sent = await api("POST", `/api/groups/${group.id}/messages`, { text: "Group guard fixture" });
    expect(sent.status).toBe(202);
    const messages = async () => {
      const rows = (await api("GET", `/api/threads/${group.threadId}/messages?limit=20`)).body.messages;
      evidence.splice(1, 1, { direct, groupSend: sent.status, groupMessages: rows, providerPromptStarted: piTurns(dumpPath).length > 0 });
      return rows;
    };
    await expect.poll(async () => (await messages()).some((message: any) =>
      message.kind === "activity" && message.tool?.ok === false && message.tool.name.includes("saved model variant cannot be applied")),
    { timeout: 10_000 }).toBe(true);
    expect(piTurns(dumpPath), "Neither rejected turn may reach the fake provider prompt").toEqual([]);
    evidence.push({ selection, returnedCapabilities: returning.capabilities, direct, groupSend: sent.status, groupMessages: await messages(), providerPromptStarted: false });
  } finally {
    const evidencePath = `${logPath}.model-variant-return.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}, 45_000);
