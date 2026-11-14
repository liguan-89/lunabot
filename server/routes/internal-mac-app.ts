// The mac_app tool's route: structured reads and writes into the Mac's own apps through JXA. Writes
// run only under the same bar a bash osascript would — the turn's approval mode must be full, or the
// answer tells the bot to reach for bash so the person gets the card.
import type { BotRecord, Store } from "../store.ts";
import { MAC_APP_ACTIONS, MAC_APP_WRITES, runMacApp, type MacAppAction } from "../mac-app.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createInternalMacAppRoutes(deps: {
  store: Pick<Store, "taskByThread">;
  from: BotRecord;
  fromThreadId: string;
  ownsThread(botId: string, threadId: string): boolean;
  /** Test seam. */
  run?: typeof runMacApp;
}): RouteHandler {
  const { from, fromThreadId } = deps;
  const run = deps.run ?? runMacApp;
  return async ({ req, res, path, method, json, readBody }) => {
    if (path !== "/api/internal/mac-app" || method !== "POST") return PASS;
    if (!deps.ownsThread(from.id, fromThreadId)) {
      return json(res, 403, { error: "source conversation does not belong to sender" });
    }
    const body = await readBody(req, 16_384);
    const action = body && typeof body === "object" ? (body as { action?: unknown }).action : undefined;
    if (typeof action !== "string" || !MAC_APP_ACTIONS.includes(action as MacAppAction)) {
      return json(res, 400, { error: `action must be one of: ${MAC_APP_ACTIONS.join(", ")}` });
    }
    const input = body && typeof body === "object" && body.input && typeof body.input === "object" ? body.input as Record<string, unknown> : {};
    const task = deps.store.taskByThread(from.id, fromThreadId);
    if (MAC_APP_WRITES.has(action as MacAppAction) && task?.approvalMode !== "full" && task?.autoApprove !== true) {
      return json(res, 200, { ok: false, error: "This write changes the person's Mac apps and the turn still asks before it acts. Run the equivalent osascript through bash so the person gets the approval card." });
    }
    return json(res, 200, await run(action as MacAppAction, input));
  };
}
