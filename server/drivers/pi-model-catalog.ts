// pi's model plumbing: the `get_available_models` catalog, model-id splitting, and the rows this
// app upserts into ~/.pi/agent/models.json so `set_model` can reach a custom provider or a live
// local host.
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "../contracts.ts";
import {
  PI_CUSTOM_PROVIDER_ID,
  piCustomApi,
  piCustomProviderFromEnv,
  splitPiCustomModel,
} from "./pi-custom-provider.ts";
import { decodeInjectId, encodeInjectId, hostApiKey, localHost, mergeLocalInject } from "./local-inject.ts";

interface PiModelEntry {
  provider: string;
  id: string;
  name?: string;
}

interface PiModelsResponse {
  type: "response";
  command: "get_available_models";
  success: boolean;
  data?: { models?: PiModelEntry[] };
}

export function piCatalogFromFrame(frame: unknown, fallbackDefault: string): ModelCatalog | null {
  const res = frame as PiModelsResponse;
  if (res?.type !== "response" || res.command !== "get_available_models" || !res.success) return null;
  const options: Array<{ id: string; label: string; custom: true; provider: string }> = [];
  for (const m of res.data?.models ?? []) {
    if (!m?.provider || !m?.id) continue;
    const id = `${m.provider}/${m.id}`;
    options.push({ id, label: m.name ?? m.id, custom: true, provider: m.provider });
  }
  return { default: fallbackDefault || (options[0]?.id ?? ""), options };
}

export function parsePiCatalog(stdout: string, fallbackDefault = ""): ModelCatalog {
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const catalog = piCatalogFromFrame(msg, fallbackDefault);
    if (catalog) return catalog;
  }
  return { default: fallbackDefault, options: [] };
}

export function splitPiModel(id: string): { provider: string; modelId: string } | null {
  const inject = decodeInjectId(id);
  if (inject) return { provider: inject.host, modelId: inject.model };
  if (!id.includes("/")) return null;
  const [provider, ...rest] = id.split("/");
  if (!provider || !rest.length) return null;
  return { provider, modelId: rest.join("/") };
}

export function preferPiInjectRows(catalog: ModelCatalog): ModelCatalog {
  const injectIds = new Set(
    catalog.options.filter((option) => decodeInjectId(option.id)).map((option) => option.id),
  );
  if (!injectIds.size) return catalog;
  const options = catalog.options.filter((option) => {
    if (decodeInjectId(option.id)) return true;
    const slash = option.id.indexOf("/");
    if (slash <= 0) return true;
    return !injectIds.has(encodeInjectId(option.id.slice(0, slash), option.id.slice(slash + 1)));
  });
  let def = catalog.default;
  if (def && !options.some((option) => option.id === def)) {
    const slash = def.indexOf("/");
    const mapped = slash > 0 ? encodeInjectId(def.slice(0, slash), def.slice(slash + 1)) : "";
    def = injectIds.has(mapped) ? mapped : (options[0]?.id ?? "");
  }
  return { default: def, options };
}

