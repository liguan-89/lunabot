import { describe, expect, it } from "vitest";

import {
  DROPPED_NOTICE_CATEGORIES,
  LEARN_LEVELS,
  NOTICE_TUNING,
  NoticeInbox,
  SELF_PACKAGE_PREFIXES,
  cleanNoticeText,
  cooldownMs,
  createNoticeDedup,
  decideTriage,
  failureHoldMs,
  isSelfPackage,
  learnLevelOf,
  learnableTopic,
  localEpochDay,
  noticeSaid,
  planTriage,
  sanitizeNotice,
  shouldLearn,
  shouldLearnPackage,
  triageMarkFor,
  trustedNoticeTime,
  type NoticeMessage,
  type NoticePolicy,
  type NoticeRecord,
  type PendingApp,
  type TriageCandidate,
  type TriageMark,
} from "./phone-notices.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const MINUTE = 60_000;

const UTC = "UTC";

const record = (key: string, overrides: Partial<NoticeRecord> = {}): NoticeRecord => ({
  key,
  packageName: "com.chat",
  postedAtMs: 1,
  title: "t",
  text: `text ${key}`,
  ...overrides,
});

const policy = (overrides: Partial<NoticePolicy> = {}): NoticePolicy => ({
  allow: new Set(["com.chat"]),
  ...overrides,
});

// ---- Inbox ----

