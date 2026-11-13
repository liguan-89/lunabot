// Scheduled calls: bots meet in a room at a time. Cohesive with the calendar-call manager; the
// presence of `path === "/..."` and `path.match(` guards here keeps them out of server/index.ts.
import type { CalendarCall, CalendarCallManager } from "../calendar-calls.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { GroupRecord, Store } from "../store.ts";
import type { WireGroup } from "../../shared/wire.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface CalendarCallRouteDeps {
  calls: CalendarCallManager;
  /** Refuses a roster whose bots are not visible to the same people. */
  audienceConflict(body: unknown): string | null;
  ensureRoom(call: CalendarCall): GroupRecord;
  personRooms: { groupForAuth(auth: RequestAuth, group: WireGroup): WireGroup };
  publicGroupState(group: GroupRecord): WireGroup;
  store: Pick<Store, "messagesFor">;
}

export function createCalendarCallRoutes(deps: CalendarCallRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path === "/api/calendar-calls" && method === "GET") {
      return json(res, 200, { calls: deps.calls.list() });
    }
    if (path === "/api/calendar-calls" && method === "POST") {
      try {
        const body = await readBody(req);
        const conflict = deps.audienceConflict(body);
        if (conflict) return json(res, 400, { error: conflict });
        return json(res, 201, { call: deps.calls.create(body) });
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 400 });
      }
    }
    const calendarCallRoomMatch = path.match(/^\/api\/calendar-calls\/([\w-]+)\/room$/);
    if (calendarCallRoomMatch && method === "POST") {
      const call = deps.calls.get(calendarCallRoomMatch[1]);
      if (!call) return json(res, 404, { error: "no such scheduled call" });
      if (call.botIds.length < 2) {
        return json(res, 400, { error: "single-bot events open that bot's chat directly" });
      }
      const group = deps.ensureRoom(call);
      return json(res, 200, { group: { ...deps.personRooms.groupForAuth(auth, deps.publicGroupState(group)), messages: deps.store.messagesFor(group.threadId) } });
    }
    const calendarCallMatch = path.match(/^\/api\/calendar-calls\/([\w-]+)$/);
    if (calendarCallMatch && method === "PATCH") {
      if (!deps.calls.get(calendarCallMatch[1])) return json(res, 404, { error: "no such scheduled call" });
      try {
        const body = await readBody(req);
        const conflict = deps.audienceConflict(body);
        if (conflict) return json(res, 400, { error: conflict });
        return json(res, 200, { call: deps.calls.update(calendarCallMatch[1], body) });
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 400 });
      }
    }
    if (calendarCallMatch && method === "DELETE") {
      return deps.calls.remove(calendarCallMatch[1])
        ? json(res, 200, { ok: true })
        : json(res, 404, { error: "no such scheduled call" });
    }
    return PASS;
  };
}
