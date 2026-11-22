import { useState } from "react";
import { Check, Loader2 } from "lucide-react";

import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { Card, SettingRow } from "./SettingsPrimitives";
import { Select } from "./Select";

type SeedanceProvider = "ark" | "tk1688";

const INPUT_CLASS =
  "w-full min-w-0 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none disabled:opacity-50";

export function VideoGenerationSettings() {
  const { state, dispatch } = useStore();
  const status = state.config?.seedance;
  const provider: SeedanceProvider = status?.provider === "tk1688" ? "tk1688" : "ark";
  const resolution = status?.resolution === "480p" ? "480p" : "720p";
  const duration = status?.duration ?? 5;
  const ready = Boolean(status?.ready ?? status?.configured);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (seedancePatch: Record<string, unknown>) => {
    setSaving(true);
    setError(null);
    try {
      const next: ConfigStatus = await api("/api/config", {
        method: "PUT",
        body: JSON.stringify({ seedance: seedancePatch }),
      });
      dispatch({ type: "configStatus", config: next });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const providerLabel = t(provider === "tk1688" ? "videoGen.providerTk1688" : "videoGen.providerArk");
  return (
    <>
      <section className="space-y-2 px-4">
        <p className="text-[13px] leading-relaxed text-ink-secondary">{t("videoGen.intro")}</p>
        <p role="status" data-testid="video-gen-status" className="flex items-center gap-2 text-[13px] font-medium text-ink">
          <span className={cn("size-1.5 shrink-0 rounded-full", ready ? "bg-success" : "bg-raised-hover")} />
          {ready ? t("videoGen.ready", { provider: providerLabel, resolution }) : t("videoGen.notConfigured")}
        </p>
      </section>

      <SettingRow title={t("videoGen.providerTitle")} subtitle={t("videoGen.providerSub")}>
        <Select
          className="w-48"
          data-testid="video-gen-provider"
          value={provider}
          onChange={(e) => void save({ provider: e.target.value })}
          disabled={saving || !state.config}
          aria-label={t("videoGen.providerTitle")}
        >
          <option value="ark">{t("videoGen.providerArk")}</option>
          <option value="tk1688">{t("videoGen.providerTk1688")}</option>
        </Select>
      </SettingRow>

      <SettingRow title={t("videoGen.resolutionTitle")} subtitle={t("videoGen.resolutionSub")}>
        <Select
          className="w-32"
          data-testid="video-gen-resolution"
          value={resolution}
          onChange={(e) => void save({ resolution: e.target.value })}
          disabled={saving || !state.config}
          aria-label={t("videoGen.resolutionTitle")}
        >
          <option value="720p">720p</option>
          <option value="480p">480p</option>
        </Select>
      </SettingRow>

      <SettingRow title={t("videoGen.durationTitle")} subtitle={t("videoGen.durationSub")}>
        <Select
          className="w-28"
          data-testid="video-gen-duration"
          value={String(duration)}
          onChange={(e) => void save({ duration: Number(e.target.value) })}
          disabled={saving || !state.config}
          aria-label={t("videoGen.durationTitle")}
        >
          {[4, 5, 6, 8, 10, 15].map((sec) => (
            <option key={sec} value={sec}>{t("videoGen.seconds", { count: sec })}</option>
          ))}
        </Select>
      </SettingRow>

      {error && <p role="alert" className="px-4 text-[12px] text-danger">{error}</p>}

      <VideoProviderCard
        provider="tk1688"
        title={t("videoGen.tk1688Title")}
        credentialName="seedanceTk1688Key"
        configured={Boolean(status?.tk1688Configured)}
        last4={state.config?.savedKeys?.seedanceTk1688Key?.last4}
        endpoint={status?.tk1688Endpoint || "https://api.tk1688.com/v1"}
        endpointPlaceholder="https://api.tk1688.com/v1"
        model={status?.tk1688Model || "doubao-seedance-2-5-260628-sec-720p"}
        modelPlaceholder="doubao-seedance-2-5-260628-sec-720p"
        hint={t("videoGen.tk1688Hint")}
      />

      <VideoProviderCard
        provider="ark"
        title={t("videoGen.arkTitle")}
        credentialName="seedanceArkKey"
        configured={Boolean(status?.arkConfigured)}
        last4={state.config?.savedKeys?.seedanceArkKey?.last4}
        endpoint={status?.arkEndpoint || "https://ark.cn-beijing.volces.com/api/v3"}
        endpointPlaceholder="https://ark.cn-beijing.volces.com/api/v3"
        model={status?.arkModel || "doubao-seedance-1-5-pro-251215"}
        modelPlaceholder="doubao-seedance-1-5-pro-251215"
        hint={t("videoGen.arkHint")}
      />
    </>
  );
}

function VideoProviderCard({
  provider,
  title,
  credentialName,
  configured,
  last4,
  endpoint,
  endpointPlaceholder,
  model,
  modelPlaceholder,
  hint,
}: {
  provider: SeedanceProvider;
  title: string;
  credentialName: "seedanceArkKey" | "seedanceTk1688Key";
  configured: boolean;
  last4?: string;
  endpoint: string;
  endpointPlaceholder: string;
  model: string;
  modelPlaceholder: string;
  hint: string;
}) {
  const { dispatch } = useStore();
  const [keyInput, setKeyInput] = useState("");
  const [endpointDraft, setEndpointDraft] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (work: () => Promise<ConfigStatus>) => {
    setSaving(true);
    setError(null);
    try {
      dispatch({ type: "configStatus", config: await work() });
      setKeyInput("");
      setEndpointDraft(null);
      setModelDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const saveKey = (key: string) =>
    run(() => {
      if (window.ogb?.setCredential) {
        return window.ogb.setCredential(credentialName, key);
      }
      const patch = provider === "tk1688" ? { seedance: { tk1688Key: key } } : { seedance: { arkKey: key } };
      return api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify(patch) });
    });

  const saveMeta = () =>
    run(() => {
      const nextEndpoint = (endpointDraft ?? endpoint).trim();
      const nextModel = (modelDraft ?? model).trim();
      const patch =
        provider === "tk1688"
          ? { seedance: { tk1688Endpoint: nextEndpoint, tk1688Model: nextModel } }
          : { seedance: { arkEndpoint: nextEndpoint, arkModel: nextModel } };
      return api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify(patch) });
    });

  const metaDirty = endpointDraft !== null || modelDraft !== null;

  return (
    <Card title={title}>
      <div role="status" className="mb-2 flex items-center gap-2 text-[13px] text-ink-secondary">
        <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
        <span className={configured ? "text-success" : undefined}>
          {configured ? t("videoGen.keySaved", { suffix: last4 ? t("videoGen.keySavedLast4", { last4 }) : "" }) : t("videoGen.keyMissing")}
        </span>
      </div>

      <div className="mb-2 flex gap-2">
        <input
          type="password"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && keyInput.trim() && void saveKey(keyInput.trim())}
          disabled={saving}
          placeholder={configured ? t("videoGen.keyReplace") : t("videoGen.keyPlaceholder")}
          aria-label={`${title} API Key`}
          autoComplete="off"
          spellCheck={false}
          className={INPUT_CLASS}
        />
        <button
          type="button"
          onClick={() => void saveKey(keyInput.trim())}
          disabled={saving || !keyInput.trim()}
          className="ui-button ui-button-primary shrink-0"
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
          {t("common.save")}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input
          type="url"
          value={endpointDraft ?? endpoint}
          onChange={(e) => setEndpointDraft(e.target.value)}
          disabled={saving}
          placeholder={endpointPlaceholder}
          aria-label={t("videoGen.endpointAria", { title })}
          autoComplete="off"
          className={INPUT_CLASS}
        />
        <input
          type="text"
          value={modelDraft ?? model}
          onChange={(e) => setModelDraft(e.target.value)}
          disabled={saving}
          placeholder={modelPlaceholder}
          aria-label={t("videoGen.modelAria", { title })}
          autoComplete="off"
          spellCheck={false}
          className={INPUT_CLASS}
        />
        <button
          type="button"
          onClick={() => void saveMeta()}
          disabled={saving || !metaDirty}
          className="ui-button shrink-0"
        >
          {t("videoGen.updateMeta")}
        </button>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 text-[12px] text-ink-secondary">
        <span>{hint}</span>
        {configured && (
          <button
            type="button"
            onClick={() => void saveKey("")}
            disabled={saving}
            className="ui-button ui-button-sm ui-button-danger shrink-0"
          >
            {t("videoGen.removeKey")}
          </button>
        )}
      </div>

      {error && <p role="alert" className="mt-1 text-[12px] text-danger">{error}</p>}
    </Card>
  );
}