describe("NoticeInbox: bounded store", () => {
  it("keeps the newest records and drops the oldest first", () => {
    const inbox = new NoticeInbox({ capacity: 3, clock: () => 0, zone: () => UTC });
    for (const key of ["k1", "k2", "k3", "k4", "k5"]) inbox.add(record(key));
    expect(inbox.snapshot().records.map((entry) => entry.key)).toEqual(["k3", "k4", "k5"]);
    expect(NOTICE_TUNING.INBOX_CAPACITY).toBe(200);
  });

  it("replaces an update to the same key and moves it to newest", () => {
    const inbox = new NoticeInbox({ clock: () => 0, zone: () => UTC });
    inbox.add(record("a", { text: "old" }));
    inbox.add(record("b"));
    inbox.add(record("a", { text: "new" }));
    const snapshot = inbox.snapshot();
    expect(snapshot.records.map((entry) => entry.key)).toEqual(["b", "a"]);
    expect(snapshot.records.at(-1)?.text).toBe("new");
  });

  it("accumulates the texts of a message-less notification, oldest first", () => {
    const inbox = new NoticeInbox({ clock: () => 0, zone: () => UTC });
    inbox.add(record("w", { text: "one", postedAtMs: 1 }));
    inbox.add(record("o", { text: "other", postedAtMs: 2 }));
    inbox.add(record("w", { text: "two", postedAtMs: 3 }));
    const snapshot = inbox.snapshot();
    expect(snapshot.records.map((entry) => entry.key)).toEqual(["o", "w"]);
    expect(snapshot.history.get("w")).toEqual([
      { title: "t", text: "one", atMs: 1 },
      { title: "t", text: "two", atMs: 3 },
    ]);
    expect(snapshot.history.get("o")?.map((line) => line.text)).toEqual(["other"]);
  });

  it("caps the per-key history and skips a line identical to the previous one", () => {
    const inbox = new NoticeInbox({ clock: () => 0, zone: () => UTC, historyLimit: 3 });
    for (let index = 1; index <= 5; index += 1) inbox.add(record("w", { text: `m${index}`, postedAtMs: index }));
    expect(inbox.snapshot().history.get("w")?.map((line) => line.text)).toEqual(["m3", "m4", "m5"]);
    expect(NOTICE_TUNING.INBOX_HISTORY).toBe(10);

    const repeat = new NoticeInbox({ clock: () => 0, zone: () => UTC });
    repeat.add(record("w", { text: "same", postedAtMs: 1 }));
    repeat.add(record("o", { text: "x", postedAtMs: 2 }));
    repeat.add(record("w", { text: "same", postedAtMs: 3 }));
    expect(repeat.snapshot().history.get("w")).toEqual([{ title: "t", text: "same", atMs: 1 }]);
    expect(repeat.snapshot().records.map((entry) => entry.key)).toEqual(["o", "w"]);
    // A changed title is a different line even with the same body.
    repeat.add(record("w", { title: "t2", text: "same", postedAtMs: 4 }));
    expect(repeat.snapshot().history.get("w")).toHaveLength(2);
  });

  it("counts a changed speaker in the body as a different line", () => {
    const inbox = new NoticeInbox({ clock: () => 0, zone: () => UTC });
    inbox.add(record("g", { text: "hi", sender: "Alice", postedAtMs: 1 }));
    inbox.add(record("g", { text: "hi", sender: "Bob", postedAtMs: 2 }));
    expect(inbox.snapshot().history.get("g")?.map((line) => line.text)).toEqual(["Alice: hi", "Bob: hi"]);
    expect(noticeSaid({ text: "hi", sender: "  " })).toBe("hi");
  });

  it("keeps no history for a notification that carries its own messages", () => {
    const inbox = new NoticeInbox({ clock: () => 0, zone: () => UTC });
    const chat = record("c", { messages: [{ sender: "a", text: "hi", atMs: 1 }], conversation: true });
    inbox.add(chat);
    inbox.add({ ...chat, postedAtMs: 2, messages: [...(chat.messages ?? []), { sender: "a", text: "yo", atMs: 2 }] });
    expect(inbox.snapshot().history.has("c")).toBe(false);
    // A plain sighting first, then the same key with messages: the earlier history goes too.
    inbox.add(record("d", { text: "plain", postedAtMs: 3 }));
    inbox.add(record("d", { postedAtMs: 4, messages: [{ sender: null, text: "x", atMs: 4 }] }));
    expect(inbox.snapshot().history.has("d")).toBe(false);
  });

  it("drops history with its record, by key, by package and on clear", () => {
    const inbox = new NoticeInbox({ capacity: 2, clock: () => 0, zone: () => UTC });
    inbox.add(record("a", { packageName: "p1", text: "a1", postedAtMs: 1 }));
    inbox.add(record("a", { packageName: "p1", text: "a2", postedAtMs: 2 }));
    inbox.add(record("b", { packageName: "p2", text: "b1", postedAtMs: 3 }));
    inbox.remove("a");
    expect(inbox.snapshot().history.has("a")).toBe(false);
    inbox.add(record("a", { packageName: "p1", text: "again", postedAtMs: 4 }));
    expect(inbox.snapshot().history.get("a")?.map((line) => line.text)).toEqual(["again"]);
    // Eviction drops the orphaned history of the record it pushed out.
    inbox.add(record("c", { packageName: "p2", text: "c1", postedAtMs: 5 }));
    expect([...inbox.snapshot().history.keys()].sort()).toEqual(["a", "c"]);
    inbox.removePackages((packageName) => packageName !== "p1");
    expect([...inbox.snapshot().history.keys()]).toEqual(["c"]);
    inbox.clear();
    expect(inbox.snapshot().history.size).toBe(0);
    expect(inbox.snapshot().records).toEqual([]);
  });

  it("reconciles with the shade and reports how many records went", () => {
    const inbox = new NoticeInbox({ clock: () => 0, zone: () => UTC });
    inbox.add(record("a", { postedAtMs: 1 }));
    inbox.add(record("b", { postedAtMs: 2 }));
    inbox.add(record("c", { postedAtMs: 3 }));
    expect(inbox.retainKeys(new Set(["a", "b", "c", "someone-else"]))).toBe(0);
    expect(inbox.retainKeys(new Set(["b", "someone-else"]))).toBe(2);
    expect(inbox.snapshot().records.map((entry) => entry.key)).toEqual(["b"]);
    expect(inbox.snapshot().history.has("a")).toBe(false);
    expect(inbox.retainKeys(new Set())).toBe(1);
    expect(inbox.snapshot().records).toEqual([]);
  });

  it("counts received and kept, resetting both on a new local day but not the records", () => {
    let now = Date.UTC(2026, 0, 1, 23, 0, 0);
    const inbox = new NoticeInbox({ clock: () => now, zone: () => UTC });
    inbox.noteReceived();
    inbox.noteReceived();
    inbox.add(record("a"));
    expect(inbox.snapshot().received).toBe(2);
    expect(inbox.snapshot().kept).toBe(1);
    now += 2 * HOUR;
    const afterMidnight = inbox.snapshot();
    expect(afterMidnight.received).toBe(0);
    expect(afterMidnight.kept).toBe(0);
    expect(afterMidnight.records).toHaveLength(1);
    expect(afterMidnight.day).toBe(localEpochDay(now, UTC));
    inbox.noteReceived();
    expect(inbox.snapshot().received).toBe(1);
    expect(inbox.snapshot().kept).toBe(0);
  });
});

describe("localEpochDay", () => {
  it("counts local days, not UTC days", () => {
    // 2026-01-01 23:30 in UTC is already 2026-01-02 08:30 in Tokyo.
    const at = Date.UTC(2026, 0, 1, 23, 30);
    expect(localEpochDay(at, "UTC")).toBe(Math.floor(Date.UTC(2026, 0, 1) / DAY));
    expect(localEpochDay(at, "Asia/Tokyo")).toBe(Math.floor(Date.UTC(2026, 0, 2) / DAY));
  });

  it("reads an unknown zone as UTC", () => {
    const at = Date.UTC(2026, 0, 1, 12);
    expect(localEpochDay(at, "Not/AZone")).toBe(localEpochDay(at, "UTC"));
  });
});

// ---- Filters ----

