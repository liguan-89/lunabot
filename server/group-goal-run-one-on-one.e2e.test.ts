// A one-on-one /goal runs on the room goal-run engine as a room of one, against the one agent this build has:
// the fake pi. Each scenario launches the fixture with the knob that shapes its turns; replies are marker-driven.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-lunabot.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const GOAL = (decision: Record<string, string>) => `<openmaus-goal>${JSON.stringify(decision)}</openmaus-goal>`;

let base = "";
let model = "";
let promptsFile = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

async function piModel(url: string): Promise<string> {
  const deadline = Date.now() + hostTimeout(15_000);
  for (;;) {
    try {
      const state = await (await fetch(`${url}/api/instances`)).json() as {
        instances?: Array<{ instanceId: string; models?: { default?: string } }>;
      };
      const found = (state.instances ?? []).find((instance) => instance.instanceId === "pi");
      if (found?.models?.default) return found.models.default;
    } catch {
    }
    if (Date.now() >= deadline) throw new Error("the pi instance never reported a default model");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Launch the one-agent fixture, then run a scenario against it. `fake` writes the files and env its turns need. */
async function scenario(
  fake: (scratch: string) => Record<string, string>,
  body: (scratch: string) => Promise<void>,
): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "omb-one-on-one-goal-"));
  const fixture = await launchVerificationServer({ ...process.env, FAKE_PI_CLAUDE_COMPAT: "1", ...fake(scratch) });
  try {
    base = fixture.info.url;
    model = await piModel(base);
    await body(scratch);
  } finally {
    await fixture.close();
    await removeTempDir(scratch);
  }
}

function markersIn(scratch: string, replies: Record<string, string>): string {
  const path = join(scratch, "marker-replies.json");
  writeFileSync(path, JSON.stringify(replies));
  return path;
}

