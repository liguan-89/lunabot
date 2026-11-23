// Live calls' settings in config.json: schema, type and environment overrides, kept out of server/config.ts.
import { z } from "zod";

export const LIVE_KEY_NEEDS_ENDPOINT = "Save the Azure endpoint first: a Live key works only with the endpoint it was saved for.";
const NOWHERE = "nowhere";

/** Live calls: `key` is a key for Live calls only; with `provider` "openai" (the default) a call without one uses `openai.key`, with "azure" it is the Azure resource's key, with "qwen" the realtime gateway's key, with "volc" the speech app's Access Token; both are required. `keyFor` says where `key` may go (`liveKeyTarget`): the server sets it when the key is saved and never takes it from a request; absent, the key is from before Azure was offered, so OpenAI's. `azureEndpoint` is the resource URL and `azureDeployment` the gpt-live-1 deployment name. `qwenEndpoint` is the gateway's https base (any path — its origin is used), `qwenModel` a realtime model name. `volcAppId` is the Volcengine speech app's App ID and `volcModel` a dialogue model version ("1.2.1.1" O2.0). `voice` is a GPT-Live voice. */
export const liveConfigSchema = z.object({
  key: z.string().optional(),
  keyFor: z.string().max(300).optional(),
  provider: z.enum(["openai", "azure", "qwen", "volc"]).optional(),
  azureEndpoint: z.string().trim().max(300).optional(),
  azureDeployment: z.string().trim().max(64).optional(),
  qwenEndpoint: z.string().trim().max(300).optional(),
  qwenModel: z.string().trim().max(64).regex(/^[\w.-]*$/, "a realtime model id").optional(),
  volcAppId: z.string().trim().max(32).regex(/^\d*$/, "an App ID is digits").optional(),
  volcModel: z.string().trim().max(32).regex(/^[\w.-]*$/, "a dialogue model version").optional(),
  voice: z.string().trim().max(40).regex(/^[a-z]*$/, "a Live voice is a lowercase built-in voice name").optional(),
  readTypedReplies: z.boolean().optional(),
  idleMinutes: z.number().int().min(1).max(60).optional(),
});

export interface LiveConfig {
  key?: string;
  keyFor?: string;
  provider?: "openai" | "azure" | "qwen" | "volc";
  azureEndpoint?: string;
  azureDeployment?: string;
  qwenEndpoint?: string;
  qwenModel?: string;
  volcAppId?: string;
  volcModel?: string;
  voice?: string;
  readTypedReplies?: boolean;
  idleMinutes?: number;
}

/** Where a key saved now may go: "openai", "volc" (its host is fixed), "azure:<host>" or "qwen:<host>"; null while that provider is chosen with no endpoint to tie it to. */
export function liveKeyTarget(live: LiveConfig | undefined): string | null {
  if (live?.provider === "volc") return "volc";
  const raw = live?.provider === "azure" ? live.azureEndpoint : live?.provider === "qwen" ? live.qwenEndpoint : null;
  if (raw === null) return "openai";
  try {
    const host = new URL(raw?.trim() ?? "").host.toLowerCase();
    return host ? `${live!.provider}:${host}` : null;
  } catch {
    return null;
  }
}

/** The saved key, only while calls go where it was saved for. */
export function usableLiveKey(live: LiveConfig | undefined): string | undefined {
  const key = live?.key?.trim();
  const target = liveKeyTarget(live);
  return key && target && (live?.keyFor ?? "openai") === target ? key : undefined;
}

/** What to save for a change to `live`: a new key is tied to where calls now go, and any other change of where they go
 * forgets the old one. On the desktop the OS store keeps a copy the server cannot delete, which comes back as
 * LUNABOT_OPENAI_LIVE_KEY at the next launch: "nowhere" keeps that copy unusable until a key is saved again. */
