import type { CallMode } from "./call-mode";

// The Simple composer picks a call mode from its + menu, away from the call button that owns the start logic
// (voice set-up, Live key and Pro prompts, the unavailable help). The button listens here and starts the call
// exactly as its own call-mode menu would.
const listeners = new Map<string, Set<(mode: CallMode) => void>>();
const pending = new Map<string, { mode: CallMode; at: number }>();

export function requestCallStart(targetId: string, mode: CallMode): void {
  const active = Array.from(listeners.get(targetId) ?? []);
  if (active.length === 0) {
    pending.set(targetId, { mode, at: Date.now() });
    return;
  }
  pending.delete(targetId);
  for (const listener of active) listener(mode);
}

export function onCallStartRequest(targetId: string, listener: (mode: CallMode) => void): () => void {
  const set = listeners.get(targetId) ?? new Set();
  set.add(listener);
  listeners.set(targetId, set);
  const queued = pending.get(targetId);
  if (queued) {
    pending.delete(targetId);
    if (Date.now() - queued.at < 5_000) {
      queueMicrotask(() => listener(queued.mode));
    }
  }
  return () => {
    set.delete(listener);
    if (set.size === 0 && listeners.get(targetId) === set) listeners.delete(targetId);
  };
}
