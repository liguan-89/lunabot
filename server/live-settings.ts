import type { LiveKeySource, LiveSettings } from "../shared/wire.ts";
import { saveConfig, syncCredentialEnv, type AppConfig } from "./config.ts";
import { azureLiveEndpoint, LIVE_NEEDS_AZURE, LIVE_NEEDS_KEY, LIVE_NEEDS_QWEN, LIVE_NEEDS_VOLC, openAiLiveEndpoint, qwenLiveEndpoint, volcLiveEndpoint, type LiveEndpoint } from "./live-call.ts";
import { liveSavePatch, usableLiveKey, type LiveConfig as LiveConfigSection } from "./live-config.ts";

export const LIVE_IDLE_MINUTES_DEFAULT = 5;

type LiveConfig = Pick<AppConfig, "live" | "openai">;

/** A saved Live key goes only to the provider and host it was saved for (`usableLiveKey`), and the OpenAI API key only ever to OpenAI. */
export function liveCallKey(cfg: LiveConfig): { key: string; source: LiveKeySource } | null {
  const live = usableLiveKey(cfg.live);
  if (live) return { key: live, source: "live" };
  if (cfg.live?.provider === "azure" || cfg.live?.provider === "qwen" || cfg.live?.provider === "volc") return null;
  const openai = cfg.openai?.key?.trim();
  return openai ? { key: openai, source: "openai" } : null;
}

/** null when Azure, Qwen or Doubao is chosen but its endpoint, app or model is missing or not valid. */
export function liveCallEndpoint(cfg: LiveConfig, env: NodeJS.ProcessEnv = process.env): LiveEndpoint | null {
  if (cfg.live?.provider === "azure") return azureLiveEndpoint(cfg.live.azureEndpoint, cfg.live.azureDeployment);
  if (cfg.live?.provider === "qwen") return qwenLiveEndpoint(cfg.live.qwenEndpoint, cfg.live.qwenModel);
  if (cfg.live?.provider === "volc") return volcLiveEndpoint(cfg.live.volcAppId, cfg.live.volcModel, env);
  return openAiLiveEndpoint(env);
}

export function liveSetupProblem(cfg: LiveConfig): string | null {
  const own = cfg.live?.provider === "azure" ? LIVE_NEEDS_AZURE : cfg.live?.provider === "qwen" ? LIVE_NEEDS_QWEN : cfg.live?.provider === "volc" ? LIVE_NEEDS_VOLC : null;
  if (!liveCallKey(cfg)) return own ?? LIVE_NEEDS_KEY;
  return liveCallEndpoint(cfg) ? null : own;
}

/** The environment follows the save, as for PUT /api/config: loadConfig prefers it over the file. */
export function saveLiveSettings(cfg: Pick<AppConfig, "live">, patch: LiveConfigSection): void {
  const live = liveSavePatch(cfg.live, patch);
  saveConfig({ live });
  syncCredentialEnv({ live });
}

/** What a call start reads, once: its key, endpoint and provider all come from this one reading. */
export function liveCallSettings(cfg: AppConfig) {
  return { key: liveCallKey(cfg)?.key ?? "", endpoint: liveCallEndpoint(cfg), setupProblem: liveSetupProblem(cfg), ...liveSettingsFor(cfg) };
}

/** A caller without the admin scope learns which service calls use, not which resource or gateway. */
export function liveSettingsForClient({ azureEndpoint: _endpoint, azureDeployment: _deployment, qwenEndpoint: _qwen, qwenModel: _model, volcAppId: _app, volcModel: _vm, ...settings }: LiveSettings): LiveSettings {
  return settings;
}

export function liveSettingsFor(cfg: AppConfig): LiveSettings {
  const minutes = cfg.live?.idleMinutes;
  const key = liveCallKey(cfg);
  const provider = cfg.live?.provider;
  return {
    configured: liveSetupProblem(cfg) === null,
    ...(key ? { keySource: key.source } : {}),
    ...(provider === "azure" || provider === "qwen" || provider === "volc" ? { provider } : {}),
    ...(cfg.live?.azureEndpoint ? { azureEndpoint: cfg.live.azureEndpoint } : {}),
    ...(cfg.live?.azureDeployment ? { azureDeployment: cfg.live.azureDeployment } : {}),
    ...(provider === "qwen" && cfg.live?.qwenEndpoint ? { qwenEndpoint: cfg.live.qwenEndpoint } : {}),
    ...(provider === "qwen" && cfg.live?.qwenModel ? { qwenModel: cfg.live.qwenModel } : {}),
    ...(provider === "volc" && cfg.live?.volcAppId ? { volcAppId: cfg.live.volcAppId } : {}),
    ...(provider === "volc" && cfg.live?.volcModel ? { volcModel: cfg.live.volcModel } : {}),
    voice: cfg.live?.voice ?? "",
    readTypedReplies: cfg.live?.readTypedReplies ?? true,
    idleMinutes: Number.isInteger(minutes) && minutes! >= 1 && minutes! <= 60 ? minutes! : LIVE_IDLE_MINUTES_DEFAULT,
  };
}
