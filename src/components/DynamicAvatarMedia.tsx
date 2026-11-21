import { memo, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { isVideoAvatarUrl, type BotAvatarStateKey, type BotAvatarStates } from "../../shared/bot-avatar";

export type DynamicAvatarState = BotAvatarStateKey | string | undefined;

/**
 * Picks the best matching media URL from `avatarStates` for the requested runtime state.
 * Falls back gracefully: thinking <-> working, talking -> idle, listening -> idle, and finally static avatarUrl.
 */
export function resolveAvatarStateMediaUrl(
  avatarStates: BotAvatarStates | undefined,
  state: DynamicAvatarState,
  fallbackUrl?: string | null,
): { url: string; matchedState: BotAvatarStateKey | null } | null {
  if (!avatarStates) return fallbackUrl ? { url: fallbackUrl, matchedState: null } : null;
  const pick = (key: BotAvatarStateKey): { url: string; matchedState: BotAvatarStateKey } | null => {
    const u = avatarStates[key];
    return u ? { url: u, matchedState: key } : null;
  };
  switch (state) {
    case "working":
      return pick("working") ?? pick("thinking") ?? pick("idle") ?? (fallbackUrl ? { url: fallbackUrl, matchedState: null } : null);
    case "thinking":
      return pick("thinking") ?? pick("working") ?? pick("idle") ?? (fallbackUrl ? { url: fallbackUrl, matchedState: null } : null);
    case "talking":
      return pick("talking") ?? pick("idle") ?? (fallbackUrl ? { url: fallbackUrl, matchedState: null } : null);
    case "listening":
      return pick("listening") ?? pick("idle") ?? (fallbackUrl ? { url: fallbackUrl, matchedState: null } : null);
    default:
      return pick("idle") ?? (fallbackUrl ? { url: fallbackUrl, matchedState: null } : null);
  }
}

export function hasAnyDynamicAvatarState(avatarStates: BotAvatarStates | undefined): boolean {
  if (!avatarStates) return false;
  return Boolean(
    avatarStates.idle
    || avatarStates.working
    || avatarStates.listening
    || avatarStates.talking
    || avatarStates.thinking,
  );
}

interface MediaSlot {
  url: string | null;
}

export interface DynamicAvatarMediaProps {
  avatarStates?: BotAvatarStates;
  fallbackUrl?: string | null;
  state?: DynamicAvatarState;
  alt: string;
  /** Container width/height in px (ignored when `fill` is true). */
  size?: number;
  /** Fill parent container (used by the vertical Live Call floating card). */
  fill?: boolean;
  borderRadius?: string;
  objectPosition?: string;
  zoom?: number;
  /** When true and displaying a working/thinking state clip, renders a Muse-style subtle breakout-frame elevation. */
  breakout?: boolean;
  /** Optional real-time audio amplitude (0..1) for subtle organic breathing/pulse while talking. */
  audioLevel?: number;
  className?: string;
  onFallbackError?: () => void;
}

/**
 * Dual-slot seamless cross-fade player for dynamic avatar state clips (MP4/WebM/Image).
 * Preloads the next state clip in the hidden slot and fades over ~180ms once ready, eliminating black flashes.
 */
export const DynamicAvatarMedia = memo(function DynamicAvatarMedia({
  avatarStates,
  fallbackUrl,
  state = "idle",
  alt,
  size = 44,
  fill = false,
  borderRadius = "9999px",
  objectPosition = "50% 50%",
  zoom = 1,
  breakout = false,
  audioLevel = 0,
  className,
  onFallbackError,
}: DynamicAvatarMediaProps) {
  const resolved = resolveAvatarStateMediaUrl(avatarStates, state, fallbackUrl);
  const targetUrl = resolved?.url ?? null;

  const [slots, setSlots] = useState<[MediaSlot, MediaSlot]>(() => [{ url: targetUrl }, { url: null }]);
  const [activeIndex, setActiveIndex] = useState<0 | 1>(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const videoRefs = useRef<[HTMLVideoElement | null, HTMLVideoElement | null]>([null, null]);
  const pendingSwapRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Pause videos when the window/tab is hidden to save CPU/GPU.
  useEffect(() => {
    const onVisibility = () => {
      for (const el of videoRefs.current) {
        if (!el) continue;
        if (document.hidden || reducedMotion) el.pause();
        else void el.play().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [reducedMotion]);

  // Trigger dual-slot cross-fade when targetUrl changes.
  useEffect(() => {
    if (pendingSwapRef.current) {
      clearTimeout(pendingSwapRef.current);
      pendingSwapRef.current = null;
    }
    const currentUrl = slots[activeIndex].url;
    if (targetUrl === currentUrl) return;
    const nextIndex: 0 | 1 = activeIndex === 0 ? 1 : 0;
    setSlots((prev) => {
      const copy: [MediaSlot, MediaSlot] = [{ ...prev[0] }, { ...prev[1] }];
      copy[nextIndex] = { url: targetUrl };
      return copy;
    });
    // Safety swap timeout in case canplay/load fires synchronously or is cached.
    pendingSwapRef.current = setTimeout(() => {
      pendingSwapRef.current = null;
      setActiveIndex(nextIndex);
    }, 240);
    return () => {
      if (pendingSwapRef.current) {
        clearTimeout(pendingSwapRef.current);
        pendingSwapRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUrl]);

  const commitSlot = (slotIndex: 0 | 1) => {
    if (slotIndex === activeIndex) return;
    if (slots[slotIndex].url !== targetUrl) return;
    if (pendingSwapRef.current) {
      clearTimeout(pendingSwapRef.current);
      pendingSwapRef.current = null;
    }
    setActiveIndex(slotIndex);
  };

  const isBreakoutActive = breakout && (resolved?.matchedState === "working" || resolved?.matchedState === "thinking");
  const pulseScale = audioLevel > 0.04 ? 1 + Math.min(0.035, audioLevel * 0.04) : 1;
  const effectiveZoom = zoom * pulseScale;

  const mediaStyle = {
    objectPosition,
    transform: effectiveZoom === 1 ? undefined : `scale(${effectiveZoom.toFixed(4)})`,
    transformOrigin: objectPosition,
  };

  return (
    <span
      data-dynamic-avatar=""
      data-avatar-state={resolved?.matchedState ?? "static"}
      data-avatar-breakout={isBreakoutActive ? "" : undefined}
      className={cn(
        "relative block shrink-0 bg-raised transition-transform duration-200",
        fill ? "size-full overflow-hidden" : isBreakoutActive ? "overflow-visible" : "overflow-hidden",
        className,
      )}
      style={fill ? { borderRadius } : { width: size, height: size, borderRadius }}
    >
      {isBreakoutActive && !fill && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-full bg-white/95 shadow-[0_4px_14px_rgba(0,0,0,0.08)] ring-1 ring-black/[0.04]"
        />
      )}
      <span
        className={cn(
          "relative block size-full overflow-hidden transition-transform duration-200",
          isBreakoutActive && !fill && "-translate-y-[6%] scale-[1.08] drop-shadow-[0_6px_12px_rgba(0,0,0,0.14)]",
        )}
        style={{ borderRadius }}
      >
        {([0, 1] as const).map((slotIndex) => {
          const url = slots[slotIndex].url;
          if (!url) return null;
          const active = slotIndex === activeIndex;
          const isVideo = isVideoAvatarUrl(url);
          return isVideo ? (
            <video
              key={`${slotIndex}:${url}`}
              ref={(el) => { videoRefs.current[slotIndex] = el; }}
              src={url}
              autoPlay={!reducedMotion}
              loop
              muted
              playsInline
              preload="auto"
              aria-label={active ? alt : undefined}
              aria-hidden={!active || undefined}
              onCanPlay={() => commitSlot(slotIndex)}
              onError={() => {
                if (active && url === fallbackUrl) onFallbackError?.();
              }}
              className={cn(
                "absolute inset-0 block size-full max-w-none object-cover transition-opacity duration-200",
                active ? "opacity-100" : "opacity-0 pointer-events-none",
              )}
              style={mediaStyle}
            />
          ) : (
            <img
              key={`${slotIndex}:${url}`}
              src={url}
              alt={active ? alt : ""}
              aria-hidden={!active || undefined}
              draggable={false}
              onLoad={() => commitSlot(slotIndex)}
              onError={() => {
                if (active && url === fallbackUrl) onFallbackError?.();
              }}
              className={cn(
                "absolute inset-0 block size-full max-w-none object-cover transition-opacity duration-200",
                active ? "opacity-100" : "opacity-0 pointer-events-none",
              )}
              style={mediaStyle}
            />
          );
        })}
      </span>
    </span>
  );
});
