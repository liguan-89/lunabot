import { z } from "zod";

import { providerIconError } from "../../shared/provider-icon.ts";
import { persistableInstanceConfigs, saveConfig, withInstanceCli, type AppConfig } from "../config.ts";
import type { InstanceConfigMap, ModelSelection, ProviderInstance } from "../contracts.ts";
import { BUILT_IN_DRIVERS } from "../drivers/builtIn.ts";
import { findCliCandidates, resetPathCache } from "../env-path.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import { checkEngine, type EngineCheck } from "../engine-check.ts";
import { HOSTED_PROVIDER_SETTINGS_ERROR } from "../hosted-models.ts";
import { providerIconPatchSchema, withInstanceIcon } from "../provider-icon.ts";
import type { BusyFlag, ConfigStatus } from "./config.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface InstanceRouteDeps {
  store: Pick<{
    bots: readonly { id: string; modelSelection: ModelSelection; fallback?: Array<{ instanceId: string }>; busy?: boolean }[];
    tasks?(botId: string): readonly { threadId: string; modelSelection?: ModelSelection }[];
  }, "bots"> & { tasks?(botId: string): readonly { threadId: string; modelSelection?: ModelSelection }[] };
  cfg: AppConfig;
  registry: Pick<ProviderRegistry, "get" | "refreshModels" | "installRuntime" | "cliTarget" | "forgetSnapshots" | "onWrongCli">;
  sessions?: unknown;
  providerAuthSessions?: unknown;
  hostedModels?: boolean;
  providerConfigBusy: BusyFlag;
  providerInstancesChanging: Pick<Set<string>, "add" | "delete">;
  describeInstances(): Promise<unknown>;
  persistProviderInstance(instanceId: string, instances: InstanceConfigMap): Promise<void>;
  configStatus(): ConfigStatus;
  broadcast(payload: Record<string, unknown>): void;
  testCliBinary(cli: string, driver: (typeof BUILT_IN_DRIVERS)[number] | undefined): Promise<unknown>;
  cliProbeEnvironment?: () => NodeJS.ProcessEnv;
  threadBusy?: (botId: string, threadId: string) => boolean;
  botForThread?: (botId: string, threadId: string) => Pick<{ modelSelection: ModelSelection }, "modelSelection"> | null;
  activeGroupTurnForBot?: (botId: string) => { threadId: string } | null;
  checkInstance?(instance: ProviderInstance): Promise<EngineCheck>;
}

const instanceSettingsSchema = z.object({
  cli: z.string().max(4096).optional(),
  hidden: z.boolean().optional(),
  displayName: z.string().trim().min(1).max(80).optional(),
}).strict();

