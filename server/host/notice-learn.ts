// The learn runner, Mika's LearnRunner slice that feeds NoticeLearn: a kept
// notice becomes a LearnEvent, an app is due at DUE_COUNT pending or once its
// oldest pending ages past DUE_AGE_MS, and one batch is in flight at a time.
// Event-driven like the triage runner — the inbox pokes it, timers cover the
// age threshold. A failed batch drops its events and holds by consecutive
// failures; there is no retry because the texts are the same either way.
//
// `level()` off means the pipeline does not run at all: nothing captures and
// an in-flight batch is aborted back to pending for when it turns on again.
import {
  createLearnBuffer, createTopicPool, buildLearnInput, parseLearnReply,
  type LearnBuffer, type TopicPool, type TopicPoolData, type ObservedTopic,
} from "../notice-learn.ts";
import { failureHoldMs, localEpochDay, NOTICE_TUNING, type LearnLevel, type NoticeMessage, type NoticeRecord } from "../phone-notices.ts";
import { hostTimeZone } from "../turn-clock.ts";

/** A provisional per-owner daily cap on learn requests; Mika spends from a token ledger we do not have. */
const LEARN_CALLS_PER_DAY = 20;

export interface NoticeLearnDeps {
  /** A plain text call on a general model — the same judge the triage takes. */
  judge(): ((prompt: string) => Promise<string>) | null;
  /** A task is running on the owner's phones. */
  busy(): boolean;
  /** The package is still in the owner's ticked notice-apps list. */
  eligible(packageName: string): boolean;
  /** The learn level; "off" is the pipeline not running. */
  level(): LearnLevel | "off";
  /** Labels are written in this language's English name. */
  language(): string;
  /** The timezone a notice's day is counted in — the reporting phone's. Absent, the server's own. */
  zone?(): string;
  /** The topic pool after every applied batch, for the caller's file. */
  persist(data: TopicPoolData): void;
  now(): number;
  wait(ms: number, run: () => void): unknown;
  unwait(handle: unknown): void;
}

export function createNoticeLearn(deps: NoticeLearnDeps, data?: TopicPoolData) {
  const buffer: LearnBuffer = createLearnBuffer();
  const pool: TopicPool = createTopicPool(data, undefined, deps.zone);
  const dayOf = (now: number) => localEpochDay(now, deps.zone?.() ?? hostTimeZone());
  let failures = 0;
  let callsToday = 0;
  let day = dayOf(deps.now());
  let inFlight = false;
  let holdUntilMs = 0;
  let timer: unknown = null;

  const rollDay = (now: number) => {
    const today = dayOf(now);
    if (today === day) return;
    day = today;
    callsToday = 0;
    failures = 0;
    holdUntilMs = 0;
  };

  const on = () => deps.level() !== "off";

  const evaluate = () => {
    const now = deps.now();
    rollDay(now);
    if (timer !== null) { deps.unwait(timer); timer = null; }
    if (!on() || deps.judge() === null) return;
    if (inFlight || deps.busy() || callsToday >= LEARN_CALLS_PER_DAY || now < holdUntilMs) {
      if (now < holdUntilMs) timer = deps.wait(holdUntilMs - now, evaluate);
      return;
    }
    const packageName = buffer.due(now, (pkg) => deps.eligible(pkg));
    if (packageName === null) {
      // Wait for the earliest pending app's age threshold — a new arrival pokes sooner anyway.
      const pending = buffer.events.filter((e) => e.state === "pending" && deps.eligible(e.packageName));
      if (pending.length > 0) {
        const atMs = Math.min(...pending.map((e) => e.postedAtMs)) + NOTICE_TUNING.DUE_AGE_MS;
        if (atMs > now) timer = deps.wait(atMs - now, evaluate);
      }
      return;
    }
    void send(packageName);
  };

  const send = async (packageName: string) => {
    const judge = deps.judge();
    if (judge === null || inFlight || !on()) return;
    const events = buffer.begin(packageName);
    if (events.length === 0) return;
    inFlight = true;
    callsToday += 1;
    try {
      const existing = pool.strongest(deps.now(), packageName);
      const reply = await judge(buildLearnInput(packageName, events, existing, deps.language()));
      if (!on()) { buffer.abort(); return; }
      const parsed = reply === null ? null : parseLearnReply(reply, events.length, existing.map((t) => t.id));
      if (parsed === null) throw new Error("notice learn: reply carried no signals");
      const { byEvent } = pool.apply(packageName, events, parsed.signals, deps.now());
      deps.persist(pool.data());
      buffer.finish(new Map([...byEvent].map(([index, ids]) => [events[index]!.seq, ids])));
      failures = 0;
      holdUntilMs = 0;
    } catch {
      buffer.fail();
      failures += 1;
      holdUntilMs = deps.now() + failureHoldMs(failures);
    } finally {
      inFlight = false;
    }
    evaluate();
  };

  return {
    /** A kept notice: capture it, then look at whether an app came due. */
    capture: (record: NoticeRecord, newMessages: readonly NoticeMessage[] = []) => {
      if (!on()) return;
      if (buffer.capture(record, newMessages)) evaluate();
    },
    /** The timer or a state change says look again (consent narrowed, level changed, a task ended). */
    poke: evaluate,
    /** Apps the person unticked drop their queued events and their pool evidence. */
    purge: (keep: (packageName: string) => boolean) => {
      buffer.purge(keep);
      const apps = new Set(pool.all().flatMap((topic) => Object.keys(topic.evidence)));
      let changed = false;
      for (const app of apps) if (!keep(app)) changed = pool.clearApp(app).size > 0 || changed;
      if (changed) deps.persist(pool.data());
      evaluate();
    },
    /** The pool as it stands, for the observed-line and status surfaces. */
    topics: (): ObservedTopic[] => pool.all(),
    pending: (): number => buffer.pendingCount(),
    /** The server is going away: drop the pending timer. */
    stop: () => { if (timer !== null) { deps.unwait(timer); timer = null; } },
  };
}
export type NoticeLearn = ReturnType<typeof createNoticeLearn>;
