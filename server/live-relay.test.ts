import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { qwenLiveEndpoint, volcAudioTask, volcDecodeFrame, volcFrame, volcLiveEndpoint, VOLC_EVENT_START_CONNECTION, VOLC_EVENT_START_SESSION, VOLC_EVENT_TASK_REQUEST } from "./live-call.ts";
import { LiveRelays, liveRelayResolver, openProviderLink, type ProviderSocket, type RelaySink } from "./live-relay.ts";

const servers: Server[] = [];
const clients: WebSocket[] = [];
const relaySets: LiveRelays[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const relays of relaySets.splice(0)) relays.close();
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

class FakeSocket implements ProviderSocket {
  readyState = 1;
  sent: Array<Buffer | string> = [];
  closed = false;
  readonly handlers = new Map<string, Array<(...args: never[]) => void>>();
  on(event: string, fn: (...args: never[]) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const fn of this.handlers.get(event) ?? []) (fn as (...a: unknown[]) => void)(...args);
  }
  send(data: Buffer | string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 3; }
}

function sink() {
  const calls: Array<[string, unknown]> = [];
  const record: RelaySink = {
    ready: () => calls.push(["ready", null]),
    audio: (pcm) => calls.push(["audio", pcm]),
    transcript: (role, delta) => calls.push(["transcript", `${role}:${delta}`]),
    event: (name, data) => calls.push(["event", `${name}:${data}`]),
    error: (message) => calls.push(["error", message]),
    end: () => calls.push(["end", null]),
  };
  return { calls, record };
}

const qwenEndpoint = qwenLiveEndpoint("https://gw.example.com", "qwen3.5-omni-flash-realtime")!;
const volcEndpoint = volcLiveEndpoint("6255978659", "1.2.1.1")!;

describe("qwen provider link", () => {
  it("answers session.created with a session.update and reports ready", () => {
    const socket = new FakeSocket();
    const { calls, record } = sink();
    openProviderLink({ endpoint: qwenEndpoint, key: "k", voice: "Cherry", instructions: "be kind", ws: () => socket }, record);
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.created" })));
    const update = JSON.parse(String(socket.sent[0])) as { type: string; session: { voice?: string; instructions?: string } };
    expect(update.type).toBe("session.update");
    expect(update.session.voice).toBe("Cherry");
    expect(update.session.instructions).toBe("be kind");
    expect(calls).toEqual([["ready", null]]);
  });

  it("forwards mic PCM as input_audio_buffer.append and decodes output deltas", () => {
    const socket = new FakeSocket();
    const { calls, record } = sink();
    const link = openProviderLink({ endpoint: qwenEndpoint, key: "k", ws: () => socket }, record);
    link.sendPcm(Buffer.from([1, 2]));
    expect(socket.sent).toHaveLength(0);
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.created" })));
    link.sendPcm(Buffer.from([1, 2, 3, 4]));
    const append = JSON.parse(String(socket.sent[1])) as { type: string; audio: string };
    expect(append.type).toBe("input_audio_buffer.append");
    expect(Buffer.from(append.audio, "base64")).toEqual(Buffer.from([1, 2, 3, 4]));
    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.output_audio.delta", delta: Buffer.from([9, 9]).toString("base64") })));
    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.output_audio_transcript.delta", transcript: "hi" })));
    expect(calls.slice(1)).toEqual([["audio", Buffer.from([9, 9])], ["transcript", "assistant:hi"]]);
  });

  it("surfaces provider errors and end on close", () => {
    const socket = new FakeSocket();
    const { calls, record } = sink();
    openProviderLink({ endpoint: qwenEndpoint, key: "k", ws: () => socket }, record);
    socket.emit("message", Buffer.from(JSON.stringify({ type: "error", error: { message: "bad key" } })));
    socket.emit("close");
    expect(calls).toEqual([["error", "bad key"], ["end", null]]);
  });
});

