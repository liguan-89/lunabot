import { useSyncExternalStore } from "react";

export const AVATAR_STYLE_IDS = [
  "classic",
  "orb",
  "neko",
  "liquid",
  "synth",
  "spirit",
  "minibot",
  "bunny",
  "astro",
  "prism",
  "bear",
  "retro",
  "fox",
  "frog",
  "owl",
  "wisp",
  "camera",
  "cloud",
] as const;

export type AvatarStyleId = (typeof AVATAR_STYLE_IDS)[number];

export const DEFAULT_AVATAR_STYLE: AvatarStyleId = "orb";

const KEY = "omb-avatar-style";

function isAvatarStyleId(value: unknown): value is AvatarStyleId {
  return AVATAR_STYLE_IDS.includes(value as AvatarStyleId);
}

function getStore(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readAvatarStyle(): AvatarStyleId {
  try {
    const stored = getStore()?.getItem(KEY);
    return isAvatarStyleId(stored) ? stored : DEFAULT_AVATAR_STYLE;
  } catch {
    return DEFAULT_AVATAR_STYLE;
  }
}

const listeners = new Set<() => void>();

export function subscribeAvatarStyle(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function applyAvatarStyle(id: AvatarStyleId): void {
  try {
    getStore()?.setItem(KEY, id);
  } catch {
  }
  if (typeof document !== "undefined") {
    document.documentElement.dataset.avatarStyle = id;
  }
  for (const listener of listeners) listener();
}

export function useAvatarStyle(): AvatarStyleId {
  return useSyncExternalStore(subscribeAvatarStyle, readAvatarStyle, () => DEFAULT_AVATAR_STYLE);
}
