// Real server and the fake pi CLI: a held turn, a stopped one, and a queued message that keeps running.
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { PERSON_STOPPED_TURN_NAME } from "../shared/client-cancel.ts";
import { failedTurnCause } from "../shared/failed-turn.ts";
import { openSse } from "./testing/sse.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

it("ends a stopped turn with one quiet stop, keeps what it said, and a second Stop on it leaves the queued message running", async () => {
  const fixture = await launchVerificationServer({
    ...process.env,
    OMB_TEST_FIXTURE_ENGINE: "pi",
    FAKE_PI_HOLD_ON: "Hold this one",
    FAKE_PI_STALL_ON: "Start, then stall.",
    FAKE_PI_DELAY_ON: "Second message",
    FAKE_PI_DELAY_MS: "1500",
    // The person's second line takes the queued path, as it does on an engine that cannot steer.
    FAKE_PI_STEER_REFUSE: "1",
  });
  const { url } = fixture.info;
  let stream: Awaited<ReturnType<typeof openSse>> | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  const model = async () => {
    const pi = ((await api("GET", "/api/instances")).instances as any[]).find((instance) => instance.instanceId === "pi");
    return pi.models.default as string;
  };
  try {
    stream = await openSse(`${url}/api/events`, { origin: url });
    const selection = { instanceId: "pi", model: await model() };

    const { bot } = await api("POST", "/api/bots", { name: "Stopper", modelSelection: selection }, 201);
    const threadId = bot.threadId;
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "Hold this one, please." }, 202);
    const first = (await stream.until((frame) => frame.kind === "runtime" && frame.event?.type === "turn.started" && frame.event.threadId === threadId, hostTimeout(10_000))).event.turnId;
    const queued = await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "Second message" }, 202);
    expect(queued).toMatchObject({ queued: true });

    // The first Stop names the turn the person saw.
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId, turnId: first });
    const second = (await stream.until((frame) => frame.kind === "runtime" && frame.event?.type === "turn.started"
      && frame.event.threadId === threadId && frame.event.turnId !== first, hostTimeout(10_000))).event.turnId;
    // The double click's second Stop names the same, finished turn: the queued message must keep running.
    expect(await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId, turnId: first })).toEqual({ ok: true, outcome: "already-stopped" });
    await stream.until((frame) => frame.kind === "runtime" && frame.event?.type === "turn.completed" && frame.event.turnId === second, hostTimeout(10_000));
    await expect.poll(async () => (await messages(threadId)).some((message) => message.kind === "text" && /^echo: .*Second message/s.test(message.text ?? "")), { timeout: hostTimeout(20_000) }).toBe(true);

    const rows = await messages(threadId);
    const stops = rows.filter((message) => message.kind === "activity" && message.tool?.name?.startsWith("stopped:"));
    expect(stops).toEqual([expect.objectContaining({ turnId: first, tool: { name: PERSON_STOPPED_TURN_NAME, ok: true } })]);
    expect(rows.filter((message) => message.tool && failedTurnCause(message.tool.name) !== null)).toEqual([]);
    expect(rows.find((message) => message.role === "user" && message.text === "Second message")?.requestCancelled).toBeUndefined();

    // A Stop after half an answer: the chat keeps the words, and so does the turn's digest.
    const partial = (await api("POST", "/api/bots", { name: "Halfway", modelSelection: selection }, 201)).bot;
    await api("POST", `/api/bots/${partial.id}/messages`, { threadId: partial.threadId, text: "Start, then stall." }, 202);
    const halfway = (await stream.until((frame) => frame.kind === "runtime" && frame.event?.type === "content.delta"
      && frame.event.threadId === partial.threadId, hostTimeout(10_000))).event.turnId;
    await api("POST", `/api/bots/${partial.id}/interrupt`, { threadId: partial.threadId, turnId: halfway });
    const digest = await expect.poll(async () => (await messages(partial.threadId)).find((message) => message.kind === "digest"), { timeout: hostTimeout(20_000) }).toBeTruthy()
      .then(async () => (await messages(partial.threadId)).find((message) => message.kind === "digest"));
    expect(JSON.stringify(digest.digest)).toContain("half an answer, then silence");
    const after = await messages(partial.threadId);
    expect(after.filter((message) => message.tool?.name === PERSON_STOPPED_TURN_NAME)).toHaveLength(1);
    expect(after.some((message) => message.kind === "text" && message.text === "half an answer, then silence")).toBe(true);
  } finally {
    stream?.close();
    await fixture.close();
  }
}, 120_000);