describe("volc provider link", () => {
  it("opens the duplex session first and falls back to the legacy protocol when refused before ready", () => {
    const duplex = new FakeSocket();
    const legacy = new FakeSocket();
    const sockets = [duplex, legacy];
    const { calls, record } = sink();
    const link = openProviderLink({ endpoint: volcEndpoint, key: "k", appId: "6255978659", ws: () => sockets.shift()! }, record);
    duplex.emit("open");
    const create = JSON.parse(String(duplex.sent[0])) as { type: string; session: { model: string; audio: { input: { format: { rate: number } } } } };
    expect(create.type).toBe("session.create");
    expect(create.session.model).toBe("1.2.6.1");
    expect(create.session.audio.input.format.rate).toBe(16000);
    // duplex 拒绝（旧账号/未开通）→ 回落旧二进制协议，并向客户端明示降级
    duplex.emit("message", Buffer.from(JSON.stringify({ type: "error", status_code: 40000001, message: "unsupported" })));
    expect(calls).toEqual([["event", "volc:legacy-fallback:duplex refused before ready"]]);
    calls.length = 0;
    expect(legacy.sent).toHaveLength(0);
    legacy.emit("open");
    expect(volcDecodeFrame(legacy.sent[0] as Buffer)?.event).toBe(VOLC_EVENT_START_CONNECTION);
    link.sendPcm(Buffer.alloc(640, 7));
    legacy.emit("message", volcFrame(50, "{}"));
    const start = volcDecodeFrame(legacy.sent[1] as Buffer);
    expect(start?.event).toBe(VOLC_EVENT_START_SESSION);
    expect(start?.sessionId).toMatch(/^call-/);
    const session = JSON.parse(start?.payload ?? "{}") as { dialog: { extra: { model: string } } };
    expect(session.dialog.extra.model).toBe("1.2.1.1");
    legacy.emit("message", volcFrame(150, "{}", start!.sessionId));
    expect(calls).toEqual([["ready", null]]);
    link.sendPcm(Buffer.alloc(640, 7));
    const task = volcDecodeFrame(legacy.sent[2] as Buffer);
    expect(task?.event).toBe(VOLC_EVENT_TASK_REQUEST);
    expect(task?.sessionId).toBe(start!.sessionId);
  });

  it("stays on duplex once ready: relays audio and transcripts", () => {
    const socket = new FakeSocket();
    const { calls, record } = sink();
    const link = openProviderLink({ endpoint: volcEndpoint, key: "k", appId: "6255978659", ws: () => socket }, record);
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.created", session: { id: "d1" } })));
    expect(calls).toEqual([["ready", null]]);
    link.sendPcm(Buffer.from([1, 2, 3, 4]));
    const append = JSON.parse(String(socket.sent[1])) as { type: string; audio: string };
    expect(append.type).toBe("input_audio_buffer.append");
    expect(Buffer.from(append.audio, "base64")).toEqual(Buffer.from([1, 2, 3, 4]));
    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.output_audio.delta", delta: Buffer.from([9]).toString("base64") })));
    socket.emit("message", Buffer.from(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "帮我查下文件" })));
    expect(calls.slice(1)).toEqual([["audio", Buffer.from([9])], ["transcript", "user:帮我查下文件"]]);
    // ready 后报错不再回落
    socket.emit("message", Buffer.from(JSON.stringify({ type: "error", status_code: 45000000, message: "quota" })));
    expect(calls[3]).toEqual(["error", "quota"]);
  });
});

