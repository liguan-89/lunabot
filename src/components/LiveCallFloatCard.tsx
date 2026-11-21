import { useState } from "react";
import { Maximize2, Minimize2, Mic, MicOff, PhoneOff, Volume2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { hangUpLiveCall, isLiveCallRunning, setLiveMuted, useLiveMedia } from "@/lib/live-call-media";
import type { Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { DynamicAvatarMedia, hasAnyDynamicAvatarState } from "./DynamicAvatarMedia";

export type LiveCardVisualState = "talking" | "listening" | "working" | "idle";

export function resolveLiveCardState(params: {
  phase: string;
  speaking: boolean;
  busy?: boolean;
}): LiveCardVisualState {
  if (params.busy) return "working";
  if (params.phase !== "live") return "idle";
  return params.speaking ? "talking" : "listening";
}

/**
 * Muse-style right-side vertical floating video card during an active Live Call.
 * Switches smoothly between talking / listening / working / idle clips driven by real-time PCM RMS.
 */
export function LiveCallFloatCard({ bot }: { bot: Bot }) {
  const liveMedia = useLiveMedia();
  const [minimized, setMinimized] = useState(false);

  if (!isLiveCallRunning(liveMedia.phase) || liveMedia.botId !== bot.id) {
    return null;
  }

  const visualState = resolveLiveCardState({
    phase: liveMedia.phase,
    speaking: Boolean(liveMedia.speaking),
    busy: bot.busy,
  });
  const audioLevel = liveMedia.audioLevel ?? 0;
  const hasVisualMedia = hasAnyDynamicAvatarState(bot.avatarStates) || Boolean(bot.avatarUrl);
  const statusText =
    liveMedia.phase === "starting"
      ? "正在连接…"
      : visualState === "working"
        ? "努力工作中"
        : visualState === "talking"
          ? "说话中"
          : "聆听中";

  if (minimized) {
    return (
      <div
        data-live-float-card="minimized"
        className="pointer-events-auto absolute right-5 top-16 z-20 flex items-center gap-2 rounded-full bg-[#4f5358]/95 py-1.5 pl-2 pr-2.5 text-white shadow-[0_12px_32px_rgba(0,0,0,0.28)] ring-1 ring-white/10 backdrop-blur-md"
      >
        <BotAvatar
          bot={bot}
          state={visualState === "talking" ? "happy" : visualState}
          size={28}
          audioLevel={audioLevel}
          animated
        />
        <span className="max-w-[92px] truncate text-[13px] font-medium">{bot.name}</span>
        <span className="text-[11px] text-white/70">{statusText}</span>
        <button
          type="button"
          onClick={() => setMinimized(false)}
          aria-label="展开通话浮窗"
          title="展开通话浮窗"
          className="flex size-7 items-center justify-center rounded-full text-white/80 hover:bg-white/15 hover:text-white"
        >
          <Maximize2 size={13} />
        </button>
        <button
          type="button"
          onClick={() => void hangUpLiveCall()}
          aria-label="挂断通话"
          title="挂断通话"
          className="flex size-7 items-center justify-center rounded-full bg-red-500/90 text-white hover:bg-red-500"
        >
          <PhoneOff size={13} />
        </button>
      </div>
    );
  }

  const speakingGlow =
    visualState === "talking"
      ? 0.25 + Math.min(0.55, audioLevel * 0.7)
      : 0;

  return (
    <aside
      data-live-float-card="expanded"
      data-live-visual-state={visualState}
      aria-label={`${bot.name} 实时语音通话浮窗`}
      className="pointer-events-auto absolute right-5 top-16 z-20 w-[204px] select-none rounded-[28px] bg-[#5c6066]/95 p-[5px] shadow-[0_20px_48px_rgba(0,0,0,0.3)] ring-1 ring-white/15 backdrop-blur-xl transition-shadow duration-200"
      style={
        speakingGlow > 0
          ? { boxShadow: `0 20px 48px rgba(0,0,0,0.3), 0 0 0 2px rgba(255,255,255,${speakingGlow.toFixed(2)})` }
          : undefined
      }
    >
      <div className="relative aspect-[3/4.05] w-full overflow-hidden rounded-[23px] bg-raised">
        {hasVisualMedia ? (
          <DynamicAvatarMedia
            avatarStates={bot.avatarStates}
            fallbackUrl={bot.avatarUrl}
            state={visualState}
            alt={bot.name}
            fill
            borderRadius="23px"
            audioLevel={audioLevel}
          />
        ) : (
          <div className="flex size-full items-center justify-center bg-gradient-to-b from-card to-raised">
            <BotAvatar
              bot={bot}
              state={visualState === "talking" ? "happy" : visualState}
              size={112}
              life="alive"
              audioLevel={audioLevel}
              animated
            />
          </div>
        )}

        <div className="absolute inset-x-2.5 top-2.5 flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-black/35 px-2.5 py-0.5 text-[11px] font-medium text-white backdrop-blur-md">
            <span
              className={cn(
                "size-1.5 rounded-full",
                visualState === "talking"
                  ? "animate-pulse bg-emerald-400"
                  : visualState === "working"
                    ? "animate-pulse bg-amber-400"
                    : "bg-sky-300",
              )}
            />
            {statusText}
          </span>
          <button
            type="button"
            onClick={() => setMinimized(true)}
            aria-label="收起通话浮窗"
            title="收起通话浮窗"
            className="flex size-6 items-center justify-center rounded-full bg-black/30 text-white/90 backdrop-blur-md hover:bg-black/45"
          >
            <Minimize2 size={12} />
          </button>
        </div>

        <div className="absolute inset-x-3 bottom-3 flex justify-center">
          <div className="flex items-center gap-1 rounded-full bg-[#efe7e0]/88 px-2 py-1.5 shadow-[0_6px_18px_rgba(0,0,0,0.22)] ring-1 ring-white/50 backdrop-blur-md">
            <span
              aria-hidden="true"
              className="flex size-9 items-center justify-center rounded-full text-[#1f2328]"
              title={visualState === "talking" ? "正在播报语音" : "语音已连接"}
            >
              <Volume2
                size={17}
                strokeWidth={2}
                className={cn(
                  "transition-transform duration-100",
                  visualState === "talking" && "scale-110 text-emerald-700",
                )}
              />
            </span>
            <button
              type="button"
              onClick={() => setLiveMuted(!liveMedia.muted)}
              aria-pressed={liveMedia.muted}
              aria-label={liveMedia.muted ? "取消静音" : "静音麦克风"}
              title={liveMedia.muted ? "取消静音" : "静音麦克风"}
              className={cn(
                "flex size-9 items-center justify-center rounded-full transition-colors",
                liveMedia.muted
                  ? "bg-black/15 text-[#1f2328]"
                  : "text-[#1f2328] hover:bg-black/10",
              )}
            >
              {liveMedia.muted ? <MicOff size={17} strokeWidth={2} /> : <Mic size={17} strokeWidth={2} />}
            </button>
            <button
              type="button"
              onClick={() => void hangUpLiveCall()}
              disabled={liveMedia.hangingUp}
              aria-label="挂断通话"
              title="挂断通话"
              className="flex size-9 items-center justify-center rounded-full text-[#dc2626] transition-colors hover:bg-red-500/15 disabled:opacity-50"
            >
              <PhoneOff size={17} strokeWidth={2.2} />
            </button>
          </div>
        </div>
      </div>

      <div className="px-2 pb-1.5 pt-2 text-center">
        <div className="truncate text-[15px] font-medium tracking-wide text-white">
          {bot.name}
        </div>
        {(liveMedia.caption || liveMedia.heard) && (
          <div className="mt-0.5 truncate text-[11px] text-white/75">
            {liveMedia.caption || liveMedia.heard}
          </div>
        )}
      </div>
    </aside>
  );
}
