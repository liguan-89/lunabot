// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import {
  capHeldInBackground,
  followSnapshotTails,
  HELD_AFTER_LEAVING,
  HELD_FOR_PLACE,
  HELD_IN_BACKGROUND,
  noteSnapshotTails,
  olderThanHeld,
  shortHeld,
  trimmedHeld,
} from "./snapshot-tail";
import { MESSAGE_PAGE_SIZE, type Action, type AppState, type Bot, type Message } from "./store";

const row = (index: number, extra: Partial<Message> = {}): Message =>
  ({ id: `m${index}`, at: index, role: "bot", kind: "text", text: `row ${index}`, ...extra }) as Message;

const rows = (count: number, from = 0): Message[] => Array.from({ length: count }, (_, index) => row(from + index));

const bot = (over: Partial<Bot>): Bot =>
  ({ id: "bot-1", threadId: "t-1", messages: [], name: "Scout", ...over }) as Bot;

const state = (over: Partial<AppState>): AppState =>
  ({ bots: [], groups: [], selectedId: "", activeView: "chat", loadingOlder: {}, ...over }) as AppState;

const added = (message: Message, threadId = "t-1"): Action => ({ type: "messageAdded", threadId, message }) as Action;

describe("a conversation nobody has on screen keeps a bounded tail", () => {
  it("holds at most a page plus the reader's allowance once live rows overfill it", () => {
    const held = bot({ messages: rows(HELD_IN_BACKGROUND + 1), hasMore: true });
    const onScreen = bot({ id: "bot-9", threadId: "t-9", messages: rows(3, 900) });
    const current = state({ bots: [held, onScreen], selectedId: "bot-9" });
    const next = capHeldInBackground(current, added(row(HELD_IN_BACKGROUND + 2)));
    expect(next.bots[0]!.messages.length).toBeLessThanOrEqual(HELD_FOR_PLACE);
    expect(next.bots[0]!.hasMore).toBe(true);
  });

  it("leaves the open conversation alone however long it grows", () => {
    const held = bot({ messages: rows(HELD_IN_BACKGROUND + 500), hasMore: true });
    const current = state({ bots: [held], selectedId: "bot-1" });
    expect(capHeldInBackground(current, added(row(9999))).bots[0]!.messages.length).toBe(HELD_IN_BACKGROUND + 500);
  });

  it("never cuts the pinned row or the branch leaf out of the slice it keeps", () => {
    const pinned = row(10);
    const held = bot({ messages: [pinned, ...rows(HELD_FOR_PLACE, 100)], hasMore: true, pinnedMessageId: pinned.id });
    const trimmed = trimmedHeld(held);
    expect(trimmed.messages.some((message) => message.id === pinned.id)).toBe(true);
  });

  it("refuses the trim when the kept anchor lies further back than the place allowance", () => {
    const pinned = row(5);
    const held = bot({ messages: [pinned, ...rows(HELD_FOR_PLACE + HELD_AFTER_LEAVING + 50, 100)], hasMore: true, pinnedMessageId: pinned.id });
    expect(trimmedHeld(held)).toBe(held);
  });

  it("knows a short held tail from a full page", () => {
    expect(shortHeld(bot({ messages: rows(19), hasMore: true }))).toBe(true);
    expect(shortHeld(bot({ messages: rows(MESSAGE_PAGE_SIZE), hasMore: true }))).toBe(false);
    expect(shortHeld(bot({ messages: rows(5), hasMore: false }))).toBe(false);
  });
});

describe("a frame older than a held tail never lands out of order", () => {
  const tail = bot({ messages: rows(20, 100), hasMore: true });

  it("drops a row continuing a message the tail does not hold", () => {
    const older = row(50, { parentId: "m49" });
    const onScreen = bot({ id: "bot-9", threadId: "t-9", messages: rows(3, 900) });
    const current = state({ bots: [tail, onScreen], selectedId: "bot-9" });
    expect(olderThanHeld(current, added(older))).toBe(true);
  });

  it("keeps a row continuing the tail's own last row", () => {
    const next = row(121, { parentId: tail.messages.at(-1)!.id });
    const current = state({ bots: [tail], selectedId: "other" });
    expect(olderThanHeld(current, added(next))).toBe(false);
  });

  it("keeps an older row in the conversation on screen", () => {
    const older = row(50, { parentId: "m49" });
    const current = state({ bots: [tail], selectedId: "bot-1" });
    expect(olderThanHeld(current, added(older))).toBe(false);
  });
});

describe("opening a held tail pages the rows before it", () => {
  const tailed = () => [bot({ id: "bot-1", threadId: "t-1", messages: rows(20, 100), hasMore: true }),
    bot({ id: "bot-2", threadId: "t-2", messages: rows(20, 200), hasMore: true })];
  const open = () => bot({ id: "bot-3", threadId: "t-3", messages: rows(MESSAGE_PAGE_SIZE, 300), hasMore: true });

  it("asks for the page before the tail once the conversation is selected", async () => {
    const bots = tailed();
    noteSnapshotTails(bots);
    const dispatched: Action[] = [];
    const current = state({ bots, selectedId: "bot-1" });
    followSnapshotTails({ getState: () => current }, (action) => dispatched.push(action));
    await vi.waitFor(() => expect(dispatched).toContainEqual({ type: "loadOlderMessages", threadId: "t-1" }));
    expect(dispatched.filter((action) => action.type === "loadOlderMessages")).toHaveLength(1);
  });

  it("does not page a tail nobody opens", async () => {
    const bots = tailed();
    noteSnapshotTails(bots);
    const dispatched: Action[] = [];
    const current = state({ bots: [...bots, open()], selectedId: "bot-3" });
    followSnapshotTails({ getState: () => current }, (action) => dispatched.push(action));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dispatched).toEqual([]);
  });

  it("pages a tail whose branch moved under it even without a selection", async () => {
    const bots = tailed();
    noteSnapshotTails(bots);
    const dispatched: Action[] = [];
    const quiet = state({ bots: [...bots, open()], selectedId: "bot-3" });
    followSnapshotTails({ getState: () => quiet }, (action) => dispatched.push(action));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const movedState = state({
      bots: [...bots.map((b) => (b.id === "bot-1" ? { ...b, activeLeafId: "m100" } : b)), open()],
      selectedId: "bot-3",
    });
    followSnapshotTails({ getState: () => movedState }, (action) => dispatched.push(action));
    await vi.waitFor(() => expect(dispatched).toContainEqual({ type: "loadOlderMessages", threadId: "t-1" }));
  });
});