describe("delegate tool bridge", () => {
  const call = { botId: "atlas", botName: "Atlas", threadId: "t1", client: "android" as const };

  it("declares the delegate tool on duplex session.create and returns results via conversation.item.create", async () => {
    const socket = new FakeSocket();
    const { record } = sink();
    const requests: string[] = [];
    const delegate = async (request: string) => { requests.push(request); return "查到了，文件在 ~/Downloads"; };
    openProviderLink({ endpoint: volcEndpoint, key: "k", appId: "1", call, delegate, ws: () => socket }, record);
    socket.emit("open");
    const create = JSON.parse(String(socket.sent[0])) as { session: { tools?: Array<{ name: string; description: string }> } };
    expect(create.session.tools?.[0]?.name).toBe("delegate");
    expect(create.session.tools?.[0]?.description).toContain("Atlas");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.created", session: { id: "d1" } })));
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "response.function_call_arguments.done",
      items: [{ call_id: "fc1", name: "delegate", arguments: JSON.stringify({ request: "我的文件在哪" }) }],
    })));
    await new Promise((done) => setTimeout(done, 20));
    expect(requests).toEqual(["我的文件在哪"]);
    const result = JSON.parse(String(socket.sent[1])) as { type: string; items: Array<{ call_id: string; role: string; content: Array<{ text: string }> }> };
    expect(result.type).toBe("conversation.item.create");
    expect(result.items[0]).toMatchObject({ call_id: "fc1", role: "tool" });
    expect(result.items[0]!.content[0]!.text).toBe("查到了，文件在 ~/Downloads");
  });

  it("declares the tool on qwen session.update and answers with function_call_output + response.create", async () => {
    const socket = new FakeSocket();
    const { record } = sink();
    const delegate = async () => "结果文本";
    openProviderLink({ endpoint: qwenEndpoint, key: "k", call, delegate, ws: () => socket }, record);
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.created" })));
    const update = JSON.parse(String(socket.sent[0])) as { session: { tools?: unknown[]; tool_choice?: string } };
    expect(update.session.tool_choice).toBe("auto");
    expect(update.session.tools).toHaveLength(1);
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "response.function_call_arguments.done",
      call_id: "q1", name: "delegate", arguments: JSON.stringify({ request: "帮我看日程" }),
    })));
    await new Promise((done) => setTimeout(done, 20));
    const output = JSON.parse(String(socket.sent[1])) as { type: string; item: { type: string; call_id: string; output: string } };
    expect(output).toMatchObject({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "q1", output: "结果文本" } });
    expect(JSON.parse(String(socket.sent[2]))).toMatchObject({ type: "response.create" });
  });

  it("dedupes a repeated call_id and keeps a tool-less session when no delegate is wired", async () => {
    const socket = new FakeSocket();
    const { record } = sink();
    const calls: string[] = [];
    const delegate = async (request: string) => { calls.push(request); return "done"; };
    openProviderLink({ endpoint: qwenEndpoint, key: "k", call, delegate, ws: () => socket }, record);
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.created" })));
    const done = { type: "response.function_call_arguments.done", call_id: "dup", name: "delegate", arguments: JSON.stringify({ request: "查邮件" }) };
    socket.emit("message", Buffer.from(JSON.stringify(done)));
    socket.emit("message", Buffer.from(JSON.stringify(done)));
    await new Promise((done_) => setTimeout(done_, 20));
    expect(calls).toEqual(["查邮件"]);
    // 没有 delegate 的通话：session.update 不带 tools
    const bare = new FakeSocket();
    openProviderLink({ endpoint: qwenEndpoint, key: "k", call, ws: () => bare }, record);
    bare.emit("message", Buffer.from(JSON.stringify({ type: "session.created" })));
    const update = JSON.parse(String(bare.sent[0])) as { session: { tools?: unknown[] } };
    expect(update.session.tools).toBeUndefined();
  });

  it("reports a delegate failure as the tool result instead of dropping the call", async () => {
    const socket = new FakeSocket();
    const { calls, record } = sink();
    const delegate = async () => { throw new Error("send exploded"); };
    openProviderLink({ endpoint: qwenEndpoint, key: "k", call, delegate, ws: () => socket }, record);
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.created" })));
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "response.function_call_arguments.done",
      call_id: "bad", name: "delegate", arguments: JSON.stringify({ request: "整理桌面" }),
    })));
    await new Promise((done) => setTimeout(done, 20));
    const output = JSON.parse(String(socket.sent[1])) as { item: { output: string } };
    expect(output.item.output).toContain("could not be run");
    expect(calls).toEqual([["ready", null]]);
  });
});

describe("volcAudioTask", () => {
  it("round-trips event 200, the session id and the PCM body", () => {
    const pcm = Buffer.alloc(320, 3);
    const frame = volcDecodeFrame(volcAudioTask(pcm, "s1"));
    expect(frame?.type).toBe(0x2);
    expect(frame?.event).toBe(VOLC_EVENT_TASK_REQUEST);
    expect(frame?.sessionId).toBe("s1");
    expect(frame?.raw).toEqual(pcm);
  });
});

describe("liveRelayResolver", () => {
  const auth = { kind: "session" } as never;
  const deps = (over: Partial<Parameters<typeof liveRelayResolver>[0]> = {}) => ({
    refusal: () => null,
    settings: () => ({ key: "k", endpoint: qwenEndpoint }),
    appId: () => undefined,
    bot: (botId: string) => botId === "atlas" ? { name: "Atlas", title: "", description: "" } : null,
    target: (botId: string, threadId: string | null) =>
      botId === "atlas" && (threadId === null || threadId === "t1") ? { botId, botName: "Atlas", threadId: threadId ?? "bot-thread" } : null,
    instructions: () => "be kind",
    ...over,
  });

  it("carries the validated bot+chat into the call record info, with a sane client fallback", () => {
    const ok = liveRelayResolver(deps())(auth, "atlas", "t1", "desktop");
    expect("options" in ok && ok.options.call).toEqual({ botId: "atlas", botName: "Atlas", threadId: "t1", client: "desktop" });
    const main = liveRelayResolver(deps())(auth, "atlas", null, "watch");
    expect("options" in main && main.options.call).toEqual({ botId: "atlas", botName: "Atlas", threadId: "bot-thread", client: "web" });
  });

  it("refuses a chat that isn't the bot's and skips the record info with no bot", () => {
    const wrong = liveRelayResolver(deps())(auth, "atlas", "not-atlas", null);
    expect("error" in wrong && wrong.error).toBe("That bot or chat does not exist.");
    const nobody = liveRelayResolver(deps())(auth, null);
    expect("options" in nobody && nobody.options.call).toBeUndefined();
  });

  it("wires the delegate when the dep provides one, and stays tool-less when it returns null", () => {
    const delegate = async (request: string) => `done:${request}`;
    const wired = liveRelayResolver(deps({ delegate: () => delegate }))(auth, "atlas", "t1", null);
    expect("options" in wired && wired.options.delegate).toBe(delegate);
    const unsigned = liveRelayResolver(deps({ delegate: () => null }))(auth, "atlas", "t1", null);
    expect("options" in unsigned && unsigned.options.delegate).toBeUndefined();
    const nobody = liveRelayResolver(deps({ delegate: () => delegate }))(auth, null);
    expect("options" in nobody && nobody.options.delegate).toBeUndefined();
  });
});

