import type { IdleCompactResult } from "../contracts.ts";
import type { spawnCli } from "../procs.ts";
import { appendNative } from "./native.ts";
import { decodePiFrame, PiRpcChunks, piLineReader, piNativeLogMessage, PiRpcRefusalError } from "./pi-rpc.ts";
import type { PiUsage } from "./pi-usage.ts";

/** The slice of a parked pi session that out-of-turn warm operations need. */
export interface PiWarmEntry {
  child: ReturnType<typeof spawnCli>;
  sessionFile: string | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** An out-of-turn compact RPC owns the child: no warm reuse while it runs. */
  compacting?: boolean;
}

export interface PiWarmDeps {
  warmSessions: Map<string, PiWarmEntry>;
  active: { has(threadId: string): boolean };
  closeWarmSession(threadId: string, reason: string): void;
  idleMs: number;
}

/** Presence or a scheduled ping holds the warm child past its ordinary idle
 * timeout; null releases the hold back to the ordinary one. */
export const piWarmHold = (deps: PiWarmDeps, threadId: string, until: number | null): boolean => {
  const warm = deps.warmSessions.get(threadId);
  if (!warm || warm.child.exitCode !== null || warm.child.signalCode !== null) return false;
  if (warm.idleTimer) clearTimeout(warm.idleTimer);
  const ms = until === null ? deps.idleMs : Math.max(0, until - Date.now());
  warm.idleTimer = setTimeout(() => deps.closeWarmSession(threadId, until === null ? "idle" : "hold-end"), ms);
  warm.idleTimer.unref?.();
  return true;
};

/** Warm summary on the warm child: `clone` branches the session file at its
 * leaf (pi switches the child onto the fork), `compact` rewrites the fork
 * with the model's own summary. The original file is never touched — if a
 * turn lands meanwhile it can still ride the old cursor, and only a
 * successful result swaps it. `warm.sessionFile` is updated the moment the
 * fork's name is known so the pool always says where the child actually is. */
export const piWarmCompact = async (deps: PiWarmDeps, threadId: string, options: { instructions: string; session?: string; signal?: AbortSignal }): Promise<IdleCompactResult> => {
  const warm = deps.warmSessions.get(threadId);
  if (!warm || warm.child.exitCode !== null || warm.child.signalCode !== null) return { ok: false, reason: "there is no live pi session to summarize" };
  if (deps.active.has(threadId) || warm.compacting) return { ok: false, busy: true, reason: "a turn is running" };
  const child = warm.child;
  const before = options.session ?? warm.sessionFile;
  if (typeof before !== "string") return { ok: false, reason: "the conversation has no session to summarize" };

  const waiters = new Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void; timer?: NodeJS.Timeout }>();
  const rejectAll = (err: Error) => {
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    waiters.clear();
  };
  const awaitResponse = (command: string, timeoutMs = 60_000) =>
    new Promise<unknown>((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        reject(new Error("The AI exited before replying"));
        return;
      }
      const timer = setTimeout(() => {
        waiters.delete(command);
        reject(new Error(`The AI's ${command} timed out`));
      }, timeoutMs);
      timer.unref?.();
      waiters.set(command, { resolve, reject, timer });
    });
  const send = (obj: Record<string, unknown>) => {
    appendNative(threadId, { dir: "out", source: "pi.rpc", msg: piNativeLogMessage(obj) });
    child.stdin.write(JSON.stringify(obj) + "\n");
  };
  const chunks = new PiRpcChunks();
  const onData = piLineReader((line) => {
    const frame = decodePiFrame(line, chunks);
    if (!frame) return;
    if (frame.type === "response") {
      const waiter = waiters.get(typeof frame.command === "string" ? frame.command : "");
      if (!waiter) return;
      waiters.delete(typeof frame.command === "string" ? frame.command : "");
      clearTimeout(waiter.timer);
      if (frame.success === true) waiter.resolve(frame.data);
      else waiter.reject(new PiRpcRefusalError(typeof frame.error === "string" ? frame.error : `pi ${String(frame.command)} failed`));
      return;
    }
    // Anything pi asks while compacting is refused: a summary must not
    // pause for a card nobody is watching.
    if (frame.type === "extension_ui_request") {
      send({ type: "extension_ui_response", id: frame.id, cancelled: true });
    }
  });
  const onClose = () => rejectAll(new Error("The AI exited while summarizing"));
  const onAbort = () => rejectAll(new Error("the summary was cancelled"));
  const detach = () => {
    child.stdout.off("data", onData);
    child.off("close", onClose);
    options.signal?.removeEventListener("abort", onAbort);
  };

  warm.compacting = true;
  if (warm.idleTimer) {
    clearTimeout(warm.idleTimer);
    warm.idleTimer = null;
  }
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", onData);
  child.on("close", onClose);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  // A `clone` ack means the child has moved onto a fork we cannot name until
  // `get_state` answers; failing between the two leaves the child's file
  // unknowable, and a warm entry that cannot name its file must die.
  let cloneAcked = false;
  let forkKnown = false;
  try {
    if (warm.sessionFile !== before) {
      const sw = awaitResponse("switch_session");
      send({ type: "switch_session", sessionPath: before });
      const swData = (await sw) as { sessionFile?: string } | undefined;
      if (swData?.sessionFile) warm.sessionFile = swData.sessionFile;
    }
    const clone = awaitResponse("clone");
    send({ type: "clone" });
    const cloneData = (await clone) as { cancelled?: boolean } | undefined;
    cloneAcked = true;
    if (cloneData?.cancelled) return { ok: false, reason: "pi refused to fork the session" };
    const st = awaitResponse("get_state");
    send({ type: "get_state" });
    const state = (await st) as { sessionFile?: string } | undefined;
    if (typeof state?.sessionFile === "string") {
      warm.sessionFile = state.sessionFile;
      forkKnown = true;
    }
    const forkFile = warm.sessionFile;
    if (typeof forkFile !== "string" || forkFile === before) return { ok: false, reason: "the fork did not produce a new session" };
    const cp = awaitResponse("compact", 30 * 60_000);
    send({ type: "compact", customInstructions: options.instructions });
    const result = (await cp) as {
      summary?: string;
      usage?: PiUsage;
    } | undefined;
    if (typeof result?.summary !== "string" || !result.summary.trim()) return { ok: false, reason: "pi returned an empty summary" };
    return {
      ok: true,
      session: forkFile,
      sessionBefore: before,
      input: result.usage?.input ?? 0,
      cacheRead: result.usage?.cacheRead ?? 0,
      cacheWrite: result.usage?.cacheWrite ?? 0,
      output: result.usage?.output ?? 0,
      costUsd: result.usage?.cost?.total ?? null,
      model: null,
    };
  } catch (error) {
    if (cloneAcked && !forkKnown) deps.closeWarmSession(threadId, "summary failed");
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    detach();
    rejectAll(new Error("the summary ended"));
    if (deps.warmSessions.get(threadId) === warm) {
      warm.compacting = false;
      piWarmHold(deps, threadId, null);
    }
  }
};
