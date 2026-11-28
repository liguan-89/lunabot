// A freshly connected custom provider (key + URL saved, no models typed) used to stay dead: pi's catalog kept only its
// synthetic default, so every engine-readiness check failed and the Cloud setup wizard stalled with no hint that models
// were the missing piece. The provider's own /models list was already fetched for the key check and thrown away; this
// saves it instead.
import { checkProviderKey } from "./provider-key-check.ts";

export interface CompatModelsConfig {
  key?: string;
  url?: string;
  models?: string[];
}

/** 提供方完整的模型目录；端点无法证明目录时返回 null。Key 测试预览仍在调用方另行截断。 */
export async function fetchCompatModels(
  input: { key?: string; url?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string[] | null> {
  const key = input.key?.trim();
  const url = input.url?.trim();
  if (!key || !url) return null;
  const verdict = await checkProviderKey({ provider: "openaiCompat", key, url, allModels: true }, fetchImpl);
  return verdict.ok && verdict.check === "models" && verdict.models.length ? [...new Set(verdict.models)] : null;
}

/** 提供方顺序优先；它没列出但用户已保存的 ID 保留在末尾。 */
export function mergeCompatModels(saved: readonly string[], fetched: readonly string[]): string[] {
  return [...new Set([...fetched, ...saved])];
}

/** True when it saved the provider's own models into cfg (cfg is mutated and persist writes them through). */
export async function populateCompatModels(
  cfg: { openaiCompat?: CompatModelsConfig | null },
  patchModels: string[] | undefined,
  modelsBefore: readonly string[] | undefined,
  persist: (patch: { openaiCompat: { models: string[] } }) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const saved = cfg.openaiCompat;
  const key = saved?.key?.trim();
  const url = saved?.url?.trim();
  if (!key || !url) return false;
  if (saved?.models?.length) return false;
  // The panel and the model editor always send their models field: an empty one over models that existed is a
  // deliberate clear and stays cleared. A missing field (the key save) or an empty save on a provider that never
  // had models is a fresh connect — the case this fills.
  if (patchModels !== undefined && modelsBefore?.length) return false;
  const models = await fetchCompatModels({ key, url }, fetchImpl);
  if (!models?.length) return false;
  cfg.openaiCompat = { ...saved, models };
  persist({ openaiCompat: { models } });
  return true;
}
