// Automatic recovery in the one-agent build.
//
// The feature's start-up path needs an engine that fails a turn *before* its prompt is accepted
// (TurnNotStartedError) and a second model to take the work. pi now classifies exactly those
// failures — a child that dies or a model selection that fails before the prompt frame goes out —
// so the fixture drives one with FAKE_PI_EXIT_ON_FIRST_MODEL and the recovery replays the turn on
// the configured backup model of the same instance. What pi still never produces are the retired
// refusal classes (sign-out, usage limit): a turn that fails after its prompt was accepted is
// reported and never replayed, which the turn-error recipe covers.
//
// Subtests removed with the multi-engine fixtures, and why:
// - "keeps a Set me up request a setup turn on the backup", "recovers a coordinated specialist…",
//   "uses the ordered bot list only for proven pre-prompt failures", "does not automatically
//   replay when …", "stops after one failed backup…", "uses the configured … backup when Claude
//   refuses a turn because it is signed out", "preserves the sign-in error…" and "does not
//   recover a superseded turn after …" all drove a primary CLI of a *different engine* failing
//   during start-up. That second engine no longer exists: the backup is a second pi model.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLunabot } from "../scripts/control-lunabot.ts";
import { piDumpPath, piModelsSet, piTurns, piTurnText } from "./testing/pi-dump.ts";

const MARKER = "DO_NOT_REPLAY_THIS_9S";

