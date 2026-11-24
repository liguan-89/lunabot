import { afterEach, describe, expect, it } from "vitest";

import { createGoalCards } from "./host/goal-cards.ts";
import { sentRow, teammateResultRow, WAIT_CARD_CLOSED_REASON } from "./host/handoff-sent.ts";
import { briefCrossingLabel, recallCrossingLabel } from "./recall-disclosure.ts";
import "./server-line-packs.ts";
import { serverLine, setConversationLanguage } from "./server-lines.ts";
import type { Message } from "./store.ts";
import { queuedBehindPersonText, settledWaitingChip } from "./waiting-on-person.ts";

const ada = { id: "ada", name: "Ada", color: "blue" as const };
const biber = { id: "biber", name: "Biber", color: "red" as const };

describe("what a conversation shows about a teammate's work", () => {
  afterEach(() => setConversationLanguage(() => undefined));

  it("says a hand-off went out in the language of the sender's conversation", () => {
    expect(sentRow({ sender: ada, recipient: biber, threadId: "t", via: "direct", language: "zh" }).tool?.name).toBe("已发送给 Biber");
    expect(sentRow({ sender: ada, recipient: biber, threadId: "t", via: "direct", room: { id: "g", name: "Launch", here: true }, language: "zh" }).tool?.name)
      .toBe("已直接发送给 Biber：它不在这个群组聊天中。");
    expect(sentRow({ sender: ada, recipient: biber, threadId: "t", via: "lane", room: { id: "g", name: "Launch", here: false } }).tool?.name).toBe("Sent to Biber · Launch");
    expect(sentRow({ sender: ada, recipient: biber, threadId: "t", via: "direct", language: "zh" }).threadRef?.title).toBe("队友的工作");
  });

  it("says how the work came back", () => {
    expect(teammateResultRow("zh", { status: "completed", result: "Done", groupId: "g" }, "Biber", undefined, "Launch")).toBe("Biber 已回复 · Launch");
    expect(teammateResultRow("zh", { status: "failed", result: "boom\nmore" }, "Biber", undefined, undefined)).toBe("Biber：失败：boom");
    expect(teammateResultRow("zh", { status: "completed", result: "" }, undefined, "team access changed", undefined)).toBe("结果已扣留：team access changed");
    expect(teammateResultRow(undefined, { status: "cancelled", result: "stopped" }, undefined, undefined, undefined)).toBe("Teammate — cancelled: stopped");
  });

  it("keeps the card wait cancellation reason byte-identical to English", () => {
    expect(WAIT_CARD_CLOSED_REASON).toBe("The card it waited on was replaced or closed");
    expect(serverLine(undefined, "server.teammates.waitCardClosed")).toBe(WAIT_CARD_CLOSED_REASON);
  });

  it.each([
    [undefined, "The card it waited on was replaced or closed"],
    ["zh", "它等待的卡片被替换或关闭了"],
  ])("shows a cancelled card wait in the conversation language %s", (language, expected) => {
    expect(teammateResultRow(language, { status: "cancelled", result: WAIT_CARD_CLOSED_REASON }, "Biber", undefined, undefined)).toContain(expected);
  });

  it.each([
    ["zh", "en", "Biber：已取消：它等待的卡片被替换或关闭了"],
    ["en", "zh", "Biber — cancelled: The card it waited on was replaced or closed"],
  ])("shows a %s requester's cancelled card wait from a %s child", (parentLanguage, childLanguage, expected) => {
    const child = { status: "cancelled", result: serverLine(childLanguage, "server.teammates.waitCardClosed") };
    expect(teammateResultRow(parentLanguage, child, "Biber", undefined, undefined)).toBe(expected);
  });

  it("keeps other cancellation diagnostics unchanged", () => {
    expect(teammateResultRow("zh", { status: "cancelled", result: "A different stop reason\nmore" }, "Biber", undefined, undefined))
      .toBe("Biber：已取消：A different stop reason");
  });

  it("says what came of a teammate's question or approval, and what waits behind the person", () => {
    expect(settledWaitingChip("Biber", "answer", "allow", "user", "zh")).toEqual({ name: "@Biber 已收到你的回答", ok: true });
    expect(settledWaitingChip("Biber", "approval", "allow", "timeout", "zh").name).toBe("没有人及时回应 @Biber 的批准请求，该步骤没有运行");
    expect(settledWaitingChip("Biber", "approval", "deny", "user")).toEqual({ name: "@Biber's request was denied", ok: false });
    expect(queuedBehindPersonText("Biber", "question", "Release", "zh")).toBe("在「Release」中排在你的回答之后，等待 @Biber");
    expect(recallCrossingLabel("Biber", 1, "zh")).toBe("Biber 从与你的私聊中调取了 1 条消息");
    expect(briefCrossingLabel("Biber", 3)).toBe("Biber's recent-work brief covers 3 private chats with you");
  });

  it("writes a room goal's card in the room's language", () => {
    setConversationLanguage((threadId) => (threadId === "room" ? "zh" : undefined));
    const lines: Message[] = [];
    const store = {
      appendMessage: (_threadId: string, message: Omit<Message, "id" | "at">) => { const full = { id: `m${lines.length + 1}`, at: 1, ...message } as Message; lines.push(full); return full; },
      bot: () => null,
      messagesFor: () => lines,
      patchMessage: (_threadId: string, id: string, patch: Partial<Message>) => { const line = lines.find((one) => one.id === id)!; Object.assign(line, patch); return line; },
    };
    const goals = createGoalCards({ store: store as never, routines: () => null, notify: () => {}, routineSourceOwner: () => null, routineSourceThread: () => null });
    const run = goals.start("room", biber, "Ship the release", "run-1");
    expect(lines[0]!.text).toBe("目标进行中：Biber 正在协调这个目标。");
    expect(lines[0]!.goalRun?.detail).toBe("Biber 正在协调这个目标。");
    goals.finish("room", run, "needs-input", "Welche Version?", () => true);
    expect(lines[0]!.text).toBe("目标需要你回复：Welche Version?");
  });
});
