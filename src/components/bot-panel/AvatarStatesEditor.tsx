import { useRef, useState } from "react";
import { Film, Loader2, Settings2, Sparkles, Trash2, Upload } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { api, useStore, type Bot } from "@/state/store";
import { BOT_AVATAR_STATE_KEYS, isVideoAvatarUrl, type BotAvatarStateKey } from "../../../shared/bot-avatar";

const CORE_AVATAR_STATES: readonly BotAvatarStateKey[] = ["idle", "working", "talking"];

type AvatarStyleOption = "auto" | "photorealistic" | "stylized3d" | "anime" | "cartoon";

const STYLE_OPTIONS: ReadonlyArray<{ id: AvatarStyleOption; label: LocaleKey }> = [
  { id: "auto", label: "avatarStates.style.auto" },
  { id: "photorealistic", label: "avatarStates.style.photorealistic" },
  { id: "stylized3d", label: "avatarStates.style.stylized3d" },
  { id: "anime", label: "avatarStates.style.anime" },
  { id: "cartoon", label: "avatarStates.style.cartoon" },
];

const STATE_META: Record<BotAvatarStateKey, { label: LocaleKey; hint: LocaleKey }> = {
  idle: { label: "avatarStates.state.idle", hint: "avatarStates.state.idleHint" },
  working: { label: "avatarStates.state.working", hint: "avatarStates.state.workingHint" },
  listening: { label: "avatarStates.state.listening", hint: "avatarStates.state.listeningHint" },
  talking: { label: "avatarStates.state.talking", hint: "avatarStates.state.talkingHint" },
  thinking: { label: "avatarStates.state.thinking", hint: "avatarStates.state.thinkingHint" },
};