async function withRecoveryFixture(
  fakeEnv: Record<string, string>,
  check: (fixture: {
    api: (method: string, path: string, body?: unknown, expectedStatus?: number) => Promise<any>;
    control: (...args: string[]) => Promise<any>;
    /** The pi model a bot runs on by default, and a different model of the same instance to recover onto. */
    model: string;
    backup: string;
    /** The prompts the fake pi was given; its launch log also holds every model switch. */
    turns: () => ReturnType<typeof piTurns>;
    modelsSet: () => Array<{ provider: string; modelId: string }>;
    dataDir: string;
    evidence: unknown[];
  }) => Promise<void>,
) {
  const fixture = await launchVerificationServer({ ...process.env, ...fakeEnv });
  const { url, dataDir, logPath } = fixture.info;
  const dumpPath = piDumpPath(dataDir);
  const evidence: unknown[] = [{ url, fakeEnv }];
  const api = async (method: string, path: string, body?: unknown, expectedStatus?: number) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    const context = `${method} ${path}: ${JSON.stringify(result)}`;
    if (expectedStatus === undefined) expect(response.ok, context).toBe(true);
    else expect(response.status, context).toBe(expectedStatus);
    return result;
  };
  const control = async (...args: string[]) => {
    const result = await runControlLunabot([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  try {
    const { instances } = await api("GET", "/api/instances") as {
      instances: Array<{ instanceId: string; models: { default: string; options: Array<{ id: string }> } }>;
    };
    const pi = instances.find((instance) => instance.instanceId === "pi")!;
    const model = pi.models.default;
    // "default" is the synthetic always-selectable option (pi's own default
    // model): selecting it sends no set_model, so it is no recovery evidence.
    const backup = pi.models.options.map((option) => option.id).find((id) => id !== model && id !== "default") ?? model;
    expect(backup, "the fake pi offers a second model to recover onto").not.toBe(model);
    // Chief first makes the starter its team's Chief, which answers a teammate's failed run with a
    // "Problems to look at" turn of its own. Stepped down, only the runs under test run.
    const { bots } = await api("GET", "/api/bots") as { bots: Array<{ id: string; chiefOfStaff?: boolean }> };
    const starter = bots.find((bot) => bot.chiefOfStaff)!;
    await api("PATCH", `/api/bots/${starter.id}`, { chiefOfStaff: false });
    await check({
      api, control, model, backup, dataDir, evidence,
      turns: () => piTurns(dumpPath),
      modelsSet: () => piModelsSet(dumpPath),
    });
  } finally {
    evidence.push({ turns: piTurns(dumpPath), launches: existsSync(dumpPath) ? readFileSync(dumpPath, "utf8").split("\n").length : 0 });
    const evidencePath = `${logPath}.automatic-recovery.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    await fixture.close();
    console.info(JSON.stringify({ logPath, evidencePath }));
  }
}

it("rejects missing or unavailable backup settings through the API without changing the saved recovery choice", async () => {
  await withRecoveryFixture({}, async ({ api, backup, evidence }) => {
    const before = (await api("GET", "/api/config")).automaticRecovery;
    const missing = await api("PUT", "/api/config", { automaticRecovery: { enabled: true } }, 400);
    expect(missing.error).toMatch(/backup|automaticRecovery/i);
    const unavailable = await api("PUT", "/api/config", {
      automaticRecovery: { enabled: true, backup: { instanceId: "missing-fixture-engine", model: "missing-model" } },
    }, 400);
    expect(unavailable.error).toMatch(/unavailable/i);
    expect((await api("GET", "/api/config")).automaticRecovery).toEqual(before);
    // The fixture's one engine offers its other model as the backup.
    const allowed = { enabled: true, backup: { instanceId: "pi", model: backup } };
    await api("PUT", "/api/config", { automaticRecovery: allowed });
    expect((await api("GET", "/api/config")).automaticRecovery).toEqual(allowed);
    await api("PUT", "/api/config", { automaticRecovery: { enabled: false } });
    expect((await api("GET", "/api/config")).automaticRecovery).toEqual({ enabled: false });
    evidence.push({ rejectedSettings: [missing, unavailable], acceptedSettings: allowed });
  });
}, 90_000);

it("replays a turn once on the configured backup when pi dies before its prompt", async () => {
  // FAKE_PI_EXIT_ON_FIRST_MODEL kills the child while it selects the bot's model,
  // before the prompt frame: a provably un-started turn, which the driver rejects
  // with TurnNotStartedError and the harness replays on the backup model.
  await withRecoveryFixture({ FAKE_PI_EXIT_ON_FIRST_MODEL: "1" }, async ({ api, control, model, backup, turns, modelsSet, evidence }) => {
    await api("PUT", "/api/config", { automaticRecovery: { enabled: true, backup: { instanceId: "pi", model: backup } } });
    const { bot } = await control("new-bot", "--name", "Recovered");
    const threadId = bot.activeTaskId;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, {
      modelSelection: { instanceId: "pi", model }, updateBotDefault: true,
    });
    await control("send", "--bot", bot.id, "--task", threadId, "--text", MARKER);
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");

    // The backup model was selected and answered; the primary never got the prompt.
    const switched = modelsSet().map((entry) => `${entry.provider}/${entry.modelId}`);
    expect(switched).toContain(backup);
    expect(turns().map(piTurnText).filter((text) => text.includes(MARKER))).toHaveLength(1);

    const { messages } = (await api("GET", `/api/threads/${threadId}/messages?limit=100`)) as { messages: any[] };
    // The person's words once, a recovery row explaining the switch, and the backup's answer.
    expect(messages.filter((message) => message.role === "user" && message.text === MARKER)).toHaveLength(1);
    expect(messages.some((message) => message.tool?.name?.startsWith("recovery:"))).toBe(true);
    expect(messages.some((message) => message.role === "bot" && message.kind === "text")).toBe(true);

    // The thread now runs on its backup, and the bot is idle, not failed.
    const state = (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
    expect(state.tasks.find((task: any) => task.threadId === threadId)).toMatchObject({
      modelSelection: { instanceId: "pi", model: backup }, busy: false,
    });
    evidence.push({ switched });
  });
}, 90_000);

it("reports a failed pi turn once and never replays it on the configured backup", async () => {
  // The turn's prompt was accepted, then failed as pi reported it: past the prompt
  // the attempt is the turn's own, so it is reported and never replayed, backup or not.
  await withRecoveryFixture({ FAKE_PI_MODE: "turn-error" }, async ({ api, control, model, backup, turns, modelsSet }) => {
    const allowed = { enabled: true, backup: { instanceId: "pi", model: backup } };
    await api("PUT", "/api/config", { automaticRecovery: allowed });
    const { bot } = await control("new-bot", "--name", "No replay");
    const threadId = bot.activeTaskId;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, {
      modelSelection: { instanceId: "pi", model }, updateBotDefault: true,
    });
    await control("send", "--bot", bot.id, "--task", threadId, "--text", MARKER);
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("failed");

    // The backup model was never asked for, on any launch.
    expect(modelsSet().map((entry) => `${entry.provider}/${entry.modelId}`)).not.toContain(backup);
    // One prompt carried the person's words, and no second turn was started for them.
    expect(turns().map(piTurnText).filter((text) => text.includes(MARKER))).toHaveLength(1);

    const { messages } = (await api("GET", `/api/threads/${threadId}/messages?limit=100`)) as { messages: any[] };
    expect(messages.filter((message) => message.role === "user" && message.text === MARKER)).toHaveLength(1);
    expect(messages.some((message) => message.tool?.name?.startsWith("recovery:"))).toBe(false);
    expect(messages.some((message) => message.tool?.ok === false)).toBe(true);

    const state = (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
    expect(state.tasks.find((task: any) => task.threadId === threadId)).toMatchObject({
      modelSelection: { instanceId: "pi", model }, busy: false,
    });
  });
}, 90_000);