describe("LiveRelays over a real socket", () => {
  it("bridges client binary frames and provider events end to end", async () => {
    const provider = new FakeSocket();
    const relays = new LiveRelays();
    relaySets.push(relays);
    const server = createServer();
    servers.push(server);
    server.on("upgrade", (req, socket, head) => relays.accept({ req, socket: socket as Socket, head }, { endpoint: qwenEndpoint, key: "k", ws: () => provider }));
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const port = (server.address() as AddressInfo).port;
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/live/relay`);
    clients.push(client);
    const received: Array<{ binary: boolean; data: unknown }> = [];
    client.on("message", (data, binary) => received.push({ binary, data }));
    await new Promise<void>((open) => client.on("open", open));
    provider.emit("message", Buffer.from(JSON.stringify({ type: "session.created" })));
    await new Promise<void>((done) => setTimeout(done, 30));
    expect(JSON.parse(String(received[0]!.data))).toMatchObject({ t: "ready", provider: "qwen" });
    client.send(Buffer.from([5, 6]), { binary: true });
    await new Promise<void>((done) => setTimeout(done, 30));
    expect(JSON.parse(String(provider.sent[1]))).toMatchObject({ type: "input_audio_buffer.append" });
    provider.emit("message", Buffer.from(JSON.stringify({ type: "response.output_audio.delta", delta: Buffer.from([7]).toString("base64") })));
    await new Promise<void>((done) => setTimeout(done, 30));
    expect(received[1]).toEqual({ binary: true, data: Buffer.from([7]) });
    const closed = new Promise<number>((done) => client.on("close", done));
    client.send(JSON.stringify({ t: "end" }));
    expect(await closed).toBe(1000);
    expect(provider.closed).toBe(true);
  });

  it("writes the call record on hang-up, and nothing when the provider never came up", async () => {
    const recorded: Array<{ threadId: string; botName: string; record: { endReason: string; seconds: number; client: string } }> = [];
    const provider = new FakeSocket();
    const relays = new LiveRelays({ record: (input) => recorded.push(input) });
    relaySets.push(relays);
    const server = createServer();
    servers.push(server);
    server.on("upgrade", (req, socket, head) => relays.accept({ req, socket: socket as Socket, head }, {
      endpoint: qwenEndpoint, key: "k", ws: () => provider,
      call: { botId: "atlas", botName: "Atlas", threadId: "t1", client: "desktop" },
    }));
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const port = (server.address() as AddressInfo).port;
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/live/relay`);
    clients.push(client);
    await new Promise<void>((open) => client.on("open", open));
    provider.emit("message", Buffer.from(JSON.stringify({ type: "session.created" })));
    await new Promise<void>((done) => setTimeout(done, 30));
    const closed = new Promise<number>((done) => client.on("close", done));
    client.send(JSON.stringify({ t: "end" }));
    expect(await closed).toBe(1000);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.threadId).toBe("t1");
    expect(recorded[0]!.botName).toBe("Atlas");
    expect(recorded[0]!.record).toMatchObject({ botId: "atlas", client: "desktop", endReason: "hung-up" });
    expect(recorded[0]!.record.seconds).toBeGreaterThanOrEqual(0);
  });

  it("records nothing when the call never reached ready", async () => {
    const recorded: unknown[] = [];
    const provider = new FakeSocket();
    const relays = new LiveRelays({ record: (input) => recorded.push(input) });
    relaySets.push(relays);
    const server = createServer();
    servers.push(server);
    server.on("upgrade", (req, socket, head) => relays.accept({ req, socket: socket as Socket, head }, {
      endpoint: qwenEndpoint, key: "k", ws: () => provider,
      call: { botId: "atlas", botName: "Atlas", threadId: "t1", client: "web" },
    }));
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const port = (server.address() as AddressInfo).port;
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/live/relay`);
    clients.push(client);
    await new Promise<void>((open) => client.on("open", open));
    const closed = new Promise<number>((done) => client.on("close", done));
    provider.emit("message", Buffer.from(JSON.stringify({ type: "error", error: { message: "bad key" } })));
    expect(await closed).toBe(1011);
    expect(recorded).toHaveLength(0);
  });
});
