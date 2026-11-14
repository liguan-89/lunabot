// Feishu chat_id → bot task thread: which conversation answers a Feishu chat survives a restart.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

import { parseJson } from "./schema.ts";

const shape = z.object({ chats: z.record(z.string(), z.string().min(1)) }).catch({ chats: {} });

export interface FeishuChats {
  threadFor(chatId: string): string | undefined;
  chatFor(threadId: string): string | undefined;
  set(chatId: string, threadId: string): void;
}

export function createFeishuChats(file: string): FeishuChats {
  const read = (): Record<string, string> => {
    try { return existsSync(file) ? shape.parse(parseJson(readFileSync(file, "utf8"))).chats : {}; }
    catch { return {}; }
  };
  return {
    threadFor: (chatId) => read()[chatId],
    chatFor: (threadId) => Object.entries(read()).find(([, thread]) => thread === threadId)?.[0],
    set: (chatId, threadId) => writeFileSync(file, JSON.stringify({ chats: { ...read(), [chatId]: threadId } })),
  };
}
