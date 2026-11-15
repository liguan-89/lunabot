// Security: the key is write-only; the server reports configured-or-not, never the value.
import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink, Loader2 } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { Card, SettingRow, Switch } from "./SettingsPrimitives";
import { Select } from "./Select";
import { WorkersAiKeyCard } from "./WorkersAiKeyCard";
import { openKeySettings } from "./keys/key-focus";

const KEY_URL = { jev: "https://typesafe.ai", openrouter: "https://openrouter.ai/keys" } as const;
/** The room decision budget in server/decider/room-routing.ts; slower falls back to the lead. */
const ROOM_BUDGET_MS = 1_500;

type Provider = "jev" | "laya" | "openrouter";
type ModelList = { source: "openrouter" | "builtin"; models: Array<{ id: string; name: string; group: "recommended" | "more"; api?: "chat" | "decisions" }> };
type LayaServiceStatus = {
  available: boolean;
  installed: boolean;
  running: boolean;
  busy: boolean;
  operation: "idle" | "starting" | "ready" | "error";
  model: string;
  progress?: string;
  error?: string;
};
type TestResult = { ok: true; latencyMs: number } | { ok: false; reason: string; status?: number };

const FAILURES: Record<string, LocaleKey> = {
  rejected: "decider.error.rejected",
  unreachable: "decider.error.unreachable",
  timeout: "decider.error.timeout",
  rate_limited: "decider.error.rateLimited",
  overloaded: "decider.error.overloaded",
  malformed: "decider.error.malformed",
  no_key: "decider.error.noKey",
  misconfigured: "decider.error.misconfigured",
};

/** Cloud Pro's relay refuses an inactive subscription (402) and a used-up month of decisions (429). */
const INCLUDED_FAILURES: Record<string, LocaleKey> = {
  rejected: "decider.included.error.rejected",
  rate_limited: "decider.included.error.limited",
};

const OPENROUTER_FAILURES: Record<string, LocaleKey> = {
  ...FAILURES,
  rejected: "decider.openrouter.error.rejected",
  unreachable: "decider.openrouter.error.unreachable",
  timeout: "decider.openrouter.error.timeout",
  rate_limited: "decider.openrouter.error.rateLimited",
  overloaded: "decider.openrouter.error.overloaded",
  malformed: "decider.openrouter.error.malformed",
};

const WORKERS_AI_FAILURES: Record<string, LocaleKey> = {
  ...FAILURES,
  rejected: "decider.workersAi.error.rejected",
  unreachable: "decider.workersAi.error.unreachable",
  timeout: "decider.workersAi.error.timeout",
  rate_limited: "decider.workersAi.error.rateLimited",
  overloaded: "decider.workersAi.error.overloaded",
  malformed: "decider.workersAi.error.malformed",
};

const BY: Record<"jev" | "laya" | "workersai" | "openrouter", LocaleKey> = {
  jev: "decider.status.byJev", laya: "decider.status.byLaya", workersai: "decider.status.byWorkersAi", openrouter: "decider.status.byOpenRouter",
};

/** Who decides and who reads, in a word each: the person's own key, the Cloud plan's, or nothing yet. */
export function helpersStatusLine(config: ConfigStatus | null): string {
  const decider = config?.decider;
  const extraction = config?.helpers?.extraction;
  const decisions = !decider?.configured ? t("decider.status.notSetUp")
    : decider.included ? t("decider.status.byCloud") : t(BY[decider.provider] ?? BY.jev);
  const reading = !extraction?.provider ? t("decider.status.notSetUp")
    : extraction.included ? t("decider.status.byCloud") : t(BY[extraction.provider]);
  return t("decider.status.line", { decisions, extraction: reading });
}

