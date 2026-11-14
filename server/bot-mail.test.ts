import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createBotMailChats, pollBotMail, replyBotMail, type BotMailBox } from "./bot-mail.ts";
import type { ReadMessage } from "./email/client.ts";
import type { EmailAccount } from "./email/store.ts";

const account = { address: "bot@example.com" } as EmailAccount;

const message = (over: Partial<ReadMessage> = {}): ReadMessage => ({
  uid: 1, from: "sender@x.com", to: ["bot@example.com"], cc: [], replyTo: [], subject: "hello",
  date: null, unread: true, text: "  the body  ", truncated: false, attachments: [], ...over,
});

const box = (over: Partial<BotMailBox["run"]> = {}): BotMailBox => ({
  account,
  guard: async () => ({ host: "imap.example.com" }),
  run: {
    searchMessages: vi.fn(async () => ({ found: 1, messages: [{ uid: 7, from: "sender@x.com", to: [], subject: "hello", date: null, unread: true }] })),
    readMessage: vi.fn(async () => message({ uid: 7 })),
    sendMessage: vi.fn(async () => ({ messageId: "m1", accepted: [], rejected: [], filed: true })),
    ...over,
  },
});

describe("pollBotMail", () => {
  it("returns unread mail as person-ready messages", async () => {
    expect(await pollBotMail(box())).toEqual([{ uid: 7, from: "sender@x.com", subject: "hello", text: "the body" }]);
  });

  it("prefers Reply-To and skips empty or sender-less mail", async () => {
    const read = vi.fn(async () => message({ uid: 7, replyTo: ["reply@x.com"], messageId: "<m@x>" }));
    expect(await pollBotMail(box({ readMessage: read }))).toEqual([{ uid: 7, from: "reply@x.com", subject: "hello", text: "the body", messageId: "<m@x>" }]);
    const empty = vi.fn(async () => message({ uid: 7, text: "   " }));
    expect(await pollBotMail(box({ readMessage: empty }))).toEqual([]);
    const noFrom = vi.fn(async () => message({ uid: 7, from: "", replyTo: [] }));
    expect(await pollBotMail(box({ readMessage: noFrom }))).toEqual([]);
  });
});

describe("replyBotMail", () => {
  it("sends a threaded Re: reply", async () => {
    const send = vi.fn(async () => ({ messageId: "m1", accepted: [], rejected: [], filed: true }));
    await replyBotMail(box({ sendMessage: send }), { to: "sender@x.com", subject: "hello", text: "answer", inReplyTo: "<m@x>" });
    expect(send).toHaveBeenCalledWith(account, expect.anything(), {
      to: ["sender@x.com"], subject: "Re: hello", text: "answer", inReplyTo: "<m@x>", references: "<m@x>",
    });
  });

  it("keeps an existing Re: prefix and fills an empty subject", async () => {
    const send = vi.fn(async () => ({ messageId: "m1", accepted: [], rejected: [], filed: true }));
    await replyBotMail(box({ sendMessage: send }), { to: "a@x.com", subject: "RE: thread", text: "x" });
    await replyBotMail(box({ sendMessage: send }), { to: "a@x.com", subject: "", text: "x" });
    expect(send).toHaveBeenNthCalledWith(1, account, expect.anything(), { to: ["a@x.com"], subject: "RE: thread", text: "x" });
    expect(send).toHaveBeenNthCalledWith(2, account, expect.anything(), { to: ["a@x.com"], subject: "Re: (no subject)", text: "x" });
  });
});

describe("bot mail chats", () => {
  it("persists sender→thread with the reply meta", () => {
    const dir = mkdtempSync(join(tmpdir(), "bot-mail-"));
    try {
      const file = join(dir, "bot-mail-chats.json");
      const chats = createBotMailChats(file);
      chats.set("sender@x.com", { threadId: "t1", from: "reply@x.com", subject: "hello", messageId: "<m@x>" });
      const again = createBotMailChats(file);
      expect(again.threadFor("sender@x.com")).toBe("t1");
      expect(again.chatFor("t1")).toEqual({ threadId: "t1", sender: "sender@x.com", from: "reply@x.com", subject: "hello", messageId: "<m@x>" });
      expect(again.threadFor("other@x.com")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
