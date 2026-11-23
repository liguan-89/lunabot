// The one custom model provider: a base URL, a key and a model list, spoken in
// one of the APIs pi already knows. The app writes it into pi's models.json and
// lists its models beside pi's own.
import type { ModelCatalog } from "../contracts.ts";

export type PiCustomProtocol = "openai" | "responses" | "anthropic";

export const PI_CUSTOM_PROVIDER_ID = "luna";
export const PI_CUSTOM_PROVIDER_NAME = "Custom";
/** The provider id before the rename. Model selections saved as `dex/<model>` keep working: both prefixes are
 * recognized wherever a saved id is read, and everything new is written as `luna/<model>`. */
export const PI_CUSTOM_LEGACY_PROVIDER_IDS = ["dex"] as const;
const PI_CUSTOM_PROVIDER_IDS = [PI_CUSTOM_PROVIDER_ID, ...PI_CUSTOM_LEGACY_PROVIDER_IDS];

// Names of the variables the server passes to the pi driver, never credential values.
export const PI_CUSTOM_ENV = {
  protocol: "LUNABOT_PI_CUSTOM_PROTOCOL",
  baseUrl: "LUNABOT_PI_CUSTOM_BASE_URL",
  auth: "LUNABOT_PI_CUSTOM_AUTH",
  models: "LUNABOT_PI_CUSTOM_MODELS",
  displayName: "LUNABOT_PI_CUSTOM_NAME",
} as const;

export interface PiCustomProvider {
  displayName: string;
  protocol: PiCustomProtocol;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

const PROTOCOLS = new Set<PiCustomProtocol>(["openai", "responses", "anthropic"]);

export function piCustomProtocol(value: unknown): PiCustomProtocol {
  return typeof value === "string" && PROTOCOLS.has(value as PiCustomProtocol) ? value as PiCustomProtocol : "openai";
}

/** What pi's models.json calls the API this provider speaks. */
export function piCustomApi(protocol: PiCustomProtocol): string {
  return protocol === "responses" ? "openai-responses" : protocol === "anthropic" ? "anthropic-messages" : "openai-completions";
}

export function piCustomProviderFromEnv(env: Record<string, string | undefined>): PiCustomProvider | null {
  const baseUrl = env[PI_CUSTOM_ENV.baseUrl]?.trim();
  if (!baseUrl) return null;
  const models = (env[PI_CUSTOM_ENV.models] ?? "")
    .split(/[,，、\s]+/)
    .map((model) => model.trim())
    .filter(Boolean);
  if (!models.length) return null;
  return {
    displayName: env[PI_CUSTOM_ENV.displayName]?.trim() || PI_CUSTOM_PROVIDER_NAME,
    protocol: piCustomProtocol(env[PI_CUSTOM_ENV.protocol]),
    baseUrl,
    apiKey: env[PI_CUSTOM_ENV.auth]?.trim() ?? "",
    models: [...new Set(models)].slice(0, 64),
  };
}

export function withoutPiCustomEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const child = { ...env };
  for (const key of Object.values(PI_CUSTOM_ENV)) delete child[key];
  return child;
}

export function piCustomModelId(model: string): string {
  return `${PI_CUSTOM_PROVIDER_ID}/${model}`;
}

export function isPiCustomModel(id: string): boolean {
  return PI_CUSTOM_PROVIDER_IDS.some((prefix) => id.startsWith(`${prefix}/`));
}

/** A model id the custom provider serves, as its model id; ids saved under a legacy prefix keep working. */
export function splitPiCustomModel(id: string): { modelId: string } | null {
  const prefix = PI_CUSTOM_PROVIDER_IDS.find((candidate) => id.startsWith(`${candidate}/`));
  if (!prefix) return null;
  const modelId = id.slice(prefix.length + 1);
  return modelId ? { modelId } : null;
}

/** The custom provider's models join pi's own list; pi's own default wins when it has one. */
export function mergePiCustomCatalog(catalog: ModelCatalog, env: Record<string, string | undefined>): ModelCatalog {
  const custom = piCustomProviderFromEnv(env);
  if (!custom) return catalog;
  const options = catalog.options.filter((option) => !isPiCustomModel(option.id));
  for (const model of custom.models) {
    options.push({
      id: piCustomModelId(model),
      label: `${model} (${custom.displayName})`,
      custom: true,
      provider: PI_CUSTOM_PROVIDER_ID,
    });
  }
  const first = piCustomModelId(custom.models[0]!);
  const keep = catalog.default && options.some((option) => option.id === catalog.default);
  return { default: keep ? catalog.default : first, options };
}

/** pi's own default is always selectable, so a saved "default" selection never becomes unresolvable. */
export function withPiDefaultOption(catalog: ModelCatalog): ModelCatalog {
  if (catalog.options.some((option) => option.id === "default")) return catalog;
  return {
    default: catalog.default || "default",
    options: [{ id: "default", label: "Default model", custom: true }, ...catalog.options],
  };
}