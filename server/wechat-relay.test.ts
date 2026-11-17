import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { AppConfig } from "./config.ts";
import type { DirectSendInput } from "./direct-send.ts";
import { json, readBody } from "./harness/http.ts";
import { createPhones, type PhonesDeps } from "./host/phones.ts";
import type { RequestAuth } from "./request-auth.ts";
import { dispatchRoutes } from "./routes/table.ts";
import type { RuntimeEvent } from "../shared/runtime-events.ts";
import { phoneEvent } from "./sms-relay.ts";
import type { BotRecord, Message, Store } from "./store.ts";
import { createWechatRelay, PHONE_REPLY_WECHAT, type WechatEvent } from "./wechat-relay.ts";

const BOT = { id: "b1", name: "Pepper" };
/** One 1×1 JPEG, so saveImage accepts the bytes the phone would have sent. */
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/AKp/9k=",
  "base64",
);

function harness(overrides: { cfg?: AppConfig; messages?: Message[] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "wechat-relay-"));
  const cfg: AppConfig = overrides.cfg ?? { wechat: { botId: BOT.id } };
  const tasks = new Map<string, { id: string; threadId: string }>();
  const listeners: Array<(event: RuntimeEvent) => void> = [];
  const sends: DirectSendInput[] = [];
  const replies: Array<{ phoneKey: string; to: string; text: string }> = [];
  let nextThread = 0;
  const store = {
    bot: (id: string) => (id === BOT.id ? BOT : undefined),
    createTask: () => {
      const threadId = `thread-${++nextThread}`;
      tasks.set(threadId, { id: `task-${nextThread}`, threadId });
      return tasks.get(threadId)!;
    },
    taskByThread: (_botId: string, threadId: string) => tasks.get(threadId),
    activePath: (_threadId: string) => overrides.messages ?? [],
  } as unknown as Store;
  const relay = createWechatRelay({
    store, cfg, dataDir,
    bus: { subscribe: (fn) => { listeners.push(fn); return () => {}; } },
    acceptDirectSend: async (input) => { sends.push(input); return { ok: true } as never; },
    routineRunForThread: () => undefined,
    ignoreEvent: () => false,
    replyWechat: async (phoneKey, to, text) => { replies.push({ phoneKey, to, text }); },
  });
  const emit = (event: RuntimeEvent) => listeners.forEach((fn) => fn(event));
  return { relay, emits: emit, sends, replies, tasks, dataDir };
}

const wechatEvent = (extra: Partial<WechatEvent> = {}): WechatEvent =>
  ({ kind: "wechat", sendId: "m1", from: "owner-1", text: "帮我看下消息", ...extra });

const completed = (threadId: string, turnId = "turn-1"): RuntimeEvent =>
  ({ type: "turn.completed", threadId, turnId, ok: true }) as RuntimeEvent;

const wechatTurn = (turnId = "turn-1"): Message[] => [
  { id: "u1", role: "user", kind: "text", text: "hi", sender: { id: "wechat:session:abc|owner-1", name: "x" } },
  { id: "b1", role: "bot", kind: "text", text: "第一条", turnId },
  { id: "b2", role: "bot", kind: "text", text: "第二条", turnId },
] as Message[];

