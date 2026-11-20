import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_PI = join(SERVER_DIR, "testing", "fake-pi-cli.ts");

let child: ChildProcess;
let home = "";
let base = "";
let model = "";
let stderr = "";

const envelope = (payload: Record<string, string>) => `<openmaus-goal>${JSON.stringify(payload)}</openmaus-goal>`;

// turn 1 assigns the worker that never frees up; turn 2 (after the harness note) reassigns to the helper; turn 3 completes
const reassignLeadReplies = [
  `Hang should start.\n${envelope({ status: "continue", next: "Hang", instruction: "Draft the summary", detail: "Assigning" })}`,
  `Reassigning to Helper.\n${envelope({ status: "continue", next: "Helper", instruction: "Draft the summary instead", detail: "Reassigned" })}`,
  `Done.\n${envelope({ status: "completed", detail: "Helper drafted the summary." })}`,
];

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

// 本版只有一个 pi 实例，环境开关却是进程级的：包一层 .mjs，按引擎 spawn 的 OMB_BOT_ID
// 为该 bot 挑 FAKE_PI_MODE/REPLIES——与旧夹具每 bot 一台 claude 的语义一致。目录探测没有
// OMB_BOT_ID，落到 happy 默认，requireAvailableModel 才能拿到模型列表。
let botMapPath = "";

const wrapper = (data: string, fakeCli: string, mapPath: string) => [
  "#!/usr/bin/env node",
  'import { existsSync, readFileSync } from "node:fs";',
  'import { join } from "node:path";',
  'import { pathToFileURL } from "node:url";',
  `const bots = existsSync(${JSON.stringify(mapPath)}) ? JSON.parse(readFileSync(${JSON.stringify(mapPath)}, "utf8")) : {};`,
  'const spec = bots[process.env.OMB_BOT_ID ?? ""] ?? {};',
  'if (spec.compat !== false) process.env.FAKE_PI_CLAUDE_COMPAT = "1";',
  'process.env.FAKE_PI_MODE = spec.mode ?? "happy";',
  "if (spec.replies) {",
  "  process.env.FAKE_PI_REPLIES = JSON.stringify(spec.replies);",
  `  process.env.FAKE_PI_REPLY_STATE = join(${JSON.stringify(data)}, \`reply-state-\${process.env.OMB_BOT_ID}.txt\`);`,
  "}",
  `await import(${JSON.stringify(pathToFileURL(fakeCli).href)});`,
].join("\n");

