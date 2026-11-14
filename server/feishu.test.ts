import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { connectFeishu, decodeFrame, encodeFrame, textFromEvent, type FeishuFrame, type WsLike } from "./feishu.ts";
import { createFeishuChats } from "./feishu-chats.ts";

const frame = (over: Partial<FeishuFrame> = {}): FeishuFrame => ({
  seqId: 1, logId: 2, service: 3, method: 1, headers: [], ...over,
});

describe("pbbp2 frames", () => {
  it("round-trips scalars, headers and payload", () => {
    const source = frame({
      seqId: 300, logId: 0, service: 999, method: 0,
      headers: [{ key: "type", value: "event" }, { key: "trace_id", value: "t-1" }],
      payload: Buffer.from('{"schema":"2.0"}', "utf8"),
    });
    expect(decodeFrame(encodeFrame(source))).toEqual(source);
  });

  it("round-trips zero-valued required scalars", () => {
    expect(decodeFrame(encodeFrame(frame({ seqId: 0, logId: 0, service: 0, method: 0 })))).toEqual(frame({ seqId: 0, logId: 0, service: 0, method: 0 }));
  });

  it("rejects a truncated frame", () => {
    const encoded = encodeFrame(frame({ payload: Buffer.from("payload") }));
    expect(() => decodeFrame(encoded.subarray(0, encoded.length - 2))).toThrow();
    expect(() => decodeFrame(Buffer.from([0x80]))).toThrow();
  });
});

describe("textFromEvent", () => {
  const event = (over: { type?: string; msgType?: string; content?: string } = {}) => JSON.stringify({
    schema: "2.0",
    header: { event_id: "e1", event_type: over.type ?? "im.message.receive_v1" },
    event: {
      sender: { sender_id: { open_id: "ou_1" } },
      message: { message_id: "om_1", chat_id: "oc_1", message_type: over.msgType ?? "text", content: over.content ?? JSON.stringify({ text: "  hi bot  " }) },
    },
  });

  it("extracts a text message", () => {
    expect(textFromEvent(event())).toEqual({ chatId: "oc_1", messageId: "om_1", openId: "ou_1", text: "hi bot" });
  });

  it("ignores non-message events, non-text messages and empty text", () => {
    expect(textFromEvent(event({ type: "im.chat.member.bot.added_v1" }))).toBeNull();
    expect(textFromEvent(event({ msgType: "image" }))).toBeNull();
    expect(textFromEvent(event({ content: JSON.stringify({ text: "   " }) }))).toBeNull();
    expect(textFromEvent(event({ content: "not json" }))).toBeNull();
    expect(textFromEvent("not json")).toBeNull();
  });
});

class FakeWs {
  sent: Buffer[] = [];
  closed = false;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  on(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  send(data: Buffer | string) { this.sent.push(Buffer.isBuffer(data) ? data : Buffer.from(data)); }
  close() { this.closed = true; this.fire("close"); }
  fire(event: string, arg?: unknown) { for (const l of this.listeners.get(event) ?? []) l(arg); }
}

const cfg = { appId: "cli_a", appSecret: "s", baseUrl: "https://open.test" };

function connectDeps() {
  const ws = new FakeWs();
  const posts: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    posts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>, auth: new Headers(init?.headers).get("authorization") });
    if (url.endsWith("/callback/ws/endpoint")) {
      return new Response(JSON.stringify({ code: 0, data: { URL: "wss://ws.test/?service_id=42", ClientConfig: { PingInterval: 30 } } }), { status: 200 });
    }
    if (url.endsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-token", expire: 7200 }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
  });
  const timers = { interval: [] as Array<{ fn: () => void; ms: number }>, timeout: [] as Array<{ fn: () => void; ms: number }> };
  const deps = {
    fetch: fetchImpl as unknown as typeof fetch,
    ws: () => ws as unknown as WsLike,
    setInterval: ((fn: () => void, ms: number) => { timers.interval.push({ fn, ms }); return fn; }) as unknown as typeof setInterval,
    setTimeout: ((fn: () => void, ms: number) => { timers.timeout.push({ fn, ms }); return fn; }) as unknown as typeof setTimeout,
    onText: vi.fn(),
  };
  return { ws, posts, timers, deps };
}

