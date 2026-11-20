import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { AppConfig } from "./config.ts";
import type { DirectSendInput } from "./direct-send.ts";
import type { RuntimeEvent } from "../shared/runtime-events.ts";
import { createSmsRelay, phoneEvent, type PhoneEvent } from "./sms-relay.ts";
import type { Message, Store } from "./store.ts";

const BOT = { id: "b1", name: "Pepper" };

function harness(overrides: { cfg?: AppConfig; messages?: Message[] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "sms-relay-"));
  const cfg: AppConfig = overrides.cfg ?? { sms: { botId: BOT.id } };
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
  const relay = createSmsRelay({
    store, cfg, dataDir,
    bus: { subscribe: (fn) => { listeners.push(fn); return () => {}; } },
    acceptDirectSend: async (input) => { sends.push(input); return { ok: true } as never; },
    routineRunForThread: () => undefined,
    ignoreEvent: () => false,
    replySms: async (phoneKey, to, text) => { replies.push({ phoneKey, to, text }); },
  });
  const emit = (event: RuntimeEvent) => listeners.forEach((fn) => fn(event));
  return { relay, emits: emit, sends, replies, tasks };
}

const smsEvent = (extra: Partial<Extract<PhoneEvent, { kind: "sms" }>> = {}): PhoneEvent =>
  ({ kind: "sms", sendId: "m1", from: "+8613800138000", text: "bot 帮我查下快递", ...extra });

const completed = (threadId: string, turnId = "turn-1"): RuntimeEvent =>
  ({ type: "turn.completed", threadId, turnId, ok: true }) as RuntimeEvent;

const smsTurn = (turnId = "turn-1"): Message[] => [
  { id: "u1", role: "user", kind: "text", text: "hi", sender: { id: "sms:session:abc|+8613800138000", name: "x" } },
  { id: "b1", role: "bot", kind: "text", text: "查到了，明天到", turnId },
] as Message[];

describe("phoneEvent", () => {
  it("accepts a bounded sms event and rejects other shapes", () => {
    expect(phoneEvent.safeParse(smsEvent()).success).toBe(true);
    expect(phoneEvent.safeParse({ kind: "sms", sendId: "m1", from: "10655", text: "x" }).success).toBe(true);
    expect(phoneEvent.safeParse({ kind: "call", sendId: "m1", from: "+1", text: "x" }).success).toBe(false);
    expect(phoneEvent.safeParse({ kind: "sms", sendId: "", from: "+1", text: "x" }).success).toBe(false);
    expect(phoneEvent.safeParse({ kind: "sms", sendId: "m1", from: "+1", text: "x".repeat(4001) }).success).toBe(false);
    expect(phoneEvent.safeParse({ kind: "sms", sendId: "m1", from: "+1", text: "x", extra: 1 }).success).toBe(false);
  });
});

describe("createSmsRelay push", () => {
  it("ignores events when no bot is configured", () => {
    const { relay, sends, tasks } = harness({ cfg: {} });
    relay.push("session:abc", smsEvent());
    expect(sends).toEqual([]);
    expect(tasks.size).toBe(0);
  });

  it("opens a task per (phone, sender) and forwards the text as that sender", () => {
    const { relay, sends, tasks } = harness();
    relay.push("session:abc", smsEvent());
    expect(tasks.size).toBe(1);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      botId: BOT.id, text: "bot 帮我查下快递",
      sendId: "sms:session:abc:m1",
      sender: { name: "短信 +8613800138000", id: "sms:session:abc|8613800138000" },
      personPresent: false,
    });
  });

  it("reuses the thread for the same phone and sender, opens a new one for another", () => {
    const { relay, sends, tasks } = harness();
    relay.push("session:abc", smsEvent());
    relay.push("session:abc", smsEvent({ sendId: "m2", text: "再加一条提醒" }));
    relay.push("session:def", smsEvent({ sendId: "m3" }));
    expect(tasks.size).toBe(2);
    expect(sends[1]!.threadId).toBe(sends[0]!.threadId);
    expect(sends[2]!.threadId).not.toBe(sends[0]!.threadId);
  });
});

describe("createSmsRelay replies", () => {
  it("posts bot lines of an sms turn back to the sender on the same phone", () => {
    const { relay, emits, replies } = harness({ messages: smsTurn() });
    relay.push("session:abc", smsEvent());
    const threadId = "thread-1";
    emits(completed(threadId));
    expect(replies).toEqual([{ phoneKey: "session:abc", to: "8613800138000", text: "查到了，明天到" }]);
  });

  it("keeps the phone key intact when it contains a colon", () => {
    const { relay, emits, replies } = harness({ messages: smsTurn() });
    relay.push("companion:dev-1", smsEvent({ from: "10655" }));
    emits(completed("thread-1"));
    expect(replies).toEqual([{ phoneKey: "companion:dev-1", to: "10655", text: "查到了，明天到" }]);
  });

  it("does not reply to turns the channel did not start or to failed turns", () => {
    const personLine = [
      { id: "u1", role: "user", kind: "text", text: "hi", sender: { id: "person:x", name: "x" } },
      { id: "b1", role: "bot", kind: "text", text: "ok", turnId: "turn-1" },
    ] as Message[];
    const { relay, emits, replies } = harness({ messages: personLine });
    relay.push("session:abc", smsEvent());
    emits(completed("thread-1"));
    emits({ ...completed("thread-1"), ok: false } as RuntimeEvent);
    emits(completed("other-thread"));
    expect(replies).toEqual([]);
  });
});
