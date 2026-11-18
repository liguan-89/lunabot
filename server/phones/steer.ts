// Adapted from Mika's SteerSignal (Apache-2.0).
// The person's own words arriving while a phone job is being waited on: the wait ends at once, so the model reads them
// instead of sitting out a six-second screen wait or a two-minute Send wait. Nothing already done is undone and the job
// is never cancelled; its answer is simply not read. Mika keeps the flag on the run (RunInbox's `pending`) and cancels
// the waiting coroutine with `select`; a promise race here, because a phone job cannot be stopped without also telling
// the phone to stop, and that would be a different promise to the person.

/** The error a phone job answers with when the person's new message cut its wait short: nothing was done, so the model
 * reads their words before deciding the next step. */
export const SKIPPED_FOR_NEW_MESSAGE = "skipped_for_new_message";

/** Which conversation, and which bot in it, a mark belongs to. The turn is kept apart from it, so the next turn in the
 * same conversation starts clean. */
export type SteerKey = { threadId: string; botId: string };

/** What a wait came to: the person spoke first, or the job answered. */
export type SteerRace<T> = { kind: "steered" } | { kind: "done"; value: T };

/** How many conversations keep a mark; the oldest is dropped past this, so a long-lived server does not grow without
 * bound. The same cap as the per-turn gates in confirm.ts. */
export const MAX_STEER_TURNS = 200;

/** One wait listening for a mark: only a note for its own turn wakes it. */
type Waiter = { generation: string; wake: () => void };

/** The pair, as one map key. A NUL cannot appear in either part, so two pairs cannot collide. */
function steerKey(key: SteerKey): string {
  return `${key.threadId}\u0000${key.botId}`;
}

function evict<K, V>(map: Map<K, V>, max: number): void {
  for (const key of map.keys()) {
    if (map.size <= max) break;
    map.delete(key);
  }
}

/**
 * The marks the person's new messages leave, one per conversation and bot, and the waits that listen for them.
 *
 * A mark names the turn it belongs to, so the next turn in the same conversation is not steered by the one before; a note
 * for a newer turn replaces the old mark rather than adding a second. A wait uses its mark up, so one message cuts one
 * wait: the model then reads that message, and a later phone call in the same turn is not skipped as well.
 */
export class PhoneSteer {
  private readonly turns = new Map<string, { generation?: string; steered: boolean }>();
  private readonly waiters = new Map<string, Set<Waiter>>();

  /** How many conversations hold a mark; a test reads it to see the bound hold. */
  get size(): number {
    return this.turns.size;
  }

  /**
   * The person sent a new message: the turn named is steered, or, when the note names none, the turn this key last saw.
   * A note that names no turn and finds none marks nothing, since it cannot say which turn it was for.
   */
  noteUserMessage(key: SteerKey, generation?: string): void {
    const id = steerKey(key);
    const turn = generation ?? this.turns.get(id)?.generation;
    if (turn === undefined) return;
    this.remember(id, turn, true);
    // A waiter removes itself as it wakes, which Set iteration allows.
    for (const waiter of this.waiters.get(id) ?? []) if (waiter.generation === turn) waiter.wake();
  }

  /** Whether the turn named waits on a mark: its next wait is cut. */
  steered(key: SteerKey, generation: string): boolean {
    const held = this.turns.get(steerKey(key));
    return held?.steered === true && held.generation === generation;
  }

  /** Forget this conversation's mark. A wait already under way is left to its own outcome. */
  clear(key: SteerKey): void {
    this.turns.delete(steerKey(key));
  }

  /**
   * The job's answer, unless the person's new message arrives first. The losing job is not cancelled: it runs on the
   * phone, and only its answer goes unread, so a rejection it raises later is caught here rather than left unhandled.
   */
  race<T>(key: SteerKey, generation: string, promise: Promise<T>): Promise<SteerRace<T>> {
    const id = steerKey(key);
    if (this.steered(key, generation)) {
      this.consume(id, generation);
      void promise.catch(() => {});
      return Promise.resolve<SteerRace<T>>({ kind: "steered" });
    }
    // The turn is recorded before it is steered, so a note that names no turn still finds it; a newer turn replaces the
    // entry rather than adding a second.
    this.remember(id, generation, false);
    return new Promise<SteerRace<T>>((resolve, reject) => {
      const waiters = this.waiters.get(id) ?? new Set<Waiter>();
      this.waiters.set(id, waiters);
      let settled = false;
      const forget = (gone: Waiter) => {
        waiters.delete(gone);
        if (waiters.size === 0 && this.waiters.get(id) === waiters) this.waiters.delete(id);
      };
      const waiter: Waiter = {
        generation,
        wake: () => {
          if (settled) return;
          settled = true;
          forget(waiter);
          this.consume(id, generation);
          // The job keeps running, so a failure it raises later has nowhere else to go.
          void promise.catch(() => {});
          resolve({ kind: "steered" });
        },
      };
      waiters.add(waiter);
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          forget(waiter);
          resolve({ kind: "done", value });
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          forget(waiter);
          reject(error);
        },
      );
    });
  }

  /** Record which turn this conversation is on; the newest entry is kept last, so eviction drops the oldest. */
  private remember(id: string, generation: string, steered: boolean): void {
    this.turns.delete(id);
    this.turns.set(id, { generation, steered });
    evict(this.turns, MAX_STEER_TURNS);
  }

  /** A mark is spent by the wait it cut, unless a newer turn has replaced it meanwhile. */
  private consume(id: string, generation: string): void {
    if (this.turns.get(id)?.generation === generation) this.turns.delete(id);
  }
}
