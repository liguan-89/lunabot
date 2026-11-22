// The route list a paired phone re-reads on every reconnect, and the device management behind it. The list is the
// asking device's own: a device restricted to its own networks has to be told so here, not only by the relay dropping it.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createDeviceRoutes, type DeviceRouteDeps } from "./device-routes.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const LOOPBACK: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const phone = (id: string): RequestAuth => ({ kind: "session", via: "bearer", scopes: ["client"], session: { id } } as unknown as RequestAuth);

const LIST = { serverName: "VPS", endpoints: [{ url: "https://vps.example.com", kind: "hosted" as const, priority: 0 }], version: "2.1.0" };

/** Serves the module's routes with the auth the test names, and records the device ids the list was asked for. */
async function serve(deps: Partial<DeviceRouteDeps> = {}, auth: RequestAuth = LOOPBACK): Promise<{ base: string; asked: Array<string | null | undefined> }> {
  const asked: Array<string | null | undefined> = [];
  const routes = [createDeviceRoutes({
    relay: null,
    endpoints: () => LIST,
    sessions: () => [{ id: "s-phone" }],
    setRoutes: () => false,
    revoke: () => false,
    clearOwnCookie: () => {},
    ...deps,
    ...(deps.relay
      ? { relay: { ...deps.relay, endpoints: (id?: string | null) => (asked.push(id), deps.relay!.endpoints(id)) } }
      : {}),
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
      if (!handled) json(res, 404, { error: "no route" });
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked };
}

describe("the phone's route list", () => {
  it("answers a paired phone with the list, and no cache in front of it", async () => {
    const { base } = await serve();
    const reply = await fetch(`${base}/api/companion/endpoints`);
    expect(reply.status).toBe(200);
    expect(reply.headers.get("cache-control")).toBe("no-store");
    expect(await reply.json()).toEqual(LIST);
  });

  it("is the asking device's own list: a restricted phone is told so by the relay's descriptor", async () => {
    const descriptor = { v: 1 as const, k: "a".repeat(86), h: "b".repeat(22), r: ["relay1.openmausbot.com"], routes: "local" as const };
    const { base, asked } = await serve({
      relay: {
        endpoints: () => ({ ...LIST, e2e: descriptor }),
        routesChanged: () => {},
      },
    }, phone("s-phone"));
    expect(await (await fetch(`${base}/api/companion/endpoints`)).json()).toEqual({ ...LIST, e2e: descriptor });
    // The session id, not the label or the token: the relay looks the restriction up by it.
    expect(asked).toEqual(["s-phone"]);
  });

  it("answers this machine's own list when the relay never started, with no device to ask about", async () => {
    const { base, asked } = await serve();
    expect(await (await fetch(`${base}/api/companion/endpoints`)).json()).toEqual(LIST);
    expect(asked).toEqual([]);
  });

  it("keeps the device list and the per-device restriction behind the module's own routes", async () => {
    const { base } = await serve({ setRoutes: (id, routes) => id === "s-phone" && routes === "local" });
    expect(await (await fetch(`${base}/api/auth/sessions`)).json()).toEqual({ sessions: [{ id: "s-phone" }], current: null });
    const narrowed = await fetch(`${base}/api/auth/sessions/s-phone/routes`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ routes: "local" }),
    });
    expect(narrowed.status).toBe(200);
    const refused = await fetch(`${base}/api/auth/sessions/s-phone/routes`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ routes: "everywhere" }),
    });
    expect(refused.status).toBe(400);
  });

  it("passes a request that is not its own on to the next handler", async () => {
    const { base } = await serve();
    expect((await fetch(`${base}/api/bots`)).status).toBe(404);
  });
});
