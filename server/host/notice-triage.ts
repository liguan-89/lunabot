// The consumer half of notice learning, Mika's `proactive/NoticeTriage.kt` and the
// small part of `TriageRunner.kt` that schedules it. One batch is one app's
// unjudged notifications; the judge is a plain text call (`deps.verify`'s
// general model — Mika uses a ChatModel, never the decision model).
//
// Divergences, deliberate:
// - `unlocked` is always true. The server cannot see the phone's lock screen;
//   a surface lands in a chat thread that waits for the person anyway, and the
//   daily call cap is what bounds spend while nobody looks.
// - No unreachable-latch or consent pinning: a failed batch marks its keys
//   failed and cools down by consecutive failures, and the judge being absent
//   means no triage at all (the intent gate's "no wiring, no gate" shape).
// - Untrusted notice text is framed our way (defuse + a records block), not
//   Mika's `<untrusted>` tags.
import { clean, defuse } from "../records-block.ts";
import {
  cooldownMs, failureHoldMs, NOTICE_TUNING, planTriage, triageMarkFor,
  type NoticeRecord, type NoticeSnapshot, type TriageCandidate, type TriageMark, type TriageVerdict,
} from "../phone-notices.ts";

const MAX_BATCH = 8;
const TITLE_MAX = 120;
const TEXT_MAX = 300;
const LINES_MAX = 5;
const LINE_MAX = 200;
const REASON_MAX = 120;
const REPLY_MAX_CHARS = 8_000;
/** A provisional per-owner daily cap on triage requests; Mika spends from a token ledger we do not have. */
const TRIAGE_CALLS_PER_DAY = 30;

const idOf = (index: number): string => `n${index + 1}`;

/** What the model reads for one batch: which app, then each notice's texts as defused data. */
export function triageBatchInput(
  packageName: string,
  items: readonly { record: NoticeRecord; history: readonly { title: string; text: string; atMs: number }[] }[],
  language: string,
): string {
  const lines = [`Language for reasons: ${language}`, `App package: ${packageName}`, "Notifications (oldest first):"];
  items.forEach(({ record, history }, i) => {
    lines.push("", `[${idOf(i)}]`);
    if (record.group === true) lines.push("chat: group");
    else if (record.group === false) lines.push("chat: private");
    const title = clean(record.title, TITLE_MAX);
    const sender = record.sender?.trim();
    const text = clean(sender ? `${sender}: ${record.text}` : record.text, TEXT_MAX);
    if (title) lines.push(`title: ${defuse(title)}`);
    if (text) lines.push(`text: ${defuse(text)}`);
    const earlier = history.slice(0, -1).slice(-LINES_MAX)
      .map((line) => clean([line.title, line.text].filter(Boolean).join(": "), LINE_MAX))
      .filter((line) => line.length > 0);
    if (earlier.length > 0) lines.push(`earlier: ${defuse(earlier.map((line) => `- ${line}`).join("\n"))}`);
    const messages = (record.messages ?? []).slice(-LINES_MAX)
      .map((message) => clean([message.sender, message.text].filter(Boolean).join(": "), LINE_MAX))
      .filter((line) => line.length > 0);
    if (messages.length > 0) lines.push(`messages: ${defuse(messages.map((line) => `- ${line}`).join("\n"))}`);
  });
  return lines.join("\n");
}

/** The last balanced JSON value a reply ends with, or null — quoted notice text earlier in the reply never counts. */
function endingJson(raw: string): unknown | null {
  const text = raw.trim().replace(/^```(?:json)?|```$/g, "").trim();
  if (text.length === 0 || text.length > REPLY_MAX_CHARS) return null;
  const close = text[text.length - 1];
  if (close !== "}" && close !== "]") return null;
  const open = close === "}" ? "{" : "[";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === close) depth += 1;
    else if (ch === open) {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(text.slice(i)); } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * Mika's parse, exactly: the reply must end with `{"items":[…]}` or a bare array; unknown ids are dropped, a repeated
 * id keeps its first verdict, an unreadable or missing verdict is `ignore` with a `no-verdict` note, and a reply that
 * is not JSON at all fails the whole batch.
 */
