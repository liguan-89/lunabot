import { latestWebPanels } from "@/lib/web-panel-preferences";
import type { Action, AppState, Message } from "./store";

/** Messages per snapshot thread and per scrollback page: the server's own page maximum. The constant lives here, not
 * in `store`: this module is a `store` dependency, and a live read of it at module scope would hit the store's
 * temporal dead zone and blank the whole renderer. */
export const MESSAGE_PAGE_SIZE = 200;

/** The fewest rows a snapshot carries of a conversation nobody has open; the server reaches back further where the
 * sidebar, the unread divider or the team map reads an older line. */
export const SNAPSHOT_TAIL = 20;

/** A conversation holding fewer rows than one page while the server has more: a snapshot's tail. */
export const shortHeld = <T extends { messages: readonly unknown[]; hasMore?: boolean }>(owner: T | undefined | null): owner is T =>
  Boolean(owner?.hasMore) && owner!.messages.length < MESSAGE_PAGE_SIZE;

type HeldOwner = { id: string; messages: Message[]; threadId: string; hasMore?: boolean; activeLeafId?: string | null; pinnedMessageId?: string };

/** Rows a conversation keeps once the reader has left it, and the most it keeps to put a reader's place back. */
export const HELD_AFTER_LEAVING = MESSAGE_PAGE_SIZE;
export const HELD_FOR_PLACE = 3 * MESSAGE_PAGE_SIZE;

/** The most rows a conversation nobody has on screen gathers from live frames before it is trimmed again. */
export const HELD_IN_BACKGROUND = HELD_FOR_PLACE + HELD_AFTER_LEAVING;

/** The newest rows of `owner`, from `keepFromId` when that is close enough to the end, never cutting off its pinned
 * message or the leaf of the branch it shows. */
export function trimmedHeld<T extends HeldOwner>(owner: T, keepFromId?: string): T {
  const total = owner.messages.length;
  let from = total - HELD_AFTER_LEAVING;
  if (from <= 0) return owner;
  for (const id of [keepFromId, owner.activeLeafId, owner.pinnedMessageId]) {
    const at = id ? owner.messages.findIndex((message) => message.id === id) : -1;
    if (at < 0 || at >= from) continue;
    if (id !== keepFromId && total - at > HELD_FOR_PLACE) return owner;
    if (total - at <= HELD_FOR_PLACE) from = at;
  }
  return from > 0 ? { ...owner, messages: owner.messages.slice(from), hasMore: true } : owner;
}

/** The selected room or bot, or the first bot when the selection names neither: what the chat and its panels show. */
const selectedOwner = (state: Pick<AppState, "bots" | "groups" | "selectedId">) =>
  state.groups.find((group) => group.id === state.selectedId) ?? state.bots.find((bot) => bot.id === state.selectedId) ?? state.bots[0];

/** A conversation on screen: the one the chat draws, or the chat a pinned page in the web panel comes from. */
const shownThread = (state: AppState, threadId: string) =>
  (state.activeView === "chat" && selectedOwner(state)?.threadId === threadId) ||
  (state.activeView === "web-panel" && latestWebPanels().find((panel) => panel.id === state.webPanelId)?.page?.threadId === threadId);

/**
 * After a row lands in a conversation nobody has on screen: past `HELD_IN_BACKGROUND` rows it keeps the reader's place
 * when close enough to the end, else the newest page a fresh snapshot would hold.
 */
export function capHeldInBackground(state: AppState, action: Action): AppState {
  if (action.type !== "messageAdded") return state;
  const owner = [...state.bots, ...state.groups].find((candidate) => candidate.threadId === action.threadId);
  if (!owner || owner.messages.length <= HELD_IN_BACKGROUND || shownThread(state, action.threadId)) return state;
  const trim = <T extends HeldOwner>(candidate: T): T => (candidate.threadId === owner.threadId ? trimmedHeld(candidate) : candidate);
  const trimmed = { ...state, bots: state.bots.map(trim), groups: state.groups.map(trim) };
  const page = <T extends HeldOwner>(held: T): T => held.threadId === action.threadId && held.messages.length > HELD_IN_BACKGROUND
    ? { ...held, messages: held.messages.slice(-MESSAGE_PAGE_SIZE), hasMore: true } : held;
  return { ...trimmed, bots: trimmed.bots.map(page), groups: trimmed.groups.map(page) };
}

