// SMS relay over a paired phone (the Android phone app): the phone pushes inbound texts to
// /api/phones/self/events; each (phone, sender) pair is one task thread whose turn replies go back as
// PHONE_REPLY_SMS jobs the phone sends itself — never a tap, and only ever to the number that wrote in.
import { join } from "node:path";
import { z } from "zod";

import type { AppConfig } from "./config.ts";
import { createChannelChats } from "./channel-chats.ts";
import { isInternalTurn } from "./internal-turns.ts";
import { phoneNotice } from "./phone-notices.ts";
import type { DirectSendInput, DirectSendReceipt } from "./direct-send.ts";
import type { RuntimeEvent } from "../shared/runtime-events.ts";
import type { EventBus } from "./harness/bus.ts";
import type { Store } from "./store.ts";

/** One inbound WeChat picture: the mime the phone decoded it as, a display name, and the bytes as base64. */
const wechatImage = z.object({
  mime: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  data: z.string().min(1),
}).strict();

/** Total base64 one event may carry: the phone caps a picture at 10 MB, so eight of them need a ceiling of their own. */
export const WECHAT_IMAGES_MAX_BASE64 = 11_000_000;

/** What a paired phone may push through /api/phones/self/events. `sendId` dedupes phone-side retries. */
export const phoneEvent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sms"),
    sendId: z.string().min(1).max(120),
    from: z.string().trim().min(1).max(64),
    text: z.string().min(1).max(4000),
  }).strict(),
  z.object({
    kind: z.literal("wechat"),
    sendId: z.string().min(1).max(120),
    from: z.string().trim().min(1).max(64),
    // The phone forwards a picture-only message with no words, so the words may be empty only when pictures are not.
    text: z.string().max(4000),
    images: z.array(wechatImage).max(8).optional(),
  }).strict()
    .refine((event) => event.text.trim() !== "" || (event.images?.length ?? 0) > 0, { message: "text or images is required" })
    .refine((event) => (event.images ?? []).reduce((total, image) => total + image.data.length, 0) <= WECHAT_IMAGES_MAX_BASE64, { message: "images are too large" }),
  phoneNotice,
]);
export type PhoneEvent = z.infer<typeof phoneEvent>;

/** The job the phone polls for to send a channel reply itself; distinct from PHONE_SEND_MESSAGE, which waits for a tap. */
export const PHONE_REPLY_SMS = "PHONE_REPLY_SMS";

export interface SmsRelayDeps {
  store: Store;
  cfg: AppConfig;
  dataDir: string;
  bus: Pick<EventBus, "subscribe">;
  acceptDirectSend(input: DirectSendInput): Promise<DirectSendReceipt>;
  routineRunForThread(threadId: string): unknown;
  ignoreEvent(event: RuntimeEvent): boolean;
  replySms(phoneKey: string, to: string, text: string): Promise<unknown>;
}

export function createSmsRelay(deps: SmsRelayDeps): { push(phoneKey: string, event: PhoneEvent): void } {
  const { store, cfg } = deps;
  const chats = createChannelChats(join(deps.dataDir, "sms-chats.json"));

  deps.bus.subscribe((event: RuntimeEvent) => {
    if (deps.ignoreEvent(event)) return;
    if (event.type !== "turn.completed" || !event.turnId || !event.ok) return;
    const chatId = chats.chatFor(event.threadId);
    const sep = chatId?.indexOf("|") ?? -1;
    if (!chatId || sep <= 0) return;
    try {
      const messages = store.activePath(event.threadId);
      const fromSms = !isInternalTurn(event.threadId) && !deps.routineRunForThread(event.threadId)
        && messages.findLast((m) => m.role === "user")?.sender?.id?.startsWith("sms:");
      if (!fromSms) return;
      const phoneKey = chatId.slice(0, sep);
      const to = chatId.slice(sep + 1);
      for (const text of messages.filter((m) => m.turnId === event.turnId && m.role === "bot" && m.kind === "text" && m.text?.trim()).map((m) => m.text!.trim())) {
        void deps.replySms(phoneKey, to, text)
          // jobs.request resolves {ok:false} rather than rejecting, so a dropped reply must be told apart by the outcome.
          .then((outcome) => { if ((outcome as { ok?: boolean } | null)?.ok === false) console.warn(`sms: reply not sent: ${(outcome as { error?: string }).error ?? "unknown"}`); })
          .catch((error) => console.warn(`sms: reply failed: ${(error as Error).message}`));
      }
    } catch (error) {
      console.warn(`sms: reply failed: ${(error as Error).message}`);
    }
  });

  return {
    push(phoneKey, event) {
      // The events path is shared; a kind that is not an inbound text is not this relay's to read.
      if (event.kind === "notice") return;
      const botId = cfg.sms?.botId;
      if (!botId) return;
      if (!store.bot(botId)) { console.warn(`sms: no such bot ${botId}`); return; }
      try {
        // The same sender reaches us as +8618… (carrier SMS) and 8618… (notification relay); key the thread on digits.
        const chatId = `${phoneKey}|${event.from.replace(/\D/g, "") || event.from}`;
        let threadId = chats.threadFor(chatId);
        if (!threadId || !store.taskByThread(botId, threadId)) {
          const task = store.createTask(botId, event.text);
          if (!task) return;
          threadId = task.threadId;
          chats.set(chatId, threadId);
        }
        void deps.acceptDirectSend({
          botId, threadId, text: event.text,
          sendId: `sms:${phoneKey}:${event.sendId}`,
          sender: { name: `短信 ${event.from}`, id: `sms:${chatId}` },
          trigger: { kind: "user", label: `sms:${event.from}` },
          personPresent: false,
        }).catch((error) => console.warn(`sms: inbound rejected: ${(error as Error).message}`));
      } catch (error) {
        console.warn(`sms: inbound failed: ${(error as Error).message}`);
      }
    },
  };
}
