import { describe, expect, it, vi } from "vitest";

import { connectDingtalk, DINGTALK_ROBOT_TOPIC, textFromEvent, type DingtalkWs } from "./dingtalk.ts";

const envelope = (data: unknown, over: { type?: string; topic?: string; messageId?: string } = {}) => JSON.stringify({
  specVersion: "1.0",
  type: over.type ?? "CALLBACK",
  headers: { appId: "a1", connectionId: "c1", contentType: "application/json", messageId: over.messageId ?? "env_1", time: "1700000000000", topic: over.topic ?? DINGTALK_ROBOT_TOPIC },
  data,
});

const robot = (over: Record<string, unknown> = {}) => JSON.stringify({
  conversationId: "cid1", conversationType: "2", msgId: "msg1", msgtype: "text",
  text: { content: "@Robot hi bot" },
  senderId: "u1", senderStaffId: "staff1", senderNick: "小李", chatbotUserId: "robot1",
  sessionWebhook: "https://oapi.test/robot/sendBySession?session=s1", sessionWebhookExpiredTime: Date.now() + 3_600_000,
  createAt: 1700000000000, ...over,
});

describe("textFromEvent", () => {
  it("extracts a robot text with its session webhook and strips the @mention", () => {
    expect(textFromEvent(envelope(robot()))).toMatchObject({
      chatId: "cid1", messageId: "msg1", senderId: "staff1", senderNick: "小李", text: "hi bot",
      sessionWebhook: "https://oapi.test/robot/sendBySession?session=s1",
    });
  });

  it("accepts a data object as well as a data string", () => {
    expect(textFromEvent(envelope(JSON.parse(robot()) as Record<string, unknown>))).toMatchObject({ text: "hi bot" });
  });

  it("ignores non-callback types, other topics, non-text messages and echoes", () => {
    expect(textFromEvent(envelope(robot(), { type: "SYSTEM" }))).toBeNull();
    expect(textFromEvent(envelope(robot(), { topic: "/v1.0/card/instances/callback" }))).toBeNull();
    expect(textFromEvent(envelope(robot({ msgtype: "picture" })))).toBeNull();
    expect(textFromEvent(envelope(robot({ senderStaffId: "robot1" })))).toBeNull();
    expect(textFromEvent(envelope(robot({ sessionWebhook: undefined })))).toBeNull();
    expect(textFromEvent(envelope(robot({ text: { content: "@Robot   " } })))).toBeNull();
    expect(textFromEvent(envelope("not json"))).toBeNull();
    expect(textFromEvent("not json")).toBeNull();
  });
});

class FakeWs {
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  on(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  send(data: Buffer | string) { this.sent.push(String(data)); }
  close() { this.closed = true; this.fire("close"); }
  fire(event: string, arg?: unknown) { for (const l of this.listeners.get(event) ?? []) l(arg); }
}

const cfg = { appKey: "dinga", appSecret: "s", baseUrl: "https://api.test" };

function connectDeps() {
  const ws = new FakeWs();
  const posts: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    posts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>, headers: new Headers(init?.headers) });
    if (url.endsWith("/v1.0/gateway/connections/open")) {
      return new Response(JSON.stringify({ endpoint: "wss://ws.test/connect", ticket: "t-1" }), { status: 200 });
    }
    if (url.endsWith("/v1.0/oauth2/accessToken")) {
      return new Response(JSON.stringify({ accessToken: "d-token", expireIn: 7200 }), { status: 200 });
    }
    return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
  });
  const timeouts: Array<{ fn: () => void; ms: number }> = [];
  const deps = {
    fetch: fetchImpl as unknown as typeof fetch,
    ws: () => ws as unknown as DingtalkWs,
    setTimeout: ((fn: () => void, ms: number) => { timeouts.push({ fn, ms }); return fn; }) as unknown as typeof setTimeout,
    onText: vi.fn(),
  };
  return { ws, posts, timeouts, deps };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const connect = async (deps: Parameters<typeof connectDingtalk>[1], ws: FakeWs) => {
  const channel = connectDingtalk(cfg, deps);
  await flush();
  ws.fire("open");
  await channel.ready;
  return channel;
};

describe("connectDingtalk", () => {
  it("handshakes, opens the stream with the ticket, delivers inbound and ACKs the envelope", async () => {
    const { ws, posts, deps } = connectDeps();
    const channel = await connect(deps, ws);
    expect(posts[0]).toMatchObject({ url: "https://api.test/v1.0/gateway/connections/open", body: { clientId: "dinga", clientSecret: "s" } });
    ws.fire("message", Buffer.from(envelope(robot())));
    expect(deps.onText).toHaveBeenCalledWith(expect.objectContaining({ chatId: "cid1", messageId: "msg1", text: "hi bot" }));
    const ack = JSON.parse(ws.sent.at(-1)!) as { code?: number; headers?: { messageId?: string } };
    expect(ack.code).toBe(200);
    expect(ack.headers?.messageId).toBe("env_1");
    channel.close();
  });

  it("answers a SYSTEM envelope with an ACK too", async () => {
    const { ws, deps } = connectDeps();
    const channel = await connect(deps, ws);
    ws.fire("message", Buffer.from(envelope({}, { type: "SYSTEM", topic: "keepalive" })));
    expect(deps.onText).not.toHaveBeenCalled();
    expect(JSON.parse(ws.sent.at(-1)!)).toMatchObject({ code: 200 });
    channel.close();
  });

  it("sends replies through the session webhook with the access token, caching the token", async () => {
    const { ws, posts, deps } = connectDeps();
    const channel = await connect(deps, ws);
    ws.fire("message", Buffer.from(envelope(robot())));
    await channel.sendText("cid1", "answer");
    await channel.sendText("cid1", "answer 2");
    const sends = posts.filter((p) => p.url.includes("sendBySession"));
    expect(sends).toHaveLength(2);
    expect(sends[0]!.headers.get("x-acs-dingtalk-access-token")).toBe("d-token");
    expect(sends[0]!.body).toMatchObject({ msgtype: "text", text: { content: "answer" } });
    expect(posts.filter((p) => p.url.endsWith("/v1.0/oauth2/accessToken"))).toHaveLength(1);
    channel.close();
  });

  it("refuses to reply on an expired or unknown session webhook", async () => {
    const { ws, deps } = connectDeps();
    const channel = await connect(deps, ws);
    await expect(channel.sendText("nowhere", "x")).rejects.toThrow("no live session webhook");
    ws.fire("message", Buffer.from(envelope(robot({ sessionWebhookExpiredTime: Date.now() - 1_000 }))));
    await expect(channel.sendText("cid1", "x")).rejects.toThrow("no live session webhook");
    channel.close();
  });
});
