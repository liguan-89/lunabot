// A live room question fences its own task but not the room's other work, and the question outlives the turn that asked
// it: after the turn settles and the server starts again it still waits, and the person's answer then reaches the bot
// as a new turn. The engine is the synthetic pi, which raises a real question card for the prompt carrying its marker.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-omb.ts";
import type { GroupTask, WireBot, WireGroup, WireMessage } from "../shared/wire.ts";
import { waitForExit } from "./testing/cleanup.ts";

/** The prompt's own words that make the fake pi raise its question card. */
const ASKS = "Ask one question";
const env = { FAKE_PI_QUESTION_ON: ASKS };

it("keeps live room questions fenced but allows task changes after their turn settles and restarts", async () => {
  const fixture = await launchVerificationServer(env);
  const evidence: unknown[] = [{ fixture: fixture.info }];
  let restarted: ChildProcess | undefined;
  const api = async <T = unknown>(method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() as T };
    evidence.push({ method, path, body, result });
    return result;
  };
  try {
    const created = await api<{ bot: WireBot }>("POST", "/api/bots", { name: "Room question holder" });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    const roomReply = await api<{ group: WireGroup }>("POST", "/api/groups", {
      name: "Question room", memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    });
    expect(roomReply.status).toBe(201);
    const room = roomReply.body.group;
    const spare = await api<{ task: GroupTask }>("POST", `/api/groups/${room.id}/tasks`, { title: "Other task" });
    expect(spare.status).toBe(201);
    const spareThreadId = spare.body.task.threadId;
    expect((await api("POST", `/api/groups/${room.id}/tasks/${room.threadId}`, {})).status).toBe(200);
    // The prompt carries the marker, so the turn asks a question and waits on the person (a real extension-UI select).
    expect((await api("POST", `/api/groups/${room.id}/messages`, {
      threadId: room.threadId, text: "Ask one question and finish without its answer.",
    })).status).toBe(202);
    const cards = async () => (await api<{ messages: WireMessage[] }>("GET", `/api/threads/${room.threadId}/messages`)).body.messages
      .map((message) => message.card).filter((card): card is NonNullable<typeof card> => Boolean(card?.requestId));
    const cardOf = async (id: string) => (await cards()).find((card) => card.requestId === id);
    /** The question the room still waits on: the fake pi names its dialog "ask-question" every turn. */
    const question = async () => (await cards()).find((card) => card.requestType === "question" && !card.answered);
    const roomState = async () => (await api<{ groups: WireGroup[] }>("GET", "/api/bots?messages=0")).body.groups
      .find((group) => group.id === room.id)!;
    let requestId = "";
    await expect.poll(async () => { requestId = (await question())?.requestId ?? ""; return Boolean(requestId); }, { timeout: 15_000 }).toBe(true);
    expect(await question()).toMatchObject({ requestType: "question", requestId });
    expect((await roomState()).working).toBe(true);
    const changes: Array<[string, string, unknown?]> = [
      ["POST", `/api/groups/${room.id}/tasks`, { title: "New task" }],
      ["POST", `/api/groups/${room.id}/tasks/${spareThreadId}`, {}],
      ["PATCH", `/api/groups/${room.id}/tasks/${spareThreadId}`, { title: "Renamed task" }],
      ["PATCH", `/api/groups/${room.id}`, { bulletin: "Revised brief" }],
      ["PATCH", `/api/groups/${room.id}`, { memberIds: [bot.id] }],
      ["DELETE", `/api/groups/${room.id}/tasks/${spareThreadId}`],
    ];
    const fenced: Array<[string, string, unknown?]> = [
      ["PATCH", `/api/groups/${room.id}/tasks/${room.threadId}`, { title: "Renamed live task" }],
      ["DELETE", `/api/groups/${room.id}/tasks/${room.threadId}`],
      ...changes.slice(3, 5),
    ];
    for (const [method, path, body] of fenced) {
      expect((await api(method, path, body)).status, `${method} ${path} while live`).toBe(409);
    }
    const beside = await api<{ task: GroupTask }>("POST", `/api/groups/${room.id}/tasks`, { title: "Task beside the question" });
    expect(beside.status, "a new task while live").toBe(201);
    expect((await api("PATCH", `/api/groups/${room.id}/tasks/${spareThreadId}`, { title: "Renamed while live" })).status).toBe(200);
    expect((await api("POST", `/api/groups/${room.id}/tasks/${room.threadId}`, {})).status).toBe(200);
    expect((await api("DELETE", `/api/groups/${room.id}/tasks/${beside.body.task.threadId}`)).status).toBe(200);
    expect(await question()).toMatchObject({ requestType: "question", requestId });
    expect((await roomState()).working).toBe(true);

    // The person stops the turn instead of answering: the question itself is not the turn, so it stays open.
    expect((await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId })).status).toBe(200);
    await expect.poll(async () => (await roomState()).working, { timeout: 15_000 }).toBe(false);
    expect(await question()).toMatchObject({ requestType: "question", requestId });
    expect((await question())!.answered).toBeUndefined();
    expect((await question())!.dismissed).toBeUndefined();
    const settledTask = await api<{ task: GroupTask }>("POST", `/api/groups/${room.id}/tasks`, { title: "Settled question task" });
    expect(settledTask.status).toBe(201);
    expect((await api("POST", `/api/groups/${room.id}/tasks/${spareThreadId}`, {})).status).toBe(200);
    expect((await api("POST", `/api/groups/${room.id}/tasks/${room.threadId}`, {})).status).toBe(200);
    for (const [method, path, body] of changes.slice(2, 5)) {
      expect((await api(method, path, body)).status, `${method} ${path} after settlement`).toBe(200);
    }
    expect((await api("DELETE", `/api/groups/${room.id}/tasks/${settledTask.body.task.threadId}`)).status).toBe(200);

    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const log = openSync(fixture.info.logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: verificationServerEnvironment(env, fixture.info.dataDir, Number(new URL(fixture.info.url).port)),
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await api<{ pid: number }>("GET", "/api/health")).body.pid; } catch { return undefined; }
    }, { timeout: 20_000 }).toBe(restarted.pid);
    expect((await roomState()).working).toBe(false);
    expect((await question())!.answered).toBeUndefined();
    expect((await question())!.dismissed).toBeUndefined();
    for (const [method, path, body] of changes) {
      expect((await api(method, path, body)).status, `${method} ${path} after restart`).toBe(method === "POST" && path.endsWith("/tasks") ? 201 : 200);
    }
    expect((await question())!.answered).toBeUndefined();
    expect((await question())!.dismissed).toBeUndefined();
    // Its turn is over, so the answer is a new turn of the room's bot carrying the person's words.
    expect((await api("POST", `/api/threads/${room.threadId}/respond`, {
      requestId, behavior: "answer", message: "Blue",
    }))).toMatchObject({ status: 200, body: { ok: true, outcome: "answered", late: true } });
    await expect.poll(() => cardOf(requestId), { timeout: 5_000 }).toMatchObject({ answered: "answer", answeredText: "Blue", dismissed: false });
  } finally {
    if (restarted) await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    const evidencePath = `${fixture.info.logPath}.room-question-tasks.json`;
    try {
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    } catch (error) {
      console.warn("Could not write room-question test evidence", error);
    }
    const fixtureRemoved = !existsSync(fixture.info.dataDir);
    expect.soft(fixtureRemoved).toBe(true);
    console.info(JSON.stringify({ ...fixture.info, evidencePath, fixtureRemoved }));
  }
}, 60_000);
