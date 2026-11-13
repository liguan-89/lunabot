// Automatic recovery in the one-agent build.
//
// The feature's start-up path needed an engine that refuses a turn *before* accepting its prompt
// (TurnNotStartedError) and a second engine to take the work. pi reports no such pre-prompt
// refusal, and it is the only engine, so a failing pi turn is reported and never replayed on the
// configured backup. What is still engine-agnostic is the settings contract, which this recipe
// drives against the fixture's pi instance with a second pi model as the backup.
//
// Subtests removed with the multi-engine fixtures, and why:
// - "recovers once on the same thread…", "keeps a Set me up request a setup turn on the backup",
//   "recovers a coordinated specialist…", "uses the ordered bot list only for proven pre-prompt
//   failures", "does not automatically replay when …", "stops after one failed backup…",
//   "uses the configured … backup when Claude refuses a turn because it is signed out",
//   "preserves the sign-in error…" and "does not recover a superseded turn after …" all drove a
//   primary CLI that failed during start-up and a different backup engine. That refusal class and
//   second engine no longer exist: pi always accepts the prompt and reports failures as turn errors.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
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
    const result = await runControlOmb([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  try {
    const { instances } = await api("GET", "/api/instances") as {
      instances: Array<{ instanceId: string; models: { default: string; options: Array<{ id: string }> } }>;
    };
    const pi = instances.find((instance) => instance.instanceId === "pi")!;
    const model = pi.models.default;
    const backup = pi.models.options.map((option) => option.id).find((id) => id !== model) ?? model;
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

it("reports a failed pi turn once and never replays it on the configured backup", async () => {
  // The turn is accepted, then fails as pi reports it. With Automatic recovery on and a second pi
  // model configured, the failed turn still stands: pi produces no pre-prompt refusal to recover.
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