const receive = (ws: FakeWs, payload: string, headers: FeishuFrame["headers"] = []) =>
  ws.fire("message", encodeFrame(frame({ headers, payload: Buffer.from(payload, "utf8") })));

const flush = () => new Promise((resolve) => setImmediate(resolve));

const connect = async (deps: Parameters<typeof connectFeishu>[1], ws: FakeWs) => {
  const channel = connectFeishu(cfg, deps);
  await flush();
  ws.fire("open");
  await channel.ready;
  return channel;
};

describe("connectFeishu", () => {
  it("handshakes, connects, delivers text inbound and ACKs the frame", async () => {
    const { ws, posts, deps } = connectDeps();
    const channel = await connect(deps, ws);
    expect(posts[0]).toMatchObject({ url: "https://open.test/callback/ws/endpoint", body: { AppID: "cli_a", AppSecret: "s" } });
    const inbound = JSON.stringify({
      schema: "2.0", header: { event_id: "e1", event_type: "im.message.receive_v1" },
      event: { sender: { sender_id: { open_id: "ou_9" } }, message: { message_id: "om_9", chat_id: "oc_9", message_type: "text", content: JSON.stringify({ text: "ping" }) } },
    });
    receive(ws, inbound);
    expect(deps.onText).toHaveBeenCalledWith({ chatId: "oc_9", messageId: "om_9", openId: "ou_9", text: "ping" });
    const ack = decodeFrame(ws.sent.at(-1)!);
    expect(ack.method).toBe(1);
    expect(JSON.parse(ack.payload!.toString("utf8"))).toMatchObject({ code: 200 });
    expect(ack.headers.some((h) => h.key === "biz_rt")).toBe(true);
    channel.close();
  });

  it("reassembles a fragmented event before delivering", async () => {
    const { ws, deps } = connectDeps();
    const channel = await connect(deps, ws);
    const event = JSON.stringify({
      schema: "2.0", header: { event_id: "e2", event_type: "im.message.receive_v1" },
      event: { sender: { sender_id: { open_id: "ou_1" } }, message: { message_id: "om_2", chat_id: "oc_2", message_type: "text", content: JSON.stringify({ text: "split" }) } },
    });
    const half = Math.ceil(event.length / 2);
    receive(ws, event.slice(0, half), [{ key: "message_id", value: "m1" }, { key: "sum", value: "2" }, { key: "seq", value: "1" }]);
    expect(deps.onText).not.toHaveBeenCalled();
    receive(ws, event.slice(half), [{ key: "message_id", value: "m1" }, { key: "sum", value: "2" }, { key: "seq", value: "2" }]);
    expect(deps.onText).toHaveBeenCalledWith({ chatId: "oc_2", messageId: "om_2", openId: "ou_1", text: "split" });
    channel.close();
  });

  it("sends replies with the tenant token", async () => {
    const { ws, posts, deps } = connectDeps();
    const channel = await connect(deps, ws);
    await channel.sendText("oc_1", "answer");
    const send = posts.find((p) => p.url.includes("/open-apis/im/v1/messages"))!;
    expect(send.auth).toBe("Bearer t-token");
    expect(send.body).toMatchObject({ receive_id: "oc_1", msg_type: "text", content: JSON.stringify({ text: "answer" }) });
    channel.close();
  });
});

describe("feishu chats", () => {
  it("persists the chat→thread mapping", () => {
    const dir = mkdtempSync(join(tmpdir(), "feishu-chats-"));
    try {
      const file = join(dir, "feishu-chats.json");
      const chats = createFeishuChats(file);
      chats.set("oc_1", "t_1");
      expect(createFeishuChats(file).threadFor("oc_1")).toBe("t_1");
      expect(chats.chatFor("t_1")).toBe("oc_1");
      expect(chats.threadFor("oc_missing")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