describe("shouldLearn: the package gate", () => {
  it("drops a package the person never ticked before anything else", () => {
    expect(shouldLearnPackage("com.other", policy())).toBe("not-whitelisted");
    // Content that would be dropped for other reasons does not change the package answer.
    expect(shouldLearnPackage("com.other", policy({ blocked: new Set(["com.other"]) }))).toBe("not-whitelisted");
  });

  it("drops this app's own notifications under any install suffix", () => {
    expect(shouldLearnPackage("com.lunabot.companion", policy({ allow: new Set(["com.lunabot.companion"]) }))).toBe("self-package");
    expect(shouldLearnPackage("com.lunabot.companion.preview", policy({ allow: new Set(["com.lunabot.companion.preview"]) }))).toBe("self-package");
    // A phone that has not taken the new install id yet is still this app.
    expect(shouldLearnPackage("com.dexbot.companion", policy({ allow: new Set(["com.dexbot.companion"]) }))).toBe("self-package");
    expect(shouldLearnPackage("com.dexbot.companion.preview", policy({ allow: new Set(["com.dexbot.companion.preview"]) }))).toBe("self-package");
    expect(isSelfPackage("com.lunabot.companion.dev.test")).toBe(true);
    expect(isSelfPackage("com.example.companion")).toBe(false);
    expect(SELF_PACKAGE_PREFIXES).toContain("com.lunabot.companion");
    // Self wins over blocked, as in Mika.
    expect(shouldLearnPackage("com.lunabot.companion", policy({ allow: new Set(["com.lunabot.companion"]), blocked: new Set(["com.lunabot.companion"]) }))).toBe("self-package");
  });

  it("drops a package switched off under app access", () => {
    expect(shouldLearnPackage("com.chat", policy({ blocked: new Set(["com.chat"]) }))).toBe("app-blocked");
    expect(shouldLearnPackage("com.chat", policy({ blocked: new Set(["com.other"]) }))).toBe("keep");
  });
});

describe("shouldLearn: the record gate", () => {
  const learn = (overrides: Partial<NoticeRecord> = {}, overridesPolicy: Partial<NoticePolicy> = {}) =>
    shouldLearn(record("k", overrides), policy(overridesPolicy));

  it("refuses to answer without the listener grant", () => {
    expect(learn({}, { listenerGranted: false })).toBe("no-access");
    expect(learn({}, { listenerGranted: true })).toBe("keep");
    // The grant is checked before the whitelist: nothing can be read without it.
    expect(shouldLearn(record("k", { packageName: "com.other" }), policy({ listenerGranted: false }))).toBe("no-access");
  });

  it("keeps a plain notification and reports the package decisions", () => {
    expect(learn()).toBe("keep");
    expect(shouldLearn(record("k", { packageName: "com.other" }), policy())).toBe("not-whitelisted");
    expect(shouldLearn(record("k", { packageName: "com.dexbot.companion" }), policy({ allow: new Set(["com.dexbot.companion"]) }))).toBe("self-package");
    expect(learn({}, { blocked: new Set(["com.chat"]) })).toBe("app-blocked");
  });

  it("drops each notification shape", () => {
    expect(learn({ ongoing: true })).toBe("ongoing");
    expect(learn({ groupSummary: true })).toBe("group-summary");
    expect(learn({ foregroundService: true })).toBe("foreground-service");
    expect(learn({ clearable: false })).toBe("not-clearable");
    for (const category of DROPPED_NOTICE_CATEGORIES) expect(learn({ category })).toBe("category");
    expect(learn({ category: "msg" })).toBe("keep");
    expect(learn({ title: "", text: "" })).toBe("blank");
    // Only control characters clean to nothing.
    expect(learn({ title: "\u0000\u0007", text: "\u0001" })).toBe("blank");
    expect(learn({ title: "", text: " " })).toBe("blank");
  });

  it("drops authentication secrets before any other shape", () => {
    expect(learn({ title: "验证码 482913", ongoing: true })).toBe("authentication-secret");
    expect(learn({ text: "11010519491231002X" })).toBe("authentication-secret");
    expect(learn({ text: "card 4111 1111 1111 1111" })).toBe("authentication-secret");
    expect(learn({ text: "Your code is 482913" })).toBe("authentication-secret");
    expect(learn({ text: "482913 是你的登录码" })).toBe("authentication-secret");
    // A zip code, an error code and an ordinary sentence are not credentials.
    expect(learn({ text: "Your zip code is 10001" })).toBe("keep");
    expect(learn({ text: "error code: 500" })).toBe("keep");
    expect(learn({ text: "记得明天买牛奶" })).toBe("keep");
  });

  it("checks message text too", () => {
    expect(learn({ messages: [{ sender: "a", text: "验证码 123456", atMs: 1 }], conversation: true })).toBe("authentication-secret");
  });
});

