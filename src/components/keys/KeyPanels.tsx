import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { Select } from "../Select";
import { KEY_FIELD } from "./KeyRow";
import { compatBaseUrlProblem } from "../../../shared/compat-base-url";

/** Non-secret Docker-over-SSH target. Keys and passwords stay with SSH. */
export function VpsConnection() {
  const { state, dispatch } = useStore();
  const [alias, setAlias] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const configured = Boolean(state.config?.vps?.configured);
  const clearing = !alias.trim() && configured;

  useEffect(() => {
    setAlias(state.config?.vps?.sshAlias ?? "");
  }, [state.config?.vps?.sshAlias]);

  const save = () => {
    if (saving || (!alias.trim() && !configured)) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ vps: { sshAlias: alias.trim() } }) })
      .then(({ notice: savedNotice, ...status }: ConfigStatus & { notice?: string }) => {
        dispatch({ type: "configStatus", config: status });
        setAlias(status.vps?.sshAlias ?? "");
        setNotice(savedNotice ?? null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] leading-4 text-ink-secondary">
        {t("keys.vps.descBefore")}
        <a href="https://cloud.dexai.vip/docs#self-hosting" target="_blank" rel="noopener noreferrer" className="text-accent-text hover:underline">
          {t("keys.vps.descLink")}
        </a>
        {t("keys.vps.descAfter")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          data-key-input
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="my-vps"
          aria-label={t("keys.vps.aria")}
          autoComplete="off"
          spellCheck={false}
          className={cn(KEY_FIELD, "w-auto min-w-[min(100%,12rem)] flex-1")}
        />
        <button
          type="button"
          onClick={save}
          disabled={saving || (!alias.trim() && !configured) || alias.trim() === (state.config?.vps?.sshAlias ?? "")}
          className={cn("ui-button shrink-0", !clearing && "ui-button-primary")}
          title={clearing ? t("keys.vps.removeAlias") : undefined}
        >
          {saving ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : clearing ? t("keys.row.remove") : t("common.save")}
        </button>
      </div>
      {notice && <div role="status" className="text-[12px] leading-4 text-ink-secondary">{notice}</div>}
      {error && <div role="alert" className="text-[12px] leading-4 text-danger">{error}</div>}
    </div>
  );
}

const COMPAT_PROTOCOLS = [
  ["openai", "keys.openaiCompat.protocol.openai"],
  ["responses", "keys.openaiCompat.protocol.responses"],
  ["anthropic", "keys.openaiCompat.protocol.anthropic"],
] as const;

export function OpenAiCompatUrl({ models: showModels = true }: { models?: boolean } = {}) {
  const { state, dispatch } = useStore();
  const savedUrl = state.config?.openaiCompat?.url ?? "";
  const savedProtocol = state.config?.openaiCompat?.protocol ?? "openai";
  const savedModels = (state.config?.openaiCompat?.models ?? []).join(", ");
  const [url, setUrl] = useState(savedUrl);
  const [protocol, setProtocol] = useState<"openai" | "responses" | "anthropic">(savedProtocol);
  const [models, setModels] = useState(savedModels);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  useEffect(() => { setUrl(savedUrl); setProtocol(savedProtocol); setModels(savedModels); }, [savedUrl, savedProtocol, savedModels]);
  const parsedModels = [...new Set(models.split(/[,，、\s]+/).map((model) => model.trim()).filter(Boolean))];
  const dirty = url.trim() !== savedUrl || protocol !== savedProtocol || parsedModels.join(", ") !== savedModels;

  const save = () => {
    if (savingRef.current || !dirty) return;
    persist({ url: url.trim(), protocol, models: parsedModels });
  };
  const persist = (next: { url: string; protocol: "openai" | "responses" | "anthropic"; models: string[] }) => {
    if (savingRef.current) return;
    const urlProblem = compatBaseUrlProblem(next.url);
    if (urlProblem) {
      setError(t(`keys.openaiCompat.urlError.${urlProblem}`));
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ openaiCompat: next }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e) => setError(e.message))
      .finally(() => { savingRef.current = false; setSaving(false); });
  };

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-[13px] leading-[18px] text-ink">
        {t("keys.openaiCompat.protocol")}
        <Select value={protocol} onChange={(event) => {
          const next = event.target.value as "openai" | "responses" | "anthropic";
          setProtocol(next);
          persist({ url: url.trim(), protocol: next, models: parsedModels });
        }} aria-label={t("keys.openaiCompat.protocol")}>
          {COMPAT_PROTOCOLS.map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
        </Select>
      </label>
      <div className="text-[13px] leading-[18px] text-ink">{t("keys.openaiCompat.url")}</div>
      <div className="relative">
        <input
          type="url"
          value={url}
          onChange={(e) => { setUrl(e.target.value); setError(null); }}
          onBlur={save}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="https://api.example.com/v1"
          aria-label={t("keys.openaiCompat.url")}
          spellCheck={false}
          className={cn(KEY_FIELD, "pr-8")}
        />
        {saving && <Loader2 size={13} aria-hidden="true" className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-ink-secondary" />}
      </div>
      <p className="text-[12px] leading-4 text-ink-secondary">{t("keys.openaiCompat.urlHint")}</p>
      {showModels && (
        <>
          <label className="flex flex-col gap-1 text-[13px] leading-[18px] text-ink">
            {t("keys.openaiCompat.models")}
            <input
              type="text"
              value={models}
              onChange={(e) => setModels(e.target.value)}
              onBlur={save}
              onKeyDown={(e) => e.key === "Enter" && save()}
              placeholder="gpt-5, claude-sonnet-4-5"
              aria-label={t("keys.openaiCompat.models")}
              spellCheck={false}
              className={KEY_FIELD}
            />
          </label>
          <p className="text-[12px] leading-4 text-ink-secondary">{t("keys.openaiCompat.modelsHint")}</p>
        </>
      )}
      {error && <div role="alert" className="text-[12px] leading-4 text-danger">{error}</div>}
    </div>
  );
}