export function createInstanceRoutes(deps: InstanceRouteDeps): RouteHandler {
  const {
    store, cfg, registry, providerConfigBusy, providerInstancesChanging,
    persistProviderInstance, configStatus, broadcast, testCliBinary,
  } = deps;
  const botTasks = (botId: string) => deps.store.tasks ? deps.store.tasks(botId) : [];
  /** The selections of turns running right now: the only thing a CLI change has to wait for. */
  const busySelections = (): ModelSelection[] => store.bots.flatMap((bot) => {
    const busyTasks = botTasks(bot.id).filter((task) => deps.threadBusy?.(bot.id, task.threadId));
    const selections = busyTasks.flatMap((task) => {
      const at = deps.botForThread?.(bot.id, task.threadId)?.modelSelection;
      return at ? [at] : [];
    });
    if (deps.activeGroupTurnForBot?.(bot.id) || (bot.busy && busyTasks.length === 0)) selections.push(bot.modelSelection);
    return selections;
  });
  const busyOn = (instanceId: string): boolean => busySelections().some((selection) => selection.instanceId === instanceId);
  /** Bots, their backups and threads, the new-bot default, or a turn on it: an account in use cannot go away or hide. */
  const inUse = (instanceId: string): boolean => cfg.defaultModelSelection?.instanceId === instanceId || store.bots.some((bot) =>
    bot.modelSelection.instanceId === instanceId || bot.fallback?.some((candidate) => candidate.instanceId === instanceId) ||
    botTasks(bot.id).some((task) => task.modelSelection?.instanceId === instanceId)) || busyOn(instanceId);
  /** After the app installed its own copy of an engine whose CLI found a copy that does not start: point the engine at the
   * app's copy, as Set CLI would. Not while provider settings are changing or a turn runs on the engine. */
  const useAppCopy = async (instanceId: string, cli: string): Promise<boolean> => {
    if (providerConfigBusy.get() || busyOn(instanceId)) return false;
    providerConfigBusy.set(true);
    providerInstancesChanging.add(instanceId);
    try {
      const result = withInstanceCli(cfg, instanceId, cli);
      const instances = persistableInstanceConfigs(result.config);
      if (!result.ok || !Object.hasOwn(instances, instanceId)) return false;
      await persistProviderInstance(instanceId, instances);
      return true;
    } finally {
      providerInstancesChanging.delete(instanceId);
      providerConfigBusy.set(false);
    }
  };
  registry?.onWrongCli?.((instanceId, cli) => useAppCopy(instanceId, cli));
  return async ({ req, res, url, path, method, json, readBody }) => {
    if (method === "GET" && path === "/api/instances/hidden") {
      const hidden = Object.entries(persistableInstanceConfigs(cfg)).filter(([, entry]) => entry.hidden === true);
      return json(res, 200, { instances: hidden.map(([instanceId, entry]) => ({ instanceId, driverKind: entry.driver, displayName: entry.displayName ?? BUILT_IN_DRIVERS.find((driver) => driver.driverKind === entry.driver)?.metadata.displayName ?? instanceId })) });
    }
    if (method === "GET" && path === "/api/instances") {
      resetPathCache();
      if (url.searchParams.get("fresh") === "1") registry.forgetSnapshots();
      return json(res, 200, { instances: await deps.describeInstances() });
    }
    if (method === "GET" && path === "/api/health/engines") {
      const described = await deps.describeInstances();
      const available = Array.isArray(described) ? described.filter((instance) => Object(Object(instance).snapshot).state === "available").length : 0;
      return json(res, 200, { app: "dexbot", engines: available });
    }
    if (deps.hostedModels === true && path.startsWith("/api/instances/") && method !== "GET") return json(res, 403, { error: HOSTED_PROVIDER_SETTINGS_ERROR });

    const instanceIconPatch = /^\/api\/instances\/([\w.-]+)\/icon$/.exec(path);
    if (method === "PATCH" && instanceIconPatch) {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const parsed = providerIconPatchSchema.safeParse(await readBody(req, 192 * 1024));
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message;
        return json(res, 400, { error: detail && detail !== "Invalid input" ? detail : "Choose a built-in icon or upload a PNG, JPEG, or WebP image up to 128 KB." });
      }
      if (parsed.data.icon) {
        const invalid = providerIconError(parsed.data.icon);
        if (invalid) return json(res, 400, { error: invalid });
      }
      if (providerConfigBusy.get()) return json(res, 409, { error: "provider settings are already being updated" });
      providerConfigBusy.set(true);
      try {
        const changed = withInstanceIcon(cfg, instanceIconPatch[1], parsed.data.icon);
        if (!changed.ok) return json(res, 404, { error: `unknown instance "${instanceIconPatch[1]}"` });
        saveConfig({ instances: changed.instances }, { replaceInstances: true });
        cfg.instances = changed.instances;
        broadcast({ kind: "config", ...configStatus() });
        return json(res, 200, { instances: await deps.describeInstances() });
      } finally { providerConfigBusy.set(false); }
    }

    const instanceAction = /^\/api\/instances\/([\w.-]+)\/(refresh-models|install|check)$/.exec(path);
    if (method === "POST" && instanceAction) {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      await readBody(req, 4096);
      const instanceId = instanceAction[1];
      const action = instanceAction[2];
      try {
        if (action === "check") {
          const instance = registry.get(instanceId);
          if (!instance) return json(res, 404, { error: "unknown instance" });
          res.setHeader("cache-control", "no-store");
          return json(res, 200, await (deps.checkInstance ?? checkEngine)(instance));
        }
        if (action === "refresh-models") {
          if (!(await registry.refreshModels(instanceId))) return json(res, 404, { error: "unknown instance" });
          return json(res, 200, { instances: await deps.describeInstances() });
        }
        const installed = await registry.installRuntime(instanceId);
        if (!installed) return json(res, 404, { error: "Installing this engine from Settings is not available on this server. Use the install command on the machine running Luna Bot." });
        const usingAppCopy = installed !== true && await useAppCopy(instanceId, installed.useCli);
        return json(res, 200, { instances: await deps.describeInstances(), ...(usingAppCopy ? { usingAppCopy: true } : {}) });
      } catch (error) {
        const requestedStatus = error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
        const status = typeof requestedStatus === "number" && [400, 401, 404, 409, 413, 415].includes(requestedStatus) ? requestedStatus : 500;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    // ?name=pi → every `pi` on the augmented PATH, in PATH order (first = what a bare name runs).
    if (method === "GET" && path === "/api/cli-candidates") {
      const name = url.searchParams.get("name") ?? "";
      resetPathCache();
      return json(res, 200, { candidates: findCliCandidates(name) });
    }

    // POST {cli, driver} → spawn `<cli> --version` with the PATH a turn would use.
    if (method === "POST" && path === "/api/cli-test") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      const cli = typeof body?.cli === "string" ? body.cli.trim() : "";
      if (!cli || /[\n\r]/.test(cli)) return json(res, 400, { error: "cli must be a non-empty path" });
      const driver = typeof body?.driver === "string" ? BUILT_IN_DRIVERS.find((d) => d.driverKind === body.driver) : undefined;
      return json(res, 200, await testCliBinary(cli, driver));
    }

    // PATCH /api/instances/:id {cli: "/path/to/cli" | ""}: "" reverts to the driver default.
    const instancePatch = /^\/api\/instances\/([\w.-]+)$/.exec(path);
    if (method === "PATCH" && instancePatch) {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const parsed = instanceSettingsSchema.safeParse(await readBody(req, 16384));
      if (!parsed.success) return json(res, 400, { error: "Check the instance settings." });
      const body = parsed.data;
      const instanceId = instancePatch[1];
      if (providerConfigBusy.get()) return json(res, 409, { error: "provider settings are already being updated" });
      if (busyOn(instanceId)) {
        return json(res, 409, { error: "Wait for bots using this account to finish before changing its settings." });
      }
      providerConfigBusy.set(true);
      providerInstancesChanging.add(instanceId);
      try {
        const result = body.cli === undefined ? { ok: true, config: cfg } : withInstanceCli(cfg, instanceId, body.cli);
        const instances = persistableInstanceConfigs(result.config);
        if (!result.ok || !Object.hasOwn(instances, instanceId)) return json(res, 404, { error: `unknown instance "${instanceId}"` });
        const entry = instances[instanceId];
        if (body.hidden === true && inUse(instanceId)) {
          return json(res, 409, { error: "Choose another model for the bots and default model using this provider before hiding it." });
        }
        if (body.hidden !== undefined) {
          if (body.hidden) entry.hidden = true;
          else delete entry.hidden;
        }
        if (body.displayName !== undefined) entry.displayName = body.displayName;
        await persistProviderInstance(instanceId, instances);
        return json(res, 200, { instances: await deps.describeInstances() });
      } finally {
        providerInstancesChanging.delete(instanceId);
        providerConfigBusy.set(false);
      }
    }

    if (method === "DELETE" && instancePatch) {
      return json(res, 400, { error: "The built-in AI cannot be removed." });
    }
    return PASS;
  };
}