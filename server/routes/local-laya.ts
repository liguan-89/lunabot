import { LAYA_DEFAULT_MODEL, type LocalLayaService } from "../decider/local-laya.ts";
import type { AppConfig } from "../config.ts";
import { PASS, type RouteHandler } from "./table.ts";

function safeStatus(local: LocalLayaService, operation: "idle" | "starting" | "ready" | "error") {
  const status = local.status();
  return {
    available: status.available,
    installed: status.installed,
    running: status.running,
    busy: operation === "starting" || status.busy,
    operation,
    model: LAYA_DEFAULT_MODEL,
    ...(status.progress ? { progress: status.progress } : {}),
    ...(status.error ? { error: "Local Laya setup failed. Try again." } : {}),
  };
}

function validEmptyBody(body: unknown) {
  return body === undefined || Boolean(body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0);
}

export function createLocalLayaRoutes(deps: {
  local: LocalLayaService | null;
  desktopManaged: boolean;
  config(): AppConfig;
  saveProvider(provider: "laya" | "jev"): void;
  useLocal(): boolean;
}): RouteHandler {
  let operation: "idle" | "starting" | "ready" | "error" = "idle";
  let error: string | null = null;
  let generation = 0;
  return async ({ req, res, path, method, json: reply, auth, readBody }) => {
    if (path !== "/api/decider/laya" && path !== "/api/decider/laya/start" && path !== "/api/decider/laya/stop") return PASS;
    if (!deps.desktopManaged || auth.kind !== "loopback" || auth.trust === "service" || !deps.local?.supported) {
      return reply(res, 404, { error: "Local Laya is available only in DEX BOT for macOS on Apple Silicon." });
    }
    if (path === "/api/decider/laya" && method === "GET") {
      res.setHeader("cache-control", "no-store");
      const current = deps.local.status();
      const view = safeStatus(deps.local, operation);
      if (error) view.error = "Local Laya setup failed. Try again.";
      if (deps.useLocal() && current.running && deps.local.verified()) {
        view.operation = "ready";
        view.busy = false;
      }
      return reply(res, 200, view);
    }
    if ((path === "/api/decider/laya/start" || path === "/api/decider/laya/stop") && method === "POST") {
      if (!validEmptyBody(await readBody(req, 1024))) return reply(res, 400, { error: "Unexpected local model options." });
      if (path.endsWith("/stop")) {
        if (deps.config().decider?.provider === "laya") {
          try { deps.saveProvider("jev"); }
          catch { return reply(res, 500, { error: "Could not switch the decision model back before stopping Laya." }); }
        }
        generation++;
        operation = "idle";
        error = null;
        const stopped = await deps.local.stop();
        return reply(res, 200, { ...stopped, operation });
      }
      if (operation === "starting") return reply(res, 202, safeStatus(deps.local, operation));
      if (deps.useLocal() && deps.local.status().running && deps.local.verified()) return reply(res, 200, safeStatus(deps.local, "ready"));
      operation = "starting";
      error = null;
      const run = ++generation;
      const local = deps.local;
      void local.start().then(async () => {
        if (run !== generation) return local.stop();
        const checked = await local.test();
        if (run !== generation) return local.stop();
        if (!checked.ok || !local.verified()) throw new Error("The local model response did not match the decision contract.");
        if (!deps.useLocal()) deps.saveProvider("laya");
        operation = "ready";
      }).catch(async (cause: unknown) => {
        if (run !== generation) return;
        error = cause instanceof Error ? cause.message.slice(0, 400) : "Local model setup failed.";
        operation = "error";
        await local.stop();
      });
      return reply(res, 202, safeStatus(local, operation));
    }
    return PASS;
  };
}
