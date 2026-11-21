// WeChat relay over a paired phone: the phone holds the iLink binding and pushes inbound messages to
// /api/phones/self/events; each (phone, peer) pair is one task thread whose turn's replies go back as
// PHONE_REPLY_WECHAT jobs the phone sends itself — never a tap, and only ever to the peer that wrote in.
// Groups, contacts, moments and payments do not exist in this protocol: nothing here can enumerate them,
// nothing can send as the person, and the phone only ever reaches the owner bound to its own account.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { escapeAttribute } from "../src/lib/composer-attachments.ts";
import { saveImage } from "./attachments.ts";
import { createChannelChats } from "./channel-chats.ts";
import type { AppConfig } from "./config.ts";
import type { DirectSendInput, DirectSendReceipt } from "./direct-send.ts";
import type { EventBus } from "./harness/bus.ts";
import { isInternalTurn } from "./internal-turns.ts";
import type { PhoneEvent } from "./sms-relay.ts";
import type { Store } from "./store.ts";
import type { RuntimeEvent } from "../shared/runtime-events.ts";

/** The job the phone polls for to send a WeChat reply itself. It is not a phone tool: a bot never calls it. */
export const PHONE_REPLY_WECHAT = "PHONE_REPLY_WECHAT";

/** The frozen `wechat` member of phoneEvent, narrowed. */
export type WechatEvent = Extract<PhoneEvent, { kind: "wechat" }>;

/** How many iLink message ids are remembered, so a phone retry can never start a turn twice. */
const SEEN_MAX = 2_000;

export interface WechatRelayDeps {
  store: Store;
  cfg: AppConfig;
  dataDir: string;
  bus: Pick<EventBus, "subscribe">;
  acceptDirectSend(input: DirectSendInput): Promise<DirectSendReceipt>;
  routineRunForThread(threadId: string): unknown;
  ignoreEvent(event: RuntimeEvent): boolean;
  replyWechat(phoneKey: string, to: string, text: string, image?: { mime: string; data: string }): Promise<unknown>;
}

/** A picture's name is untrusted prompt content: it is a display name only, never a path. */
const safeName = (name: string, index: number): string =>
  name.replace(/[\\/]/g, "_").replaceAll("\u0000", "_").trim().slice(0, 200) || `wechat-${index + 1}.jpg`;

export function createWechatRelay(deps: WechatRelayDeps): { push(phoneKey: string, event: WechatEvent): void } {
  const { store, cfg } = deps;
  const chats = createChannelChats(join(deps.dataDir, "wechat-chats.json"));
  const seenIds = new Set<string>();

  /** Bounded, insertion-ordered: the oldest id is forgotten once the cap is reached. */
  function remember(id: string): void {
    seenIds.add(id);
    if (seenIds.size > SEEN_MAX) for (const oldest of seenIds) { seenIds.delete(oldest); break; }
  }

  /**
   * The message text plus one `<attached-image>` tag per picture, saved through saveImage exactly as
   * savePhoneAttachment saves an image the phone sends. A user line carries its pictures this way (see
   * composeMessage in src/lib/composer-attachments.ts), and beginTurn reads the tags as native image input.
   */
  function withImages(event: WechatEvent): string {
    const tags: string[] = [];
    for (const [index, image] of (event.images ?? []).entries()) {
      try {
        const saved = saveImage(Buffer.from(image.data, "base64"), image.mime);
        tags.push(`<attached-image path="${escapeAttribute(saved.path)}" name="${escapeAttribute(safeName(image.name, index))}" />`);
      } catch (error) {
        // Neither the payload nor the picture's bytes reach the log: the position and the reason are enough.
        console.warn(`wechat: image ${index + 1} dropped: ${(error as Error).message}`);
      }
    }
    return [event.text, ...tags].filter(Boolean).join("\n\n");
  }

  deps.bus.subscribe((event: RuntimeEvent) => {
    if (deps.ignoreEvent(event)) return;
    if (event.type !== "turn.completed" || !event.turnId || !event.ok) return;
    const chatId = chats.chatFor(event.threadId);
    const sep = chatId?.indexOf("|") ?? -1;
    if (!chatId || sep <= 0) return;
    try {
      const messages = store.activePath(event.threadId);
      const fromWechat = !isInternalTurn(event.threadId) && !deps.routineRunForThread(event.threadId)
        && messages.findLast((m) => m.role === "user")?.sender?.id?.startsWith("wechat:");
      if (!fromWechat) return;
      const phoneKey = chatId.slice(0, sep);
      const to = chatId.slice(sep + 1);
      const send = (text: string, image?: { mime: string; data: string }) => void deps.replyWechat(phoneKey, to, text, image)
        // jobs.request resolves {ok:false} rather than rejecting, so a dropped reply must be told apart by the outcome.
        .then((outcome) => { if ((outcome as { ok?: boolean } | null)?.ok === false) console.warn(`wechat: reply not sent: ${(outcome as { error?: string }).error ?? "unknown"}`); })
        .catch((error) => console.warn(`wechat: reply failed: ${(error as Error).message}`));
      for (const message of messages.filter((m) => m.turnId === event.turnId && m.role === "bot" && m.kind === "text")) {
        if (message.text?.trim()) send(message.text.trim());
        // An image the bot attached is an outbound message of its own; a fromTool image is input the bot saw, not sent.
        for (const attachment of message.attachments ?? []) {
          if (attachment.kind !== "image" || attachment.fromTool) continue;
          readFile(attachment.path)
            .then((bytes) => send("", { mime: attachment.mime, data: bytes.toString("base64") }))
            .catch((error) => console.warn(`wechat: image reply failed: ${(error as Error).message}`));
        }
      }
    } catch (error) {
      console.warn(`wechat: reply failed: ${(error as Error).message}`);
    }
  });

  return {
    push(phoneKey, event) {
      const botId = cfg.wechat?.botId;
      if (!botId) return;
      if (!store.bot(botId)) { console.warn(`wechat: no such bot ${botId}`); return; }
      // A retried iLink message is dropped before anything is created: no second thread, no second turn.
      const seen = `${phoneKey}\u0000${event.sendId}`;
      if (seenIds.has(seen)) return;
      remember(seen);
      try {
        const chatId = `${phoneKey}|${event.from}`;
        let threadId = chats.threadFor(chatId);
        if (!threadId || !store.taskByThread(botId, threadId)) {
          const task = store.createTask(botId, event.text || event.images?.[0]?.name || event.from);
          if (!task) return;
          threadId = task.threadId;
          chats.set(chatId, threadId);
        }
        void deps.acceptDirectSend({
          botId, threadId, text: withImages(event),
          sendId: `wechat:${phoneKey}:${event.sendId}`,
          // The SMS convention: the kind prefix plus the chat id, so each phone keeps its own peer.
          sender: { name: `微信 ${event.from}`, id: `wechat:${chatId}` },
          trigger: { kind: "user", label: `wechat:${event.from}` },
          personPresent: false,
        }).catch((error) => console.warn(`wechat: inbound rejected: ${(error as Error).message}`));
      } catch (error) {
        console.warn(`wechat: inbound failed: ${(error as Error).message}`);
      }
    },
  };
}
