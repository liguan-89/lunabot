// The companion apps' route list, and the device list, revocation and per-device restriction behind it. Moved out of
// server/index.ts, which the route ratchet holds to its count (server/routes/README.md).
import { z } from "zod";

import type { CompanionEndpoint } from "../../shared/pairing-link.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface DeviceRouteDeps {
  /** The relay's own view of the endpoint list and of a restriction change; null when the relay is off. `deviceId`
   * selects the descriptor, so a device restricted to its own networks is told so here too. */
  relay: {
    endpoints(deviceId?: string | null): { serverName: string; endpoints: CompanionEndpoint[]; version?: string; e2e?: unknown };
    routesChanged(deviceId: string): void;
  } | null;
  /** The list when the relay never started: the same builder, read from this process. */
  endpoints(): { serverName: string; endpoints: CompanionEndpoint[]; version?: string; e2e?: unknown };
  sessions(): Array<{ id: string }>;
  /** One paired device's way in; false when no such session exists. */
  setRoutes(sessionId: string, routes: "any" | "local"): boolean;
  revoke(sessionId: string): boolean;
  /** Drops this browser's own sign-in cookie when it revokes itself. */
  clearOwnCookie(res: Parameters<RouteHandler>[0]["res"]): void;
}

const ROUTES_BODY = z.object({ routes: z.enum(["any", "local"]) });

export function createDeviceRoutes(deps: DeviceRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    // The companion apps' route list, answered over HTTPS as the desktop sidecar answers it: a paired phone re-reads
    // the ways in on every reconnect, so a new LAN address or a later `--lan` reaches it without a new QR. It is the
    // asking device's own list, descriptor included: one restricted to its own networks is told so here as well, not
    // only by the relay dropping it.
    if (method === "GET" && path === "/api/companion/endpoints") {
      res.setHeader("cache-control", "no-store");
      const deviceId = auth.kind === "session" ? auth.session.id : null;
      return json(res, 200, deps.relay?.endpoints(deviceId) ?? deps.endpoints());
    }
    if (method === "GET" && path === "/api/auth/sessions") {
      return json(res, 200, { sessions: deps.sessions(), current: auth.kind === "session" ? auth.session.id : null });
    }
    const device = /^\/api\/auth\/sessions\/([\w-]+)$/.exec(path);
    if (device && method === "DELETE") {
      const revoked = deps.revoke(device[1]!);
      if (auth.kind === "session" && auth.session.id === device[1]) deps.clearOwnCookie(res);
      return json(res, revoked ? 200 : 404, revoked ? { ok: true } : { error: "no such session" });
    }
    const routes = /^\/api\/auth\/sessions\/([\w-]+)\/routes$/.exec(path);
    if (!routes || method !== "PUT") return PASS;
    // Where one paired device may connect from. `local` keeps it on this machine's own networks and off the relay; the
    // relay drops its sessions at once, so the change is not only what the phone is told.
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
      return json(res, 415, { error: "content-type must be application/json" });
    }
    const parsed = ROUTES_BODY.safeParse(await readBody(req, 4096));
    if (!parsed.success) return json(res, 400, { error: 'routes must be "any" or "local"' });
    const sessionId = routes[1]!;
    if (!deps.setRoutes(sessionId, parsed.data.routes)) return json(res, 404, { error: "no such session" });
    deps.relay?.routesChanged(sessionId);
    return json(res, 200, { ok: true, session: deps.sessions().find((session) => session.id === sessionId) ?? null });
  };
}
