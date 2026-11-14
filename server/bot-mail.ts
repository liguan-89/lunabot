// Bot-owned mailbox: a connected mailbox account the bot answers end to end. A poller scans its
// INBOX for unread mail; each sender maps to a task, and the turn's replies go back over SMTP
// threading the original message. Configured by cfg.botMail {address, botId}: the address must be
// a connected account, and everything unread in it is the bot's — connect a mailbox the bot owns.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

import { parseJson } from "./schema.ts";
import { readMessage, searchMessages, sendMessage, type EmailGuard } from "./email/client.ts";
import type { EmailAccount } from "./email/store.ts";

export interface BotMailMessage {
  uid: number;
  /** The address the reply goes to (Reply-To wins over From). */
  from: string;
  subject: string;
  text: string;
  messageId?: string;
}

export interface BotMailRun {
  searchMessages: typeof searchMessages;
  readMessage: typeof readMessage;
  sendMessage: typeof sendMessage;
}

const DEFAULT_RUN: BotMailRun = { searchMessages, readMessage, sendMessage };

export interface BotMailBox {
  account: EmailAccount;
  guard: EmailGuard;
  /** Test seam. */
  run?: Partial<BotMailRun>;
}

/** Unread INBOX mail as person-ready text. Reads never mark a message seen (read-only mailbox lock),
 * so the caller dedups by uid across cycles. */
export async function pollBotMail(box: BotMailBox, limit = 25): Promise<BotMailMessage[]> {
  const run = { ...DEFAULT_RUN, ...box.run };
  const found = await run.searchMessages(box.account, box.guard, { mailbox: "INBOX", limit, unread: true });
  const out: BotMailMessage[] = [];
  for (const summary of found.messages) {
    const message = await run.readMessage(box.account, box.guard, { mailbox: "INBOX", uid: summary.uid });
    const from = (message.replyTo[0] ?? message.from).trim();
    const text = message.text.trim();
    if (!from || !text) continue;
    out.push({ uid: message.uid, from, subject: message.subject, text: text.slice(0, 8_000), ...(message.messageId ? { messageId: message.messageId } : {}) });
  }
  return out;
}

export async function replyBotMail(box: BotMailBox, mail: { to: string; subject: string; text: string; inReplyTo?: string }): Promise<void> {
  const run = { ...DEFAULT_RUN, ...box.run };
  const subject = mail.subject.trim();
  await run.sendMessage(box.account, box.guard, {
    to: [mail.to],
    subject: /^re:/iu.test(subject) ? subject : `Re: ${subject || "(no subject)"}`,
    text: mail.text,
    ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo, references: mail.inReplyTo } : {}),
  });
}

interface BotMailChat { threadId: string; from: string; subject: string; messageId?: string }

const shape = z.object({
  chats: z.record(z.string(), z.object({
    threadId: z.string().min(1),
    from: z.string().min(1),
    subject: z.string().max(998),
    messageId: z.string().max(998).optional(),
  })),
}).catch({ chats: {} });

export interface BotMailChats {
  threadFor(sender: string): string | undefined;
  chatFor(threadId: string): (BotMailChat & { sender: string }) | undefined;
  set(sender: string, chat: BotMailChat): void;
}

export function createBotMailChats(file: string): BotMailChats {
  const read = (): Record<string, BotMailChat> => {
    try { return existsSync(file) ? shape.parse(parseJson(readFileSync(file, "utf8"))).chats : {}; }
    catch { return {}; }
  };
  return {
    threadFor: (sender) => read()[sender]?.threadId,
    chatFor: (threadId) => {
      const hit = Object.entries(read()).find(([, chat]) => chat.threadId === threadId);
      return hit ? { ...hit[1], sender: hit[0] } : undefined;
    },
    set: (sender, chat) => writeFileSync(file, JSON.stringify({ chats: { ...read(), [sender]: chat } })),
  };
}