/**
 * A row from before a short tail, landing in a conversation nobody has on screen (a frame queued while the snapshot was
 * read): appended, it would read as the newest row. The page before the tail brings it in order when the tail opens.
 * Only a row that is older than the tail and continues a row the tail does not hold counts: a row continuing the held
 * rows is new, whatever its time says.
 */
export function olderThanHeld(state: AppState, action: Action): boolean {
  if (action.type !== "messageAdded") return false;
  const owner = [...state.bots, ...state.groups].find((candidate) => candidate.threadId === action.threadId);
  const first = owner?.messages[0], parentId = action.message.parentId;
  if (!shortHeld(owner) || first === undefined || action.message.at >= first.at || typeof parentId !== "string") return false;
  if ("activeLeafId" in owner && owner.activeLeafId === parentId) return false;
  return !shownThread(state, action.threadId) && !owner!.messages.some((message) => message.id === action.message.id || message.id === parentId);
}

/** The conversations the last snapshot sent as a short tail, by the first row it sent, until the page before the tail
 * lands. */
const tails = new Map<string, string>();

export function noteSnapshotTails(owners: Iterable<{ threadId: string; messages: readonly { id: string }[] }>): void {
  tails.clear();
  for (const owner of owners) if (owner.messages[0]) tails.set(owner.threadId, owner.messages[0].id);
}

/** How often one opening of a tail asks for the page before it: the first ask, and one more after a failed or
 * discarded answer. */
const ASKS_PER_OPENING = 2;

const leaves = new Map<string, string | null | undefined>();
const asks = new Map<string, number>();
const moved = new Set<string>();
let selectedThread: string | undefined;
let checkQueued = false;

/**
 * Asks for the page before a snapshot's tail once the conversation is selected however that happens (a click, a
 * deletion moving the selection), or once its branch moves anywhere but onto a new newest row (another client
 * switching branches), since the rest of that branch may lie before the tail. Every request goes through
 * `loadOlderMessages`; selecting it again, or another branch move, starts a fresh round of asks. The check runs a
 * microtask after the dispatch that may have changed the selection, so it never nests inside that dispatch.
 */
export function followSnapshotTails(store: { getState(): AppState }, dispatch: (action: Action) => void): void {
  if (!tails.size || checkQueued) return;
  checkQueued = true;
  queueMicrotask(() => {
    checkQueued = false;
    if (!tails.size) return;
    const state = store.getState();
    const selected = selectedOwner(state);
    if (selected?.threadId !== selectedThread) {
      selectedThread = selected?.threadId;
      if (selectedThread) asks.delete(selectedThread);
    }
    for (const owner of [...state.bots, ...state.groups]) {
      const threadId = owner.threadId, first = tails.get(threadId);
      if (first === undefined) continue;
      if (owner.messages[0]?.id !== first || !shortHeld(owner)) {
        if (asks.has(threadId)) {
          tails.delete(threadId);
          asks.delete(threadId);
          moved.delete(threadId);
        }
        continue;
      }
      const leaf = "activeLeafId" in owner ? owner.activeLeafId : undefined;
      if (leaves.has(threadId) && leaves.get(threadId) !== leaf && leaf !== owner.messages.at(-1)?.id) {
        moved.add(threadId);
        asks.delete(threadId);
      }
      leaves.set(threadId, leaf);
      const asked = asks.get(threadId) ?? 0;
      if ((threadId !== selectedThread && !moved.has(threadId)) || state.loadingOlder[threadId] || asked >= ASKS_PER_OPENING) continue;
      asks.set(threadId, asked + 1);
      dispatch({ type: "loadOlderMessages", threadId });
    }
  });
}