describe("wechat relay job contract", () => {
  it("names the reply job the phone answers, and it is not a phone tool", () => {
    expect(PHONE_REPLY_WECHAT).toBe("PHONE_REPLY_WECHAT");
  });

  it("asks the phone for exactly PHONE_REPLY_WECHAT { to, text }", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wechat-reply-"));
    writeFileSync(join(dir, "phones.json"), JSON.stringify({ version: 1, phones: [{
      key: "companion:dev-1", owner: "owner", registeredAt: 1, seen: Date.now(), lastUsedAt: null,
      registration: { installId: "install-0001", name: "Owner's phone", platform: "android", appVersion: "2.0.1", timeZone: "Asia/Shanghai", capabilities: { messages: "full" } },
    }] }));
    const bot = { id: BOT.id, name: BOT.name } as BotRecord;
    const phones = createPhones({
      dataDir: dir, shared: false, cloudHome: false, cloudOwnerKey: null, loopbackTrust: "owner", sharedMembership: () => false,
      store: { bot: () => bot, groupByThread: () => undefined, messagesFor: () => [], appendMessage: () => {} } as unknown as PhonesDeps["store"],
      sessions: { list: () => [], isLive: () => true, onSessionRevoked: () => () => {} }, routines: () => null, ownerOrAdmin: () => true, cloudOwnerSession: () => false,
      smsOwners: () => [], cloudLendingRefusal: () => null, cloudLendingTurn: () => { throw new Error("unused"); },
      originIsUser: () => true, request: () => undefined, nudge: () => {}, mint: () => "turn-token", harnessUrl: "http://127.0.0.1:1", active: () => true,
    });
    // The phone's own key is what authenticated it; the route handler is the only path a job reaches a phone through.
    const auth: RequestAuth = { kind: "loopback", scopes: ["admin", "client"], companionDevice: "dev-1" };
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      try {
        await dispatchRoutes([phones.routes], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
      } catch (error) { json(res, (error as { status?: number }).status ?? 500, { error: (error as Error).message }); }
    });
    try {
      await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const reply = phones.replyWechat("companion:dev-1", "owner-1", "收到");
      const polled = await (await fetch(`${base}/api/phones/self/jobs`, { signal: AbortSignal.timeout(3_000) })).json() as { job: { id: string; tool: string; arguments: Record<string, unknown> } };
      expect(polled.job.tool).toBe(PHONE_REPLY_WECHAT);
      expect(polled.job.arguments).toEqual({ to: "owner-1", text: "收到" });
      await fetch(`${base}/api/phones/self/jobs/${polled.job.id}/lease`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      await fetch(`${base}/api/phones/self/jobs/${polled.job.id}/result`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true, result: { ok: true } }) });
      expect(await reply).toEqual({ ok: true, result: { ok: true } });
    } finally {
      phones.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe("createWechatRelay push", () => {
  it("ignores events when no bot is configured", () => {
    const { relay, sends, tasks } = harness({ cfg: {} });
    relay.push("session:abc", wechatEvent());
    expect(sends).toEqual([]);
    expect(tasks.size).toBe(0);
  });

  it("opens one thread per (phone, peer) and forwards the text as that peer", () => {
    const { relay, sends, tasks } = harness();
    relay.push("session:abc", wechatEvent());
    expect(tasks.size).toBe(1);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      botId: BOT.id, text: "帮我看下消息",
      sendId: "wechat:session:abc:m1",
      sender: { name: "微信 owner-1", id: "wechat:session:abc|owner-1" },
      personPresent: false,
    });
  });

  it("reuses the thread for the same phone and peer, opens a new one for another peer", () => {
    const { relay, sends, tasks } = harness();
    relay.push("session:abc", wechatEvent());
    relay.push("session:abc", wechatEvent({ sendId: "m2", text: "再一条" }));
    relay.push("session:abc", wechatEvent({ sendId: "m3", from: "owner-2" }));
    expect(tasks.size).toBe(2);
    expect(sends[1]!.threadId).toBe(sends[0]!.threadId);
    expect(sends[2]!.threadId).not.toBe(sends[0]!.threadId);
  });

  it("drops a repeated sendId, so a phone retry cannot run a turn twice", () => {
    const { relay, sends, tasks } = harness();
    relay.push("session:abc", wechatEvent());
    relay.push("session:abc", wechatEvent());
    expect(sends).toHaveLength(1);
    expect(tasks.size).toBe(1);
    // Another phone's message with the same iLink id is its own message.
    relay.push("session:def", wechatEvent());
    expect(sends).toHaveLength(2);
  });

  it("attaches inbound pictures as image tags on the user line", () => {
    const { relay, sends } = harness();
    relay.push("session:abc", wechatEvent({ text: "", images: [{ mime: "image/jpeg", name: "wechat-1.jpg", data: JPEG.toString("base64") }] }));
    expect(sends).toHaveLength(1);
    expect(sends[0]!.text).toMatch(/<attached-image path="[^"]+\.jpg" name="wechat-1\.jpg" \/>/u);
  });
});

