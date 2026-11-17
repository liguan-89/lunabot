// The steer signal the phone host waits on: the person's new message cuts a wait short, the job it was waiting on runs on,
// and a turn's mark never leaks into the next turn of the same conversation.
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_STEER_TURNS, PhoneSteer, SKIPPED_FOR_NEW_MESSAGE } from "./steer.ts";

const KEY = { threadId: "thread-1", botId: "chief" };
const GEN = "gen-1";
const nextTurn = "gen-2";

afterEach(() => vi.restoreAllMocks());

/** A promise whose settle the test decides. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

describe("the steer signal", () => {
  it("skips a wait whose turn was already steered, and names the code the model reads", async () => {
    const steer = new PhoneSteer();
    steer.noteUserMessage(KEY, GEN);
    expect(steer.steered(KEY, GEN)).toBe(true);
    const job = deferred<string>();
    await expect(steer.race(KEY, GEN, job.promise)).resolves.toEqual({ kind: "steered" });
    // Nothing was waited on, so the job never had to settle.
    expect(SKIPPED_FOR_NEW_MESSAGE).toBe("skipped_for_new_message");
  });

  it("ends a wait that is already under way when the message arrives", async () => {
    const steer = new PhoneSteer();
    const job = deferred<string>();
    const raced = steer.race(KEY, GEN, job.promise);
    steer.noteUserMessage(KEY, GEN);
    await expect(raced).resolves.toEqual({ kind: "steered" });
    // The job still settles on its own, and its answer is simply not read.
    job.resolve("the phone answered late");
    await Promise.resolve();
  });

  it("lets a job that answers first win the race", async () => {
    const steer = new PhoneSteer();
    const job = deferred<string>();
    const raced = steer.race(KEY, GEN, job.promise);
    job.resolve("done");
    await expect(raced).resolves.toEqual({ kind: "done", value: "done" });
  });

  it("leaves a job that rejects after the steer with no unhandled rejection", async () => {
    const steer = new PhoneSteer();
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => { seen.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      // Steered before the wait: the job was never awaited at all.
      steer.noteUserMessage(KEY, GEN);
      const early = deferred<never>();
      await expect(steer.race(KEY, GEN, early.promise)).resolves.toEqual({ kind: "steered" });
      early.reject(new Error("the phone went away"));
      // Steered during the wait: the job's own answer is no longer wanted.
      const job = deferred<never>();
      const raced = steer.race(KEY, GEN, job.promise);
      steer.noteUserMessage(KEY, GEN);
      await expect(raced).resolves.toEqual({ kind: "steered" });
      job.reject(new Error("the phone went away"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("hands a rejection to the caller when the job answers first", async () => {
    const steer = new PhoneSteer();
    const job = deferred<never>();
    const raced = steer.race(KEY, GEN, job.promise);
    job.reject(new Error("the phone went away"));
    await expect(raced).rejects.toThrow("the phone went away");
  });

  it("leaves another turn of the same conversation unsteered", async () => {
    const steer = new PhoneSteer();
    steer.noteUserMessage(KEY, GEN);
    expect(steer.steered(KEY, nextTurn)).toBe(false);
    const job = deferred<string>();
    const raced = steer.race(KEY, nextTurn, job.promise);
    job.resolve("the next turn's answer");
    await expect(raced).resolves.toEqual({ kind: "done", value: "the next turn's answer" });
  });

  it("replaces an older turn's mark rather than compounding, and spends it on one wait", async () => {
    const steer = new PhoneSteer();
    steer.noteUserMessage(KEY, GEN);
    steer.noteUserMessage(KEY, nextTurn);
    expect(steer.steered(KEY, GEN)).toBe(false);
    expect(steer.steered(KEY, nextTurn)).toBe(true);
    await expect(steer.race(KEY, nextTurn, Promise.resolve("first"))).resolves.toEqual({ kind: "steered" });
    // The message cut one wait: a later call in the same turn is not skipped as well.
    expect(steer.steered(KEY, nextTurn)).toBe(false);
    await expect(steer.race(KEY, nextTurn, Promise.resolve("second"))).resolves.toEqual({ kind: "done", value: "second" });
  });

  it("keeps a note with no turn for the turn a wait already recorded", async () => {
    const steer = new PhoneSteer();
    const job = deferred<string>();
    const raced = steer.race(KEY, GEN, job.promise);
    steer.noteUserMessage(KEY);
    await expect(raced).resolves.toEqual({ kind: "steered" });
  });

  it("forgets a conversation on clear, and keeps its waits out of another's way", async () => {
    const steer = new PhoneSteer();
    steer.noteUserMessage(KEY, GEN);
    steer.clear(KEY);
    expect(steer.steered(KEY, GEN)).toBe(false);
    // A note for one conversation never wakes a wait in another.
    const other = { threadId: "thread-2", botId: "chief" };
    const job = deferred<string>();
    const raced = steer.race(other, GEN, job.promise);
    steer.noteUserMessage(KEY, GEN);
    job.resolve("the other conversation's answer");
    await expect(raced).resolves.toEqual({ kind: "done", value: "the other conversation's answer" });
  });

  it("drops the oldest conversation rather than growing without bound", () => {
    const steer = new PhoneSteer();
    for (let index = 0; index <= MAX_STEER_TURNS; index += 1) steer.noteUserMessage({ threadId: `thread-${index}`, botId: "chief" }, GEN);
    expect(steer.size).toBe(MAX_STEER_TURNS);
    expect(steer.steered({ threadId: "thread-0", botId: "chief" }, GEN)).toBe(false);
    expect(steer.steered({ threadId: `thread-${MAX_STEER_TURNS}`, botId: "chief" }, GEN)).toBe(true);
    // Clearing a live conversation frees its entry, so the map is not stuck at the cap.
    steer.clear({ threadId: `thread-${MAX_STEER_TURNS}`, botId: "chief" });
    expect(steer.size).toBe(MAX_STEER_TURNS - 1);
  });
});