describe("cleanNoticeText and sanitizeNotice", () => {
  it("strips controls and bidi marks, collapses whitespace and trims", () => {
    expect(cleanNoticeText("  a\u0000b  c\u202Ed  ", 100)).toBe("a b cd");
    // A zero-width space is one of the space characters, so it collapses to a space rather than vanishing.
    expect(cleanNoticeText("a\u200Bb", 100)).toBe("a b");
    expect(cleanNoticeText("\u2060x\u00ADy", 100)).toBe("xy");
    // A zero-width joiner is kept: emoji need it.
    expect(cleanNoticeText("a\u200Db", 100)).toBe("a\u200Db");
  });

  it("caps without splitting a surrogate pair", () => {
    expect(cleanNoticeText("abc", 2)).toBe("ab");
    expect(cleanNoticeText("ab😀", 3)).toBe("ab");
    expect(cleanNoticeText("ab😀", 4)).toBe("ab😀");
  });

  it("cleans every field and keeps the newest messages that still have text", () => {
    const messages: NoticeMessage[] = Array.from({ length: 25 }, (_, index) => ({
      sender: index === 0 ? "  " : "Alice",
      text: index === 1 ? "\u0000" : `m${index}`,
      atMs: index,
    }));
    const clean = sanitizeNotice(record("c", { title: " t\n", text: "x\u0007", conversationTitle: " ", messages, conversation: true }));
    expect(clean.title).toBe("t");
    expect(clean.text).toBe("x");
    expect(clean.conversationTitle).toBeNull();
    expect(clean.messages).toHaveLength(NOTICE_TUNING.FILTER_MESSAGES_MAX);
    expect(clean.messages?.at(0)?.sender).toBe("Alice");
    expect(clean.messages?.at(-1)?.text).toBe("m24");
  });
});

// ---- Dedup ----

describe("createNoticeDedup", () => {
  const chat = (key: string, postedAtMs: number, ...messages: NoticeMessage[]): NoticeRecord =>
    record(key, { postedAtMs, messages, conversation: true });

  it("sees a plain notification once per post time", () => {
    const dedup = createNoticeDedup();
    expect(dedup.accept(record("k", { postedAtMs: 1 }))).toBe(true);
    expect(dedup.accept(record("k", { postedAtMs: 1 }))).toBe(false);
    expect(dedup.accept(record("k", { postedAtMs: 2 }))).toBe(true);
    expect(dedup.accept(record("other", { postedAtMs: 2 }))).toBe(true);
    expect(dedup.size()).toBe(2);
    dedup.clear();
    expect(dedup.size()).toBe(0);
  });

  it("counts a reposted conversation only when it carries a message not seen before", () => {
    const dedup = createNoticeDedup();
    expect(dedup.accept(chat("chat", 10, { sender: "a", text: "m5", atMs: 5 }, { sender: "a", text: "m8", atMs: 8 }))).toBe(true);
    // Reposted with a new post time but the same messages.
    expect(dedup.accept(chat("chat", 11, { sender: "a", text: "m5", atMs: 5 }, { sender: "a", text: "m8", atMs: 8 }))).toBe(false);
    expect(dedup.accept(chat("chat", 12, { sender: "a", text: "m5", atMs: 5 }, { sender: "a", text: "m8", atMs: 8 }, { sender: "a", text: "m9", atMs: 9 }))).toBe(true);
    // The app pushed the oldest entry out of its list: still nothing new.
    expect(dedup.accept(chat("chat", 13, { sender: "a", text: "m8", atMs: 8 }, { sender: "a", text: "m9", atMs: 9 }))).toBe(false);
  });

  it("says which messages are new, and none for a plain notification", () => {
    const dedup = createNoticeDedup();
    const one = { sender: "a", text: "one", atMs: 10 };
    const two = { sender: "a", text: "two", atMs: 20 };
    const three = { sender: "a", text: "three", atMs: 0 };
    expect(dedup.admit(chat("chat", 100, one, two))?.newMessages.map((message) => message.text)).toEqual(["one", "two"]);
    expect(dedup.admit(chat("chat", 200, one, two, three))?.newMessages.map((message) => message.text)).toEqual(["three"]);
    expect(dedup.admit(chat("chat", 300, two, three))).toBeNull();
    expect(dedup.admit(record("plain", { postedAtMs: 1 }))?.newMessages).toEqual([]);
  });

  it("forgets the least recently used key beyond its capacity", () => {
    const dedup = createNoticeDedup({ capacity: 3 });
    for (const key of ["a", "b", "c"]) expect(dedup.accept(record(key, { postedAtMs: 1 }))).toBe(true);
    // Using a moves it to most recent.
    expect(dedup.accept(record("a", { postedAtMs: 1 }))).toBe(false);
    expect(dedup.accept(record("d", { postedAtMs: 1 }))).toBe(true);
    expect(dedup.size()).toBe(3);
    // b was the least recently used and is forgotten, so its old post time reads as new.
    expect(dedup.accept(record("b", { postedAtMs: 1 }))).toBe(true);
    expect(NOTICE_TUNING.DEDUP_CAPACITY).toBe(500);
  });

  it("ignores an untrusted message time and still reports later messages", () => {
    const dedup = createNoticeDedup();
    const future = { sender: "a", text: "first", atMs: 9_999_999 };
    expect(dedup.accept(chat("chat", 100, future))).toBe(true);
    expect(dedup.accept(chat("chat", 200, future, { sender: "a", text: "second", atMs: 150 }))).toBe(true);
    expect(dedup.accept(chat("chat", 300, future, { sender: "a", text: "second", atMs: 150 }))).toBe(false);
  });

  it("treats zero and same-millisecond times by content, not by clock", () => {
    const zero = createNoticeDedup();
    const one = { sender: "a", text: "one", atMs: 0 };
    const two = { sender: "a", text: "two", atMs: 0 };
    expect(zero.accept(chat("chat", 100, one))).toBe(true);
    expect(zero.accept(chat("chat", 110, one))).toBe(false);
    expect(zero.accept(chat("chat", 120, one, two))).toBe(true);
    expect(zero.accept(chat("chat", 130, one, two))).toBe(false);
  });

  it("keeps earlier fingerprints through a sighting that carried no messages", () => {
    const dedup = createNoticeDedup();
    const one = { sender: "a", text: "one", atMs: 0 };
    expect(dedup.accept(chat("chat", 100, one))).toBe(true);
    expect(dedup.accept(record("chat", { postedAtMs: 110, conversation: true }))).toBe(true);
    expect(dedup.accept(chat("chat", 120, one))).toBe(false);
    expect(dedup.accept(chat("chat", 130, one, { sender: "a", text: "two", atMs: 0 }))).toBe(true);
  });

  it("uses trusted times for the first sighting after a message-less record", () => {
    const dedup = createNoticeDedup();
    expect(dedup.accept(record("chat", { postedAtMs: 100 }))).toBe(true);
    // No fingerprints from before: a time of 0 cannot be newer than anything and counts as already seen.
    expect(dedup.accept(chat("chat", 200, { sender: "a", text: "old", atMs: 0 }))).toBe(false);
    expect(dedup.accept(chat("chat", 210, { sender: "a", text: "old", atMs: 0 }, { sender: "a", text: "new", atMs: 0 }))).toBe(true);
  });
});