describe("createWechatRelay replies", () => {
  it("posts every bot line of a wechat turn back to the peer on the same phone", () => {
    const { relay, emits, replies } = harness({ messages: wechatTurn() });
    relay.push("session:abc", wechatEvent());
    emits(completed("thread-1"));
    expect(replies).toEqual([
      { phoneKey: "session:abc", to: "owner-1", text: "第一条" },
      { phoneKey: "session:abc", to: "owner-1", text: "第二条" },
    ]);
  });

  it("keeps the phone key intact when it contains a colon", () => {
    const { relay, emits, replies } = harness({ messages: wechatTurn() });
    relay.push("companion:dev-1", wechatEvent());
    emits(completed("thread-1"));
    expect(replies.map((reply) => reply.phoneKey)).toEqual(["companion:dev-1", "companion:dev-1"]);
  });

  it("sends nothing for a failed turn, another thread, or a turn the channel did not start", () => {
    const personLine = [
      { id: "u1", role: "user", kind: "text", text: "hi", sender: { id: "person:x", name: "x" } },
      { id: "b1", role: "bot", kind: "text", text: "ok", turnId: "turn-1" },
    ] as Message[];
    const { relay, emits, replies } = harness({ messages: personLine });
    relay.push("session:abc", wechatEvent());
    emits(completed("thread-1"));
    emits({ ...completed("thread-1"), ok: false } as RuntimeEvent);
    emits(completed("other-thread"));
    expect(replies).toEqual([]);
  });
});

describe("phoneEvent wechat member", () => {
  it("accepts a bounded wechat event and keeps the sms member working", () => {
    expect(phoneEvent.safeParse(wechatEvent()).success).toBe(true);
    expect(phoneEvent.safeParse({ kind: "sms", sendId: "m1", from: "10655", text: "x" }).success).toBe(true);
    expect(phoneEvent.safeParse({ kind: "wechat", sendId: "m1", from: "owner-1", text: "" }).success).toBe(false);
  });

  it("rejects an oversized text, a 9th image, and an unknown field", () => {
    expect(phoneEvent.safeParse({ ...wechatEvent(), text: "x".repeat(4001) }).success).toBe(false);
    const image = { mime: "image/jpeg", name: "wechat-1.jpg", data: "AAAA" };
    expect(phoneEvent.safeParse({ ...wechatEvent(), images: Array.from({ length: 9 }, () => image) }).success).toBe(false);
    expect(phoneEvent.safeParse({ ...wechatEvent(), extra: 1 }).success).toBe(false);
    expect(phoneEvent.safeParse({ ...wechatEvent(), images: [{ ...image, extra: 1 }] }).success).toBe(false);
  });

  it("rejects a sendId or peer over its bound, and a picture whose fields are over theirs", () => {
    expect(phoneEvent.safeParse({ ...wechatEvent(), sendId: "x".repeat(121) }).success).toBe(false);
    expect(phoneEvent.safeParse({ ...wechatEvent(), from: "x".repeat(65) }).success).toBe(false);
    const image = { mime: "image/jpeg", name: "wechat-1.jpg", data: "AAAA" };
    expect(phoneEvent.safeParse({ ...wechatEvent(), images: [{ ...image, mime: "x".repeat(101) }] }).success).toBe(false);
    expect(phoneEvent.safeParse({ ...wechatEvent(), images: [{ ...image, name: "x".repeat(201) }] }).success).toBe(false);
    // 11 MB of base64 across the pictures is the ceiling, not per picture.
    const big = "A".repeat(11_000_001);
    expect(phoneEvent.safeParse({ ...wechatEvent(), images: [{ ...image, data: big }] }).success).toBe(false);
  });
});
