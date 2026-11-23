import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { piAgentsToken, piInstructionsFor, piTurns } from "./testing/pi-dump.ts";

const SETTLED = "Your downstream room requests have settled.";
const REPORT_FROM_PEER = "[From @Routine peer (bot) · report on assignment";

describe("routine delegation through the isolated harness", () => {
  let fixture: VerificationServer;
  let source: any;
  let peer: any;
  let evidence: unknown[];
  const raw = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : { origin: fixture.info.url }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    if (method !== "GET") evidence.push({ method, path, body, status: response.status });
    return { status: response.status, body: value };
  };
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const { status, body: value } = await raw(method, path, body, token);
    expect(status, `${method} ${path}: ${JSON.stringify(value)}`).toBeLessThan(300);
    return value;
  };
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
  const file = (threadId: string, extension: string) => join(fixture.info.dataDir, `${threadId}.${extension}`);
  const finish = (threadId: string) => writeFileSync(file(threadId, "gate"), "finish isolated turn");
  // The fake pi appends its launches and prompts to a per-thread JSONL log (the wrapper points FAKE_PI_DUMP here),
  // so a turn whose prompt has arrived is a turn under way, where the retired fixture waited for a dump file.
  const turns = (threadId: string) => piTurns(file(threadId, "jsonl"));
  const dump = async (threadId: string, atLeast = 1) => {
    await expect.poll(() => turns(threadId).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(atLeast);
    return turns(threadId);
  };
  /** The instructions in effect on the thread's `index`th turn (default: the newest). */
  const instructions = (threadId: string, index?: number) => {
    const threadTurns = turns(threadId);
    return piInstructionsFor(threadTurns, index ?? threadTurns.length - 1);
  };
  const runState = async (id: string) => (await api("GET", "/api/routines")).runs.find((run: any) => run.id === id);
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  const botState = async (botId: string) => (await api("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.id === botId);
  const rows = () => readHandoffs(fixture.info.dataDir);
  const peerWork = (threadId: string) => rows().find((node) => node.botId === peer.id && node.parentId && rows().find((root) => root.id === node.parentId)?.threadId === threadId);
  const awaitPeerWork = async (threadId: string) => {
    await expect.poll(() => Boolean(peerWork(threadId)), { timeout: 15_000 }).toBe(true);
    return peerWork(threadId)!;
  };
  const token = async (threadId: string) => piAgentsToken((await dump(threadId)).at(-1)) as string;
  const start = async () => {
    const { routine } = await api("POST", "/api/routines", {
      name: "Delegated report", prompt: "Ask the peer for evidence, then report its result.", botId: source.id,
      enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    });
    const { run } = await api("POST", `/api/routines/${routine.id}/run`);
    await expect.poll(async () => (await runState(run.id))?.status, { timeout: 15_000 }).toBe("running");
    return await runState(run.id);
  };
  const delegate = async (threadId: string) => {
    const result = await api("POST", "/api/internal/coordinate-bots", { botIds: [peer.id], message: "Produce the fixture report." }, await token(threadId));
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0]).toMatchObject({ botId: peer.id, outcome: "queued", requestId: expect.any(String) });
    expect(result.message).toContain("End your turn");
    return result;
  };
  /** The isolated fake runs every bot: one slot per bot makes "busy" mean busy. */
  const oneSlotPerBot = () => api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } });
  beforeEach(async () => {
    fixture = await launchVerificationServer();
    evidence = [{ fixture: fixture.info }];
    source = (await control(["new-bot", "--name", "Routine owner"]) as any).bot;
    peer = (await control(["new-bot", "--name", "Routine peer"]) as any).bot;
    // The resumed routine turn answers with this reply once the peer's report reaches its prompt (the fake pi's
    // whole-prompt echo would push the settled line past the run output's recorded first 2 000 characters).
    writeFileSync(join(fixture.info.dataDir, "marker-replies.json"), JSON.stringify({
      [REPORT_FROM_PEER]: `${SETTLED} ${REPORT_FROM_PEER}] The peer's fixture report is recorded and the run is complete.`,
    }));
    const wrapper = join(fixture.info.dataDir, "routine-gated.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'import { join } from "node:path";',
      // The driver hands every pi child its thread id in the env, so each bot turn hangs on its own thread's gate
      // file (model probes, which have no thread, run happy). pi keeps one warm process per thread: the gate path and
      // the agents token are fixed at its first launch and stay the thread's for later turns. The marker replies are
      // what let a resumed routine turn answer with its report instead of the whole-prompt echo.
      'process.env.FAKE_PI_CLAUDE_COMPAT = "1";',
      'const thread = process.env.LUNABOT_THREAD_ID ?? "probe";',
      'process.env.FAKE_PI_MODE = thread === "probe" ? "happy" : "hang";',
      `process.env.FAKE_PI_RELEASE = join(${JSON.stringify(fixture.info.dataDir)}, thread + ".gate");`,
      `process.env.FAKE_PI_MARKER_REPLIES = join(${JSON.stringify(fixture.info.dataDir)}, "marker-replies.json");`,
      `process.env.FAKE_PI_DUMP = join(${JSON.stringify(fixture.info.dataDir)}, thread + ".jsonl");`,
      `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-pi-cli.ts")).href)});`,
    ].join("\n"), { mode: 0o700 });
    await api("PATCH", "/api/instances/pi", { cli: wrapper });
  }, 30_000);
  afterEach(async () => {
    if (!fixture) return;
    const path = `${fixture.info.logPath}.json`;
    writeFileSync(path, JSON.stringify({ evidence, final: await api("GET", "/api/routines").catch(() => null),
      bots: await api("GET", "/api/bots?messages=0").catch(() => null), rows: rows() }, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath: path }));
    await fixture.close();
  });

  it("waits for a busy peer, then resumes the same routine as a routine turn and records the final report", async () => {
    await oneSlotPerBot();
    const peerThread = (await botState(peer.id)).threadId;
    await control(["send", "--bot", peer.id, "--text", "An existing task occupies the peer."]);
    await dump(peerThread);
    expect(instructions(peerThread, 0)).not.toContain("Execute this routine now:");
    const run = await start();
    await dump(run.threadId);
    const kickoff = instructions(run.threadId, 0);
    expect(kickoff).toContain("Execute this routine now:");
    expect(kickoff).toContain("use coordinate_bots for required handoffs");
    expect(kickoff).toContain("after an accepted hand-off, end this turn for automatic resumption");
    const { receipts } = await delegate(run.threadId);
    finish(run.threadId);
    await expect.poll(async () => (await runState(run.id))?.status, { timeout: 15_000 }).toBe("waiting");
    expect((await runState(run.id)).attention).toContain("handed on");
    expect((await runState(run.id)).finishedAt).toBeUndefined();
    const work = await awaitPeerWork(run.threadId);
    expect(work).toMatchObject({ id: receipts[0].requestId, status: "queued", mode: "work", reply: "resume", text: "Produce the fixture report." });
    expect(work.threadId).not.toBe(peerThread);
    expect(rows().find((node) => node.id === work.parentId)).toMatchObject({ threadId: run.threadId, botId: source.id, status: "waiting" });
    finish(peerThread);
    await dump(work.threadId);
    finish(work.threadId);
    await expect.poll(async () => (await runState(run.id))?.status, { timeout: 20_000 }).toBe("completed");
    const transcript = await messages(run.threadId);
    expect(transcript.some((message) => message.tool?.name === "Routine peer replied" && message.from?.botId === peer.id)).toBe(true);
    expect(transcript.some((message) => message.tool?.name?.startsWith("Resumed with Routine peer results"))).toBe(true);
    const finished = await runState(run.id);
    expect(finished.output).toContain(SETTLED);
    expect(finished.output).toContain(REPORT_FROM_PEER);
    // The resumed routine turn still runs under the routine's instructions.
    await dump(run.threadId, 2);
    expect(instructions(run.threadId)).toContain("Execute this routine now:");
    expect(peerWork(run.threadId)).toMatchObject({ status: "completed" });
    expect(rows().find((node) => node.id === work.parentId)?.status).toBe("completed");
    evidence.push({ waitedForBusyPeer: true, resumedRoutine: run.id, threadId: run.threadId, transcript });
  }, 60_000);

  it.each([
    { capacity: 3, resume: "completion" },
    { capacity: 1, resume: "raise" },
  ])("resumes the waiting routine once a slot frees at capacity $capacity, on $resume", async ({ capacity, resume }) => {
    await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: capacity } });
    const run = await start();
    await delegate(run.threadId);
    finish(run.threadId);
    await expect.poll(async () => (await runState(run.id))?.status, { timeout: 15_000 }).toBe("waiting");
    const work = await awaitPeerWork(run.threadId);
    await dump(work.threadId);

    const occupiedThreads: string[] = [];
    for (let index = 0; index < capacity; index++) {
      const { task } = await api("POST", `/api/bots/${source.id}/tasks`, { title: `Occupied ${index}` });
      occupiedThreads.push(task.threadId);
      await api("POST", `/api/bots/${source.id}/messages`, { threadId: task.threadId, text: "Hold this task open." });
      await dump(task.threadId);
    }
    finish(work.threadId);
    await expect.poll(async () => (await messages(run.threadId)).some(
      (message) => message.tool?.name === "Routine peer replied" && message.from?.botId === peer.id,
    ), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => peerWork(run.threadId)?.status, { timeout: 15_000 }).toBe("completed");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect((await runState(run.id)).status).toBe("waiting");
    expect(rows().find((node) => node.id === work.parentId)?.status).toBe("resume");
    expect((await messages(run.threadId)).some((message) => message.tool?.name?.startsWith("Resumed with"))).toBe(false);

    if (resume === "raise") await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: capacity + 1 } });
    else {
      finish(occupiedThreads[0]);
      await expect.poll(async () => (await botState(source.id)).tasks.find((task: any) => task.threadId === occupiedThreads[0]).busy, { timeout: 15_000 }).toBe(false);
    }
    await expect.poll(async () => (await runState(run.id))?.status, { timeout: 15_000 }).toBe("completed");
    expect((await runState(run.id)).output).toContain(SETTLED);
    expect((await messages(run.threadId)).some((message) => message.tool?.name?.startsWith("Resumed with Routine peer results"))).toBe(true);
    const bot = await botState(source.id);
    expect(occupiedThreads.map(threadId => bot.tasks.find((task: any) => task.threadId === threadId).busy))
      .toEqual(resume === "raise" ? [true] : [false, true, true]);
    evidence.push({ resumeWaitedForSlot: true, capacity, resume, runId: run.id, transcript: await messages(run.threadId) });
  }, 60_000);

  it("coordinates a new user request on a completed routine's thread without changing its recorded result", async () => {
    const run = await start();
    finish(run.threadId);
    await expect.poll(async () => (await runState(run.id))?.status, { timeout: 15_000 }).toBe("completed");
    const finished = await runState(run.id);
    await expect.poll(async () => (await botState(source.id)).tasks.find((task: any) => task.threadId === run.threadId)?.busy).toBe(false);
    // Retire the finished turn's gate, so the thread's warm pi holds the new request until this test finishes it.
    unlinkSync(file(run.threadId, "gate"));
    await api("POST", `/api/bots/${source.id}/messages`, { threadId: run.threadId, text: "A new request: ask the peer for a fresh report." });
    // The coordinate call rides the thread's turn capability, so it waits until that new turn is under way.
    await dump(run.threadId, 2);
    const coordinated = await api("POST", "/api/internal/coordinate-bots", {
      botIds: [peer.id], message: "Produce a fresh fixture report.",
    }, await token(run.threadId));
    expect(coordinated.receipts).toHaveLength(1);
    const requestId = coordinated.receipts[0].requestId;
    const handoff = () => rows().find((node) => node.id === requestId)!;
    finish(run.threadId);
    await dump(handoff().threadId);
    finish(handoff().threadId);
    await expect.poll(async () => (await messages(run.threadId)).some(
      (message) => message.from?.botId === peer.id && message.roomRequest?.id === requestId && message.roomRequest.phase === "result",
    ), { timeout: 20_000 }).toBe(true);
    await control(["wait", "--bot", source.id, "--task", run.threadId]);
    expect(handoff().status).toBe("completed");
    expect(await runState(run.id)).toMatchObject({ status: "completed", finishedAt: finished.finishedAt, output: finished.output });
    evidence.push({ reusedCompletedExecution: true, transcript: await messages(run.threadId) });
  }, 45_000);

  it("keeps a failed routine's queued hand-off on the runtime through a provider reload without reviving the run", async () => {
    await oneSlotPerBot();
    const peerThread = (await botState(peer.id)).threadId;
    await control(["send", "--bot", peer.id, "--text", "An existing task occupies the peer."]);
    await dump(peerThread);
    const run = await start();
    const { receipts } = await delegate(run.threadId);
    const work = await awaitPeerWork(run.threadId);
    expect(work).toMatchObject({ id: receipts[0].requestId, status: "queued" });
    // A workspace provider key reaches the fixture's pi engine (its custom provider rides the instance's injected
    // env), so the save rebuilds it without a credential probe and interrupts the turn it was running.
    await api("PUT", "/api/config", { openaiCompat: { key: "fixture-pi-key" } });
    await expect.poll(async () => (await runState(run.id))?.status).toBe("failed");
    const failed = await runState(run.id);
    const health = (await api("GET", "/api/routines")).routines.find((routine: any) => routine.id === run.routineId);
    expect(health.failureStreak).toBe(1);
    evidence.push({ failedRunHealth: health });
    await dump(work.threadId);
    finish(work.threadId);
    await expect.poll(() => peerWork(run.threadId)?.status, { timeout: 20_000 }).toBe("completed");
    await expect.poll(async () => (await messages(run.threadId)).some(
      (message) => message.tool?.name === "Routine peer replied" && message.from?.botId === peer.id,
    ), { timeout: 15_000 }).toBe(true);
    finish(run.threadId);
    await expect.poll(() => rows().find((node) => node.id === work.parentId)?.status, { timeout: 20_000 }).toBe("completed");
    await control(["wait", "--bot", source.id, "--task", run.threadId]);
    expect(await runState(run.id)).toMatchObject({ status: "failed", finishedAt: failed.finishedAt, error: failed.error });
    expect((await api("GET", "/api/routines")).routines.find((routine: any) => routine.id === run.routineId).failureStreak).toBe(1);
    evidence.push({ providerReloadKeptRuntimeHandoff: true, runId: run.id, transcript: await messages(run.threadId) });
  }, 60_000);

  it("does not revive a cancelled routine: its running peer stops with it, and later user work never resumes it", async () => {
    const run = await start();
    await delegate(run.threadId);
    finish(run.threadId);
    await expect.poll(async () => (await runState(run.id))?.status).toBe("waiting");
    const work = await awaitPeerWork(run.threadId);
    await dump(work.threadId);
    await expect.poll(() => peerWork(run.threadId)?.status, { timeout: 15_000 }).toBe("running");
    await api("POST", `/api/routine-runs/${run.id}/cancel`);
    await expect.poll(() => rows().find((node) => node.id === work.parentId)?.status, { timeout: 10_000 }).toBe("cancelled");
    // Stop means stop: the peer mid-turn ends with the cancelled run, its engine turn included.
    await expect.poll(() => peerWork(run.threadId)?.status, { timeout: 10_000 }).toBe("cancelled");
    await expect.poll(async () => Boolean((await botState(peer.id)).busy), { timeout: 15_000 }).toBe(false);
    unlinkSync(file(run.threadId, "gate"));
    await api("POST", `/api/bots/${source.id}/messages`, { threadId: run.threadId, text: "A new independent request after cancellation." });
    await dump(run.threadId, 2);
    // Past the moment the peer would have answered, during the later user work.
    finish(work.threadId);
    finish(run.threadId);
    await control(["wait", "--bot", source.id, "--task", run.threadId]);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(peerWork(run.threadId)?.status).toBe("cancelled");
    const transcript = await messages(run.threadId);
    expect(transcript.some((message) => message.tool?.name === "Routine peer replied")).toBe(false);
    expect(transcript.some((message) => message.text?.includes(REPORT_FROM_PEER))).toBe(false);
    expect(transcript.some((message) => message.text?.includes(SETTLED))).toBe(false);
    expect(transcript.some((message) => message.tool?.name?.startsWith("Resumed with"))).toBe(false);
    expect((await runState(run.id)).status).toBe("cancelled");
    expect(Boolean((await botState(source.id)).busy)).toBe(false);
    evidence.push({ cancelledPeerStoppedWithRun: true, transcript });
  }, 45_000);
});