const prompts = (): string[] => {
  try {
    return readFileSync(promptsFile, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const newBot = async (name: string) => (await api("POST", "/api/bots", {
  name,
  modelSelection: { instanceId: "pi", model },
  requireAvailableModel: true,
})).body.bot as { id: string; threadId: string };

const messagesIn = async (threadId: string): Promise<any[]> =>
  (await api("GET", `/api/threads/${encodeURIComponent(threadId)}/messages?limit=100`)).body.messages;
const cardIn = async (threadId: string) => (await messagesIn(threadId)).find((message) => message.kind === "goal.run")?.goalRun;
const busy = async (botId: string) =>
  (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: { id: string }) => bot.id === botId)?.busy;
const sendGoal = (bot: { id: string; threadId: string }, text: string, extra: Record<string, unknown> = {}) =>
  api("POST", `/api/bots/${bot.id}/messages`, { text, mode: "goal", threadId: bot.threadId, ...extra });

describe("one-on-one goal runs (a room of one)", () => {
  it("works in its own chat until the bot reports the goal done, and the marker never shows", async () => {
    await scenario((scratch) => {
      promptsFile = join(scratch, "prompts.jsonl");
      return {
        FAKE_PI_PROMPTS: promptsFile,
        FAKE_PI_MARKER_REPLIES: markersIn(scratch, {
          "Your next step: Fix the last failing test": `Every test passes now.\n${GOAL({ status: "completed", detail: "All tests pass." })}`,
          "This is turn 1 of 13": `I fixed the parser test.\n${GOAL({ status: "continue", next: "Solo", instruction: "Fix the last failing test", detail: "One test left" })}`,
        }),
      };
    }, async () => {
      const bot = await newBot("Solo");
      const sent = await sendGoal(bot, "Get every test passing", { sendId: "one_on_one_goal_send_1" });
      expect(sent.status).toBe(202);
      expect(sent.body.message).toMatchObject({ role: "user", text: "Get every test passing", channelMode: "goal" });

      await expect.poll(() => cardIn(bot.threadId), { timeout: hostTimeout(15_000) }).toMatchObject({
        status: "completed",
        coordinatorBotId: bot.id,
        turnCount: 2,
        maxTurns: 13,
        detail: "All tests pass.",
      });
      await expect.poll(() => busy(bot.id)).toBe(false);

      const sentPrompts = prompts();
      expect(sentPrompts).toHaveLength(2);
      expect(sentPrompts[0]).toContain("You are working alone toward a bounded goal.");
      expect(sentPrompts[0]).toContain("Get every test passing");
      expect(sentPrompts[1]).toContain("Your next step: Fix the last failing test");

      const messages = await messagesIn(bot.threadId);
      const afterGoal = messages.slice(messages.findIndex((message) => message.id === sent.body.message.id) + 1);
      expect(JSON.stringify(messages)).not.toContain("openmaus-goal");
      expect(afterGoal.filter((message) => message.kind === "text" && message.role === "bot").map((message) => message.text))
        .toEqual(["I fixed the parser test.", "Every test passes now."]);
      expect(messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual(["Get every test passing"]);

      const retried = await sendGoal(bot, "Get every test passing", { sendId: "one_on_one_goal_send_1" });
      expect(retried.status).toBe(202);
      expect(retried.body.message.id).toBe(sent.body.message.id);
      expect((await messagesIn(bot.threadId)).filter((message) => message.kind === "goal.run")).toHaveLength(1);
    });
  });

  it("hides an envelope written in a turn outside the goal's own, such as a teammate's result waking the lead", async () => {
    await scenario((scratch) => ({
      FAKE_PI_MARKER_REPLIES: markersIn(scratch, {
        "Coder replied": `Coder finished it.\n${GOAL({ status: "completed", detail: "Done." })}`,
      }),
    }), async () => {
      const bot = await newBot("Stray");
      const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "Coder replied", threadId: bot.threadId });
      expect(sent.status).toBe(202);
      const replies = async () => (await messagesIn(bot.threadId))
        .filter((message) => message.kind === "text" && message.role === "bot" && message.requestMessageId === sent.body.message.id).map((message) => message.text);
      await expect.poll(replies, { timeout: hostTimeout(15_000) }).toEqual(["Coder finished it."]);
      expect(JSON.stringify(await messagesIn(bot.threadId))).not.toContain("openmaus-goal");
    });
  });

  it("Stop ends the goal on its card and no turn starts after the interrupted one", async () => {
    await scenario(() => ({ FAKE_PI_HOLD_ON: "Keep going" }), async () => {
      const bot = await newBot("Stopper");
      expect((await sendGoal(bot, "Keep going")).status).toBe(202);
      await expect.poll(() => busy(bot.id)).toBe(true);
      const refused = await sendGoal(bot, "A second goal");
      expect(refused.status).toBe(409);
      expect(refused.body).toEqual({ error: "A goal is already running in this chat. Stop it before starting another.", errorKey: "serverError.goal.alreadyRunning" });

      expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
      await expect.poll(() => cardIn(bot.threadId)).toMatchObject({ status: "stopped", detail: "Stopped by you.", turnCount: 1 });
      await expect.poll(() => busy(bot.id), { timeout: hostTimeout(10_000) }).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(await busy(bot.id)).toBe(false);
      expect(await cardIn(bot.threadId)).toMatchObject({ status: "stopped", turnCount: 1 });
      expect(JSON.stringify(await messagesIn(bot.threadId))).not.toContain("Halfway");
    });
  });

  it("waits for the chat's current turn without spending a goal turn, then runs on the same card", async () => {
    await scenario((scratch) => ({
      FAKE_PI_TOOL_CALLS_FILE: join(scratch, "tool-calls.json"),
      FAKE_PI_RELEASE: join(scratch, "release"),
    }), async (scratch) => {
      writeFileSync(join(scratch, "tool-calls.json"), JSON.stringify([{ name: "Bash", input: { command: "echo hold" }, hold: true }]));
      const bot = await newBot("Patient");
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Finish this first", threadId: bot.threadId })).status).toBe(202);
      await expect.poll(() => busy(bot.id)).toBe(true);
      expect((await sendGoal(bot, "Then finish the goal")).status).toBe(202);
      await expect.poll(() => cardIn(bot.threadId)).toMatchObject({
        status: "working",
        turnCount: 0,
        detail: "Patient is finishing what it is doing. This goal will continue when it is free.",
        detailCode: "chat.notice.goalWaiting",
        detailParams: { name: "Patient" },
      });
      writeFileSync(join(scratch, "release"), "observed the waiting goal");
      // The fixture's goal turn ends without a marker, so the run stops after exactly the one turn it waited for.
      await expect.poll(() => cardIn(bot.threadId), { timeout: hostTimeout(15_000) })
        .toMatchObject({ status: "blocked", turnCount: 1, detail: "Patient did not provide a valid next-step decision." });
      expect((await messagesIn(bot.threadId)).filter((message) => message.kind === "goal.run")).toHaveLength(1);
    });
  });

  it("stops at the same turn cap as a room goal", async () => {
    await scenario((scratch) => {
      promptsFile = join(scratch, "prompts.jsonl");
      const loopMarkers: Record<string, string> = {};
      for (let turn = 1; turn <= 13; turn++) {
        loopMarkers[`This is turn ${turn} of 13`] =
          `Not there yet.\n${GOAL({ status: "continue", next: "Looper", instruction: `Try approach ${turn}`, detail: "Still working" })}`;
      }
      return { FAKE_PI_PROMPTS: promptsFile, FAKE_PI_MARKER_REPLIES: markersIn(scratch, loopMarkers) };
    }, async () => {
      const bot = await newBot("Looper");
      expect((await sendGoal(bot, "Keep trying forever")).status).toBe(202);
      await expect.poll(() => cardIn(bot.threadId), { timeout: hostTimeout(30_000) })
        .toMatchObject({ status: "limit-reached", turnCount: 13, maxTurns: 13 });
      expect(prompts()).toHaveLength(13);
    });
  });

  it("never treats a failed turn as done: it is retried once, then the goal fails", async () => {
    // pi's prompt command refuses these turns, which is a provider failure, not a reply.
    await scenario(() => ({ FAKE_PI_MODE: "prompt-reject" }), async () => {
      const bot = await newBot("Crasher");
      expect((await sendGoal(bot, "Do not claim this succeeded")).status).toBe(202);
      await expect.poll(() => cardIn(bot.threadId), { timeout: hostTimeout(15_000) }).toMatchObject({ status: "failed", turnCount: 2 });
    });
  });

  it("a routine runs a goal in the bot's own chat when it names no room", async () => {
    await scenario((scratch) => ({
      FAKE_PI_MARKER_REPLIES: markersIn(scratch, {
        "Goal: Review the release": `Reviewed.\n${GOAL({ status: "completed", detail: "Scheduled review done." })}`,
      }),
    }), async () => {
      const bot = await newBot("Reviewer");
      const created = await api("POST", "/api/routines", {
        name: "Daily review",
        prompt: "Review the release",
        target: "room-goal",
        botId: bot.id,
        runOn: "maus",
        schedule: { type: "once", at: Date.now() + 60_000 },
        durationMinutes: 30,
      });
      expect(created.status).toBe(201);
      expect(created.body.routine).toMatchObject({ target: "room-goal", botId: bot.id });
      expect(created.body.routine.groupId).toBeUndefined();

      const started = await api("POST", `/api/routines/${created.body.routine.id}/run`);
      expect(started.status).toBe(201);
      const runId = started.body.run.id;
      await expect.poll(async () => (await api("GET", "/api/routines")).body.runs.find((run: { id: string }) => run.id === runId),
        { timeout: hostTimeout(15_000) }).toMatchObject({ status: "completed", target: "room-goal", output: "Scheduled review done." });

      const run = (await api("GET", "/api/routines")).body.runs.find((candidate: { id: string }) => candidate.id === runId);
      const owner = (await api("GET", "/api/bots?messages=0")).body.bots.find((candidate: { id: string }) => candidate.id === bot.id);
      expect(owner.tasks.some((task: { threadId: string }) => task.threadId === run.threadId)).toBe(true);
      expect(await cardIn(run.threadId)).toMatchObject({ runId, status: "completed", coordinatorBotId: bot.id });
    });
  });

  it("refuses a mode it does not know", async () => {
    await scenario(() => ({}), async () => {
      const bot = await newBot("Checker");
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "hello", mode: "forever", threadId: bot.threadId })).status).toBe(400);
    });
  });
});
