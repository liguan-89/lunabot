import type { ConfigStatus } from "@/state/config-status";
import type { InstanceInfo } from "@/state/store";

/** What the server accepts per custom provider. */
export const MAX_CUSTOM_MODELS = 64;
export const MAX_MODEL_ID_LENGTH = 200;

export interface ManagedModel {
  /** The id bots select: `provider/model` for the custom provider, pi's own id otherwise. */
  id: string;
  label: string;
  provider?: string;
  /** Comes from Luna Bot's one custom provider, so it can be removed here. */
  removable: boolean;
  /** The model new bots start with. */
  default: boolean;
  /** The raw model id the custom provider serves. */
  raw?: string;
}

export function customModelIds(config: ConfigStatus | null | undefined): string[] {
  return [...(config?.openaiCompat?.models ?? [])];
}

/** The catalog id `mergePiCustomCatalog` gives a raw model id. */
export function customModelId(providerId: string, raw: string): string {
  return `${providerId}/${raw}`;
}

function rawModelId(id: string, providerId: string | undefined): string | undefined {
  if (!providerId || !id.startsWith(`${providerId}/`)) return undefined;
  return id.slice(providerId.length + 1) || undefined;
}

/** One row per model the pi instance can run, including saved custom models the catalog has not listed yet. */
export function managedModels(instance: InstanceInfo | undefined, config: ConfigStatus | null | undefined): ManagedModel[] {
  const providerId = config?.openaiCompat?.providerId;
  const configured = new Set(customModelIds(config));
  const defaultSelection = config?.defaultModelSelection;
  const rows: ManagedModel[] = [];
  const seen = new Set<string>();

  for (const option of instance?.models.options ?? []) {
    if (seen.has(option.id)) continue;
    seen.add(option.id);
    const raw = rawModelId(option.id, providerId);
    const removable = raw !== undefined && configured.has(raw);
    rows.push({
      id: option.id,
      label: removable ? raw! : option.label || option.id,
      ...(option.provider ? { provider: option.provider } : {}),
      removable,
      default: Boolean(instance && defaultSelection?.instanceId === instance.instanceId && defaultSelection.model === option.id),
      ...(removable ? { raw } : {}),
    });
  }

  // A saved id the catalog has not listed (pi unavailable, or its model list still loading) is still manageable.
  if (providerId) {
    for (const raw of configured) {
      const id = customModelId(providerId, raw);
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push({
        id,
        label: raw,
        provider: providerId,
        removable: true,
        default: Boolean(instance && defaultSelection && defaultSelection.instanceId === instance.instanceId && defaultSelection.model === id),
        raw,
      });
    }
  }
  return rows;
}

export type AddModelsProblem = "empty" | "limit" | "length";

/** Adds comma/space separated ids, de-duplicated; leaves `ids` untouched when nothing can be added. */
export function addCustomModels(ids: readonly string[], text: string): { ids: string[]; added: string[]; problem?: AddModelsProblem } {
  const incoming = [...new Set(text.split(/[,，、\s]+/).map((id) => id.trim()).filter(Boolean))];
  if (incoming.length === 0) return { ids: [...ids], added: [], problem: "empty" };
  if (incoming.some((id) => id.length > MAX_MODEL_ID_LENGTH)) return { ids: [...ids], added: [], problem: "length" };
  const added = incoming.filter((id) => !ids.includes(id));
  if (ids.length + added.length > MAX_CUSTOM_MODELS) return { ids: [...ids], added: [], problem: "limit" };
  return { ids: [...ids, ...added], added };
}

export function removeCustomModel(ids: readonly string[], raw: string): string[] {
  return ids.filter((id) => id !== raw);
}

export type ModelUseKind = "bot" | "fallback" | "task" | "routine" | "recovery";

export interface ModelUse {
  kind: ModelUseKind;
  /** The bot or routine using it; empty for the recovery backup. */
  name: string;
}

interface SelectionLike { instanceId: string; model: string }

export interface ModelUseSources {
  bots?: ReadonlyArray<{
    name: string;
    modelSelection?: SelectionLike;
    fallback?: ReadonlyArray<SelectionLike>;
    tasks?: ReadonlyArray<{ modelSelection?: SelectionLike }>;
  }>;
  routines?: ReadonlyArray<{ name: string; modelSelection?: SelectionLike }>;
  automaticRecovery?: { enabled: boolean; backup?: SelectionLike };
}

/** Everything that would be left pointing at a model once it is removed. */
export function modelUsers(modelId: string, instanceId: string | undefined, sources: ModelUseSources): ModelUse[] {
  if (!instanceId) return [];
  const names = (selection?: SelectionLike) => Boolean(selection && selection.instanceId === instanceId && selection.model === modelId);
  const uses: ModelUse[] = [];
  for (const bot of sources.bots ?? []) {
    if (names(bot.modelSelection)) uses.push({ kind: "bot", name: bot.name });
    if ((bot.fallback ?? []).some(names)) uses.push({ kind: "fallback", name: bot.name });
    if ((bot.tasks ?? []).some((task) => names(task.modelSelection))) uses.push({ kind: "task", name: bot.name });
  }
  for (const routine of sources.routines ?? []) {
    if (names(routine.modelSelection)) uses.push({ kind: "routine", name: routine.name });
  }
  if (sources.automaticRecovery?.enabled && names(sources.automaticRecovery.backup)) uses.push({ kind: "recovery", name: "" });
  const seen = new Set<string>();
  return uses.filter((use) => {
    const key = `${use.kind}:${use.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}