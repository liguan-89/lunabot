import { useMemo, useState } from "react";
import { Activity, Check, ChevronDown, ChevronRight, Eye, EyeOff, Loader2, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { activeLocale, t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import {
  addCustomModels,
  customModelIds,
  groupModelsByProvider,
  managedModels,
  modelUsers,
  removeCustomModel,
  type ManagedModel,
  type ModelUse,
} from "@/lib/model-management";
import { ConfirmDialog } from "./ConfirmDialog";
import { BuiltInReplyWait } from "./OpenAiCompatServers";
import { Card, SettingsGroup } from "./SettingsPrimitives";
import { OpenAiCompatUrl } from "./keys/KeyPanels";
import { KeyRow } from "./keys/KeyRow";

const MODEL_PREVIEW_COUNT = 6;
const BADGE = "shrink-0 rounded-full bg-control px-1.5 py-0.5 text-[10px] font-medium leading-3 text-ink-secondary";
const QUIET_BUTTON = "shrink-0 rounded-md px-1.5 py-1 text-[12px] font-medium text-accent-text hover:bg-control disabled:cursor-default disabled:opacity-50";

type ProbeState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok"; latencyMs: number }
  | { status: "error"; latencyMs: number; message: string };

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function useLabel(use: ModelUse): string {
  switch (use.kind) {
    case "bot": return t("modelManagement.usedBy.bot", { name: use.name });
    case "fallback": return t("modelManagement.usedBy.fallback", { name: use.name });
    case "task": return t("modelManagement.usedBy.task", { name: use.name });
    case "routine": return t("modelManagement.usedBy.routine", { name: use.name });
    case "recovery": return t("modelManagement.usedBy.recovery");
  }
}

function latencyTone(latencyMs: number): string {
  if (latencyMs < 800) return "bg-success/15 text-success";
  if (latencyMs < 2500) return "bg-warning/15 text-warning";
  return "bg-danger/15 text-danger";
}

/** Luna Bot's models: the catalog pi lists plus the one custom provider, managed in one place. */
export function ModelManagement() {
  const { state, dispatch, refreshModels, refreshInstances } = useStore();
  const instance = state.instances.find((candidate) => candidate.driverKind === "piAgent");
  const config = state.config;
  const models = managedModels(instance, config);
  const zh = activeLocale().startsWith("zh");
  // The default stays on top; custom models next; the catalog's own list follows and folds after a few rows.
  const ordered = [...models.filter((model) => model.default), ...models.filter((model) => model.removable && !model.default), ...models.filter((model) => !model.removable && !model.default)];
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [probe, setProbe] = useState<ProbeState>({ status: "idle" });
  const [showAll, setShowAll] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<{ model: ManagedModel; users: ModelUse[] } | null>(null);
  const needle = filter.trim().toLowerCase();
  const matched = needle ? ordered.filter((model) => `${model.label} ${model.id} ${model.provider ?? ""}`.toLowerCase().includes(needle)) : ordered;
  const visible = needle ? matched : showAll ? ordered : ordered.slice(0, MODEL_PREVIEW_COUNT);
  const groupedVisible = useMemo(() => groupModelsByProvider(visible), [visible]);
  const hiddenCount = needle ? 0 : models.length - visible.length;
  const providerUrl = config?.openaiCompat?.url?.trim() ?? "";

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const saveModels = async (ids: string[], busyKey: string): Promise<boolean> => {
    setBusy(busyKey);
    setError(null);
    setNotice(null);
    try {
      try {
        const status = await api<ConfigStatus>("/api/config", {
          method: "PUT",
          body: JSON.stringify({
            openaiCompat: {
              url: config?.openaiCompat?.url ?? "",
              protocol: config?.openaiCompat?.protocol ?? "openai",
              models: ids,
            },
          }),
        });
        dispatch({ type: "configStatus", config: status });
      } catch (cause) {
        setError(errorText(cause));
        return false;
      }
      // The config is saved even when the catalog check fails; the saved rows still show.
      if (instance) {
        try {
          await refreshModels(instance.instanceId);
        } catch (cause) {
          setError(errorText(cause));
        }
      }
      return true;
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    if (!instance || refreshing) return;
    setRefreshing(true);
    setError(null);
    setNotice(null);
    try {
      await refreshModels(instance.instanceId);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setRefreshing(false);
    }
  };

  const testConnectivity = async () => {
    if (!instance || probe.status === "testing") return;
    setProbe({ status: "testing" });
    setError(null);
    const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
      await refreshModels(instance.instanceId);
      const elapsed = Math.max(1, Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt));
      setProbe({ status: "ok", latencyMs: elapsed });
    } catch (cause) {
      const elapsed = Math.max(1, Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt));
      setProbe({ status: "error", latencyMs: elapsed, message: errorText(cause) });
    }
  };

  const add = async () => {
    if (!providerUrl) {
      setError(t("modelManagement.urlFirst"));
      return;
    }
    const result = addCustomModels(customModelIds(config), draft);
    if (result.problem) {
      setError(t(result.problem === "empty" ? "modelManagement.typeModel" : `modelManagement.${result.problem}`));
      return;
    }
    if (result.added.length === 0) {
      setError(t("modelManagement.duplicate"));
      return;
    }
    if (await saveModels(result.ids, "add")) setDraft("");
  };

  const remove = (model: ManagedModel) => {
    if (!model.raw) return;
    void saveModels(removeCustomModel(customModelIds(config), model.raw), model.id);
  };

  const requestRemove = (model: ManagedModel) => {
    const users = modelUsers(model.id, instance?.instanceId, {
      bots: state.bots,
      routines: state.routines,
      automaticRecovery: config?.automaticRecovery,
    });
    if (users.length === 0) remove(model);
    else setConfirmRemove({ model, users });
  };

  const hiddenIds = config?.hiddenModels ?? [];
  const pinnedDefault = (model: ManagedModel) => model.default || model.id === instance?.models.default;

  const setHiddenModels = async (ids: string[], busyKey: string, noticeText: string) => {
    setBusy(busyKey);
    setError(null);
    setNotice(null);
    try {
      const status = await api<ConfigStatus>("/api/config", { method: "PATCH", body: JSON.stringify({ hiddenModels: ids }) });
      dispatch({ type: "configStatus", config: status });
      await refreshInstances({ cached: true });
      setNotice(noticeText);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const hide = (model: ManagedModel) => {
    if (pinnedDefault(model)) {
      setError(t("modelManagement.defaultCantHide"));
      return;
    }
    void setHiddenModels([...hiddenIds, model.id], `hide:${model.id}`, t("modelManagement.hiddenNotice", { model: model.label }));
  };

  const unhide = (id: string) => {
    void setHiddenModels(hiddenIds.filter((hidden) => hidden !== id), `show:${id}`, t("modelManagement.restoredNotice", { model: id }));
  };

  const setDefault = async (model: ManagedModel) => {
    if (!instance) return;
    setBusy(model.id);
    setError(null);
    setNotice(null);
    try {
      const status = await api<ConfigStatus>("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ defaultModelSelection: { instanceId: instance.instanceId, model: model.id } }),
      });
      dispatch({ type: "configStatus", config: status });
      setNotice(t("modelManagement.defaultSet", { model: model.label }));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
    <SettingsGroup
      label={t("modelManagement.title")}
      actions={
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-managed-connectivity-test
            onClick={() => void testConnectivity()}
            disabled={!instance || probe.status === "testing"}
            className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] font-medium text-ink-secondary hover:bg-control hover:text-ink disabled:cursor-default disabled:opacity-50"
          >
            {probe.status === "testing" ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Activity size={13} aria-hidden="true" />}
            {zh ? "测速" : "Test"}
          </button>
          <button type="button" onClick={() => void refresh()} disabled={!instance || refreshing}
            className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] font-medium text-ink-secondary hover:bg-control hover:text-ink disabled:cursor-default disabled:opacity-50">
            {refreshing ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
            {t("modelManagement.refresh")}
          </button>
        </div>
      }
    >
      <Card title={t("modelManagement.provider")} subtitle={t("modelManagement.providerSubtitle")}>
        <OpenAiCompatUrl models={false} />
        <div className="mt-4 text-[13px] leading-[18px] text-ink">{t("modelManagement.apiKey")}</div>
        <KeyRow id="openaiCompat" bare labelKey="modelManagement.apiKey" className="mt-1.5 px-0 pb-0" />
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <BuiltInReplyWait />
          {probe.status === "ok" && (
            <span
              data-managed-probe-status="ok"
              role="status"
              className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium tabular-nums", latencyTone(probe.latencyMs))}
            >
              <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
              {zh ? `已连通 · ${probe.latencyMs} ms` : `Connected · ${probe.latencyMs} ms`}
            </span>
          )}
          {probe.status === "error" && (
            <span
              data-managed-probe-status="error"
              role="alert"
              className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-danger/15 px-2.5 py-0.5 text-[11px] font-medium text-danger"
              title={probe.message}
            >
              <span className="size-1.5 shrink-0 rounded-full bg-danger" aria-hidden="true" />
              <span className="truncate">{zh ? `连接失败 · ${probe.message}` : `Failed · ${probe.message}`}</span>
            </span>
          )}
        </div>
      </Card>
      <Card title={t("modelManagement.models")} subtitle={t("modelManagement.modelsSubtitle")}>
        {models.length > MODEL_PREVIEW_COUNT && (
          <div className="mb-2 flex h-8 items-center gap-2 rounded-lg bg-ink/[0.05] px-2.5">
            <Search size={13} aria-hidden="true" className="shrink-0 text-ink-secondary" />
            <input
              data-managed-model-search
              type="text"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t("modelManagement.search")}
              aria-label={t("modelManagement.search")}
              autoComplete="off"
              spellCheck={false}
              className="w-full min-w-0 bg-transparent text-[12px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </div>
        )}
        {models.length === 0 ? (
          <p data-managed-models-empty className="text-[12px] leading-4 text-ink-secondary">{t("modelManagement.empty")}</p>
        ) : needle && matched.length === 0 ? (
          <p data-managed-models-nomatch className="text-[12px] leading-4 text-ink-secondary">{t("modelManagement.noMatch", { query: filter.trim() })}</p>
        ) : (
          <>
          <div data-managed-models className="flex flex-col gap-2">
            {groupedVisible.map((group) => {
              const collapsed = !needle && collapsedGroups.has(group.key);
              return (
                <div
                  key={group.key}
                  data-managed-provider-group={group.key}
                  className="overflow-hidden rounded-xl border border-hairline/35 bg-inset/25"
                >
                  <button
                    type="button"
                    data-managed-provider-toggle={group.key}
                    aria-expanded={!collapsed}
                    onClick={() => toggleGroup(group.key)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-ink/[0.04]"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      {collapsed
                        ? <ChevronRight size={13} className="shrink-0 text-ink-tertiary" aria-hidden="true" />
                        : <ChevronDown size={13} className="shrink-0 text-ink-tertiary" aria-hidden="true" />}
                      <span className="truncate text-[12px] font-semibold text-ink">{group.label}</span>
                      {group.hasCustom && <span className={BADGE}>{t("modelManagement.customBadge")}</span>}
                    </span>
                    <span className="shrink-0 rounded-full bg-control/80 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-ink-secondary">
                      {group.models.length}
                    </span>
                  </button>
                  {!collapsed && (
                    <ul className="flex flex-col border-t border-hairline/30 px-3">
                      {group.models.map((model) => (
                        <li key={model.id} data-managed-model={model.id} className="flex min-w-0 items-center gap-3 border-t border-hairline/30 py-2.5 first:border-t-0">
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate text-[13px] leading-[18px] text-ink">{model.label}</span>
                              {model.default && <span data-managed-default className={BADGE}>{t("modelManagement.defaultBadge")}</span>}
                              {model.removable && <span data-managed-custom className={BADGE}>{t("modelManagement.customBadge")}</span>}
                            </span>
                            <span className="mt-0.5 block truncate font-mono text-[11px] leading-4 text-ink-secondary">{model.id}</span>
                          </span>
                          {!model.default && (
                            <button type="button" onClick={() => void setDefault(model)} disabled={!instance || busy !== null}
                              className={cn(QUIET_BUTTON, "flex items-center gap-1")}>
                              {busy === model.id ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}
                              {t("modelManagement.setDefault")}
                            </button>
                          )}
                          <button type="button" data-managed-hide onClick={() => hide(model)}
                            disabled={busy !== null || pinnedDefault(model)}
                            aria-label={t("modelManagement.hide", { model: model.label })}
                            title={pinnedDefault(model) ? t("modelManagement.defaultCantHide") : t("modelManagement.hide", { model: model.label })}
                            className="shrink-0 rounded-md p-1.5 text-ink-tertiary hover:bg-control hover:text-ink disabled:cursor-default disabled:opacity-40">
                            {busy === `hide:${model.id}` ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}
                          </button>
                          {/* The default stays removable only after another model is made the default. */}
                          {model.removable && !model.default && (
                            <button type="button" onClick={() => requestRemove(model)} disabled={busy !== null}
                              aria-label={t("modelManagement.remove", { model: model.label })}
                              className="shrink-0 rounded-md p-1.5 text-ink-tertiary hover:bg-control hover:text-danger disabled:cursor-default disabled:opacity-50">
                              {busy === model.id ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
          {(hiddenCount > 0 || showAll) && (
            <button type="button" data-managed-more onClick={() => setShowAll(!showAll)}
              className="mt-2 self-start text-[12px] font-medium text-accent-text hover:underline">
              {showAll ? t("modelManagement.showLess") : t("modelManagement.showAll", { count: String(models.length) })}
            </button>
          )}
          </>
        )}
        {hiddenIds.length > 0 && (
          <details data-managed-hidden className="mt-3 border-t border-hairline/40 pt-3">
            <summary className="cursor-pointer text-[12px] font-medium text-ink-secondary">{t("modelManagement.hiddenTitle", { count: String(hiddenIds.length) })}</summary>
            <p className="mt-1 text-[12px] leading-4 text-ink-secondary">{t("modelManagement.hiddenNote")}</p>
            <div className="mt-1 flex flex-col">
              {hiddenIds.map((id) => (
                <div key={id} data-managed-hidden-model={id} className="flex min-w-0 items-center gap-2 py-1">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] leading-4 text-ink-secondary">{id}</span>
                  <button type="button" onClick={() => unhide(id)} disabled={busy !== null}
                    className={cn(QUIET_BUTTON, "flex items-center gap-1")}>
                    {busy === `show:${id}` ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Eye size={12} aria-hidden="true" />}
                    {t("modelManagement.unhide")}
                  </button>
                </div>
              ))}
            </div>
          </details>
        )}
        <div className="mt-3 flex items-center gap-2 border-t border-hairline/40 pt-3">
          <input
            data-managed-model-input
            type="text"
            value={draft}
            onChange={(event) => { setDraft(event.target.value); setError(null); }}
            onKeyDown={(event) => event.key === "Enter" && void add()}
            placeholder={t("modelManagement.addPlaceholder")}
            aria-label={t("modelManagement.addPlaceholder")}
            spellCheck={false}
            disabled={busy !== null}
            className="h-8 min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-2.5 font-mono text-[12px] text-ink placeholder:font-sans placeholder:text-ink-secondary focus:outline-none disabled:opacity-50"
          />
          <button type="button" onClick={() => void add()} disabled={!draft.trim() || busy !== null || !providerUrl}
            title={!providerUrl ? t("modelManagement.urlFirst") : undefined}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-control px-3 text-[12px] font-medium text-ink hover:bg-raised-hover disabled:cursor-default disabled:opacity-50">
            {busy === "add" ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Plus size={13} aria-hidden="true" />}
            {t("modelManagement.add")}
          </button>
        </div>
        <p className={cn("mt-1.5 text-[12px] leading-4", providerUrl ? "text-ink-secondary" : "text-warning")}>
          {t(providerUrl ? "modelManagement.addHint" : "modelManagement.urlFirst")}
        </p>
        {notice && <p role="status" className="mt-1.5 text-[12px] leading-4 text-success">{notice}</p>}
        {error && <p role="alert" className="mt-1.5 text-[12px] leading-4 text-danger">{error}</p>}
      </Card>
    </SettingsGroup>
    <ConfirmDialog
      open={confirmRemove !== null}
      title={t("modelManagement.removeInUseTitle", { model: confirmRemove?.model.label ?? "" })}
      body={confirmRemove && (
        <span className="block">
          <span className="block">{t("modelManagement.removeInUseBody", { count: String(confirmRemove.users.length) })}</span>
          <span className="mt-2 flex flex-col gap-0.5">
            {confirmRemove.users.slice(0, 5).map((use, index) => <span key={`${use.kind}:${use.name}:${index}`}>• {useLabel(use)}</span>)}
          </span>
          {confirmRemove.users.length > 5 && <span className="mt-1 block">{t("modelManagement.removeInUseMore", { count: String(confirmRemove.users.length - 5) })}</span>}
        </span>
      )}
      confirmLabel={t("modelManagement.removeAnyway")}
      cancelLabel={t("common.cancel")}
      tone="danger"
      pending={busy !== null}
      onCancel={() => setConfirmRemove(null)}
      onConfirm={() => {
        const model = confirmRemove?.model;
        setConfirmRemove(null);
        if (model) remove(model);
      }}
    />
    </>
  );
}
