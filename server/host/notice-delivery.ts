// The index.ts side of notice triage: which engine judges, which language the
// reasons read in, and where a surfaced batch lands. index.ts stays the
// composition root and only spreads what this builds.
import { join } from "node:path";

import { createChannelChats } from "../channel-chats.ts";
import type { DirectSendInput } from "../direct-send.ts";
import type { PhonesDeps } from "./phones.ts";
import type { NoticeSurfacedItem } from "./notice-triage.ts";
import type { SideJobInstance, SideJobs } from "../side-jobs.ts";

const JUDGE_TIMEOUT_MS = 30_000;

export function createNoticeDelivery(deps: {
  dataDir: string;
  /** The owner's chief bot, looked up at call time. */
  chiefBot(): { id: string; modelSelection: { instanceId: string } } | undefined;
  /** The engine registry — what side-jobs routes a text call through. */
  engine(instanceId: string): SideJobInstance | null | undefined;
  /** Late-bound: index.ts builds side-jobs after the phones host. */
  sideJobs(): SideJobs;
  taskByThread(botId: string, threadId: string): unknown;
  createTask(botId: string, title: string): { threadId: string } | null;
  /** acceptDirectSend — a surfaced batch is an inbound event the bot answers in place. */
  send(input: DirectSendInput): Promise<unknown>;
  /** The UI language, e.g. appLanguage. */
  language(): string | undefined;
}): Pick<PhonesDeps, "noticeJudge" | "noticeLanguage" | "noticeSurfaced"> {
  // A surfaced batch lands in one thread per app, like an inbound SMS lands in
  // one thread per number.
  const chats = createChannelChats(join(deps.dataDir, "notice-chats.json"));
  return {
    noticeJudge: () => {
      const chief = deps.chiefBot();
      const instance = chief ? deps.engine(chief.modelSelection.instanceId) : null;
      // side-jobs falls to the helper model when the engine has no one-off text call — pi never does.
      const write = chief ? deps.sideJobs().text("notice", chief.id, { instance: instance ?? undefined })?.generateText : null;
      return write ? (prompt: string) => write(prompt, { timeoutMs: JUDGE_TIMEOUT_MS }) : null;
    },
    noticeLanguage: () => (deps.language()?.startsWith("zh") ? "Chinese" : "English"),
    noticeSurfaced: (ownerKey: string, packageName: string, items: NoticeSurfacedItem[]) => {
      const chief = deps.chiefBot();
      if (!chief) return;
      const chatId = `${ownerKey}|${packageName}`;
      const text = `手机通知 · ${packageName}\n${items.map(({ record }) => [record.title, record.sender ? `${record.sender}: ${record.text}` : record.text].filter(Boolean).join(" — ")).join("\n")}`;
      let threadId = chats.threadFor(chatId);
      if (!threadId || !deps.taskByThread(chief.id, threadId)) {
        const task = deps.createTask(chief.id, `通知 · ${packageName}`);
        if (!task) return;
        threadId = task.threadId;
        chats.set(chatId, threadId);
      }
      void deps.send({
        botId: chief.id, threadId, text,
        sendId: `notice:${chatId}:${Date.now()}`,
        sender: { name: `手机通知 ${packageName}`, id: `notice:${chatId}` },
        trigger: { kind: "user", label: `notice:${packageName}` },
        personPresent: false,
      }).catch((error) => console.warn(`notice: surfaced rejected: ${(error as Error).message}`));
    },
  };
}