describe("trustedNoticeTime", () => {
  it("trusts a positive time up to the allowed skew", () => {
    expect(trustedNoticeTime(0, 100_000)).toBe(false);
    expect(trustedNoticeTime(-5, 100_000)).toBe(false);
    expect(trustedNoticeTime(1, 100_000)).toBe(true);
    expect(trustedNoticeTime(100_000 + NOTICE_TUNING.CLOCK_SKEW_MS, 100_000)).toBe(true);
    expect(trustedNoticeTime(100_000 + NOTICE_TUNING.CLOCK_SKEW_MS + 1, 100_000)).toBe(false);
  });
});

// ---- Triage planning ----

const candidate = (key: string, packageName = "com.a", postedAtMs = 1_000): TriageCandidate => ({ key, packageName, postedAtMs });

const plan = (input: Partial<Parameters<typeof planTriage>[0]> & Pick<Parameters<typeof planTriage>[0], "nowMs">) =>
  planTriage({ records: [], marks: new Map(), unlocked: true, busy: false, budgetLeft: true, ...input });

const done = (postedAtMs: number): TriageMark => ({ kind: "done", postedAtMs, verdict: { decision: "remember" } });
const failed = (postedAtMs: number): TriageMark => ({ kind: "failed", postedAtMs });

describe("planTriage: idle reasons", () => {
  const t0 = 1_000_000;

  it("does nothing at all while locked", () => {
    expect(plan({ unlocked: false, nowMs: t0 })).toEqual({ kind: "idle", why: "locked" });
    // Locked wins over a full batch and over the budget.
    expect(plan({ unlocked: false, records: [candidate("k")], budgetLeft: false, nowMs: t0 })).toEqual({ kind: "idle", why: "locked" });
  });

  it("reports an open request only while unlocked", () => {
    expect(plan({ inFlight: true, records: [candidate("k", "com.a", 5)], nowMs: t0 })).toEqual({ kind: "idle", why: "in-flight" });
    expect(plan({ unlocked: false, inFlight: true, records: [candidate("k", "com.a", 5)], nowMs: t0 })).toEqual({ kind: "idle", why: "locked" });
    // InFlight wins over a full batch, a cooldown and the budget while unlocked; only Locked comes first.
    expect(plan({ inFlight: true, records: [candidate("k", "com.a", 5)], budgetLeft: false, nowMs: t0 })).toEqual({ kind: "idle", why: "in-flight" });
  });

  it("has nothing to do with no pending and no cooldown", () => {
    expect(plan({ nowMs: t0 })).toEqual({ kind: "idle", why: "nothing" });
    expect(plan({ records: [candidate("k")], marks: new Map([["k", done(1_000)]]), nowMs: t0 })).toEqual({ kind: "idle", why: "nothing" });
  });

  it("stops for the budget before a busy task, and for a busy task otherwise", () => {
    const records = [candidate("k")];
    expect(plan({ records, budgetLeft: false, nowMs: t0 })).toEqual({ kind: "idle", why: "budget-used-up" });
    expect(plan({ records, busy: true, nowMs: t0 })).toEqual({ kind: "idle", why: "busy" });
    expect(plan({ records, budgetLeft: false, busy: true, nowMs: t0 })).toEqual({ kind: "idle", why: "budget-used-up" });
    // "Nothing" is decided before the budget: with no record there is nothing cooling either.
    expect(plan({ budgetLeft: false, nowMs: t0 })).toEqual({ kind: "idle", why: "nothing" });
    // A cooling record and no budget is a budget stop, not a wait.
    expect(plan({
      records: [candidate("k", "com.a", 2_000)],
      marks: new Map([["k", done(1_000)]]),
      coolingUntilMs: new Map([["k", t0 + MINUTE]]),
      budgetLeft: false,
      nowMs: t0,
    })).toEqual({ kind: "idle", why: "budget-used-up" });
  });
});

