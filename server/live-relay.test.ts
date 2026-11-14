import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { qwenLiveEndpoint, volcAudioTask, volcDecodeFrame, volcFrame, volcLiveEndpoint, VOLC_EVENT_START_CONNECTION, VOLC_EVENT_START_SESSION, VOLC_EVENT_TASK_REQUEST } from "./live-call.ts";
import { LiveRelays, openProviderLink, type ProviderSocket, type RelaySink } from "./live-relay.ts";

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
  it("drives StartConnection → StartSession → ready, then sends TaskRequest audio", () => {
    const socket = new FakeSocket();
    const { calls, record } = sink();
    const link = openProviderLink({ endpoint: volcEndpoint, key: "k", appId: "6255978659", ws: () => socket }, record);
    socket.emit("open");
    expect(volcDecodeFrame(socket.sent[0] as Buffer)?.event).toBe(VOLC_EVENT_START_CONNECTION);
    socket.emit("message", volcFrame(50, "{}"));
    const start = volcDecodeFrame(socket.sent[1] as Buffer);
    expect(start?.event).toBe(VOLC_EVENT_START_SESSION);
    expect(start?.sessionId).toMatch(/^call-/);
    const session = JSON.parse(start?.payload ?? "{}") as { dialog: { extra: { model: string } } };
    expect(session.dialog.extra.model).toBe("1.2.1.1");
    socket.emit("message", volcFrame(150, "{}", start!.sessionId));
    expect(calls).toEqual([["ready", null]]);
    link.sendPcm(Buffer.alloc(640, 7));
    const task = volcDecodeFrame(socket.sent[2] as Buffer);
    expect(task?.event).toBe(VOLC_EVENT_TASK_REQUEST);
    expect(task?.sessionId).toBe(start!.sessionId);
  });

  it("decodes audio packets to raw bytes and error packets to messages", () => {
    const socket = new FakeSocket();
    const { calls, record } = sink();
    openProviderLink({ endpoint: volcEndpoint, key: "k", appId: "6255978659", ws: () => socket }, record);
    socket.emit("open");
    socket.emit("message", volcFrame(50, "{}"));
    socket.emit("message", volcFrame(150, "{}", volcDecodeFrame(socket.sent[1] as Buffer)!.sessionId));
    // 服务器下行音频帧：mt=0b1011, flags 0b0100 带事件 350, 纯二进制载荷
    const audio = Buffer.concat([
      Buffer.from([0x11, 0xb4, 0x10, 0x00]),
      (() => { const b = Buffer.alloc(4); b.writeUInt32BE(350); return b; })(),
      (() => { const b = Buffer.alloc(4); b.writeUInt32BE(4); return b; })(),
      Buffer.from([1, 2, 3, 4]),
    ]);
    socket.emit("message", audio);
    expect(calls[1]).toEqual(["audio", Buffer.from([1, 2, 3, 4])]);
    // 错误帧：mt=0b1111 + code + JSON
    const errPayload = Buffer.from(JSON.stringify({ error: "quota" }));
    socket.emit("message", Buffer.concat([
      Buffer.from([0x11, 0xf0, 0x10, 0x00]),
      (() => { const b = Buffer.alloc(4); b.writeUInt32BE(45000000); return b; })(),
      (() => { const b = Buffer.alloc(4); b.writeUInt32BE(errPayload.length); return b; })(),
      errPayload,
    ]));
    expect(calls[2]).toEqual(["error", "quota"]);
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
});