export function liveSavePatch(current: LiveConfig | undefined, patch: LiveConfig): LiveConfig {
  const { keyFor: _fromRequest, ...asked } = patch;
  const target = liveKeyTarget({ ...current, ...asked });
  if (asked.key?.trim()) {
    if (!target) throw Object.assign(new Error(LIVE_KEY_NEEDS_ENDPOINT), { status: 400 });
    return { ...asked, keyFor: target };
  }
  return asked.key !== undefined || target !== liveKeyTarget(current) ? { ...asked, key: "", keyFor: NOWHERE } : asked;
}

export function liveConfigWithEnv(live: LiveConfig | undefined, env: NodeJS.ProcessEnv = process.env): LiveConfig {
  const next = { ...live };
  const envKey = env.LUNABOT_OPENAI_LIVE_KEY;
  if (envKey !== undefined) {
    // A different key from the environment is not the one `keyFor` was saved for.
    if (next.key?.trim() && next.key.trim() !== envKey.trim()) delete next.keyFor;
    next.key = envKey;
  }
  const provider = env.LUNABOT_LIVE_PROVIDER?.trim().toLowerCase();
  if (provider === "openai" || provider === "azure" || provider === "qwen" || provider === "volc") next.provider = provider;
  if (env.LUNABOT_AZURE_OPENAI_LIVE_ENDPOINT !== undefined) next.azureEndpoint = env.LUNABOT_AZURE_OPENAI_LIVE_ENDPOINT.trim();
  if (env.LUNABOT_AZURE_OPENAI_LIVE_DEPLOYMENT !== undefined) next.azureDeployment = env.LUNABOT_AZURE_OPENAI_LIVE_DEPLOYMENT.trim();
  if (env.LUNABOT_LIVE_QWEN_ENDPOINT !== undefined) next.qwenEndpoint = env.LUNABOT_LIVE_QWEN_ENDPOINT.trim();
  if (env.LUNABOT_LIVE_QWEN_MODEL !== undefined) next.qwenModel = env.LUNABOT_LIVE_QWEN_MODEL.trim();
  if (env.LUNABOT_LIVE_VOLC_APP_ID !== undefined) next.volcAppId = env.LUNABOT_LIVE_VOLC_APP_ID.trim();
  if (env.LUNABOT_LIVE_VOLC_MODEL !== undefined) next.volcModel = env.LUNABOT_LIVE_VOLC_MODEL.trim();
  // Set together in the environment, the key and the provider endpoint are the operator's own pairing. A `keyFor` from
  // the file stands: saves mirror settings into the environment, so they must not be able to pair a forgotten key.
  const envEndpoint = provider === "azure" ? env.LUNABOT_AZURE_OPENAI_LIVE_ENDPOINT : provider === "qwen" ? env.LUNABOT_LIVE_QWEN_ENDPOINT : provider === "volc" ? env.LUNABOT_LIVE_VOLC_APP_ID : undefined;
  if (envKey?.trim() && envEndpoint?.trim() && next.keyFor === undefined) next.keyFor = liveKeyTarget(next) ?? NOWHERE;
  return next;
}

/** The non-secret Live settings a settings patch mirrors into the environment. */
export function liveSettingEnv(live: LiveConfig | undefined): Array<[value: string | undefined, name: string]> {
  return [
    [live?.provider, "LUNABOT_LIVE_PROVIDER"],
    [live?.azureEndpoint, "LUNABOT_AZURE_OPENAI_LIVE_ENDPOINT"],
    [live?.azureDeployment, "LUNABOT_AZURE_OPENAI_LIVE_DEPLOYMENT"],
    [live?.qwenEndpoint, "LUNABOT_LIVE_QWEN_ENDPOINT"],
    [live?.qwenModel, "LUNABOT_LIVE_QWEN_MODEL"],
    [live?.volcAppId, "LUNABOT_LIVE_VOLC_APP_ID"],
    [live?.volcModel, "LUNABOT_LIVE_VOLC_MODEL"],
  ];
}