describe("planTriage: sending a batch", () => {
  const t0 = 1_000_000;

  it("sends when an app has a full batch", () => {
    const records = Array.from({ length: 8 }, (_, index) => candidate(`k${index}`));
    expect(plan({ records, firstAtMs: new Map([["com.a", t0]]), nowMs: t0 })).toEqual({ kind: "send", packageName: "com.a" });
    expect(plan({ records: records.slice(0, 7), firstAtMs: new Map([["com.a", t0]]), nowMs: t0 })).toEqual({
      kind: "wait-until",
      atMs: t0 + NOTICE_TUNING.TRIAGE_WINDOW_MS,
    });
  });

  it("sends when the oldest waiting notification has waited the window", () => {
    const records = [candidate("k")];
    const firstAtMs = new Map([["com.a", t0 - 5_000]]);
    expect(plan({ records, firstAtMs, nowMs: t0 })).toEqual({ kind: "wait-until", atMs: t0 - 5_000 + NOTICE_TUNING.TRIAGE_WINDOW_MS });
    expect(plan({ records, firstAtMs, nowMs: t0 - 5_000 + NOTICE_TUNING.TRIAGE_WINDOW_MS })).toEqual({ kind: "send", packageName: "com.a" });
  });

  it("sends the app whose window ends first", () => {
    const records = [candidate("a1", "com.a"), candidate("b1", "com.b"), candidate("b2", "com.b")];
    const firstAtMs = new Map([["com.a", t0 - 30_000], ["com.b", t0 - 40_000]]);
    expect(plan({ records, firstAtMs, nowMs: t0 })).toEqual({ kind: "send", packageName: "com.b" });
  });

  it("stays in flight while a request is open, then sends what was left out of the batch", () => {
    const sent = candidate("k", "com.a", 5);
    const records = [sent, candidate("n", "com.a", 6)];
    expect(plan({ records, inFlight: true, firstAtMs: new Map([["com.a", t0]]), nowMs: t0 })).toEqual({ kind: "idle", why: "in-flight" });
    // Once the request ends, the sent notification is judged and the second one is pending; the app's window has run out.
    expect(plan({
      records,
      marks: new Map([["k", done(5)]]),
      firstAtMs: new Map([["com.a", t0 - NOTICE_TUNING.TRIAGE_WINDOW_MS]]),
      nowMs: t0,
    })).toEqual({ kind: "send", packageName: "com.a" });
  });
});