/** A fixed sentence per failure: the vendor's own body never reaches the UI. */
export function deciderFailureText(result: { reason: string; status?: number }, included = false, provider: Provider | "workersai" = "jev"): string {
  if (provider === "workersai") {
    if (result.reason === "http_error") return t("decider.workersAi.error.http", { status: String(result.status ?? "?") });
    const key = WORKERS_AI_FAILURES[result.reason];
    return key ? t(key) : t("decider.error.other");
  }
  if (provider === "openrouter") {
    // 402 is OpenRouter's answer for an account with no credits left.
    if (result.reason === "http_error" && result.status === 402) return t("decider.openrouter.error.credits");
    if (result.reason === "http_error") return t("decider.openrouter.error.http", { status: String(result.status ?? "?") });
    const key = OPENROUTER_FAILURES[result.reason];
    return key ? t(key) : t("decider.error.other");
  }
  if (included && result.reason === "http_error" && result.status === 402) return t("decider.included.error.subscription");
  if (included && INCLUDED_FAILURES[result.reason]) return t(INCLUDED_FAILURES[result.reason]!);
  if (result.reason === "http_error") return t("decider.error.http", { status: String(result.status ?? "?") });
  const key = FAILURES[result.reason];
  return key ? t(key) : t("decider.error.other");
}

const COMING_SOON: LocaleKey[] = ["decider.jobs.browserClicks", "decider.jobs.toolSelection", "decider.jobs.placement"];