beforeAll(async () => {
  chmodSync(FAKE_PI, 0o755);
  home = mkdtempSync(join(tmpdir(), "omb-goal-wait-cap-"));
  const data = join(home, ".lunabot");
  const staticDir = join(home, "static");
  botMapPath = join(home, "goal-cap-bots.json");
  const cliPath = join(home, "goal-cap-cli.mjs");
  writeFileSync(cliPath, wrapper(home, FAKE_PI, botMapPath), { mode: 0o700 });
  mkdirSync(data, { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Goal wait cap test</title>");
  writeFileSync(join(staticDir, "assets", "smoke.css"), "body{}");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    features: { smartSetupChoices: false },
    instances: {
      pi: { driver: "piAgent", displayName: "Verification pi", config: { cli: cliPath } },
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
      OMB_STATIC_DIR: staticDir,
      // seconds, not minutes: the point of this file is the cap firing
      OMB_GOAL_WAIT_MAX_MS: "1500",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    try {
      if ((await fetch(`${base}/api/health`)).status === 200) break;
    } catch {
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (;;) {
    const found = ((await api("GET", "/api/instances")).body.instances ?? [])
      .find((instance: { instanceId: string; models?: { default?: string } }) => instance.instanceId === "pi")?.models?.default;
    if (found) { model = found; break; }
    if (Date.now() >= deadline) throw new Error(`the pi instance never reported a default model: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

const createBot = async (name: string) =>
  (await api("POST", "/api/bots", {
    name,
    modelSelection: { instanceId: "pi", model },
    requireAvailableModel: true,
  })).body.bot;

/** botId -> { mode, replies }: written before the bots' first turn; the wrapper reads it at every spawn. */
const flavors = (entries: Record<string, { mode?: string; replies?: string[]; compat?: boolean }>) =>
  writeFileSync(botMapPath, JSON.stringify(entries));

const createRoom = async (name: string, leadId: string, memberIds: string[]) =>
  (await api("POST", "/api/groups", {
    name,
    memberIds,
    setup: { bulletin: "", defaultResponder: { kind: "member", botId: leadId } },
  })).body.group;

const roomState = async (roomId: string) => {
  const state = (await api("GET", "/api/bots?messages=40")).body;
  const room = state.groups.find((group: { id: string }) => group.id === roomId);
  const cards = room?.messages.filter((message: { kind: string }) => message.kind === "goal.run") ?? [];
  return { state, room, cards };
};

const holdBusy = async (botId: string, text: string) => {
  const posted = await api("POST", `/api/bots/${botId}/messages`, { text });
  expect(posted.status, JSON.stringify(posted.body)).toBe(202);
  await expect.poll(async () => {
    const state = (await api("GET", "/api/bots?messages=0")).body;
    return state.bots.find((bot: { id: string }) => bot.id === botId)?.busy;
  }).toBe(true);
};

describe("goal wait cap and transient retry", () => {
  it("reassigns through the lead when a worker stays busy past the cap, and still completes", async () => {
    const lead = await createBot("Lead");
    const hang = await createBot("Hang");
    const helper = await createBot("Helper");
    flavors({
      [lead.id]: { replies: reassignLeadReplies },
      [hang.id]: { mode: "hang" },
      [helper.id]: { replies: ["Here is the summary draft."] },
    });
    const room = await createRoom("Wait cap team", lead.id, [lead.id, hang.id, helper.id]);

    // the worker is stuck in an unrelated direct turn that never settles
    await holdBusy(hang.id, "Never finish this");

    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Draft the summary", mode: "goal" })).status).toBe(202);

    await expect.poll(async () => {
      const { room: current, cards } = await roomState(room.id);
      const spoke = (botId: string) =>
        current?.messages.some((message: { kind: string; role?: string; from?: { botId?: string } }) =>
          message.kind === "text" && message.role === "bot" && message.from?.botId === botId
        );
      return {
        cards: cards.length,
        status: cards[0]?.goalRun?.status,
        detail: cards[0]?.goalRun?.detail,
        reassignChip: current?.messages.some((message: { kind: string; tool?: { name?: string } }) =>
          message.kind === "activity" && /stayed busy .* asking Lead to reassign/i.test(message.tool?.name ?? "")
        ),
        hangSpoke: spoke(hang.id),
        helperSpoke: spoke(helper.id),
      };
    }, { timeout: 20_000 }).toEqual({
      cards: 1,
      status: "completed",
      detail: "Helper drafted the summary.",
      reassignChip: true,
      hangSpoke: false,
      helperSpoke: true,
    });

    const state = (await api("GET", "/api/bots?messages=0")).body;
    expect(state.bots.find((bot: { id: string }) => bot.id === hang.id)?.busy).toBe(true);
    expect((await api("POST", `/api/bots/${hang.id}/interrupt`)).status).toBe(200);
  });

  it("ends blocked, not failed, when the lead itself stays busy past the cap", async () => {
    const lead = await createBot("Stuck lead");
    const helper = await createBot("Idle helper");
    flavors({ [lead.id]: { mode: "hang" }, [helper.id]: { replies: ["Here is the summary draft."] } });
    const room = await createRoom("Stuck lead team", lead.id, [lead.id, helper.id]);

    await holdBusy(lead.id, "Never finish this either");
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Plan the launch", mode: "goal" })).status).toBe(202);

    await expect.poll(async () => {
      const { cards } = await roomState(room.id);
      return { cards: cards.length, status: cards[0]?.goalRun?.status, detail: cards[0]?.goalRun?.detail };
    }, { timeout: 20_000 }).toEqual({
      cards: 1,
      status: "blocked",
      detail: expect.stringMatching(/Stuck lead stayed busy .* send the goal again when they are free/i),
    });

    expect((await api("POST", `/api/bots/${lead.id}/interrupt`)).status).toBe(200);
  });

  it("retries a lead whose provider dies exactly once before the run fails", async () => {
    const lead = await createBot("Crashing lead");
    const helper = await createBot("Spare helper");
    flavors({ [lead.id]: { mode: "turn-error", compat: false }, [helper.id]: { replies: ["Here is the summary draft."] } });
    const room = await createRoom("Crash team", lead.id, [lead.id, helper.id]);

    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Try anyway", mode: "goal" })).status).toBe(202);

    await expect.poll(async () => {
      const { cards } = await roomState(room.id);
      return { cards: cards.length, status: cards[0]?.goalRun?.status };
    }, { timeout: 20_000 }).toEqual({ cards: 1, status: "failed" });

    const { room: current } = await roomState(room.id);
    const activity = current?.messages.filter((message: { kind: string }) => message.kind === "activity") ?? [];
    const failures = activity.filter((message: { tool?: { name?: string } }) => /error:/i.test(message.tool?.name ?? ""));
    expect(failures.length).toBeGreaterThanOrEqual(2);
  });

  it("chat: a responder that stays busy past the cap is skipped with the bounded truth, and the next responder still runs", async () => {
    const stuck = await createBot("Stuck");
    const helper = await createBot("Chat helper");
    flavors({ [stuck.id]: { mode: "hang" }, [helper.id]: { replies: ["Here is the summary draft."] } });
    const room = (await api("POST", "/api/groups", {
      name: "Wait cap chat",
      memberIds: [stuck.id, helper.id],
      setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
    })).body.group;

    await holdBusy(stuck.id, "Never finish this chat");
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Quick check-in" })).status).toBe(202);

    await expect.poll(async () => {
      const { room: current } = await roomState(room.id);
      const messages: Array<{ kind: string; role?: string; from?: { botId?: string }; tool?: { name?: string; ok?: boolean } }> =
        current?.messages ?? [];
      const chip = messages.find((message) =>
        message.kind === "activity" && message.from?.botId === stuck.id && /skipped this round/i.test(message.tool?.name ?? "")
      );
      return {
        working: current?.working,
        chip: chip?.tool?.name,
        chipOk: chip?.tool?.ok,
        waitChips: messages.filter((message) =>
          message.kind === "activity" && message.from?.botId === stuck.id && /another conversation/i.test(message.tool?.name ?? "")
        ).length,
        stuckSpoke: messages.some((message) => message.kind === "text" && message.role === "bot" && message.from?.botId === stuck.id),
        helperSpoke: messages.some((message) => message.kind === "text" && message.role === "bot" && message.from?.botId === helper.id),
      };
    }, { timeout: 20_000 }).toEqual({
      working: false,
      chip: "Stuck stayed busy in another conversation for 1 minute — skipped this round",
      chipOk: false,
      waitChips: 1,
      stuckSpoke: false,
      helperSpoke: true,
    });

    const state = (await api("GET", "/api/bots?messages=0")).body;
    expect(state.bots.find((bot: { id: string }) => bot.id === stuck.id)?.busy).toBe(true);
    expect((await api("POST", `/api/bots/${stuck.id}/interrupt`)).status).toBe(200);
  });
});
