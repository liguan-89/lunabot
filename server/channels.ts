// External channels that turn remote messages into bot turns and post the replies back.
import { join } from "node:path";
import { WebSocket } from "ws";

import type { AppConfig } from "./config.ts";
import { onConfigSaved } from "./config.ts";
import { connectFeishu, type FeishuChannel, type WsLike } from "./feishu.ts";
import { createFeishuChats } from "./feishu-chats.ts";
import { createBotMailChats, pollBotMail, replyBotMail, type BotMailBox } from "./bot-mail.ts";
import { isInternalTurn } from "./internal-turns.ts";
import type { DirectSendInput, DirectSendReceipt } from "./direct-send.ts";
import type { RuntimeEvent } from "../shared/runtime-events.ts";
import type { EventBus } from "./harness/bus.ts";
import type { Store } from "./store.ts";
import type { EmailService } from "./email/service.ts";

export interface ChannelsDeps {
  store: Store;
  cfg: AppConfig;
  dataDir: string;
  bus: Pick<EventBus, "subscribe">;
  emailService: EmailService;
  acceptDirectSend(input: DirectSendInput): Promise<DirectSendReceipt>;
  // routines is a late-bound index.ts `let`; read it through the getter.
  routineRunForThread(threadId: string): unknown;
  ignoreEvent(event: RuntimeEvent): boolean;
}