describe("planTriage: cooldowns and stale marks", () => {
  const t0 = 1_000_000;

  it("stops counting a mark once the post time changes", () => {
    const marks = new Map<string, TriageMark>([["k", done(5)]]);
    expect(triageMarkFor({ key: "k", postedAtMs: 5 }, marks)?.kind).toBe("done");
    expect(triageMarkFor({ key: "k", postedAtMs: 6 }, marks)).toBeNull();
    expect(triageMarkFor({ key: "missing", postedAtMs: 5 }, marks)).toBeNull();
    // The changed notification is pending again; with no recorded start its window begins now.
    expect(plan({ records: [candidate("k", "com.a", 6)], marks, nowMs: t0 })).toEqual({
      kind: "wait-until",
      atMs: t0 + NOTICE_TUNING.TRIAGE_WINDOW_MS,
    });
    expect(plan({
      records: [candidate("k", "com.a", 6)],
      marks,
      firstAtMs: new Map([["com.a", t0 - NOTICE_TUNING.TRIAGE_WINDOW_MS]]),
      nowMs: t0,
    })).toEqual({ kind: "send", packageName: "com.a" });
    expect(plan({ records: [candidate("k", "com.a", 6)], marks, coolingUntilMs: new Map([["k", t0 + MINUTE]]), nowMs: t0 })).toEqual({
      kind: "wait-until",
      atMs: t0 + MINUTE,
    });
  });

  it("waits for the cooldown when only a judged-then-changed notification is left", () => {
    const records = [candidate("k", "com.a", 6)];
    const marks = new Map([["k", done(5)]]);
    const coolingUntilMs = new Map([["k", t0 + 2 * MINUTE]]);
    expect(plan({ records, marks, coolingUntilMs, nowMs: t0 })).toEqual({ kind: "wait-until", atMs: t0 + 2 * MINUTE });
    // At the cooldown end it is pending, and its gathering window starts from that moment.
    expect(plan({ records, marks, coolingUntilMs, firstAtMs: new Map([["com.a", t0 + 2 * MINUTE]]), nowMs: t0 + 2 * MINUTE })).toEqual({
      kind: "wait-until",
      atMs: t0 + 2 * MINUTE + NOTICE_TUNING.TRIAGE_WINDOW_MS,
    });
  });

  it("wakes at the earlier of the gathering window and the cooldown", () => {
    const cooling = candidate("k", "com.a", 6);
    const records = [cooling, candidate("o", "com.b", 7)];
    const marks = new Map([["k", done(5)]]);
    const coolingUntilMs = new Map([["k", t0 + 2 * MINUTE]]);
    // The other app's window ends after the cooldown.
    expect(plan({
      records,
      marks,
      coolingUntilMs,
      firstAtMs: new Map([["com.b", t0 + 2 * MINUTE - 5_000]]),
      nowMs: t0 + 2 * MINUTE - 5_000,
    })).toEqual({ kind: "wait-until", atMs: t0 + 2 * MINUTE });
    // The other app's window ends before the cooldown.
    expect(plan({
      records,
      marks,
      coolingUntilMs,
      firstAtMs: new Map([["com.b", t0 + 1_000]]),
      nowMs: t0 + 1_000,
    })).toEqual({ kind: "wait-until", atMs: t0 + 1_000 + NOTICE_TUNING.TRIAGE_WINDOW_MS });
  });

  it("treats a failed mark as judged, not pending", () => {
    expect(plan({ records: [candidate("k")], marks: new Map([["k", failed(1_000)]]), nowMs: t0 })).toEqual({ kind: "idle", why: "nothing" });
    // With new content it is pending again, unless the failure hold still has it.
    const records = [candidate("k", "com.a", 2_000)];
    const marks = new Map([["k", failed(1_000)]]);
    expect(plan({ records, marks, nowMs: t0 })).toEqual({ kind: "wait-until", atMs: t0 + NOTICE_TUNING.TRIAGE_WINDOW_MS });
    expect(plan({
      records,
      marks,
      firstAtMs: new Map([["com.a", t0 - NOTICE_TUNING.TRIAGE_WINDOW_MS]]),
      nowMs: t0,
    })).toEqual({ kind: "send", packageName: "com.a" });
    expect(plan({ records, marks, coolingUntilMs: new Map([["k", t0 + 2 * MINUTE]]), nowMs: t0 })).toEqual({
      kind: "wait-until",
      atMs: t0 + 2 * MINUTE,
    });
  });

  it("honours a custom window and batch size", () => {
    const records = [candidate("k")];
    expect(plan({ records, firstAtMs: new Map([["com.a", t0]]), windowMs: 1_000, nowMs: t0 + 1_000 })).toEqual({ kind: "send", packageName: "com.a" });
    expect(plan({ records, firstAtMs: new Map([["com.a", t0]]), windowMs: 1_000, nowMs: t0 + 999 })).toEqual({ kind: "wait-until", atMs: t0 + 1_000 });
    expect(plan({ records, firstAtMs: new Map([["com.a", t0]]), batchMax: 2, nowMs: t0 })).toEqual({
      kind: "wait-until",
      atMs: t0 + NOTICE_TUNING.TRIAGE_WINDOW_MS,
    });
  });
});

describe("decideTriage: the pure decision", () => {
  const t0 = 1_000_000;
  const pending = (entries: Record<string, PendingApp>): ReadonlyMap<string, PendingApp> => new Map(Object.entries(entries));
  const decide = (input: Partial<Parameters<typeof decideTriage>[0]> & Pick<Parameters<typeof decideTriage>[0], "pending" | "nowMs">) =>
    decideTriage({ unlocked: true, busy: false, budgetLeft: true, ...input });

  it("returns each idle reason in Mika's order", () => {
    expect(decide({ unlocked: false, pending: pending({ a: { firstAtMs: 0, count: 8 } }), nowMs: t0 })).toEqual({ kind: "idle", why: "locked" });
    expect(decide({ busy: true, pending: pending({ a: { firstAtMs: 0, count: 8 } }), nowMs: t0 })).toEqual({ kind: "idle", why: "busy" });
    expect(decide({ budgetLeft: false, pending: pending({ a: { firstAtMs: 0, count: 8 } }), nowMs: t0 })).toEqual({ kind: "idle", why: "budget-used-up" });
    expect(decide({ pending: pending({}), nowMs: t0 })).toEqual({ kind: "idle", why: "nothing" });
    expect(decide({ inFlight: true, pending: pending({ a: { firstAtMs: 0, count: 8 } }), nowMs: t0 })).toEqual({ kind: "idle", why: "in-flight" });
    // Locked is reported before in-flight.
    expect(decide({ unlocked: false, inFlight: true, pending: pending({ a: { firstAtMs: 0, count: 8 } }), nowMs: t0 })).toEqual({ kind: "idle", why: "locked" });
  });

  it("waits for the window or sends when a batch is full, whichever app is oldest", () => {
    const young = pending({ a: { firstAtMs: t0 - 5_000, count: 3 }, b: { firstAtMs: t0 - 1_000, count: 1 } });
    expect(decide({ pending: young, nowMs: t0 })).toEqual({ kind: "wait-until", atMs: t0 - 5_000 + NOTICE_TUNING.TRIAGE_WINDOW_MS });
    expect(decide({ pending: pending({ a: { firstAtMs: t0 - 5_000, count: 3 }, b: { firstAtMs: t0 - 1_000, count: 8 } }), nowMs: t0 }))
      .toEqual({ kind: "send", packageName: "b" });
    expect(decide({ pending: pending({ a: { firstAtMs: t0 - 30_000, count: 1 }, b: { firstAtMs: t0 - 40_000, count: 1 } }), nowMs: t0 }))
      .toEqual({ kind: "send", packageName: "b" });
  });

  it("waits only on the cooldown when nothing is pending, and on the earlier of the two otherwise", () => {
    expect(decide({ pending: pending({}), coolingUntilMs: t0 + MINUTE, nowMs: t0 })).toEqual({ kind: "wait-until", atMs: t0 + MINUTE });
    expect(decide({ pending: pending({ a: { firstAtMs: t0, count: 1 } }), coolingUntilMs: t0 + MINUTE, nowMs: t0 })).toEqual({
      kind: "wait-until",
      atMs: t0 + NOTICE_TUNING.TRIAGE_WINDOW_MS,
    });
    // The cooldown ends before the window does: wake for the cooldown.
    expect(decide({ pending: pending({ a: { firstAtMs: t0, count: 1 } }), coolingUntilMs: t0 + 5_000, nowMs: t0 })).toEqual({
      kind: "wait-until",
      atMs: t0 + 5_000,
    });
  });

  it("does not send while locked even when a cooldown is over", () => {
    expect(decide({ unlocked: false, pending: pending({}), coolingUntilMs: t0 - 1, nowMs: t0 })).toEqual({ kind: "idle", why: "locked" });
  });
});