export function DecisionModelSettings() {
  const { state, dispatch } = useStore();
  const decider = state.config?.decider;
  const [localLayaSelected, setLocalLayaSelected] = useState(false);
  const provider: Provider = localLayaSelected ? "laya" : decider?.provider === "openrouter" ? "openrouter" : decider?.provider === "laya" ? "laya" : "jev";
  const openrouter = provider === "openrouter";
  const laya = provider === "laya";
  const [localLaya, setLocalLaya] = useState<LayaServiceStatus | null>(null);
  const [localLayaBusy, setLocalLayaBusy] = useState(false);
  const [localLayaError, setLocalLayaError] = useState<string | null>(null);
  const localConfigured = laya && localLaya?.operation === "ready" && localLaya.running;
  const configured = laya ? Boolean(localConfigured) : decider?.configured ?? false;
  const included = !laya && configured && decider?.included === true;
  const usingShared = openrouter && configured && decider?.keySource === "shared";
  const sharedKey = openrouter && decider?.sharedKey === true;
  const ownKey = configured && !included && !usingShared && !laya;
  const enabled = laya && decider?.provider !== "laya" ? false : decider?.enabled ?? false;
  const roomRouting = decider?.jobs.roomRouting ?? true;
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<{ ok: boolean; text: string } | null>(null);
  const [models, setModels] = useState<ModelList | null>(null);
  const draft = value.trim();
  const clearing = !draft && ownKey;
  const keyHint: LocaleKey | null = !openrouter || included
    ? null
    : usingShared
      ? "decider.openrouter.status.sharedHint"
      : !configured
        ? "decider.openrouter.status.notConnectedHint"
        : sharedKey
          ? "decider.openrouter.status.ownFallbackHint"
          : null;

  const applied = (config: ConfigStatus) => dispatch({ type: "configStatus", config });

  const patch = async (decision: Record<string, unknown>) => {
    if (switching) return;
    setSwitching(true);
    setError(null);
    try {
      applied(await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ decider: decision }) }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSwitching(false);
    }
  };

  const localLayaGeneration = useRef(0);
  useEffect(() => {
    if (!laya) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const generation = localLayaGeneration.current;
    const refresh = async () => {
      try {
        const next = await api<LayaServiceStatus>("/api/decider/laya", { timeoutMs: 5_000 });
        if (cancelled || generation !== localLayaGeneration.current) return;
        setLocalLaya(next);
        setLocalLayaBusy(next.operation === "starting");
        if (next.operation === "starting") timer = setTimeout(() => void refresh(), 1_000);
        else if (next.operation === "ready") {
          const config = await api<ConfigStatus>("/api/config");
          if (!cancelled && generation === localLayaGeneration.current) applied(config);
        } else if (next.error) setLocalLayaError(next.error);
      } catch {
        if (cancelled || generation !== localLayaGeneration.current) return;
        setLocalLayaError(t("decider.laya.error"));
        setLocalLayaBusy(false);
      }
    };
    void refresh();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [laya]);

  const runLocalLaya = async (action: "start" | "stop"): Promise<boolean> => {
    if (action === "start" && localLayaBusy) return false;
    const run = ++localLayaGeneration.current;
    setLocalLayaBusy(true);
    setLocalLayaError(null);
    if (action === "start") {
      try {
        const next = await api<LayaServiceStatus>("/api/decider/laya/start", { method: "POST", body: "{}", timeoutMs: 10_000 });
        if (run !== localLayaGeneration.current) return false;
        setLocalLaya(next);
        setLocalLayaBusy(next.operation === "starting");
        if (next.operation === "ready") {
          const config = await api<ConfigStatus>("/api/config");
          if (run !== localLayaGeneration.current) return false;
          applied(config);
          return true;
        }
        return next.operation === "starting";
      } catch {
        if (run !== localLayaGeneration.current) return false;
        setLocalLayaBusy(false);
        setLocalLayaError(t("decider.laya.error"));
        return false;
      }
    }
    try {
      const next = await api<LayaServiceStatus>("/api/decider/laya/stop", { method: "POST", body: "{}", timeoutMs: 10_000 });
      if (run !== localLayaGeneration.current) return false;
      setLocalLaya(next);
      setLocalLayaSelected(false);
      setLocalLayaBusy(false);
      const config = await api<ConfigStatus>("/api/config");
      if (run !== localLayaGeneration.current) return false;
      applied(config);
      return true;
    } catch {
      if (run !== localLayaGeneration.current) return false;
      setLocalLayaBusy(false);
      setLocalLayaError(t("decider.laya.error"));
      return false;
    }
  };

  useEffect(() => {
    if (!openrouter || models) return;
    let cancelled = false;
    api<ModelList>("/api/decider/models").then(
      (list) => { if (!cancelled) setModels(list); },
      () => undefined,
    );
    return () => { cancelled = true; };
  }, [openrouter, models]);

  const choose = (decision: { provider: "jev" | "openrouter" } | { openrouterModel: string; openrouterApi: "chat" | "decisions" }) => {
    setValue("");
    setVerdict(null);
    void patch(decision);
  };

  const save = async () => {
    if (laya || saving || (!draft && !ownKey)) return;
    setSaving(true);
    setError(null);
    setVerdict(null);
    try {
      const status = window.ogb?.setCredential
        ? await window.ogb.setCredential(openrouter ? "openrouterDeciderKey" : "jevApiKey", draft)
        : await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ decider: { [openrouter ? "openrouterKey" : "key"]: draft } }) });
      applied(status);
      setValue("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (laya || testing || saving || (!draft && !configured)) return;
    setTesting(true);
    setVerdict(null);
    setError(null);
    const testingIncluded = !draft && included;
    const testingShared = !draft && usingShared;
    try {
      const result = await api<TestResult>("/api/decider/test", { method: "POST", body: JSON.stringify(draft ? { key: draft } : {}) });
      setVerdict(result.ok
        ? {
          ok: true,
          text: openrouter
            ? [
              t(testingShared ? "decider.openrouter.test.okShared" : "decider.openrouter.test.ok", { ms: String(result.latencyMs) }),
              ...(result.latencyMs > ROOM_BUDGET_MS ? [t("decider.test.slow")] : []),
            ].join(" ")
            : t("decider.test.ok", { ms: String(result.latencyMs) }),
        }
        : { ok: false, text: deciderFailureText(result, testingIncluded, provider) });
    } catch (cause) {
      setVerdict({ ok: false, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <section className="space-y-2 px-4">
        <p className="text-[13px] leading-relaxed text-ink-secondary">{t("decider.intro")}</p>
        <p role="status" data-testid="helpers-status" className="text-[13px] font-medium text-ink">{helpersStatusLine(state.config)}</p>
      </section>
      <WorkersAiKeyCard failureText={(result) => deciderFailureText(result, false, "workersai")} />
      <SettingRow title={t("decider.provider.label")}>
        <Select className="w-48"
          data-testid="decider-provider"
          value={provider}
          onChange={(event) => {
            const next = event.target.value === "openrouter" ? "openrouter" : "jev";
            if (event.target.value === "laya") {
              setLocalLayaSelected(true);
              void runLocalLaya("start");
            } else if (laya && (localLayaBusy || localLaya?.running)) {
              void (async () => {
                if (await runLocalLaya("stop")) choose({ provider: next });
              })();
            } else {
              setLocalLayaSelected(false);
              choose({ provider: next });
            }
          }}
          disabled={switching || !state.config}
          aria-label={t("decider.provider.label")}
        >
          <option value="jev">{t("decider.provider.jev")}</option>
          <option value="laya">{t("decider.provider.laya")}</option>
          <option value="openrouter">{t("decider.provider.openrouter")}</option>
        </Select>
      </SettingRow>
      {openrouter && (
        <SettingRow title={t("decider.model.label")} subtitle={models?.source === "builtin" ? t("decider.model.builtinNote") : undefined}>
          <Select className="w-64 max-w-full"
            data-testid="decider-model"
            value={decider?.model ?? ""}
            onChange={(event) => choose({
              openrouterModel: event.target.value,
              openrouterApi: models?.models.find((model) => model.id === event.target.value)?.api ?? "chat",
            })}
            disabled={switching}
            aria-label={t("decider.model.label")}
          >
            {decider?.model && !models?.models.some((model) => model.id === decider.model) && (
              <option value={decider.model}>{decider.model}</option>
            )}
            {(["recommended", "more"] as const).map((group) => {
              const inGroup = models?.models.filter((model) => model.group === group) ?? [];
              return inGroup.length > 0 && (
                <optgroup key={group} label={t(group === "recommended" ? "decider.model.recommended" : "decider.model.more")}>
                  {inGroup.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                </optgroup>
              );
            })}
          </Select>
        </SettingRow>
      )}
      <SettingRow
        title={t(openrouter ? "decider.openrouter.master" : "decider.master")}
        subtitle={laya ? t("decider.laya.masterHint") : configured ? undefined : t(openrouter ? "decider.masterNeedsKey.openrouter" : "decider.masterNeedsKey")}
      >
        <Switch
          data-testid="decider-master"
          aria-label={t(openrouter ? "decider.openrouter.master" : "decider.master")}
          checked={enabled}
          disabled={!configured || switching || !state.config || (laya && !localLaya?.running)}
          onClick={() => void patch({ enabled: !enabled })}
          className="cursor-pointer"
        />
      </SettingRow>

      {laya ? (
        <Card title={t("decider.laya.title")}>
          <div role="status" data-testid="local-laya-status" className="flex items-center gap-2 text-[13px] text-ink-secondary">
            <span className={cn("size-1.5 rounded-full", localConfigured ? "bg-success" : "bg-raised-hover")} />
            <span>{localLaya?.progress ?? (localConfigured ? t("decider.laya.ready", { model: localLaya?.model ?? "Laya" }) : !localLaya ? t("decider.laya.preparing") : localLaya.installed ? t("decider.laya.installed") : localLaya.available ? t("decider.laya.notInstalled") : t("decider.laya.unsupported"))}</span>
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("decider.laya.detail")}</p>
          {localLayaError && <p role="alert" className="mt-2 text-[12px] text-danger">{localLayaError}</p>}
          {localLaya?.error && <p role="alert" className="mt-2 text-[12px] text-danger">{localLaya.error}</p>}
          <div className="mt-3 flex justify-end">
            {localLaya?.running || localLayaBusy
              ? <button type="button" data-testid="local-laya-stop" disabled={false} onClick={() => void runLocalLaya("stop")} className="cursor-pointer rounded-lg border border-hairline/40 px-3 py-2 text-[13px] text-ink-secondary">{localLayaBusy ? t("decider.laya.cancel") : t("decider.laya.stop")}</button>
              : <button type="button" data-testid="local-laya-start" disabled={!localLaya?.available || localLayaBusy} onClick={() => void runLocalLaya("start")} className="flex cursor-pointer items-center gap-2 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">{localLayaBusy && <Loader2 size={14} className="animate-spin" />}{localLaya?.installed ? t("decider.laya.start") : t("decider.laya.install")}</button>}
          </div>
        </Card>
      ) : (
      <Card title={t(openrouter ? "decider.openrouter.key.label" : "decider.key.label")}>
        <div role="status" className="mb-2 flex items-center gap-2 text-[13px] text-ink-secondary">
          <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
          <span className={configured ? "text-success" : undefined}>
            {included
              ? t("keys.includedWithCloudPro")
              : usingShared
                ? t("decider.openrouter.status.shared")
                : configured
                  ? t(sharedKey ? "decider.openrouter.status.own" : "decider.status.connected")
                  : t("decider.status.notConnected")}
          </span>
        </div>
        {keyHint && (
          <p className="mb-2 text-[12px] leading-relaxed text-ink-secondary">
            {t(keyHint)}
            {!ownKey && (
              <>
                {" "}
                <button
                  type="button"
                  data-testid="decider-manage-keys"
                  onClick={() => dispatch(openKeySettings("openrouter"))}
                  className="cursor-pointer text-accent hover:underline"
                >
                  {t("decider.openrouter.key.manageLink")}
                </button>
              </>
            )}
          </p>
        )}
        <div className="flex gap-2">
          <input
            type="password"
            value={value}
            onChange={(event) => { setVerdict(null); setError(null); setValue(event.target.value); }}
            onKeyDown={(event) => event.key === "Enter" && void save()}
            disabled={saving}
            placeholder={ownKey ? t("keys.replace") : t(usingShared ? "decider.openrouter.key.overridePlaceholder" : openrouter ? "decider.openrouter.key.placeholder" : "decider.key.placeholder")}
            aria-label={t(openrouter ? "decider.openrouter.key.label" : "decider.key.label")}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
          <button
            type="button"
            data-testid="decider-save"
            onClick={() => void save()}
            disabled={saving || (!draft && !ownKey)}
            title={clearing ? t("keys.removeKey") : t("common.save")}
            className={cn(
              "flex w-[72px] shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50",
              clearing ? "text-danger" : "text-ink",
            )}
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : clearing ? t("keys.clear") : <><Check size={13} />{t("common.save")}</>}
          </button>
          <button
            type="button"
            data-testid="decider-test"
            onClick={() => void test()}
            disabled={testing || saving || (!draft && !configured)}
            className="flex shrink-0 cursor-pointer items-center justify-center rounded-lg border border-hairline/40 px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {testing ? t("keys.testing") : t("keys.test")}
          </button>
        </div>
        {error && <p role="alert" className="mt-1 text-[12px] text-danger">{error}</p>}
        {verdict && <p role="status" className={cn("mt-1 text-[12px]", verdict.ok ? "text-success" : "text-danger")}>{verdict.text}</p>}
        {!usingShared && (
          <a
            href={KEY_URL[provider]}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex cursor-pointer items-center gap-1 text-[12px] text-accent hover:underline"
          >
            {t(openrouter ? "decider.openrouter.key.getKey" : "decider.key.getKey")}
            <ExternalLink size={11} aria-hidden="true" />
          </a>
        )}
      </Card>
      )}

      <Card title={t("decider.jobs.title")}>
        <ul className="flex flex-col">
          <li className="flex items-start justify-between gap-4 py-2">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-ink">{t("decider.jobs.roomRouting")}</div>
              <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("decider.jobs.roomRoutingDetail")}</div>
            </div>
            <Switch
              data-testid="decider-job-roomRouting"
              aria-label={t("decider.jobs.roomRouting")}
              checked={enabled && roomRouting}
              disabled={!enabled || switching}
              onClick={() => void patch({ jobs: { roomRouting: !roomRouting } })}
              className="cursor-pointer"
            />
          </li>
          {COMING_SOON.map((label) => (
            <li key={label} data-testid="decider-coming-soon" aria-disabled="true" className="flex items-center justify-between gap-4 border-t border-hairline/40 py-2 opacity-50">
              <span className="text-[13px] text-ink-secondary">{t(label)}</span>
              <span className="rounded bg-control px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-secondary">
                {t("decider.jobs.comingSoon")}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