export function parseTriageReply(raw: string, ids: readonly string[]): Map<string, TriageVerdict> | null {
  const end = endingJson(raw);
  if (end === null || typeof end !== "object") return null;
  const items = Array.isArray(end) ? end : (end as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  if (items.length > 0 && !items.some((one) => one !== null && typeof one === "object" && !Array.isArray(one))) return null;
  const out = new Map<string, TriageVerdict>();
  for (const one of items) {
    if (one === null || typeof one !== "object" || Array.isArray(one)) continue;
    const { id, decision, reason } = one as { id?: unknown; decision?: unknown; reason?: unknown };
    if (typeof id !== "string" || !ids.includes(id) || out.has(id)) continue;
    const verdict = typeof decision === "string" && ["ignore", "remember", "surface"].includes(decision.trim().toLowerCase())
      ? decision.trim().toLowerCase() as TriageVerdict["decision"]
      : null;
    out.set(id, verdict === null
      ? { decision: "ignore", note: "no-verdict" }
      : { decision: verdict, reason: clean(typeof reason === "string" ? reason : "", REASON_MAX) });
  }
  return new Map(ids.map((id) => [id, out.get(id) ?? { decision: "ignore", note: "no-verdict" as const }]));
}

export interface NoticeSurfacedItem {
  record: NoticeRecord;
  verdict: TriageVerdict;
}

export interface NoticeTriageDeps {
  /** The owner's inbox, read fresh per evaluation. */
  snapshot(): NoticeSnapshot;
  /** A plain text call on a general model; null wires no triage at all. */
  judge(): ((prompt: string) => Promise<string>) | null;
  /** A task is running on the owner's phones. */
  busy(): boolean;
  /** Reasons are written in this language's English name. */
  language(): string;
  /** The batch the judge said was worth interrupting for. */
  surface(packageName: string, items: NoticeSurfacedItem[]): void;
  now(): number;
  /** setTimeout/clearTimeout, injectable for tests. */
  wait(ms: number, run: () => void): unknown;
  unwait(handle: unknown): void;
  /** Per-app surface allowance for the day; the conservative default otherwise. */
  surfaceCap?(): number;
}

/**
 * One owner's triage schedule: poked when the inbox changes and when a timer it set fires. Never polls; at most one
 * judge call in flight; a failed batch cools down per its key and the whole runner backs off by consecutive failures.
 */
export function createNoticeTriage(deps: NoticeTriageDeps) {
  const marks = new Map<string, TriageMark>();
  const coolingUntilMs = new Map<string, number>();
  const firstAtMs = new Map<string, number>();
  const verdictCounts = new Map<string, number>();
  const surfacedToday = new Map<string, number>();
  let failures = 0;
  let callsToday = 0;
  let day = new Date(deps.now()).toDateString();
  let inFlight = false;
  let timer: unknown = null;

  const rollDay = (now: number) => {
    const today = new Date(now).toDateString();
    if (today === day) return;
    day = today;
    callsToday = 0;
    surfacedToday.clear();
    verdictCounts.clear();
  };

  const recordCandidates = (): TriageCandidate[] =>
    deps.snapshot().records.map(({ key, packageName, postedAtMs }) => ({ key, packageName, postedAtMs }));

  const evaluate = () => {
    const now = deps.now();
    rollDay(now);
    if (timer !== null) { deps.unwait(timer); timer = null; }
    if (deps.judge() === null) return;
    // An app's gathering window starts when it first had something unjudged; an
    // app with nothing pending loses its clock. Keys the inbox evicted lose
    // their marks — a repost of the same key is deduped upstream anyway.
    const records = deps.snapshot().records;
    const live = new Set(records.map((record) => record.key));
    for (const key of marks.keys()) if (!live.has(key)) { marks.delete(key); verdictCounts.delete(key); }
    for (const key of coolingUntilMs.keys()) if (!live.has(key)) coolingUntilMs.delete(key);
    const pending = new Set<string>();
    for (const record of records) {
      if (triageMarkFor(record, marks) !== null) continue;
      if ((coolingUntilMs.get(record.key) ?? 0) > now) continue;
      pending.add(record.packageName);
    }
    for (const key of firstAtMs.keys()) if (!pending.has(key)) firstAtMs.delete(key);
    for (const packageName of pending) if (!firstAtMs.has(packageName)) firstAtMs.set(packageName, now);
    const plan = planTriage({
      records: recordCandidates(), marks, firstAtMs, coolingUntilMs,
      unlocked: true, busy: deps.busy(), budgetLeft: callsToday < TRIAGE_CALLS_PER_DAY,
      nowMs: now, inFlight,
    });
    if (plan.kind === "wait-until") {
      timer = deps.wait(Math.max(0, plan.atMs - now), evaluate);
      return;
    }
    // A finished job does not poke the runner; look again shortly rather than
    // stall until the next notification lands.
    if (plan.kind === "idle" && plan.why === "busy") {
      timer = deps.wait(NOTICE_TUNING.BUSY_RECHECK_MS, evaluate);
      return;
    }
    if (plan.kind !== "send") return;
    void send(plan.packageName);
  };

  const send = async (packageName: string) => {
    const judge = deps.judge();
    if (judge === null || inFlight) return;
    const now = deps.now();
    const { records, history } = deps.snapshot();
    const batch = records
      .filter((record) => record.packageName === packageName && triageMarkFor(record, marks) === null)
      .filter((record) => (coolingUntilMs.get(record.key) ?? 0) <= now)
      .slice(0, MAX_BATCH);
    if (batch.length === 0) return;
    inFlight = true;
    callsToday += 1;
    try {
      const items = batch.map((record) => ({ record, history: history.get(record.key) ?? [] }));
      const reply = await judge(triageBatchInput(packageName, items, deps.language()));
      const parsed = reply === null ? null : parseTriageReply(reply, batch.map((_, i) => idOf(i)));
      // No final JSON at all is a failed batch, not a quiet all-ignore.
      if (parsed === null) throw new Error("notice triage: reply carried no verdicts");
      const at = deps.now();
      failures = 0;
      const cap = deps.surfaceCap?.() ?? 10;
      // The inbox as it stands after the request, so a notification the app
      // updated while the judge was reading is recognized as updated (Mika's
      // TriagePlanner.finish, upstream 2026-11-20).
      const postedAfter = new Map(deps.snapshot().records.map((record) => [record.key, record.postedAtMs]));
      const surfaced: NoticeSurfacedItem[] = [];
      batch.forEach((record, i) => {
        const id = idOf(i);
        const verdict = parsed.get(id)!;
        let final = verdict;
        if (verdict.decision === "surface" && (surfacedToday.get(packageName) ?? 0) + surfaced.length >= cap) {
          final = { decision: "ignore", note: "surface-capped" };
        }
        marks.set(record.key, { kind: "done", postedAtMs: record.postedAtMs, verdict: final });
        const count = (verdictCounts.get(record.key) ?? 0) + 1;
        verdictCounts.set(record.key, count);
        // The mark keeps the post time the judge actually read, so updated
        // content is unjudged again. Cooling that new content at the fixed
        // surface hold would leave a chatty conversation re-judged only once
        // every 30 minutes, so an updated surface verdict cools at the
        // escalating ignore pace instead. An evicted key is left alone: the
        // user handled it, and `evaluate` forgets the mark and its count.
        const updated = postedAfter.get(record.key) !== undefined && postedAfter.get(record.key) !== record.postedAtMs;
        const hold = updated && final.decision === "surface" ? cooldownMs("ignore", count) : cooldownMs(final.decision, count);
        coolingUntilMs.set(record.key, at + hold);
        if (final.decision === "surface") surfaced.push({ record, verdict: final });
      });
      if (surfaced.length > 0) {
        surfacedToday.set(packageName, (surfacedToday.get(packageName) ?? 0) + surfaced.length);
        deps.surface(packageName, surfaced);
      }
    } catch {
      failures += 1;
      const until = deps.now() + failureHoldMs(failures);
      for (const record of batch) {
        marks.set(record.key, { kind: "failed", postedAtMs: record.postedAtMs });
        coolingUntilMs.set(record.key, until);
      }
    } finally {
      inFlight = false;
    }
    evaluate();
  };

  return {
    /** The inbox changed or a timer fired: look at the plan again. */
    poke: evaluate,
    /** The judgement a key carries at its current post time, for status surfaces and tests. */
    marks: (): ReadonlyMap<string, TriageMark> => marks,
    /** The server is going away: drop the pending timer (an in-flight call lands in a dead process anyway). */
    stop: () => { if (timer !== null) { deps.unwait(timer); timer = null; } },
  };
}

export type NoticeTriage = ReturnType<typeof createNoticeTriage>;