export function createChannels(deps: ChannelsDeps): void {
  const { store, cfg, bus, emailService } = deps;

  // Feishu self-built-app channel (server/feishu.ts): one app answers as one bot over the platform's
  // long connection, so no public callback URL is needed. Each chat_id maps to a task; inbound text is
  // a person message, and a turn that chat triggered posts its bot replies back to the chat.
  const feishuChats = createFeishuChats(join(deps.dataDir, "feishu-chats.json"));
  let feishuChannel: FeishuChannel | null = null;
  const syncFeishu = () => {
    feishuChannel?.close();
    feishuChannel = null;
    const fc = cfg.feishu;
    if (!fc?.appId || !fc.appSecret || !fc.botId) return;
    const botId = fc.botId;
    if (!store.bot(botId)) { console.warn(`feishu: no such bot ${botId}`); return; }
    feishuChannel = connectFeishu({ appId: fc.appId, appSecret: fc.appSecret, baseUrl: fc.baseUrl }, {
      fetch,
      ws: (url) => new WebSocket(url) as unknown as WsLike,
      log: (line) => console.log(line),
      onText: (inbound) => {
        try {
          let threadId = feishuChats.threadFor(inbound.chatId);
          if (!threadId || !store.taskByThread(botId, threadId)) {
            const task = store.createTask(botId, inbound.text);
            if (!task) return;
            threadId = task.threadId;
            feishuChats.set(inbound.chatId, threadId);
          }
          void deps.acceptDirectSend({
            botId, threadId, text: inbound.text,
            sendId: `feishu:${inbound.messageId}`,
            sender: { name: `飞书 ${inbound.openId}`, id: `feishu:${inbound.openId}` },
            trigger: { kind: "user", label: `feishu:${inbound.openId}` },
            personPresent: false,
          }).catch((error) => console.warn(`feishu: inbound rejected: ${(error as Error).message}`));
        } catch (error) {
          console.warn(`feishu: inbound failed: ${(error as Error).message}`);
        }
      },
    });
  };
  syncFeishu();
  onConfigSaved((before, after) => {
    if (JSON.stringify(before.feishu ?? null) !== JSON.stringify(after.feishu ?? null)) setImmediate(() => syncFeishu());
  });
  bus.subscribe((event: RuntimeEvent) => {
    if (deps.ignoreEvent(event)) return;
    if (event.type !== "turn.completed" || !event.turnId || !event.ok) return;
    const channel = feishuChannel;
    if (!channel) return;
    const chatId = feishuChats.chatFor(event.threadId);
    if (!chatId) return;
    try {
      const messages = store.activePath(event.threadId);
      // The triggering person message carries no turnId: the chat asked iff the latest person line is
      // from it. Side jobs and routine runs on the thread stay quiet.
      const fromChat = !isInternalTurn(event.threadId) && !deps.routineRunForThread(event.threadId)
        && messages.findLast((m) => m.role === "user")?.sender?.id?.startsWith("feishu:");
      if (!fromChat) return;
      for (const text of messages.filter((m) => m.turnId === event.turnId && m.role === "bot" && m.kind === "text" && m.text?.trim()).map((m) => m.text!.trim())) {
        channel.sendText(chatId, text).catch((error) => console.warn(`feishu: send failed: ${(error as Error).message}`));
      }
    } catch (error) {
      console.warn(`feishu: reply failed: ${(error as Error).message}`);
    }
  });

  // Bot-owned mailbox (server/bot-mail.ts): one connected account's unread INBOX mail becomes person
  // messages; each sender maps to a task, and the turn's replies go back over SMTP threading the mail.
  const botMailChats = createBotMailChats(join(deps.dataDir, "bot-mail-chats.json"));
  let botMailTimer: ReturnType<typeof setInterval> | null = null;
  let botMailBox: BotMailBox | null = null;
  const syncBotMail = () => {
    if (botMailTimer) { clearInterval(botMailTimer); botMailTimer = null; }
    botMailBox = null;
    const bm = cfg.botMail;
    if (!bm?.address || !bm.botId) return;
    const account = emailService.store.get(bm.address);
    if (!account || !store.bot(bm.botId)) { console.warn(`bot mail: mailbox ${bm.address} is not connected or bot ${bm.botId} is missing`); return; }
    botMailBox = { account, guard: emailService.guard };
    botMailTimer = setInterval(() => void pollBotMailOnce(), Number(process.env.OMB_BOT_MAIL_MS) || 180_000);
    void pollBotMailOnce();
  };
  const pollBotMailOnce = async () => {
    const box = botMailBox;
    const botId = cfg.botMail?.botId;
    if (!box || !botId) return;
    try {
      for (const mail of await pollBotMail(box)) {
        try {
          let threadId = botMailChats.threadFor(mail.from);
          if (!threadId || !store.taskByThread(botId, threadId)) {
            const task = store.createTask(botId, mail.subject || mail.from);
            if (!task) continue;
            threadId = task.threadId;
          }
          botMailChats.set(mail.from, { threadId, from: mail.from, subject: mail.subject, ...(mail.messageId ? { messageId: mail.messageId } : {}) });
          void deps.acceptDirectSend({
            botId, threadId,
            text: `From: ${mail.from}\nSubject: ${mail.subject}\n\n${mail.text}`,
            sendId: `mail:${box.account.address}:${mail.uid}`,
            sender: { name: mail.from, id: `mail:${box.account.address}:${mail.from}` },
            trigger: { kind: "user", label: `mail:${mail.from}` },
            personPresent: false,
          }).catch((error) => console.warn(`bot mail: inbound rejected: ${(error as Error).message}`));
        } catch (error) {
          console.warn(`bot mail: inbound failed: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      console.warn(`bot mail: poll failed: ${(error as Error).message}`);
    }
  };
  syncBotMail();
  onConfigSaved((before, after) => {
    if (JSON.stringify(before.botMail ?? null) !== JSON.stringify(after.botMail ?? null)) setImmediate(() => syncBotMail());
  });
  bus.subscribe((event: RuntimeEvent) => {
    if (deps.ignoreEvent(event)) return;
    if (event.type !== "turn.completed" || !event.turnId || !event.ok) return;
    const box = botMailBox;
    if (!box) return;
    const chat = botMailChats.chatFor(event.threadId);
    if (!chat) return;
    try {
      const messages = store.activePath(event.threadId);
      const fromMail = !isInternalTurn(event.threadId) && !deps.routineRunForThread(event.threadId)
        && messages.findLast((m) => m.role === "user")?.sender?.id?.startsWith("mail:");
      if (!fromMail) return;
      for (const text of messages.filter((m) => m.turnId === event.turnId && m.role === "bot" && m.kind === "text" && m.text?.trim()).map((m) => m.text!.trim())) {
        replyBotMail(box, { to: chat.from, subject: chat.subject, text, ...(chat.messageId ? { inReplyTo: chat.messageId } : {}) })
          .catch((error) => console.warn(`bot mail: send failed: ${(error as Error).message}`));
      }
    } catch (error) {
      console.warn(`bot mail: reply failed: ${(error as Error).message}`);
    }
  });
}