describe("cooldownMs and failureHoldMs", () => {
  it("escalates ignore and remember through 2, 5, 15, 30 minutes and repeats the last step", () => {
    expect(cooldownMs("ignore", 1)).toBe(2 * MINUTE);
    expect(cooldownMs("remember", 2)).toBe(5 * MINUTE);
    expect(cooldownMs("remember", 3)).toBe(15 * MINUTE);
    expect(cooldownMs("ignore", 4)).toBe(30 * MINUTE);
    expect(cooldownMs("ignore", 99)).toBe(30 * MINUTE);
  });

  it("keeps a surface at a flat 30 minutes", () => {
    expect(cooldownMs("surface", 1)).toBe(30 * MINUTE);
    expect(cooldownMs("surface", 7)).toBe(30 * MINUTE);
    expect(NOTICE_TUNING.SURFACE_COOLDOWN_MS).toBe(30 * MINUTE);
  });

  it("holds after a failure by consecutive count", () => {
    expect(failureHoldMs(0)).toBe(2 * MINUTE);
    expect(failureHoldMs(1)).toBe(2 * MINUTE);
    expect(failureHoldMs(2)).toBe(5 * MINUTE);
    expect(failureHoldMs(3)).toBe(15 * MINUTE);
    expect(failureHoldMs(4)).toBe(30 * MINUTE);
    expect(failureHoldMs(99)).toBe(30 * MINUTE);
    expect(NOTICE_TUNING.FAILURE_HOLD_MS).toEqual([2 * MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE]);
  });
});

// ---- Learn level ----

describe("learn levels", () => {
  it("carries Mika's three sets of thresholds", () => {
    expect(LEARN_LEVELS.conservative).toEqual({ topicDays: 2, surfaceCap: 10, intoTasks: [] });
    expect(LEARN_LEVELS.balanced).toEqual({ topicDays: 2, surfaceCap: 20, intoTasks: ["high"] });
    expect(LEARN_LEVELS.aggressive).toEqual({ topicDays: 1, surfaceCap: 2_147_483_647, intoTasks: ["mid", "high"] });
    expect(NOTICE_TUNING.SURFACE_CAP_PER_APP).toBe(10);
  });

  it("answers established at the boundary day", () => {
    for (const level of ["conservative", "balanced"] as const) {
      expect(learnableTopic(level, { days: 1 })).toBe(false);
      expect(learnableTopic(level, { days: 2 })).toBe(true);
    }
    expect(learnableTopic("aggressive", { days: 0 })).toBe(false);
    expect(learnableTopic("aggressive", { days: 1 })).toBe(true);
    expect(learnableTopic({ topicDays: 3, surfaceCap: 5, intoTasks: [] }, { days: 2 })).toBe(false);
    expect(learnableTopic({ topicDays: 3, surfaceCap: 5, intoTasks: [] }, { days: 3 })).toBe(true);
  });

  it("reads a stored wire value, unknown as conservative", () => {
    expect(learnLevelOf("aggressive")).toBe("aggressive");
    expect(learnLevelOf("balanced")).toBe("balanced");
    expect(learnLevelOf("conservative")).toBe("conservative");
    expect(learnLevelOf("loud")).toBe("conservative");
    expect(learnLevelOf(null)).toBe("conservative");
  });
});
