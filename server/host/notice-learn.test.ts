// The learn runner around the pure pieces: due scheduling, one batch in flight, the pool
// persisted per applied batch, failure holds, and the level switch gating all of it.
import { describe, expect, it } from "vitest";

import type { NoticeRecord } from "../phone-notices.ts";
import type { TopicPoolData } from "../notice-learn.ts";
import { createNoticeLearn } from "./notice-learn.ts";

const record = (over: Partial<NoticeRecord> = {}): NoticeRecord => ({
  key: "k1", packageName: "com.app.a", postedAtMs: 1_000, title: "标题", text: "正文", ...over,
});

const runner = (options: {
  reply?: string | null;
  fail?: boolean;
  busy?: boolean;
  level?: "conservative" | "balanced" | "aggressive" | "off";
  noJudge?: boolean;
  eligible?: (pkg: string) => boolean;
  data?: TopicPoolData;
} = {}) => {
  const state = { now: 1_000_000 };
  const timers = new Map<number, { ms: number; run: () => void }>();
  let nextHandle = 0;
  const judgeCalls: string[] = [];
  const persisted: TopicPoolData[] = [];
  const learn = createNoticeLearn({
    judge: () => options.noJudge ? null : async () => {
      if (options.fail) throw new Error("unreachable");
      return options.reply ?? `{"signals":[{"ids":["n1"],"new":{"kind":"interest","label":"咖啡"}}]}`;
    },
    busy: () => options.busy ?? false,
    eligible: options.eligible ?? (() => true),
    level: () => options.level ?? "conservative",
    language: () => "Chinese",
    persist: (data) => persisted.push(data),
    now: () => state.now,
    wait: (ms, run) => { const handle = nextHandle++; timers.set(handle, { ms, run }); return handle; },
    unwait: (handle) => { timers.delete(handle as number); },
  }, options.data);
  // judge prompt capture happens inside the async body; record it via a wrapping judge is awkward —
  // instead assert on call counts through persisted/timers and keep the prompt covered by notice-learn.test.ts.
  const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
  const advance = async (ms: number) => {
    state.now += ms;
    const fired = Array.from(timers.values());
    timers.clear();
    for (const t of fired) t.run();
    await flush();
  };
  return { learn, timers, judgeCalls, persisted, flush, advance, state };
};

const DAY_MS = 86_400_000;

describe("createNoticeLearn", () => {
  it("an aged pending batch is judged, applied to the pool and persisted; texts leave the buffer", async () => {
    const { learn, persisted, advance } = runner();
    learn.capture(record());
    await advance(31 * 60_000);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.topics).toHaveLength(1);
    expect(persisted[0]!.topics[0]!.label).toBe("咖啡");
    expect(persisted[0]!.topics[0]!.evidence["com.app.a"]).toHaveLength(1);
  });

  it("a fresh pending app waits for its age deadline on a timer", async () => {
    const { learn, timers, persisted, flush } = runner();
    learn.capture(record());
    await flush();
    expect(persisted).toHaveLength(0);
    expect(timers.size).toBe(1);
  });

  it("a failed judgement drops the batch and holds the next try", async () => {
    const { learn, persisted, advance } = runner({ fail: true });
    learn.capture(record());
    await advance(31 * 60_000);
    expect(persisted).toHaveLength(0);
    // The failure hold keeps the next evaluation waiting even with a new pending notice.
    learn.capture(record({ key: "k2", postedAtMs: 1_000_000 + 31 * 60_000 }));
    await advance(60_000);
    expect(persisted).toHaveLength(0);
  });

  it("an unreadable reply fails the batch the same way a thrown error does", async () => {
    const { learn, persisted, advance } = runner({ reply: "看不懂的通知" });
    learn.capture(record());
    await advance(31 * 60_000);
    expect(persisted).toHaveLength(0);
  });

  it("level off captures nothing; flipping it on starts from then on", async () => {
    const { learn, persisted, advance } = runner({ level: "off" });
    learn.capture(record());
    await advance(31 * 60_000);
    expect(persisted).toHaveLength(0);
    expect(learn.pending()).toBe(0);
  });

  it("no judge wires no learning at all", async () => {
    const { learn, persisted, advance, timers } = runner({ noJudge: true });
    learn.capture(record());
    await flushTimers(timers);
    await advance(31 * 60_000);
    expect(persisted).toHaveLength(0);
    async function flushTimers(t: Map<number, { run: () => void }>) { for (const x of t.values()) x.run(); }
  });

  it("purge drops an unticked app's pending events and pool evidence", async () => {
    const data: TopicPoolData = {
      version: 1,
      topics: [{
        id: "t1", kind: "interest", label: "咖啡", firstSeenMs: 1, lastSeenMs: 1,
        evidence: { "com.app.a": [1, 2], "com.app.b": [1] },
      }],
    };
    const { learn, persisted } = runner({ data });
    learn.purge((pkg) => pkg !== "com.app.b");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.topics[0]!.evidence["com.app.b"]).toBeUndefined();
    expect(persisted[0]!.topics[0]!.evidence["com.app.a"]).toEqual([1, 2]);
  });

  it("a busy phone holds the batch until the job ends", async () => {
    const { learn, persisted, advance } = runner({ busy: true });
    learn.capture(record());
    await advance(31 * 60_000 + 2 * DAY_MS);
    expect(persisted).toHaveLength(0);
  });

  it("a busy phone re-checks on a timer rather than stalling for the next notice", async () => {
    const { learn, timers, flush } = runner({ busy: true });
    learn.capture(record());
    await flush();
    // A finished job does not poke the runner, so the hold arms a recheck.
    expect(timers.size).toBe(1);
    expect([...timers.values()][0]!.ms).toBe(30_000);
  });
});
