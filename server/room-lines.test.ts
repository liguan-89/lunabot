import { describe, expect, it } from "vitest";

import { roomResetNote } from "./room-context.ts";
import { heldMemberLine, isHeldMemberLine } from "./room-holds.ts";
import { finishedWithoutSummaryLine } from "./room-reply.ts";
import { roomTurnTimeoutMessage } from "./room-turn-timeout.ts";
import "./server-line-packs.ts";
import { isServerLine } from "./server-lines.ts";
import { HARNESS_NOTICE } from "./sentinel/normalize.ts";
import { toolError } from "./sentinel/detectors/tool-error.ts";
import { turnStop } from "./sentinel/detectors/turn-stop.ts";
import type { DetectorConfig, SentinelRecord } from "./sentinel/types.ts";

describe("a room's status rows", () => {
  it("read in the room's language, and in English for a coordinator", () => {
    expect(heldMemberLine("Biber", "zh")).toBe("Biber 已暂停（由你停止）。用 @ 提及它，或输入「resume」");
    expect(heldMemberLine("Biber")).toBe("Biber is held (stopped by you) — @mention it or say resume");
    expect(finishedWithoutSummaryLine("Biber", true, "zh")).toBe("Biber 结束了，但没有总结；正在请它给出简短结果");
    expect(roomTurnTimeoutMessage("Biber", 1, "zh")).toBe("Biber 在群组聊天中的回合 1 分钟没有进展，已停止");
    expect(roomTurnTimeoutMessage("Biber", 20, "zh")).toBe("Biber 在群组聊天中的回合 20 分钟没有进展，已停止");
    expect(roomResetNote("Biber", { reason: "threshold", percent: 92 }, "zh"))
      .toBe("Biber 的上下文已用 92%：已压缩为包含群组聊天最近消息的新会话");
  });

  it("are recognized in every language when read back", () => {
    expect(isHeldMemberLine(heldMemberLine("Biber", "zh"))).toBe(true);
    expect(isHeldMemberLine(heldMemberLine("Ada Lovelace", "zh-cn"))).toBe(true);
    expect(isHeldMemberLine("Biber is busy in another conversation — skipped this round")).toBe(false);
    expect(isServerLine("server.rooms.postedIn", "已发布到 Standup")).toBe(true);
    expect(isServerLine("server.rooms.postedIn", "Posted in Standup")).toBe(true);
    expect(isServerLine("server.rooms.postedIn", "Posted Standup")).toBe(false);
  });
});

describe("the sentinel reading a Chinese room", () => {
  const config: DetectorConfig = { queueWaitMs: 300_000, costUsd: 5, retryLoopMin: 3, now: 10_000_000 };
  // As sentinel/sources.ts reads a status row: a harness notice with the bots' names taken out.
  const notice = (id: string, text: string): SentinelRecord => ({ type: "tool", id, threadId: "room", at: 1, ok: false, tool: HARNESS_NOTICE, text });

  it("counts a stopped room turn as a timeout, and a held member as no failure", () => {
    const stopped = notice("m1", roomTurnTimeoutMessage("<bot>", 5, "zh"));
    expect(turnStop.detect([stopped], config).map((one) => one.kind)).toEqual(["turn_timeout"]);
    expect(toolError.detect([stopped], config)).toEqual([]);
    expect(toolError.detect([notice("m2", heldMemberLine("<bot>", "zh"))], config)).toEqual([]);
    expect(toolError.detect([notice("m3", "一个工具崩溃了")], config)).toHaveLength(1);
  });
});
