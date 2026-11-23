// Group goal runs against the one agent this build has: the fake pi. The fake's knobs are process-wide, so each
// scenario launches its own fixture with the behavior it needs (a delay, a hold, a stall, a rejected prompt); the
// per-bot flavors inside one scenario come from marker replies keyed on the turn's prompt.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-lunabot.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const GOAL = (decision: Record<string, string>) => `<openmaus-goal>${JSON.stringify(decision)}</openmaus-goal>`;

let base = "";
let model = "";

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
  const scratch = mkdtempSync(join(tmpdir(), "omb-goal-run-"));
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

/** A marker file: the first marker a prompt contains picks that turn's reply. */
function markersIn(scratch: string, replies: Record<string, string>): string {
  const path = join(scratch, "marker-replies.json");
  writeFileSync(path, JSON.stringify(replies));
  return path;
}

const newBot = async (name: string) => (await api("POST", "/api/bots", {
  name,
  modelSelection: { instanceId: "pi", model },
  requireAvailableModel: true,
})).body.bot;

describe("goal-driven channel runs", () => {
  it("returns to the lead until the goal is completed and appends a clean receipt", async () => {
    await scenario((scratch) => ({
      FAKE_PI_MARKER_REPLIES: markersIn(scratch, {
        "This is team turn 3 of 13": `The verified draft is ready to ship.\n${GOAL({ status: "completed", detail: "Draft produced and independently verified." })}`,
        "This is team turn 1 of 13": `Scout should verify the draft.\n${GOAL({ status: "continue", next: "Scout", instruction: "Verify the draft and report evidence", detail: "Draft prepared" })}`,
        "Your assignment: Verify the draft and report evidence": "The draft is accurate and the cited evidence checks out.",
      }),
    }), async () => {
      const lead = await newBot("Lead");
      const scout = await newBot("Scout");
      const room = (await api("POST", "/api/groups", {
        name: "Launch team",
        memberIds: [lead.id, scout.id],
        setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
      })).body.group;

      const sent = await api("POST", `/api/groups/${room.id}/messages`, {
        text: "Produce and verify the launch draft",
        mode: "goal",
        sendId: "goal_send_1234567890",
      });
      expect(sent.status).toBe(202);
      expect(sent.body.message).toMatchObject({ channelMode: "goal" });

      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=30")).body;
        const current = state.groups.find((candidate: { id: string }) => candidate.id === room.id);
        return current?.messages.find((message: { kind: string }) => message.kind === "goal.run")?.goalRun;
      }, { timeout: hostTimeout(10_000) }).toMatchObject({
        status: "completed",
        coordinatorBotId: lead.id,
        turnCount: 3,
        detail: "Draft produced and independently verified.",
      });

      const state = (await api("GET", "/api/bots?messages=30")).body;
      const current = state.groups.find((candidate: { id: string }) => candidate.id === room.id);
      expect(current.messages.find((message: { kind: string }) => message.kind === "goal.run")?.text)
        .toBe("Goal completed: Draft produced and independently verified.");
      expect(current.working).toBe(false);
      expect(current.messages.filter((message: { kind: string; role?: string }) => message.kind === "text" && message.role === "bot")
        .map((message: { from?: { name?: string } }) => message.from?.name)).toEqual(["Lead", "Scout", "Lead"]);
      expect(JSON.stringify(current.messages)).not.toContain("<openmaus-goal>");
    });
  });

  it("waits for a busy coordinator without spending a goal turn, then completes on the same card", async () => {
    await scenario((scratch) => ({
      FAKE_PI_DELAY_ON: "\n\nFinish this direct task first",
      FAKE_PI_DELAY_MS: "15000",
      FAKE_PI_MARKER_REPLIES: markersIn(scratch, {
        "Goal: Complete this goal after your current work": `The queued team goal is complete.\n${GOAL({ status: "completed", detail: "Waited for the lead, then completed normally." })}`,
        "Finish this direct task first": "The unrelated direct task is complete.",
      }),
    }), async () => {
      const lead = await newBot("Patient lead");
      const room = (await api("POST", "/api/groups", {
        name: "Patient goal team",
        memberIds: [lead.id],
        setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
      })).body.group;

      try {
        expect((await api("POST", `/api/bots/${lead.id}/messages`, { text: "Finish this direct task first" })).status)
          .toBe(202);
        await expect.poll(async () => {
          const state = (await api("GET", "/api/bots?messages=0")).body;
          return state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy;
        }).toBe(true);

        expect((await api("POST", `/api/groups/${room.id}/messages`, {
          text: "Complete this goal after your current work",
          mode: "goal",
        })).status).toBe(202);

        await expect.poll(async () => {
          const state = (await api("GET", "/api/bots?messages=30")).body;
          const current = state.groups.find((group: { id: string }) => group.id === room.id);
          const cards = current?.messages.filter((message: { kind: string }) => message.kind === "goal.run") ?? [];
          return {
            count: cards.length,
            status: cards[0]?.goalRun?.status,
            detail: cards[0]?.goalRun?.detail,
            turnCount: cards[0]?.goalRun?.turnCount,
            busyBotId: current?.busyBotId,
          };
        }).toMatchObject({
          count: 1,
          status: "working",
          detail: expect.stringMatching(/finishing another conversation/i),
          turnCount: 0,
          busyBotId: null,
        });

        const waitingState = (await api("GET", "/api/bots?messages=30")).body;
        const waitingRoom = waitingState.groups.find((group: { id: string }) => group.id === room.id);
        const cardId = waitingRoom.messages.find((message: { kind: string }) => message.kind === "goal.run").id;
        // The direct turn ends on its own delay; the goal turn then runs on the same card.

        await expect.poll(async () => {
          const state = (await api("GET", "/api/bots?messages=30")).body;
          const current = state.groups.find((group: { id: string }) => group.id === room.id);
          const cards = current?.messages.filter((message: { kind: string }) => message.kind === "goal.run") ?? [];
          return {
            working: current?.working,
            count: cards.length,
            id: cards[0]?.id,
            status: cards[0]?.goalRun?.status,
            detail: cards[0]?.goalRun?.detail,
            turnCount: cards[0]?.goalRun?.turnCount,
          };
        }, { timeout: hostTimeout(25_000) }).toEqual({
          working: false,
          count: 1,
          id: cardId,
          status: "completed",
          detail: "Waited for the lead, then completed normally.",
          turnCount: 1,
        });
      } finally {
        await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
        await api("POST", `/api/bots/${lead.id}/interrupt`, {}).catch(() => undefined);
        await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
        await api("DELETE", `/api/bots/${lead.id}`).catch(() => undefined);
      }
    });
  });

  it("waits for a busy delegated worker, preserves its direct turn, then resumes the goal", async () => {
    await scenario((scratch) => ({
      FAKE_PI_DELAY_ON: "\n\nComplete this unrelated direct research first",
      FAKE_PI_DELAY_MS: "15000",
      FAKE_PI_MARKER_REPLIES: markersIn(scratch, {
        "This is team turn 3 of 13": `The specialist's evidence resolves the goal.\n${GOAL({ status: "completed", detail: "Specialist research incorporated after their direct task finished." })}`,
        "This is team turn 1 of 13": `I am delegating the research.\n${GOAL({ status: "continue", next: "Busy specialist", instruction: "Research the answer and report evidence", detail: "Waiting for specialist research." })}`,
        "Your assignment: Research the answer and report evidence": "Evidence gathered for the coordinator.",
        "Complete this unrelated direct research first": "The unrelated direct research is complete.",
      }),
    }), async () => {
      const lead = await newBot("Worker coordinator");
      const worker = await newBot("Busy specialist");
      const room = (await api("POST", "/api/groups", {
        name: "Busy specialist team",
        memberIds: [lead.id, worker.id],
        setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
      })).body.group;

      try {
        expect((await api("POST", `/api/bots/${worker.id}/messages`, {
          text: "Complete this unrelated direct research first",
        })).status).toBe(202);
        await expect.poll(async () => {
          const state = (await api("GET", "/api/bots?messages=0")).body;
          return state.bots.find((bot: { id: string }) => bot.id === worker.id)?.busy;
        }, { timeout: hostTimeout(10_000) }).toBe(true);

        expect((await api("POST", `/api/groups/${room.id}/messages`, {
          text: "Research and resolve the team question",
          mode: "goal",
        })).status).toBe(202);

        await expect.poll(async () => {
          const state = (await api("GET", "/api/bots?messages=30")).body;
          const current = state.groups.find((group: { id: string }) => group.id === room.id);
          const card = current?.messages.find((message: { kind: string }) => message.kind === "goal.run");
          return {
            status: card?.goalRun?.status,
            detail: card?.goalRun?.detail,
            turnCount: card?.goalRun?.turnCount,
            roomBusyBotId: current?.busyBotId,
            workerDirectBusy: state.bots.find((bot: { id: string }) => bot.id === worker.id)?.busy,
          };
        }, { timeout: hostTimeout(10_000) }).toMatchObject({
          status: "working",
          detail: expect.stringMatching(/Busy specialist is finishing another conversation/i),
          turnCount: 1,
          roomBusyBotId: null,
          workerDirectBusy: true,
        });

        // The worker's direct turn ends on its own delay, so the goal resumes it afterwards.

        await expect.poll(async () => {
          const state = (await api("GET", "/api/bots?messages=30")).body;
          const current = state.groups.find((group: { id: string }) => group.id === room.id);
          const currentWorker = state.bots.find((bot: { id: string }) => bot.id === worker.id);
          const cards = current?.messages.filter((message: { kind: string }) => message.kind === "goal.run") ?? [];
          return {
            roomWorking: current?.working,
            cards: cards.length,
            status: cards[0]?.goalRun?.status,
            detail: cards[0]?.goalRun?.detail,
            turnCount: cards[0]?.goalRun?.turnCount,
            speakers: current?.messages
              .filter((message: { kind: string; role?: string }) => message.kind === "text" && message.role === "bot")
              .map((message: { from?: { name?: string } }) => message.from?.name)
              .filter((name: string | undefined, index: number, names: Array<string | undefined>) =>
                name !== names[index - 1]
              ),
            workerDirectBusy: currentWorker?.busy,
            directFinishedNaturally: currentWorker?.messages.some((message: { text?: string }) =>
              message.text?.startsWith("echo: ")
            ),
          };
        }, { timeout: hostTimeout(25_000) }).toEqual({
          roomWorking: false,
          cards: 1,
          status: "completed",
          detail: "Specialist research incorporated after their direct task finished.",
          turnCount: 3,
          speakers: ["Worker coordinator", "Busy specialist", "Worker coordinator"],
          workerDirectBusy: false,
          directFinishedNaturally: true,
        });
      } finally {
        await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
        await api("POST", `/api/bots/${lead.id}/interrupt`, {}).catch(() => undefined);
        await api("POST", `/api/bots/${worker.id}/interrupt`, {}).catch(() => undefined);
        await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
        await api("DELETE", `/api/bots/${lead.id}`).catch(() => undefined);
        await api("DELETE", `/api/bots/${worker.id}`).catch(() => undefined);
      }
    });
  });

  it("stops a waiting goal without interrupting unrelated direct work, and chat waits for busy bots the same way", async () => {
    await scenario(() => ({ FAKE_PI_MODE: "hang" }), async () => {
      const lead = await newBot("Occupied lead");
      const room = (await api("POST", "/api/groups", {
        name: "Scoped stop team",
        memberIds: [lead.id],
        setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
      })).body.group;
      const chips = (messages: Array<{ kind: string; role?: string; tool?: { name?: string; ok?: boolean } }>) => ({
        waiting: messages.some((message) =>
          message.kind === "activity" &&
          /finishing another conversation — will reply here when free/i.test(message.tool?.name ?? "") &&
          message.tool?.ok === undefined
        ),
        skipped: messages.some((message) => /skipped this round/i.test(message.tool?.name ?? "")),
        replies: messages.filter((message) => message.kind === "text" && message.role === "bot").length,
      });

      try {
        expect((await api("POST", `/api/bots/${lead.id}/messages`, { text: "Keep this direct task running" })).status)
          .toBe(202);
        await expect.poll(async () => {
          const state = (await api("GET", "/api/bots?messages=0")).body;
          return state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy;
        }).toBe(true);

        expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Ordinary room chat" })).status).toBe(202);
        await expect.poll(async () => {
          const state = (await api("GET", "/api/bots?messages=30")).body;
          const current = state.groups.find((group: { id: string }) => group.id === room.id);
          return { working: current?.working, busyBotId: current?.busyBotId, ...chips(current?.messages ?? []) };
        }).toEqual({ working: true, busyBotId: null, waiting: true, skipped: false, replies: 0 });

        expect((await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId })).status).toBe(200);
        await expect.poll(async () => {
          const state = (await api("GET", "/api/bots?messages=30")).body;
          const current = state.groups.find((group: { id: string }) => group.id === room.id);
          return {
            working: current?.working,
            directBusy: state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy,
            ...chips(current?.messages ?? []),
          };
        }).toEqual({ working: false, directBusy: true, waiting: true, skipped: false, replies: 0 });

        expect((await api("POST", `/api/groups/${room.id}/messages`, {
          text: "Wait and run this as a goal",
          mode: "goal",
        })).status).toBe(202);
        await expect.poll(async () => {
          const state = (await api("GET", "/api/bots?messages=30")).body;
          const current = state.groups.find((group: { id: string }) => group.id === room.id);
          const card = current?.messages.find((message: { kind: string }) => message.kind === "goal.run");
          return {
            roomWorking: current?.working,
            roomBusyBotId: current?.busyBotId,
            status: card?.goalRun?.status,
            detail: card?.goalRun?.detail,
            turnCount: card?.goalRun?.turnCount,
          };
        }).toMatchObject({
          roomWorking: true,
          roomBusyBotId: null,
          status: "working",
          detail: expect.stringMatching(/finishing another conversation/i),
          turnCount: 0,
        });

        expect((await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId })).status).toBe(200);
        await expect.poll(async () => {
          const state = (await api("GET", "/api/bots?messages=30")).body;
          const current = state.groups.find((group: { id: string }) => group.id === room.id);
          const cards = current?.messages.filter((message: { kind: string }) => message.kind === "goal.run") ?? [];
          return {
            roomWorking: current?.working,
            cards: cards.length,
            status: cards[0]?.goalRun?.status,
            turnCount: cards[0]?.goalRun?.turnCount,
            directBusy: state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy,
          };
        }).toEqual({
          roomWorking: false,
          cards: 1,
          status: "stopped",
          turnCount: 0,
          directBusy: true,
        });
      } finally {
        await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
        await api("POST", `/api/bots/${lead.id}/interrupt`, {}).catch(() => undefined);
        await expect.poll(async () => {
          const state = (await api("GET", "/api/bots?messages=0")).body;
          return state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy;
        }, { timeout: 5_000 }).toBe(false);
        await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
        await api("DELETE", `/api/bots/${lead.id}`).catch(() => undefined);
      }
    });
  });

  it("stops a detached scheduled goal from the active room and cancels its routine run", async () => {
    await scenario(() => ({ FAKE_PI_MODE: "hang" }), async () => {
      const lead = await newBot("Detached scheduled lead");
      const room = (await api("POST", "/api/groups", {
        name: "Detached stop team",
        memberIds: [lead.id],
        setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
      })).body.group;
      const originalThreadId = room.threadId;

      try {
        const created = await api("POST", "/api/routines", {
          name: "Hanging scheduled goal",
          prompt: "Keep this scheduled team goal running",
          target: "room-goal",
          groupId: room.id,
          botId: lead.id,
          runOn: "maus",
          schedule: { type: "once", at: Date.now() + 60_000 },
          durationMinutes: 30,
        });
        expect(created.status).toBe(201);
        const started = await api("POST", `/api/routines/${created.body.routine.id}/run`);
        expect(started.status).toBe(201);
        const runId = started.body.run.id;

        let backgroundThreadId = "";
        await expect.poll(async () => {
          const calendar = (await api("GET", "/api/routines")).body;
          const running = calendar.runs.find((run: { id: string }) => run.id === runId);
          const state = (await api("GET", "/api/bots?messages=0")).body;
          const current = state.groups.find((group: { id: string }) => group.id === room.id);
          backgroundThreadId = running?.threadId ?? "";
          return {
            runStatus: running?.status,
            detached: Boolean(running?.threadId && running.threadId !== originalThreadId),
            activeThreadId: current?.threadId,
            hasBackgroundTask: current?.tasks.some(
              (task: { threadId: string }) => task.threadId === running?.threadId,
            ),
            roomWorking: current?.working,
            leadBusy: state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy,
          };
        }, { timeout: hostTimeout(10_000) }).toEqual({
          runStatus: "running",
          detached: true,
          activeThreadId: originalThreadId,
          hasBackgroundTask: true,
          roomWorking: true,
          leadBusy: true,
        });

        expect((await api("POST", `/api/groups/${room.id}/interrupt`)).status).toBe(200);

        await expect.poll(async () => {
          const calendar = (await api("GET", "/api/routines")).body;
          const stopped = calendar.runs.find((run: { id: string }) => run.id === runId);
          const state = (await api("GET", "/api/bots?messages=0")).body;
          const current = state.groups.find((group: { id: string }) => group.id === room.id);
          return {
            runStatus: stopped?.status,
            runThreadId: stopped?.threadId,
            activeThreadId: current?.threadId,
            roomWorking: current?.working,
            leadBusy: state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy,
          };
        }, { timeout: hostTimeout(10_000) }).toEqual({
          runStatus: "cancelled",
          runThreadId: backgroundThreadId,
          activeThreadId: originalThreadId,
          roomWorking: false,
          leadBusy: false,
        });

        const opened = await api("POST", `/api/groups/${room.id}/tasks/${backgroundThreadId}`);
        expect(opened.status).toBe(200);
        expect(opened.body.group.messages.filter((message: { kind: string }) => message.kind === "goal.run"))
          .toEqual([
            expect.objectContaining({
              goalRun: expect.objectContaining({ runId, status: "stopped", detail: "Stopped by you." }),
            }),
          ]);
      } finally {
        await api("POST", `/api/groups/${room.id}/interrupt`).catch(() => undefined);
        await api("POST", `/api/bots/${lead.id}/interrupt`).catch(() => undefined);
        await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
        await api("DELETE", `/api/bots/${lead.id}`).catch(() => undefined);
      }
    });
  });

  it("stops a detached scheduled goal from the coordinator's ordinary Stop", async () => {
    await scenario(() => ({ FAKE_PI_MODE: "hang" }), async () => {
      const lead = await newBot("Detached bot-stop lead");
      const room = (await api("POST", "/api/groups", {
        name: "Detached bot-stop team",
        memberIds: [lead.id],
        setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
      })).body.group;
      const originalThreadId = room.threadId;

      try {
        const created = await api("POST", "/api/routines", {
          name: "Coordinator-stopped scheduled goal",
          prompt: "Keep this detached goal running until the coordinator is stopped",
          target: "room-goal",
          groupId: room.id,
          botId: lead.id,
          runOn: "maus",
          schedule: { type: "once", at: Date.now() + 60_000 },
          durationMinutes: 30,
        });
        expect(created.status).toBe(201);
        const started = await api("POST", `/api/routines/${created.body.routine.id}/run`);
        expect(started.status).toBe(201);
        const runId = started.body.run.id;

        let backgroundThreadId = "";
        await expect.poll(async () => {
          const calendar = (await api("GET", "/api/routines")).body;
          const running = calendar.runs.find((run: { id: string }) => run.id === runId);
          const state = (await api("GET", "/api/bots?messages=0")).body;
          const current = state.groups.find((group: { id: string }) => group.id === room.id);
          backgroundThreadId = running?.threadId ?? "";
          return {
            runStatus: running?.status,
            detached: Boolean(running?.threadId && running.threadId !== originalThreadId),
            activeThreadId: current?.threadId,
            roomWorking: current?.working,
            leadBusy: state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy,
          };
        }, { timeout: hostTimeout(10_000) }).toEqual({
          runStatus: "running",
          detached: true,
          activeThreadId: originalThreadId,
          roomWorking: true,
          leadBusy: true,
        });

        expect((await api("POST", `/api/bots/${lead.id}/interrupt`)).status).toBe(200);

        await expect.poll(async () => {
          const calendar = (await api("GET", "/api/routines")).body;
          const stopped = calendar.runs.find((run: { id: string }) => run.id === runId);
          const state = (await api("GET", "/api/bots?messages=0")).body;
          const current = state.groups.find((group: { id: string }) => group.id === room.id);
          return {
            runStatus: stopped?.status,
            runThreadId: stopped?.threadId,
            activeThreadId: current?.threadId,
            roomWorking: current?.working,
            leadBusy: state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy,
          };
        }, { timeout: hostTimeout(10_000) }).toEqual({
          runStatus: "cancelled",
          runThreadId: backgroundThreadId,
          activeThreadId: originalThreadId,
          roomWorking: false,
          leadBusy: false,
        });

        const opened = await api("POST", `/api/groups/${room.id}/tasks/${backgroundThreadId}`);
        expect(opened.status).toBe(200);
        expect(opened.body.group.messages.filter((message: { kind: string }) => message.kind === "goal.run"))
          .toEqual([
            expect.objectContaining({
              goalRun: expect.objectContaining({ runId, status: "stopped", detail: "Stopped by you." }),
            }),
          ]);
      } finally {
        await api("POST", `/api/groups/${room.id}/interrupt`).catch(() => undefined);
        await api("POST", `/api/bots/${lead.id}/interrupt`).catch(() => undefined);
        await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
        await api("DELETE", `/api/bots/${lead.id}`).catch(() => undefined);
      }
    });
  });

  it("stops the coordinator's direct turn without cancelling a routine goal waiting on its worker", async () => {
    await scenario((scratch) => ({
      FAKE_PI_DELAY_ON: "\n\nFinish this unrelated worker task first",
      FAKE_PI_DELAY_MS: "10000",
      FAKE_PI_STALL_ON: "\n\nStart unrelated coordinator work",
      FAKE_PI_MARKER_REPLIES: markersIn(scratch, {
        "This is team turn 3 of 13": `The scheduled analysis is now complete.\n${GOAL({ status: "completed", detail: "Scheduled goal survived the coordinator's direct Stop." })}`,
        "This is team turn 1 of 13": `I am delegating this scheduled goal.\n${GOAL({ status: "continue", next: "Delayed worker", instruction: "Finish the scheduled analysis", detail: "Waiting for the delayed worker." })}`,
        "Your assignment: Finish the scheduled analysis": "Scheduled analysis returned to the coordinator.",
      }),
    }), async () => {
      const lead = await newBot("Stop-scoped coordinator");
      const worker = await newBot("Delayed worker");
      const room = (await api("POST", "/api/groups", {
        name: "Coordinator stop scope team",
        memberIds: [lead.id, worker.id],
        setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
      })).body.group;

      try {
        expect((await api("POST", `/api/bots/${worker.id}/messages`, {
          text: "Finish this unrelated worker task first",
        })).status).toBe(202);
        await expect.poll(async () => {
          const state = (await api("GET", "/api/bots?messages=0")).body;
          return state.bots.find((bot: { id: string }) => bot.id === worker.id)?.busy;
        }).toBe(true);

        const created = await api("POST", "/api/routines", {
          name: "Worker-gated scheduled goal",
          prompt: "Complete the scheduled analysis as a team",
          target: "room-goal",
          groupId: room.id,
          botId: lead.id,
          runOn: "maus",
          schedule: { type: "once", at: Date.now() + 60_000 },
          durationMinutes: 30,
        });
        expect(created.status).toBe(201);
        const started = await api("POST", `/api/routines/${created.body.routine.id}/run`);
        expect(started.status).toBe(201);
        const runId = started.body.run.id;

        let backgroundThreadId = "";
        await expect.poll(async () => {
          const calendar = (await api("GET", "/api/routines")).body;
          const running = calendar.runs.find((run: { id: string }) => run.id === runId);
          backgroundThreadId = running?.threadId ?? "";
          return { status: running?.status, threadId: running?.threadId };
        }, { timeout: hostTimeout(10_000) }).toMatchObject({ status: "running", threadId: expect.any(String) });

        const opened = await api("POST", `/api/groups/${room.id}/tasks/${backgroundThreadId}`);
        expect(opened.status).toBe(200);
        await expect.poll(async () => {
          const state = (await api("GET", "/api/bots?messages=30")).body;
          const current = state.groups.find((group: { id: string }) => group.id === room.id);
          const card = current?.messages.find((message: { kind: string }) => message.kind === "goal.run");
          return {
            activeThreadId: current?.threadId,
            roomWorking: current?.working,
            status: card?.goalRun?.status,
            detail: card?.goalRun?.detail,
            turnCount: card?.goalRun?.turnCount,
            leadBusy: state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy,
            workerBusy: state.bots.find((bot: { id: string }) => bot.id === worker.id)?.busy,
          };
        }, { timeout: hostTimeout(10_000) }).toMatchObject({
          activeThreadId: backgroundThreadId,
          roomWorking: true,
          status: "working",
          detail: expect.stringMatching(/Delayed worker is finishing another conversation/i),
          turnCount: 1,
          leadBusy: false,
          workerBusy: true,
        });

        // The direct turn stalls until Stop; pi keeps the half answer for the transcript when it settles.
        expect((await api("POST", `/api/bots/${lead.id}/messages`, {
          text: "Start unrelated coordinator work",
        })).status).toBe(202);
        await expect.poll(async () => {
          const state = (await api("GET", "/api/bots?messages=30")).body;
          const currentLead = state.bots.find((bot: { id: string }) => bot.id === lead.id);
          return { busy: currentLead?.busy };
        }).toEqual({ busy: true });

        expect((await api("POST", `/api/bots/${lead.id}/interrupt`)).status).toBe(200);
        await expect.poll(async () => {
          const state = (await api("GET", "/api/bots?messages=30")).body;
          return state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy;
        }, { timeout: 5_000 }).toBe(false);

        // The worker may settle and advance the room while Stop is in flight: only cancellation is wrong.
        const afterStopCalendar = (await api("GET", "/api/routines")).body;
        const afterStopRun = afterStopCalendar.runs.find((run: { id: string }) => run.id === runId);
        const afterStopState = (await api("GET", "/api/bots?messages=30")).body;
        const afterStopRoom = afterStopState.groups.find((group: { id: string }) => group.id === room.id);
        const afterStopCard = afterStopRoom.messages.find((message: { kind: string }) => message.kind === "goal.run");
        expect(["running", "completed"]).toContain(afterStopRun.status);
        expect(["working", "completed"]).toContain(afterStopCard.goalRun.status);
        expect(afterStopCard.goalRun.status).not.toBe("stopped");

        // The worker's direct delay ends on its own, then the routine goal finishes.
        await expect.poll(async () => {
          const calendar = (await api("GET", "/api/routines")).body;
          const completed = calendar.runs.find((run: { id: string }) => run.id === runId);
          const state = (await api("GET", "/api/bots?messages=30")).body;
          const current = state.groups.find((group: { id: string }) => group.id === room.id);
          const cards = current?.messages.filter((message: { kind: string }) => message.kind === "goal.run") ?? [];
          return {
            runStatus: completed?.status,
            output: completed?.output,
            roomWorking: current?.working,
            cards: cards.length,
            goalStatus: cards[0]?.goalRun?.status,
            detail: cards[0]?.goalRun?.detail,
            turnCount: cards[0]?.goalRun?.turnCount,
          };
        }, { timeout: 15_000 }).toEqual({
          runStatus: "completed",
          output: "Scheduled goal survived the coordinator's direct Stop.",
          roomWorking: false,
          cards: 1,
          goalStatus: "completed",
          detail: "Scheduled goal survived the coordinator's direct Stop.",
          turnCount: 3,
        });
      } finally {
        await api("POST", `/api/groups/${room.id}/interrupt`).catch(() => undefined);
        await api("POST", `/api/bots/${lead.id}/interrupt`).catch(() => undefined);
        await api("POST", `/api/bots/${worker.id}/interrupt`).catch(() => undefined);
        await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
        await api("DELETE", `/api/bots/${lead.id}`).catch(() => undefined);
        await api("DELETE", `/api/bots/${worker.id}`).catch(() => undefined);
      }
    });
  });

  it("runs a routine as a goal in a new background room task", async () => {
    await scenario((scratch) => ({
      FAKE_PI_TOOL_CALLS_FILE: join(scratch, "tool-calls.json"),
      FAKE_PI_RELEASE: join(scratch, "release"),
      FAKE_PI_MARKER_REPLIES: markersIn(scratch, {
        "Goal: Review the release as a team": `The scheduled review is complete.\n${GOAL({ status: "completed", detail: "Scheduled team review completed." })}`,
      }),
    }), async (scratch) => {
      // Hold the goal's first turn open until the running background task has been opened.
      writeFileSync(join(scratch, "tool-calls.json"), JSON.stringify([{ name: "Bash", input: { command: "echo hold" }, hold: true }]));
      const lead = await newBot("Scheduled lead");
      const room = (await api("POST", "/api/groups", {
        name: "Scheduled review team",
        memberIds: [lead.id],
        setup: { bulletin: "Review carefully.", defaultResponder: { kind: "member", botId: lead.id } },
      })).body.group;
      const originalThreadId = room.threadId;

      try {
        const created = await api("POST", "/api/routines", {
          name: "Daily team review",
          prompt: "Review the release as a team",
          target: "room-goal",
          groupId: room.id,
          botId: lead.id,
          runOn: "maus",
          schedule: { type: "once", at: Date.now() + 60_000 },
          durationMinutes: 30,
        });
        expect(created.status).toBe(201);
        expect(created.body.routine).toMatchObject({
          target: "room-goal",
          groupId: room.id,
          botId: lead.id,
        });

        const started = await api("POST", `/api/routines/${created.body.routine.id}/run`);
        expect(started.status).toBe(201);
        const runId = started.body.run.id;

        await expect.poll(async () => {
          const calendar = (await api("GET", "/api/routines")).body;
          const running = calendar.runs.find((run: { id: string }) => run.id === runId);
          const state = (await api("GET", "/api/bots?messages=0")).body;
          const backgroundRoom = state.groups.find((group: { id: string }) => group.id === room.id);
          return {
            status: running?.status,
            threadId: running?.threadId,
            activeThreadId: backgroundRoom?.threadId,
            hasTask: backgroundRoom?.tasks.some(
              (task: { threadId: string }) => task.threadId === running?.threadId,
            ),
            working: backgroundRoom?.working,
          };
        }).toMatchObject({
          status: "running",
          threadId: expect.any(String),
          activeThreadId: originalThreadId,
          hasTask: true,
          working: true,
        });

        const runningCalendar = (await api("GET", "/api/routines")).body;
        const running = runningCalendar.runs.find((run: { id: string }) => run.id === runId);
        const openedWhileWorking = await api("POST", `/api/groups/${room.id}/tasks/${running.threadId}`);
        expect(openedWhileWorking.status).toBe(200);
        expect(openedWhileWorking.body.group).toMatchObject({
          threadId: running.threadId,
          working: true,
        });
        writeFileSync(join(scratch, "release"), "opened the running background task");

        await expect.poll(async () => {
          const calendar = (await api("GET", "/api/routines")).body;
          return calendar.runs.find((run: { id: string }) => run.id === runId);
        }, { timeout: hostTimeout(10_000) }).toMatchObject({
          id: runId,
          status: "completed",
          target: "room-goal",
          groupId: room.id,
          botId: lead.id,
          output: "Scheduled team review completed.",
          threadId: expect.any(String),
        });

        const calendar = (await api("GET", "/api/routines")).body;
        const completedRun = calendar.runs.find((run: { id: string }) => run.id === runId);
        const state = (await api("GET", "/api/bots?messages=0")).body;
        const backgroundRoom = state.groups.find((group: { id: string }) => group.id === room.id);
        expect(backgroundRoom.threadId).toBe(completedRun.threadId);
        expect(backgroundRoom.tasks).toContainEqual(expect.objectContaining({
          threadId: completedRun.threadId,
          title: expect.stringMatching(/^Daily team review · [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M$/),
        }));

        const switched = await api("POST", `/api/groups/${room.id}/tasks/${completedRun.threadId}`);
        expect(switched.status).toBe(200);
        expect(switched.body.group.messages.filter((message: { kind: string }) => message.kind === "goal.run"))
          .toEqual([
            expect.objectContaining({
              goalRun: expect.objectContaining({
                runId,
                status: "completed",
                coordinatorBotId: lead.id,
                detail: "Scheduled team review completed.",
              }),
            }),
          ]);
      } finally {
        await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
        await api("POST", `/api/bots/${lead.id}/interrupt`, {}).catch(() => undefined);
        await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
        await api("DELETE", `/api/bots/${lead.id}`).catch(() => undefined);
      }
    });
  });

  it("pauses a non-converging team at the hard turn limit", async () => {
    // A one-member room still runs team turns: the coordinator continues, then the same bot takes the assignment.
    const loopMarkers: Record<string, string> = {};
    for (let turn = 1; turn <= 13; turn++) {
      if (turn % 2 === 1) {
        const approach = (turn + 1) / 2;
        loopMarkers[`This is team turn ${turn} of 13`] =
          `More work is needed.\n${GOAL({ status: "continue", next: "Looper", instruction: `Try approach ${approach}`, detail: "Still working" })}`;
      } else {
        const approach = turn / 2;
        loopMarkers[`Your assignment: Try approach ${approach}`] = `Approach ${approach} did not finish the task.`;
      }
    }
    await scenario((scratch) => ({ FAKE_PI_MARKER_REPLIES: markersIn(scratch, loopMarkers) }), async () => {
      const looper = await newBot("Looper");
      const room = (await api("POST", "/api/groups", {
        name: "Bounded team",
        memberIds: [looper.id],
        setup: { bulletin: "", defaultResponder: { kind: "member", botId: looper.id } },
      })).body.group;
      const started = await api("POST", `/api/groups/${room.id}/messages`, {
        text: "Keep trying forever",
        mode: "goal",
      });
      expect(started.status).toBe(202);
      // Per-turn digests can push the card out of a tail page, so read around the accepted message.
      const initial = await api("GET", `/api/threads/${started.body.threadId}/messages?around=${started.body.message.id}&limit=3`);
      const card = initial.body.messages.find((message: { kind: string }) => message.kind === "goal.run");
      expect(card).toMatchObject({ id: expect.any(String) });

      await expect.poll(async () => {
        const page = await api("GET", `/api/threads/${started.body.threadId}/messages?around=${card.id}&limit=1`);
        return page.body.messages[0]?.goalRun;
      }, { timeout: 15_000 }).toMatchObject({ status: "limit-reached", turnCount: 13, maxTurns: 13 });
    });
  });

  it("never treats a failed provider turn as a completed goal", async () => {
    // pi's prompt command refuses these turns, which is a provider failure, not a reply.
    await scenario(() => ({ FAKE_PI_MODE: "prompt-reject" }), async () => {
      const lead = await newBot("Failing lead");
      const room = (await api("POST", "/api/groups", {
        name: "Failure checks",
        memberIds: [lead.id],
        setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
      })).body.group;

      expect((await api("POST", `/api/groups/${room.id}/messages`, {
        text: "Do not claim this succeeded",
        mode: "goal",
      })).status).toBe(202);

      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=20")).body;
        const current = state.groups.find((candidate: { id: string }) => candidate.id === room.id);
        return current?.messages.find((message: { kind: string }) => message.kind === "goal.run")?.goalRun;
        // the failed attempt is retried once, and a retry costs a turn, so the count is two
      }, { timeout: hostTimeout(10_000) }).toMatchObject({ status: "failed", turnCount: 2 });
    });
  });

  it("validates mode and binds it to the send id", async () => {
    await scenario(() => ({}), async () => {
      const bot = (await api("POST", "/api/bots")).body.bot;
      const room = (await api("POST", "/api/groups", {
        name: "Mode checks",
        memberIds: [bot.id],
        setup: { bulletin: "", defaultResponder: { kind: "mentions" } },
      })).body.group;
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "hello", mode: "forever" })).status).toBe(400);
      const body = { text: "quiet note", mode: "chat", sendId: "mode_send_1234567890" };
      expect((await api("POST", `/api/groups/${room.id}/messages`, body)).status).toBe(202);
      expect((await api("POST", `/api/groups/${room.id}/messages`, { ...body, mode: "goal" })).status).toBe(409);

      const dm = (await api("GET", "/api/bots?messages=0")).body.groups.find((group: { dm?: boolean }) => group.dm);
      if (dm) expect((await api("POST", `/api/groups/${dm.id}/messages`, { text: "goal", mode: "goal" })).status).toBe(400);
    });
  });

  it("automatically dispatches channel messages queued during a running turn", async () => {
    await scenario((scratch) => ({
      FAKE_PI_TOOL_CALLS_FILE: join(scratch, "tool-calls.json"),
      FAKE_PI_RELEASE: join(scratch, "release"),
      FAKE_PI_MARKER_REPLIES: markersIn(scratch, {
        "second request": "second response",
        "first request": "first response",
      }),
    }), async (scratch) => {
      writeFileSync(join(scratch, "tool-calls.json"), JSON.stringify([{ name: "Bash", input: { command: "echo hold" }, hold: true }]));
      const bot = await newBot("Queue worker");
      const room = (await api("POST", "/api/groups", {
        name: "Queue checks",
        memberIds: [bot.id],
        setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
      })).body.group;
      const firstSendId = "channel_queue_first_1234";
      const secondSendId = "channel_queue_second_123";

      const first = await api("POST", `/api/groups/${room.id}/messages`, {
        text: "first request",
        sendId: firstSendId,
      });
      expect(first.status).toBe(202);
      expect(first.body.message).toMatchObject({ role: "user", text: "first request", sendId: firstSendId });

      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.groups.find((candidate: { id: string }) => candidate.id === room.id)?.working;
      }).toBe(true);

      const queuedBody = { text: "second request", sendId: secondSendId };
      const queued = await api("POST", `/api/groups/${room.id}/messages`, queuedBody);
      expect(queued.status).toBe(202);
      expect(queued.body).toMatchObject({ queued: true, threadId: room.threadId });
      expect(queued.body.queueId).toEqual(expect.any(String));
      expect(queued.body.message).toBeUndefined();

      const retryWhileQueued = await api("POST", `/api/groups/${room.id}/messages`, queuedBody);
      expect(retryWhileQueued.body).toMatchObject({ queued: true, queueId: queued.body.queueId });
      writeFileSync(join(scratch, "release"), "observed the queued message and idempotent retry");

      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=30")).body;
        const current = state.groups.find((candidate: { id: string }) => candidate.id === room.id);
        const userLines = current?.messages.filter((message: { role?: string }) => message.role === "user") ?? [];
        return {
          working: current?.working,
          sends: userLines.map((message: { sendId?: string }) => message.sendId),
        };
      }, { timeout: hostTimeout(10_000) }).toEqual({ working: false, sends: [firstSendId, secondSendId] });

      const state = (await api("GET", "/api/bots?messages=30")).body;
      const current = state.groups.find((candidate: { id: string }) => candidate.id === room.id);
      const firstUserAt = current.messages.findIndex((message: { sendId?: string }) => message.sendId === firstSendId);
      const secondUserAt = current.messages.findIndex((message: { sendId?: string }) => message.sendId === secondSendId);
      const firstReplyAt = current.messages.findIndex(
        (message: { role?: string }, index: number) => index > firstUserAt && message.role === "bot",
      );
      const secondReplyAt = current.messages.findIndex(
        (message: { role?: string }, index: number) => index > secondUserAt && message.role === "bot",
      );
      expect(firstUserAt).toBeGreaterThanOrEqual(0);
      expect(firstReplyAt).toBeGreaterThan(firstUserAt);
      expect(secondUserAt).toBeGreaterThan(firstReplyAt);
      expect(secondReplyAt).toBeGreaterThan(secondUserAt);
      expect(current.messages[secondUserAt]).toMatchObject({ queueId: queued.body.queueId });

      const retryAfterDrain = await api("POST", `/api/groups/${room.id}/messages`, queuedBody);
      expect(retryAfterDrain.body.message).toMatchObject({
        sendId: secondSendId,
        queueId: queued.body.queueId,
      });
    });
  });
});
