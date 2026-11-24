// A turn its engine's usage limit refused, end to end against the real server. This build has one engine (pi), which
// reports neither plan usage nor a reset time, so there is no second AI to carry on with and no clock to wait on. What
// the product still does — stop the refused turn without retrying it, keep the provider's own words, and set up the
// one-time "Continue when your limit resets" automation — is what this recipe checks.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlLunabot } from "../scripts/control-lunabot.ts";

/** A provider's usage-limit refusal, as pi reports it from the model call that failed. */
const LIMIT_TEXT = "429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"You have reached your 5-hour usage limit. Try again at 7:22 PM.\"}} retry-after-ms=18000000";

/** The smallest pi RPC child that answers setup and refuses its one prompt with the engine's own limit words. */
const LIMIT_CLI = `#!/usr/bin/env node
import { createInterface } from "node:readline";
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write("pi 0.84.2 (fake)\\n");
  process.exit(0);
}
let session = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  let cmd;
  try { cmd = JSON.parse(line); } catch { return; }
  const reply = (command, data) => out({ id: cmd.id, type: "response", command, success: true, data });
  if (cmd.type === "generate_models" || cmd.type === "get_available_models") {
    return reply("get_available_models", { models: [{ provider: "ollama-cloud", id: "glm-5.2", name: "glm-5.2" }] });
  }
  if (cmd.type === "new_session") return reply("new_session", { sessionId: "s-" + (++session), sessionFile: "/fake/limit-session.json" });
  if (cmd.type === "switch_session") return reply("switch_session", { sessionId: "s-" + session, sessionFile: cmd.sessionPath ?? "/fake/limit-session.json" });
  if (cmd.type === "set_model") return reply("set_model", { id: cmd.modelId, provider: cmd.provider });
  if (cmd.type === "set_thinking_level") return reply("set_thinking_level", undefined);
  if (cmd.type === "get_state") return reply("get_state", { model: null, thinkingLevel: "off", isStreaming: false, isCompacting: false, sessionFile: "/fake/limit-session.json" });
  if (cmd.type !== "prompt") return;
  out({ type: "agent_start" });
  out({ type: "turn_start" });
  out({ type: "turn_end", message: { stopReason: "error", errorMessage: ${JSON.stringify(LIMIT_TEXT)} }, usage: { input: 0, output: 0 } });
  out({ type: "agent_end", isTerminal: true });
});
`;

it("a refusal by the only engine's usage limit fails the turn, names its words, and offers a Continue automation that waits for a reset pi never reports", async () => {
  const fixture = await launchVerificationServer();
  const { url, dataDir, logPath } = fixture.info;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const control = (...args: string[]) => runControlLunabot([...args, "--url", url]) as Promise<any>;
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[];
  const evidence: unknown[] = [{ fixture: fixture.info }];
  try {
    // A new bot's greeting runs on the fixture's ordinary fake before the limit CLI is installed.
    const { bot } = await control("new-bot", "--name", "Scout");
    expect((await control("wait", "--bot", bot.id, "--timeout", "30")).status).toBe("settled");
    const limitCli = join(dataDir, "limit-cli.mjs");
    writeFileSync(limitCli, LIMIT_CLI, { mode: 0o700 });
    await api("PATCH", "/api/instances/pi", { cli: limitCli });

    const threadId = bot.activeTaskId as string;
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Write the quarterly report");
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("failed");
    const stopped = await messages(threadId);
    const failure = stopped.find((message) => message.tool?.name?.startsWith("error:"));
    // The provider's own sentence is the failure; pi reports no reset of its own, so none is invented.
    expect(failure?.tool).toMatchObject({ ok: false });
    expect(failure?.tool?.name).toContain("You have reached your 5-hour usage limit");
    expect(failure?.tool).not.toHaveProperty("limitResetsAt");
    // One refused turn, no silent retry behind the person's back.
    expect(stopped.filter((message) => message.tool?.name?.startsWith("error:"))).toHaveLength(1);
    const limits = await api("GET", "/api/limit-resets");
    expect(limits.engines).not.toContainEqual(expect.objectContaining({ engine: "pi", blocked: true }));

    // "Continue when your limit resets": a one-time automation in the stopped conversation. pi names no reset, so it
    // waits without a run time rather than guessing one.
    const continued = await api("POST", "/api/limit-resets/continue", { botId: bot.id, threadId }, 201);
    expect(continued.routine).toMatchObject({
      sourceThreadId: threadId, enabled: true, nextRunAt: null,
      schedule: { type: "limit_reset", engine: "pi", repeat: "once", at: null },
    });
    expect(continued.routine.prompt).toContain("cut off because Verification pi's usage limit was reached");
    const card = (await messages(threadId)).find((message) => message.card?.routineRequest?.resultId === continued.routine.id);
    expect(card?.card).toMatchObject({ autoApplied: true, answered: "allow" });
    // A second press is the same automation, not another one.
    expect((await api("POST", "/api/limit-resets/continue", { botId: bot.id, threadId })).routine.id).toBe(continued.routine.id);
    expect((await api("GET", "/api/routines")).routines.filter((routine: any) => routine.id === continued.routine.id)).toHaveLength(1);
    // With no reset time known there is nothing to move past, and the automation stays pending instead of running.
    expect((await api("POST", "/api/limit-resets/after-reset", { routineId: continued.routine.id, engine: "pi" }, 409)).error).toContain("not known yet");
    expect((await api("GET", "/api/routines")).runs.filter((run: any) => run.routineId === continued.routine.id)).toEqual([]);
    evidence.push({ stopped, routine: continued.routine, limits });
  } finally {
    const evidencePath = `${logPath}.limit-reset.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ logPath, evidencePath }));
    await fixture.close();
  }
}, 120_000);
