// Real isolated server, with the synthetic pi asking a person's permission through its own extension-UI confirm (the
// retired fixture's broker socket is gone). On a Windows runner the floor is not applied, so the test checks that
// instead and stops there. The "engine" asking for permission is the fake pi, told one command per turn by a wrapper in
// this fixture's own data folder: no command named here is run by anything, and no live data is touched.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

/** The words every turn's prompt carries, which make the fake pi ask a person's permission instead of replying. */
const ASKS = "Hold this verification task";
const BLOCKED = "notice: Blocked by the safety floor";

it("denies a never-list command a grant would have allowed, at a saved command and at Full access, and leaves a person's card alone", async () => {
  const fixture = await launchVerificationServer();
  const { url, dataDir, logPath } = fixture.info;
  const commandFile = join(dataDir, "fixture-command.txt");
  let restarted: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, { method, headers: { origin: url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    return result;
  };
  const rows = async (thread: string): Promise<any[]> => (await api("GET", `/api/threads/${thread}/messages?limit=200`)).messages;
  const notices = async (thread: string): Promise<string[]> => (await rows(thread))
    .flatMap(message => message.kind === "activity" && typeof message.tool?.name === "string" && message.tool.name.startsWith(BLOCKED) ? [message.tool.name] : []);
  const decisions = async () => (await api("GET", "/api/decisions")).decisions as Array<Record<string, any>>;
  const idle = async (bot: any) => expect.poll(async () => (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id)?.busy,
    { timeout: 20_000 }).toBe(false);
  /** Start a turn that asks the person's permission for `command`, and return the card it raised, if any: the server
   * answers for the person when a grant covers the command. The fake pi names its confirm "Allow bash?" and carries the
   * call's input, which is where the server reads the command line from. */
  const start = async (bot: any, command: string) => {
    writeFileSync(commandFile, command);
    const known = new Set((await rows(bot.threadId)).filter((message) => message.card?.requestId).map((message) => message.id));
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `${ASKS} while its approvals are exercised.` }, 202);
    let card: any;
    try {
      await expect.poll(async () => {
        card = (await rows(bot.threadId)).find((message) => message.card?.requestId && !known.has(message.id))?.card;
        return Boolean(card);
      }, { timeout: 8_000, interval: 100 }).toBe(true);
    } catch {
      card = undefined;
    }
    return card;
  };
  /** One request the server answered by itself: no card, and a decision row of its own. */
  const answered = async (bot: any, command: string, expected: { decision: string; source: string; rule?: string }) => {
    const seen = (await decisions()).length;
    expect(await start(bot, command), `a card was raised for ${JSON.stringify(command)}`).toBeUndefined();
    await expect.poll(async () => (await decisions()).slice(seen), { timeout: 15_000 })
      .toContainEqual(expect.objectContaining({ decision: expected.decision, source: expected.source, tool: "bash", botId: bot.id, ...(expected.rule ? { rule: expected.rule } : {}) }));
    await idle(bot);
  };
  /** The fold answered by itself: a deny carrying the reason, one line the person sees, one decision row, and no card. */
  const expectFloored = async (bot: any, command: string, label: string, rule: string) => {
    const before = (await decisions()).length;
    expect(await start(bot, command), "a never-list command never becomes a card").toBeUndefined();
    await expect.poll(async () => await notices(bot.threadId), { timeout: 15_000 }).toContain(`${BLOCKED}: ${label}`);
    await expect.poll(async () => (await decisions()).slice(before), { timeout: 15_000 })
      .toContainEqual(expect.objectContaining({ decision: "auto-denied", source: "safety-floor", rule, tool: "bash", botId: bot.id }));
    await idle(bot);
  };
  const stop = (bot: any) => api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
  try {
    const bot = (await api("POST", "/api/bots", { name: "Safety floor fixture" }, 201)).bot;
    // A warm pi child serves several turns, so the wrapper keeps the confirm's input in step with the file the test
    // writes before each turn: it is the server that decides what to do with the command it reads there.
    const wrapper = join(dataDir, "pi-asking.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'import { readFileSync } from "node:fs";',
      `process.env.FAKE_PI_PERMISSION_ON = ${JSON.stringify(ASKS)};`,
      'process.env.FAKE_PI_CONFIRM_TITLE = "Allow bash?";',
      `const sync = () => { try { process.env.FAKE_PI_CONFIRM_MESSAGE = JSON.stringify({ command: readFileSync(${JSON.stringify(commandFile)}, "utf8") }); } catch {} };`,
      "// The fake pi's own stdin listener is registered after this one, so a prompt's bytes refresh the confirm first.",
      'process.stdin.on("data", sync); sync(); setInterval(sync, 50).unref?.();',
      `await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL("./testing/fake-pi-cli.ts", import.meta.url))).href)});`,
    ].join("\n"), { mode: 0o700 });
    await api("PATCH", "/api/instances/pi", { cli: wrapper });
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { approvalMode: "ask" });
    const wipe = "rm -rf /";

    // Off by default. A person answers the card and saves the command; the
    // saved command then answers the next request, exactly as before. A
    // never-list command is a danger card, so the card itself offers no
    // "Always allow this command": the rule below is saved through the API.
    const first = await start(bot, wipe);
    expect(first?.requestType).toBe("permission");
    expect(first.commandAllowlist).toBeUndefined();
    expect((await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: first.requestId, behavior: "allow", rememberCommand: true })).outcome).toBe("allowed-once");
    await idle(bot);
    await answered(bot, wipe, { decision: "auto-approved", source: "command-allowlist" });
    expect(await notices(bot.threadId)).toEqual([]);

    // Switched on in Settings: it applies to the very next request.
    expect((await api("GET", "/api/config")).safetyFloor).toEqual({ enabled: false });
    await api("PUT", "/api/config", { safetyFloor: { enabled: true } });
    if (process.platform === "win32") {
      // Not applied on a Windows server yet. The setting is saved, the
      // server reports the floor as not in force, and the saved command
      // goes on answering exactly as it did with the setting off.
      expect((await api("GET", "/api/config")).safetyFloor).toEqual({ enabled: false });
      await answered(bot, wipe, { decision: "auto-approved", source: "command-allowlist" });
      expect(await notices(bot.threadId)).toEqual([]);
      await stop(bot);
      return;
    }
    expect((await api("GET", "/api/config")).safetyFloor).toEqual({ enabled: true });
    await expectFloored(bot, wipe, "recursive delete of the filesystem root", "delete-root");
    expect(await notices(bot.threadId)).toHaveLength(1);

    // A card a person answers is not overridden: at Ask an unsaved never-list
    // command still reaches them, and their Allow stands.
    const theirs = await start(bot, "rm -rf ~");
    expect(theirs?.requestType).toBe("permission");
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: theirs.requestId, behavior: "allow" });
    await idle(bot);
    expect(await notices(bot.threadId)).toHaveLength(1);
    await stop(bot);

    // Restart with the file's switch removed and only LUNABOT_SAFETY_FLOOR=1 set,
    // then give the bot Full access the way a person does.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const { safetyFloor: _removed, ...saved } = JSON.parse(readFileSync(configPath, "utf8"));
    expect(_removed).toEqual({ enabled: true });
    writeFileSync(configPath, JSON.stringify(saved, null, 2));
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), LUNABOT_SAFETY_FLOOR: "1" },
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    // the file no longer enables it; the environment alone does
    expect(JSON.parse(readFileSync(configPath, "utf8")).safetyFloor).toBeUndefined();
    expect((await api("GET", "/api/config")).safetyFloor).toEqual({ enabled: true });
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { approvalMode: "full" });

    // Full access answers every request except one on the never-list.
    await expectFloored(bot, "sudo rm -rf /etc", "recursive delete of /etc", "delete-system-directory");
    await answered(bot, "printf 'safety floor fixture'", { decision: "auto-approved", source: "full-access" });
    // the same words as data are not a command
    await answered(bot, "git commit -m 'never run rm -rf /'", { decision: "auto-approved", source: "full-access" });
    expect(await notices(bot.threadId)).toHaveLength(2);
    await stop(bot);
    console.info(`Safety floor real-server verification passed; isolated log: ${logPath}`);
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    rmSync(commandFile, { force: true });
  }
}, 120_000);
