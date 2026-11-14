import { useState } from "react";

import { t } from "@/lib/i18n";
import { api, useStore } from "@/state/store";
import type { LiveProvider, LiveSettings } from "../../shared/wire";
import { Select } from "./Select";

type ProviderPatch = Partial<Pick<LiveSettings, "provider" | "azureEndpoint" | "azureDeployment" | "qwenEndpoint" | "qwenModel" | "volcAppId" | "volcModel">>;

const FIELD = "w-full rounded-lg border border-hairline bg-inset px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent/60";

function Field({ label, hint, ...input }: { label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] text-ink-secondary">{label}</span>
      <input autoComplete="off" spellCheck={false} className={FIELD} {...input} />
      {hint && <span className="text-[12px] text-ink-tertiary">{hint}</span>}
    </label>
  );
}

export function LiveProviderSettings() {
  const { state, dispatch } = useStore();
  const live: LiveSettings = state.config?.live ?? { configured: false, voice: "", readTypedReplies: true, idleMinutes: 5 };
  const provider: LiveProvider = live.provider ?? "openai";
  const [endpoint, setEndpoint] = useState(live.azureEndpoint ?? "");
  const [deployment, setDeployment] = useState(live.azureDeployment ?? "");
  const [qwenEndpoint, setQwenEndpoint] = useState(live.qwenEndpoint ?? "");
  const [qwenModel, setQwenModel] = useState(live.qwenModel ?? "");
  const [volcAppId, setVolcAppId] = useState(live.volcAppId ?? "");
  const [volcModel, setVolcModel] = useState(live.volcModel ?? "");
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<{ ok: boolean; error?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const azureChanged = endpoint.trim() !== (live.azureEndpoint ?? "") || deployment.trim() !== (live.azureDeployment ?? "");
  const qwenChanged = qwenEndpoint.trim() !== (live.qwenEndpoint ?? "") || qwenModel.trim() !== (live.qwenModel ?? "");
  const volcChanged = volcAppId.trim() !== (live.volcAppId ?? "") || volcModel.trim() !== (live.volcModel ?? "");

  const save = async (patch: ProviderPatch) => {
    setSaving(true);
    setError(null);
    setProbe(null);
    try {
      const body = await api<{ live: LiveSettings }>("/api/live/settings", { method: "PATCH", body: JSON.stringify(patch) });
      if (state.config) dispatch({ type: "configStatus", config: { ...state.config, live: body.live } });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setProbing(true);
    setError(null);
    setProbe(null);
    try {
      const path = provider === "volc" ? "/api/live/volc/probe" : "/api/live/qwen/probe";
      const body = await api<{ probe: { ok: boolean; error?: string } }>(path, { method: "POST", body: "{}" });
      setProbe(body.probe);
      if (!body.probe.ok) setError(body.probe.error ? t("call.live.probeFailed", { error: body.probe.error }) : t("call.live.probeFailed", { error: "" }));
    } catch (probeError) {
      setError(probeError instanceof Error ? probeError.message : String(probeError));
    } finally {
      setProbing(false);
    }
  };

  const saveRow = (changed: boolean) => changed ? (
    <button
      type="submit"
      disabled={saving}
      className="self-start rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
    >
      {t("common.save")}
    </button>
  ) : null;

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center justify-between gap-2">
        <span className="text-[13px] text-ink-secondary">{t("call.live.provider")}</span>
        <Select
          size="sm"
          value={provider}
          disabled={saving}
          onChange={(event) => void save({ provider: event.target.value as LiveProvider })}
        >
          <option value="openai">{t("call.live.provider.openai")}</option>
          <option value="azure">{t("call.live.provider.azure")}</option>
          <option value="qwen">{t("call.live.provider.qwen")}</option>
          <option value="volc">{t("call.live.provider.volc")}</option>
        </Select>
      </label>
      {provider === "azure" && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save({ azureEndpoint: endpoint.trim(), azureDeployment: deployment.trim() });
          }}
        >
          <Field label={t("call.live.azureEndpoint")} type="url" inputMode="url" value={endpoint} placeholder="https://my-resource.openai.azure.com" onChange={(event) => setEndpoint(event.target.value)} />
          <Field label={t("call.live.azureDeployment")} type="text" value={deployment} placeholder="gpt-live-1" onChange={(event) => setDeployment(event.target.value)} />
          <div className="text-[12px] text-ink-tertiary">{t("call.live.azureHint")}</div>
          {saveRow(azureChanged)}
        </form>
      )}
      {provider === "qwen" && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save({ qwenEndpoint: qwenEndpoint.trim(), qwenModel: qwenModel.trim() });
          }}
        >
          <Field label={t("call.live.qwenEndpoint")} type="url" inputMode="url" value={qwenEndpoint} placeholder="https://dashscope.aliyuncs.com" onChange={(event) => setQwenEndpoint(event.target.value)} />
          <Field label={t("call.live.qwenModel")} type="text" value={qwenModel} placeholder="qwen3.5-omni-flash-realtime" onChange={(event) => setQwenModel(event.target.value)} />
          <div className="text-[12px] text-ink-tertiary">{t("call.live.qwenHint")}</div>
          {saveRow(qwenChanged)}
        </form>
      )}
      {provider === "volc" && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save({ volcAppId: volcAppId.trim(), volcModel: volcModel.trim() });
          }}
        >
          <Field label={t("call.live.volcAppId")} type="text" inputMode="numeric" value={volcAppId} placeholder="6255978659" onChange={(event) => setVolcAppId(event.target.value)} />
          <Field label={t("call.live.volcModel")} type="text" value={volcModel} placeholder="1.2.1.1" onChange={(event) => setVolcModel(event.target.value)} />
          <div className="text-[12px] text-ink-tertiary">{t("call.live.volcHint")}</div>
          {saveRow(volcChanged)}
        </form>
      )}
      {(provider === "qwen" || provider === "volc") && live.keySource === "live" && !qwenChanged && !volcChanged && (
        <button type="button" disabled={probing} className="self-start text-accent hover:underline disabled:opacity-50" onClick={() => void test()}>
          {probing ? t("call.live.probing") : t("call.live.probe")}
        </button>
      )}
      {probe?.ok && <div className="text-[12px] text-ink-tertiary">{t("call.live.probeOk")}</div>}
      {error && <div className="text-[12px] text-danger">{error}</div>}
    </div>
  );
}
