import { z } from "zod";
import type { InstanceConfig } from "./contracts.ts";
import { compatBaseUrlProblem } from "../shared/compat-base-url.ts";

export { compatBaseUrlProblem, MAX_COMPAT_BASE_URL_LENGTH } from "../shared/compat-base-url.ts";

export const ADDED_ENDPOINT_PREFIX = "openai-compat-";

/** Origin and path only. The driver appends /models and /chat/completions. */
export function endpointBaseUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value || compatBaseUrlProblem(value)) return null;
  const url = new URL(value);
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** What the instance list shows: never userinfo, query or fragment, even from a hand-edited config.json. */
export function endpointDisplayUrl(config: unknown): string | undefined {
  const raw = (config as { url?: unknown } | undefined)?.url;
  if (typeof raw !== "string") return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? `${url.origin}${url.pathname}`.replace(/\/+$/, "") : undefined;
  } catch {
    return undefined;
  }
}

export const addEndpointSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  url: z.string().max(512),
  key: z.string().trim().min(1).max(4096),
  models: z.array(z.string().trim().min(1).max(200)).max(64).optional(),
  catalog: z.enum(["lmstudio", "ollama"]).optional(),
}).strict();

export function isAddedEndpoint(instanceId: string, entry: InstanceConfig | undefined): boolean {
  return entry?.driver === "openai-compat" && instanceId.startsWith(ADDED_ENDPOINT_PREFIX);
}

