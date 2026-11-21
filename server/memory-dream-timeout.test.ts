import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { createMemoryUpkeep, DREAM_TIMEOUT_MS } from "./memory-upkeep.ts";
import { workspaceDir } from "./workspace.ts";

// fork 无 claude 驱动：桩引擎在 generateText 收到 timeoutMs 时落盘发令并挂起直到 abort，
// 等价验证「upkeep 把预算透传给引擎调用，dream 在 DREAM_TIMEOUT_MS 被收」。
it("a dream outlives the helper's default minute, but still stops at three minutes", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-dream-timeout-"));
  const dump = join(scratch, "helper.json");
  const bot = { id: "dream-timeout-test", name: "Scout", memoryUpkeep: true };
  let seenTimeout: number | undefined;
  const engine = {
    generateText: (_prompt: string, options?: { signal?: AbortSignal; timeoutMs?: number }) => {
      seenTimeout = options?.timeoutMs;
      writeFileSync(dump, "launched");
      return new Promise<string>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason));
      });
    },
    dispose: async () => {},
  };
  const loop = createMemoryUpkeep({
    bots: () => [bot], bot: () => bot, engine: () => engine, busy: () => false,
    addToAboutMe: () => 0, sourceLabel: () => "fixture", quietMs: () => 60_000, tidyHour: () => 3,
    conversations: () => [
      { threadId: "a", lines: [{ by: "person", text: "Keep drafts short." }] },
      { threadId: "b", lines: [{ by: "person", text: "Shorter again, please." }] },
    ],
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let settled = false;
  const dream = loop.dream(bot.id).then((report) => { settled = true; return report; });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(seenTimeout, "the upkeep passes its budget to the engine call").toBe(DREAM_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(settled, "a dream still has budget after the helper's default minute").toBe(false);
    await vi.advanceTimersByTimeAsync(118_000);
    expect(settled, "a dream retains its budget until three minutes").toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await dream).toMatchObject({ conversations: 2, note: "The dream did not answer in time." });
  } finally {
    await vi.advanceTimersByTimeAsync(180_000);
    await dream;
    vi.useRealTimers();
    loop.stop();
    rmSync(scratch, { recursive: true, force: true });
    rmSync(workspaceDir(bot.id), { recursive: true, force: true });
  }
});