export function AvatarStatesEditor({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const seedance = state.config?.seedance;
  const provider = seedance?.provider === "tk1688" ? "tk1688" : "ark";
  const resolution = seedance?.resolution === "480p" ? "480p" : "720p";
  const ready = Boolean(seedance?.ready ?? seedance?.configured);
  const [style, setStyle] = useState<AvatarStyleOption>("auto");
  const [customPrompt, setCustomPrompt] = useState("");
  const [busyState, setBusyState] = useState<{ state: BotAvatarStateKey; kind: "upload" | "generate" | "clear" } | null>(null);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number; current: BotAvatarStateKey } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const pendingUploadStateRef = useRef<BotAvatarStateKey | null>(null);

  const openVideoSettings = () => {
    dispatch({ type: "toggleAppSettings", open: true, section: "videoGeneration" });
  };

  const triggerUpload = (target: BotAvatarStateKey) => {
    pendingUploadStateRef.current = target;
    uploadInputRef.current?.click();
  };

  const handleFilePicked = async (file: File | undefined) => {
    const target = pendingUploadStateRef.current;
    pendingUploadStateRef.current = null;
    if (uploadInputRef.current) uploadInputRef.current.value = "";
    if (!file || !target) return;
    setError(null);
    setBusyState({ state: target, kind: "upload" });
    try {
      const response = await fetch(`/api/bots/${encodeURIComponent(bot.id)}/avatar/states/upload?state=${encodeURIComponent(target)}`, {
        method: "POST",
        headers: { "content-type": file.type || "video/mp4" },
        body: file,
      });
      const data = (await response.json()) as { bot?: Bot; error?: string };
      if (!response.ok || !data.bot) throw new Error(data.error || t("avatarStates.uploadFailed", { status: response.status }));
      dispatch({ type: "botPatched", bot: data.bot });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyState(null);
    }
  };

  const handleGenerate = async (target: BotAvatarStateKey) => {
    if (!ready) {
      openVideoSettings();
      return;
    }
    setError(null);
    setBusyState({ state: target, kind: "generate" });
    try {
      const data = await api<{ bot: Bot }>(`/api/bots/${encodeURIComponent(bot.id)}/avatar/states/generate`, {
        method: "POST",
        timeoutMs: 1_560_000,
        body: JSON.stringify({
          state: target,
          provider,
          style,
          resolution,
          loop: target !== "working",
          ...(customPrompt.trim() ? { prompt: customPrompt.trim() } : {}),
        }),
      });
      dispatch({ type: "botPatched", bot: data.bot });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyState(null);
    }
  };

  const missingCoreStates = CORE_AVATAR_STATES.filter((key) => !bot.avatarStates?.[key]);
  const batchTargets = missingCoreStates.length > 0 ? missingCoreStates : CORE_AVATAR_STATES;

  const handleGeneratePack = async () => {
    if (!ready) {
      openVideoSettings();
      return;
    }
    setError(null);
    for (let i = 0; i < batchTargets.length; i += 1) {
      const target = batchTargets[i]!;
      setBatchProgress({ done: i, total: batchTargets.length, current: target });
      setBusyState({ state: target, kind: "generate" });
      try {
        const data = await api<{ bot: Bot }>(`/api/bots/${encodeURIComponent(bot.id)}/avatar/states/generate`, {
          method: "POST",
          timeoutMs: 1_560_000,
          body: JSON.stringify({
            state: target,
            provider,
            style,
            resolution,
            loop: target !== "working",
            ...(customPrompt.trim() ? { prompt: customPrompt.trim() } : {}),
          }),
        });
        dispatch({ type: "botPatched", bot: data.bot });
      } catch (err) {
        setError(t("avatarStates.generateFailed", { state: t(STATE_META[target].label), error: err instanceof Error ? err.message : String(err) }));
        break;
      }
    }
    setBusyState(null);
    setBatchProgress(null);
  };

  const handleClear = async (target: BotAvatarStateKey) => {
    setError(null);
    setBusyState({ state: target, kind: "clear" });
    try {
      const next = { ...bot.avatarStates };
      delete next[target];
      const payload = Object.keys(next).length ? next : null;
      const data = await api<{ bot: Bot }>(`/api/bots/${encodeURIComponent(bot.id)}/profile`, {
        method: "PATCH",
        body: JSON.stringify({ avatarStates: payload }),
      });
      dispatch({ type: "botPatched", bot: data.bot });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyState(null);
    }
  };

  return (
    <div className="space-y-2.5" data-avatar-states-editor>
      <input
        ref={uploadInputRef}
        type="file"
        accept="video/mp4,video/webm,image/png,image/jpeg,image/gif,image/webp"
        className="sr-only"
        onChange={(e) => void handleFilePicked(e.target.files?.[0])}
      />

      <div className="flex items-center justify-between gap-2 rounded-xl border border-ink/[0.08] bg-ink/[0.025] px-2.5 py-2">
        <div className="flex min-w-0 items-center gap-1.5 text-[12px]">
          <span className={cn("size-1.5 shrink-0 rounded-full", ready ? "bg-success" : "bg-ink-tertiary/50")} />
          <span className="truncate text-ink">
            {ready
              ? t("avatarStates.ready", { provider: t(provider === "tk1688" ? "videoGen.providerTk1688" : "videoGen.providerArk"), resolution })
              : t("avatarStates.notConfigured")}
          </span>
        </div>
        <button
          type="button"
          onClick={openVideoSettings}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-ink/[0.07] px-2 py-1 text-[11px] font-medium text-ink hover:bg-ink/[0.12]"
        >
          <Settings2 size={11} />
          <span>{t(ready ? "avatarStates.settings" : "avatarStates.configure")}</span>
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("avatarStates.styleAria")}>
        {STYLE_OPTIONS.map((option) => {
          const active = style === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={busyState !== null}
              onClick={() => setStyle(option.id)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40",
                active
                  ? "border-accent bg-accent/15 text-accent"
                  : "border-ink/10 bg-card text-ink-secondary hover:bg-ink/[0.05] hover:text-ink",
              )}
            >
              {t(option.label)}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        disabled={busyState !== null}
        onClick={() => void handleGeneratePack()}
        className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {batchProgress ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
        <span>
          {batchProgress
            ? t("avatarStates.generatingPack", { done: batchProgress.done + 1, total: batchProgress.total, state: t(STATE_META[batchProgress.current].label) })
            : !ready
              ? t("avatarStates.setupFirst")
              : missingCoreStates.length > 0 && missingCoreStates.length < CORE_AVATAR_STATES.length
                ? t("avatarStates.completeMissing", { states: missingCoreStates.map((k) => t(STATE_META[k].label)).join(" / ") })
                : t("avatarStates.generatePack")}
        </span>
      </button>

      <input
        type="text"
        value={customPrompt}
        onChange={(e) => setCustomPrompt(e.target.value)}
        placeholder={t("avatarStates.promptPlaceholder")}
        className="w-full rounded-lg border border-ink/10 bg-card px-2.5 py-1.5 text-[12px] text-ink placeholder:text-ink-tertiary focus:border-accent/50 focus:outline-none"
      />

      <div className="space-y-1.5">
        {BOT_AVATAR_STATE_KEYS.map((stateKey) => {
          const mediaUrl = bot.avatarStates?.[stateKey];
          const isBusy = busyState?.state === stateKey;
          const anyBusy = busyState !== null;
          const meta = STATE_META[stateKey];
          const stateLabel = t(meta.label);
          const providerName = t(provider === "tk1688" ? "videoGen.providerTk1688" : "videoGen.providerArk");
          return (
            <div
              key={stateKey}
              data-avatar-state-row={stateKey}
              className="flex items-center gap-2 rounded-xl border border-ink/[0.06] bg-card/60 px-2 py-1.5"
            >
              <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-raised">
                {mediaUrl ? (
                  isVideoAvatarUrl(mediaUrl) ? (
                    <video src={mediaUrl} autoPlay loop muted playsInline className="size-full object-cover" />
                  ) : (
                    <img src={mediaUrl} alt={stateLabel} className="size-full object-cover" />
                  )
                ) : (
                  <Film size={15} className="text-ink-tertiary" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium text-ink">{stateLabel}</div>
                <div className="truncate text-[11px] text-ink-tertiary">{t(meta.hint)}</div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  disabled={anyBusy}
                  onClick={() => triggerUpload(stateKey)}
                  title={t("avatarStates.uploadTitle")}
                  className="inline-flex h-7 items-center gap-1 rounded-lg border border-ink/10 px-2 text-[11px] text-ink-secondary hover:bg-ink/[0.05] hover:text-ink disabled:opacity-40"
                >
                  {isBusy && busyState.kind === "upload" ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
                  <span>{t("avatarStates.upload")}</span>
                </button>
                <button
                  type="button"
                  disabled={anyBusy}
                  onClick={() => void handleGenerate(stateKey)}
                  title={ready ? t("avatarStates.generateTitle", { provider: providerName, resolution }) : t("avatarStates.generateSetupTitle")}
                  className="inline-flex h-7 items-center gap-1 rounded-lg bg-accent/15 px-2 text-[11px] font-medium text-accent hover:bg-accent/25 disabled:opacity-40"
                >
                  {isBusy && busyState.kind === "generate" ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                  <span>{t(isBusy && busyState.kind === "generate" ? "avatarStates.generating" : "avatarStates.generate")}</span>
                </button>
                {mediaUrl && (
                  <button
                    type="button"
                    disabled={anyBusy}
                    onClick={() => void handleClear(stateKey)}
                    aria-label={t("avatarStates.clearAria", { state: stateLabel })}
                    title={t("avatarStates.clearTitle")}
                    className="flex size-7 items-center justify-center rounded-lg text-ink-tertiary hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {!bot.avatarUrl && (
        <p className="text-[11px] text-ink-tertiary">{t("avatarStates.baseTip")}</p>
      )}
      {error && <div role="alert" className="text-[12px] text-danger">{error}</div>}
    </div>
  );
}
