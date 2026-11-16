// The proactivity tool's routes: how much Luna Bot initiates for the person — "standard" posts briefs and suggestions
// with notifications; "quiet" keeps working but never pings.
import type { BotRecord, Store } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const PROACTIVITY_LEVELS = ["standard", "quiet"] as const;
export type ProactivityLevel = (typeof PROACTIVITY_LEVELS)[number];

export function createInternalProactivityRoutes(deps: {
  store: Pick<Store, "bots">;
  from: BotRecord;
  fromThreadId: string;
  ownsThread(botId: string, threadId: string): boolean;
  level(): ProactivityLevel;
  set(level: ProactivityLevel): void;
}): RouteHandler {
  const { from, fromThreadId } = deps;
  return async ({ req, res, path, method, json, readBody }) => {
    if (path !== "/api/internal/proactivity") return PASS;
    if (!deps.ownsThread(from.id, fromThreadId)) {
      return json(res, 403, { error: "source conversation does not belong to sender" });
    }
    if (method === "GET") return json(res, 200, { level: deps.level() });
    if (method !== "PUT") return PASS;
    const body = await readBody(req, 2048);
    const level = body && typeof body === "object" ? (body as { level?: unknown }).level : undefined;
    if (level !== "standard" && level !== "quiet") return json(res, 400, { error: `level must be one of: ${PROACTIVITY_LEVELS.join(", ")}` });
    deps.set(level);
    return json(res, 200, { level });
  };
}
