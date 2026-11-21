import { useRef, useState } from "react";
import { Film, Loader2, Settings2, Sparkles, Trash2, Upload } from "lucide-react";

import { cn } from "@/lib/cn";
import { api, useStore, type Bot } from "@/state/store";
import { BOT_AVATAR_STATE_KEYS, isVideoAvatarUrl, type BotAvatarStateKey } from "../../../shared/bot-avatar";

const CORE_AVATAR_STATES: readonly BotAvatarStateKey[] = ["idle", "working", "talking"];

type AvatarStyleOption = "auto" | "photorealistic" | "stylized3d" | "anime" | "cartoon";

const STYLE_OPTIONS: ReadonlyArray<{ id: AvatarStyleOption; label: string }> = [
  { id: "auto", label: "沿用当前头像" },
  { id: "photorealistic", label: "真人写真" },
  { id: "stylized3d", label: "3D 类人" },
  { id: "anime", label: "二次元" },
  { id: "cartoon", label: "卡通萌系" },
];

const STATE_META: Record<BotAvatarStateKey, { label: string; hint: string }> = {
  idle: { label: "待机", hint: "轻眨眼、微呼吸" },
  working: { label: "工作中", hint: "戴耳机敲电脑（破框态）" },
  listening: { label: "聆听", hint: "通话倾听、轻点头" },
  talking: { label: "说话", hint: "通话开口说话、自然手势" },
  thinking: { label: "思考", hint: "微抬头、思索神态" },
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
      if (!response.ok || !data.bot) throw new Error(data.error || `上传失败 (${response.status})`);
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
        setError(`${STATE_META[target].label}生成失败：${err instanceof Error ? err.message : String(err)}`);
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
              ? `视频能力已就绪 · ${provider === "tk1688" ? "TK1688" : "火山方舟 Ark"} (${resolution})`
              : "未配置视频生成密钥"}
          </span>
        </div>
        <button
          type="button"
          onClick={openVideoSettings}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-ink/[0.07] px-2 py-1 text-[11px] font-medium text-ink hover:bg-ink/[0.12]"
        >
          <Settings2 size={11} />
          <span>{ready ? "设置" : "去配置"}</span>
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="动态头像风格">
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
              {option.label}
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
            ? `正在生成 (${batchProgress.done + 1}/${batchProgress.total} · ${STATE_META[batchProgress.current].label})…`
            : !ready
              ? "配置视频密钥后可一键生成动态头像"
              : missingCoreStates.length > 0 && missingCoreStates.length < CORE_AVATAR_STATES.length
                ? `一键补全动态头像（${missingCoreStates.map((k) => STATE_META[k].label).join(" / ")}）`
                : "一键生成动态头像（待机 / 工作中 / 说话）"}
        </span>
      </button>

      <input
        type="text"
        value={customPrompt}
        onChange={(e) => setCustomPrompt(e.target.value)}
        placeholder="可选：补充细节（留空即按所选风格生成；聊天里说「做套动态头像」会先问你风格）"
        className="w-full rounded-lg border border-ink/10 bg-card px-2.5 py-1.5 text-[12px] text-ink placeholder:text-ink-tertiary focus:border-accent/50 focus:outline-none"
      />

      <div className="space-y-1.5">
        {BOT_AVATAR_STATE_KEYS.map((stateKey) => {
          const mediaUrl = bot.avatarStates?.[stateKey];
          const isBusy = busyState?.state === stateKey;
          const anyBusy = busyState !== null;
          const meta = STATE_META[stateKey];
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
                    <img src={mediaUrl} alt={meta.label} className="size-full object-cover" />
                  )
                ) : (
                  <Film size={15} className="text-ink-tertiary" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium text-ink">{meta.label}</div>
                <div className="truncate text-[11px] text-ink-tertiary">{meta.hint}</div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  disabled={anyBusy}
                  onClick={() => triggerUpload(stateKey)}
                  title="上传本地 MP4/WebM 或图片"
                  className="inline-flex h-7 items-center gap-1 rounded-lg border border-ink/10 px-2 text-[11px] text-ink-secondary hover:bg-ink/[0.05] hover:text-ink disabled:opacity-40"
                >
                  {isBusy && busyState.kind === "upload" ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
                  <span>上传</span>
                </button>
                <button
                  type="button"
                  disabled={anyBusy}
                  onClick={() => void handleGenerate(stateKey)}
                  title={ready ? `使用 ${provider === "tk1688" ? "TK1688" : "火山方舟 Ark"} 生成 ${resolution} 视频` : "前往设置配置视频生成密钥"}
                  className="inline-flex h-7 items-center gap-1 rounded-lg bg-accent/15 px-2 text-[11px] font-medium text-accent hover:bg-accent/25 disabled:opacity-40"
                >
                  {isBusy && busyState.kind === "generate" ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                  <span>{isBusy && busyState.kind === "generate" ? "生成中…" : "生成"}</span>
                </button>
                {mediaUrl && (
                  <button
                    type="button"
                    disabled={anyBusy}
                    onClick={() => void handleClear(stateKey)}
                    aria-label={`清除${meta.label}素材`}
                    title="清除该状态素材"
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
        <p className="text-[11px] text-ink-tertiary">
          提示：先在「上传」或「生成」页设置基础人物头像，Seedance 会以该头像为参考帧生成角色一致的动态循环。
        </p>
      )}
      {error && <div role="alert" className="text-[12px] text-danger">{error}</div>}
    </div>
  );
}
