import { fetchCompatModels, mergeCompatModels } from "../openai-compat-models.ts";
import { PI_CUSTOM_ENV, piCustomModelsFromEnv } from "./pi-custom-provider.ts";

/** 用提供方当前目录补齐 pi 的两份环境；拉取失败或返回空目录时保留现状。 */
export async function syncPiCustomProviderModels(
  catalogEnv: Record<string, string | undefined>,
  piEnv: Record<string, string | undefined>,
): Promise<void> {
  const baseUrl = catalogEnv[PI_CUSTOM_ENV.baseUrl]?.trim();
  const apiKey = catalogEnv[PI_CUSTOM_ENV.auth]?.trim();
  if (!baseUrl || !apiKey) return;
  const fetched = await fetchCompatModels({ key: apiKey, url: baseUrl });
  if (!fetched?.length) return;
  const saved = piCustomModelsFromEnv(catalogEnv);
  const merged = mergeCompatModels(saved, fetched);
  if (merged.length === saved.length && merged.every((id, index) => id === saved[index])) return;
  const serialized = merged.join(",");
  catalogEnv[PI_CUSTOM_ENV.models] = serialized;
  piEnv[PI_CUSTOM_ENV.models] = serialized;
}