export async function applyPiLocalCatalog(
  catalog: ModelCatalog,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelCatalog> {
  return preferPiInjectRows(await mergeLocalInject(catalog, env, fetchImpl));
}

function piAgentDir(env: Record<string, string | undefined>): string {
  if (env.PI_CODING_AGENT_DIR) return env.PI_CODING_AGENT_DIR;
  return join(env.HOME || env.USERPROFILE || homedir(), ".pi", "agent");
}

/** The environment one pi instance's spawns and catalog reads get: an explicit PI_CODING_AGENT_DIR wins; otherwise the
 *  instance's own dir (seeded with auth and models only) keeps the operator's AGENTS.md, skills and extensions out of a
 *  bot's turn. `providerEnv` keeps the custom-provider variables the spawn itself needs. */
export function piInstanceEnvs(
  instanceId: string,
  baseEnv: Record<string, string | undefined>,
  providerEnv: Record<string, string | undefined> = baseEnv,
): { dir: string; catalogEnv: Record<string, string | undefined>; piEnv: Record<string, string | undefined> } {
  const dir = baseEnv.PI_CODING_AGENT_DIR
    ?? ensurePiInstanceAgentDir(instanceId, join(baseEnv.HOME || baseEnv.USERPROFILE || homedir(), ".pi", "agent"), baseEnv);
  return {
    dir,
    catalogEnv: { ...baseEnv, PI_CODING_AGENT_DIR: dir },
    piEnv: { ...providerEnv, PI_CODING_AGENT_DIR: dir },
  };
}

/** Create DEX BOT's own pi agent dir for this instance and link `auth.json` + `models.json` from the operator's
 * `~/.pi/agent`, so a bot's turn does not inherit the operator's AGENTS.md, skills or extensions. The dir sits under
 * the real HOME (`~/.pi/instances/<id>`) rather than the data folder, which a bot box hides behind a tmpfs. */
export function ensurePiInstanceAgentDir(
  instanceId: string,
  operatorAgentDir: string,
  env: Record<string, string | undefined> = process.env,
): string {
  // The id comes from the instance registry; keep it to a single path segment whatever a caller passes.
  const safe = instanceId.replace(/[^A-Za-z0-9._-]/g, "_");
  const dir = join(env.HOME || env.USERPROFILE || homedir(), ".pi", "instances", safe);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const file of ["auth.json", "models.json"] as const) {
    const link = join(dir, file);
    const target = join(operatorAgentDir, file);
    if (!existsSync(link) && existsSync(target)) {
      try {
        symlinkSync(target, link);
      } catch {
        // Symlinks need elevated privileges on Windows; a copy keeps sign-in working there.
        try {
          copyFileSync(target, link);
        } catch (error) {
          throw new Error(`pi: could not seed ${file} into ${dir}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  return dir;
}

function piModelsRoot(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return { providers: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function writePiModelsRoot(path: string, root: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {}
}

function providersOf(root: Record<string, unknown>): Record<string, unknown> {
  return root.providers && typeof root.providers === "object" && !Array.isArray(root.providers)
    ? { ...(root.providers as Record<string, unknown>) }
    : {};
}

function modelRows(existing: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(existing.models)
    ? existing.models.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    : [];
}

/** A models.json seeded as a symlink to the operator's file becomes this instance's own copy before any write, so a
 *  bot's custom provider or local host never edits the operator's shared pi config. */
function ownPiModelsFile(path: string): void {
  let isSymlink = false;
  try {
    isSymlink = lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!isSymlink) return;
  let content: string | null = null;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    // A dangling link (the operator deleted the file after seeding) drops and starts from an owned file.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  unlinkSync(path);
  if (content !== null) writeFileSync(path, content, { mode: 0o600 });
}

/** Upsert the custom provider into ~/.pi/agent/models.json, so pi lists its models and `set_model` can reach them. */
export function ensurePiCustomProvider(env: Record<string, string | undefined>): void {
  const custom = piCustomProviderFromEnv(env);
  if (!custom) return;
  const dir = piAgentDir(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "models.json");
  ownPiModelsFile(path);
  const root = piModelsRoot(path);
  if (!root) return;
  const providers = providersOf(root);
  const previous = providers[PI_CUSTOM_PROVIDER_ID];
  const existing: Record<string, unknown> =
    previous && typeof previous === "object" && !Array.isArray(previous) ? { ...(previous as Record<string, unknown>) } : { models: [] };
  existing.name = custom.displayName;
  existing.baseUrl = custom.baseUrl;
  existing.api = piCustomApi(custom.protocol);
  existing.apiKey = custom.apiKey || "local";
  const models = modelRows(existing);
  for (const model of custom.models) {
    if (models.some((row) => row.id === model)) continue;
    models.push({
      id: model,
      name: model,
      reasoning: true,
      input: custom.protocol === "anthropic" ? ["text", "image"] : ["text"],
      contextWindow: 131072,
      maxTokens: 16384,
    });
  }
  existing.models = models;
  providers[PI_CUSTOM_PROVIDER_ID] = existing;
  root.providers = providers;
  writePiModelsRoot(path, root);
}

/** Upsert a live local host into ~/.pi/agent/models.json so `set_model` can reach it. */
export function ensurePiInjectModel(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): { provider: string; modelId: string } | null {
  const custom = splitPiCustomModel(modelId);
  if (custom && piCustomProviderFromEnv(env)) {
    ensurePiCustomProvider(env);
    return { provider: PI_CUSTOM_PROVIDER_ID, modelId: custom.modelId };
  }
  const split = splitPiModel(modelId);
  if (!split) return null;
  const inject = decodeInjectId(modelId);
  if (!inject) return split;
  const host = localHost(inject.host);
  if (!host) return split;

  const dir = piAgentDir(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "models.json");
  ownPiModelsFile(path);
  const root = piModelsRoot(path);
  if (!root) return split;

  const providers = providersOf(root);
  const previous = providers[inject.host];
  const existing: Record<string, unknown> =
    previous && typeof previous === "object" && !Array.isArray(previous)
      ? { ...(previous as Record<string, unknown>) }
      : {
          baseUrl: host.baseUrl,
          api: "openai-completions",
          apiKey: hostApiKey(host, env),
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
          models: [] as Array<Record<string, unknown>>,
        };
  existing.baseUrl = host.baseUrl;
  existing.api = typeof existing.api === "string" && existing.api ? existing.api : "openai-completions";
  existing.apiKey = hostApiKey(host, env);
  if (!existing.compat) {
    existing.compat = { supportsDeveloperRole: false, supportsReasoningEffort: true };
  }
  const models = modelRows(existing);
  if (!models.some((row) => row.id === inject.model)) {
    models.push({
      id: inject.model,
      name: inject.model,
      reasoning: true,
      input: ["text"],
      contextWindow: 131072,
      maxTokens: 16384,
    });
  }
  existing.models = models;
  providers[inject.host] = existing;
  root.providers = providers;
  writePiModelsRoot(path, root);
  return split;
}

export function readPiDefaultModel(env: Record<string, string | undefined>): string {
  try {
    const s = JSON.parse(readFileSync(join(piAgentDir(env), "settings.json"), "utf8")) as {
      defaultProvider?: string;
      defaultModel?: string;
    };
    return s.defaultProvider && s.defaultModel ? `${s.defaultProvider}/${s.defaultModel}` : "";
  } catch {
    return "";
  }
}
