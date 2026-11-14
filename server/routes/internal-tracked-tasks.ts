// The tracked_tasks tool's routes: the bot's task list for the person, one row per unit of work.
// Dispatch only inside the internal capability gate: `from` and `fromThreadId` come from the caller's capability.
import { randomUUID } from "node:crypto";

import type { TrackedItem } from "../../shared/wire.ts";
import type { BotRecord, Store } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

const MAX_ITEMS = 50;
const MAX_TITLE = 160;
const MAX_NOTE = 400;
const STATES: readonly TrackedItem["state"][] = ["open", "needs-you", "done"];

export function createInternalTrackedTaskRoutes(deps: {
  store: Pick<Store, "patchBot">;
  from: BotRecord;
  fromThreadId: string;
  ownsThread(botId: string, threadId: string): boolean;
}): RouteHandler {
  const { store, from, fromThreadId } = deps;
  const items = () => from.trackedItems ?? [];

  return async ({ req, res, path, method, json, readBody }) => {
    if (!path.startsWith("/api/internal/tracked-tasks")) return PASS;
    if (!deps.ownsThread(from.id, fromThreadId)) {
      return json(res, 403, { error: "source conversation does not belong to sender" });
    }

    if (method === "GET" && path === "/api/internal/tracked-tasks") {
      return json(res, 200, { items: items() });
    }

    const id = /^\/api\/internal\/tracked-tasks\/([\w-]+)$/.exec(path)?.[1];
    if (method === "PATCH" && id) {
      const item = items().find((candidate) => candidate.id === id);
      if (!item) return json(res, 404, { error: "no such item" });
      const body = await readBody(req);
      const patch: Partial<TrackedItem> = {};
      if (body.title !== undefined) {
        if (typeof body.title !== "string" || !body.title.trim() || body.title.length > MAX_TITLE) {
          return json(res, 400, { error: `title is one line of up to ${MAX_TITLE} characters` });
        }
        patch.title = body.title.trim();
      }
      if (body.note !== undefined) {
        if (body.note !== null && (typeof body.note !== "string" || body.note.length > MAX_NOTE)) {
          return json(res, 400, { error: `note is up to ${MAX_NOTE} characters, or null to clear` });
        }
        patch.note = body.note === null ? undefined : (body.note as string).trim() || undefined;
      }
      if (body.state !== undefined) {
        if (!STATES.includes(body.state)) return json(res, 400, { error: "state is open, needs-you or done" });
        patch.state = body.state;
      }
      store.patchBot(from.id, { trackedItems: items().map((candidate) => candidate.id === id ? { ...candidate, ...patch, updatedAt: Date.now() } : candidate) });
      return json(res, 200, { ok: true });
    }

    if (method === "POST" && path === "/api/internal/tracked-tasks") {
      const body = await readBody(req);
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title || title.length > MAX_TITLE) {
        return json(res, 400, { error: `title is one line of up to ${MAX_TITLE} characters` });
      }
      if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > MAX_NOTE)) {
        return json(res, 400, { error: `note is up to ${MAX_NOTE} characters` });
      }
      if (body.threadId !== undefined && (typeof body.threadId !== "string" || !deps.ownsThread(from.id, body.threadId))) {
        return json(res, 400, { error: "threadId must be one of your own threads" });
      }
      if (items().length >= MAX_ITEMS) {
        return json(res, 429, { error: `the task list holds ${MAX_ITEMS} items; mark some done first` });
      }
      const now = Date.now();
      const item: TrackedItem = {
        id: randomUUID(), title, state: "open",
        ...(body.note ? { note: (body.note as string).trim() || undefined } : {}),
        ...(typeof body.threadId === "string" ? { threadId: body.threadId } : {}),
        createdAt: now, updatedAt: now,
      };
      store.patchBot(from.id, { trackedItems: [...items(), item] });
      return json(res, 200, { ok: true, item });
    }

    return PASS;
  };
}
