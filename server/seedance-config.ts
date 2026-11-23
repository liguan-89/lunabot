import { z } from "zod";

export const SEEDANCE_PROVIDERS = ["ark", "tk1688"] as const;
export type SeedanceProvider = (typeof SEEDANCE_PROVIDERS)[number];

export const DEFAULT_ARK_ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3";
export const DEFAULT_ARK_MODEL = "doubao-seedance-1-5-pro-251215";
export const DEFAULT_TK1688_ENDPOINT = "https://api.tk1688.com/v1";
export const DEFAULT_TK1688_MODEL = "doubao-seedance-2-5-260628-sec-720p";

const httpUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((value) => !value || /^https?:\/\//i.test(value), "endpoint must start with http:// or https://");

export const seedanceConfigSchema = z.object({
  provider: z.enum(SEEDANCE_PROVIDERS).optional(),
  arkEndpoint: httpUrlSchema.optional(),
  arkKey: z.string().trim().max(500).optional(),
  arkModel: z.string().trim().max(120).optional(),
  tk1688Endpoint: httpUrlSchema.optional(),
  tk1688Key: z.string().trim().max(500).optional(),
  tk1688Model: z.string().trim().max(120).optional(),
  resolution: z.enum(["480p", "720p"]).optional(),
  duration: z.number().int().min(4).max(30).optional(),
});

export interface SeedanceConfig {
  provider?: SeedanceProvider;
  arkEndpoint?: string;
  arkKey?: string;
  arkModel?: string;
  tk1688Endpoint?: string;
  tk1688Key?: string;
  tk1688Model?: string;
  resolution?: "480p" | "720p";
  duration?: number;
}

export interface SeedancePublicStatus {
  provider: SeedanceProvider;
  arkEndpoint: string;
  arkModel: string;
  arkConfigured: boolean;
  tk1688Endpoint: string;
  tk1688Model: string;
  tk1688Configured: boolean;
  resolution: "480p" | "720p";
  duration: number;
  ready: boolean;
  configured: boolean;
}

export function seedanceConfigWithEnv(
  cfg: SeedanceConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SeedanceConfig {
  const next: SeedanceConfig = { ...cfg };
  const envProvider = env.LUNABOT_SEEDANCE_PROVIDER?.trim().toLowerCase();
  if (envProvider === "ark" || envProvider === "tk1688") next.provider = envProvider;
  if (env.LUNABOT_SEEDANCE_ARK_ENDPOINT !== undefined) next.arkEndpoint = env.LUNABOT_SEEDANCE_ARK_ENDPOINT.trim();
  if (env.LUNABOT_SEEDANCE_ARK_KEY !== undefined) next.arkKey = env.LUNABOT_SEEDANCE_ARK_KEY.trim();
  if (env.LUNABOT_SEEDANCE_ARK_MODEL !== undefined) next.arkModel = env.LUNABOT_SEEDANCE_ARK_MODEL.trim();
  if (env.LUNABOT_SEEDANCE_TK1688_ENDPOINT !== undefined) next.tk1688Endpoint = env.LUNABOT_SEEDANCE_TK1688_ENDPOINT.trim();
  if (env.LUNABOT_SEEDANCE_TK1688_KEY !== undefined) next.tk1688Key = env.LUNABOT_SEEDANCE_TK1688_KEY.trim();
  if (env.LUNABOT_SEEDANCE_TK1688_MODEL !== undefined) next.tk1688Model = env.LUNABOT_SEEDANCE_TK1688_MODEL.trim();
  return next;
}

export function seedanceSettingEnv(cfg: SeedanceConfig | undefined): Array<[value: string | undefined, name: string]> {
  return [
    [cfg?.provider, "LUNABOT_SEEDANCE_PROVIDER"],
    [cfg?.arkEndpoint, "LUNABOT_SEEDANCE_ARK_ENDPOINT"],
    [cfg?.arkModel, "LUNABOT_SEEDANCE_ARK_MODEL"],
    [cfg?.tk1688Endpoint, "LUNABOT_SEEDANCE_TK1688_ENDPOINT"],
    [cfg?.tk1688Model, "LUNABOT_SEEDANCE_TK1688_MODEL"],
  ];
}

export function seedancePublicStatus(cfg: SeedanceConfig | undefined): SeedancePublicStatus {
  const provider: SeedanceProvider = cfg?.provider === "tk1688" ? "tk1688" : "ark";
  const arkEndpoint = cfg?.arkEndpoint?.trim() || DEFAULT_ARK_ENDPOINT;
  const arkModel = cfg?.arkModel?.trim() || DEFAULT_ARK_MODEL;
  const arkConfigured = Boolean(cfg?.arkKey?.trim());
  const tk1688Endpoint = cfg?.tk1688Endpoint?.trim() || DEFAULT_TK1688_ENDPOINT;
  const tk1688Model = cfg?.tk1688Model?.trim() || DEFAULT_TK1688_MODEL;
  const tk1688Configured = Boolean(cfg?.tk1688Key?.trim());
  const resolution = cfg?.resolution === "480p" ? "480p" : "720p";
  const duration = typeof cfg?.duration === "number" && cfg.duration >= 4 && cfg.duration <= 30 ? cfg.duration : 5;
  const ready = provider === "tk1688" ? tk1688Configured && Boolean(tk1688Endpoint) : arkConfigured;
  return {
    provider,
    arkEndpoint,
    arkModel,
    arkConfigured,
    tk1688Endpoint,
    tk1688Model,
    tk1688Configured,
    resolution,
    duration,
    ready,
    configured: ready,
  };
}
