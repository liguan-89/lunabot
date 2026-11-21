import { z } from "zod";

export const MASCOT_FACE_COLORS = ["white", "black"] as const;
export const mascotFaceColorSchema = z.enum(MASCOT_FACE_COLORS);
export type MascotFaceColor = z.infer<typeof mascotFaceColorSchema>;

export function mascotFaceInk(value: unknown): string | undefined {
  const color = mascotFaceColorSchema.safeParse(value).data;
  return color === "white" ? "#ffffff" : color === "black" ? "#000000" : undefined;
}

/**
 * `mascot` draws the animated mascot body, filled with the bot's colour
 * gradient. `circle`, `rounded`, and `square` crop the bot's own image
 * instead, shown as it is, with no mascot at all.
 */
export const BOT_AVATAR_CROPS = ["mascot", "circle", "rounded", "square"] as const;
export const botAvatarCropSchema = z.enum(BOT_AVATAR_CROPS);
export type BotAvatarCrop = z.infer<typeof botAvatarCropSchema>;

/** CSS radius for a profile crop. Mascot is drawn, not photo-cropped, so it is not clipped. */
export function avatarCropRadius(crop: BotAvatarCrop): string {
  if (crop === "circle") return "50%";
  if (crop === "rounded") return "22%";
  return "0";
}

/** 1 shows the picture with object-fit cover. Larger values zoom in. */
export const AVATAR_ZOOM_MIN = 1;
export const AVATAR_ZOOM_MAX = 3;
/** The point of the picture kept in the middle of the crop, from 0 to 1. */
export const AVATAR_FOCUS_CENTER = 0.5;

export function clampAvatarZoom(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(parsed)) return AVATAR_ZOOM_MIN;
  const clamped = Math.min(AVATAR_ZOOM_MAX, Math.max(AVATAR_ZOOM_MIN, parsed));
  return Math.round(clamped * 100) / 100;
}

export function clampAvatarFocus(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(parsed)) return AVATAR_FOCUS_CENTER;
  const clamped = Math.min(1, Math.max(0, parsed));
  return Math.round(clamped * 1000) / 1000;
}

/**
 * Custom avatars are deliberately limited to this app's attachment server.
 * Besides making persisted profiles portable across desktop/browser clients,
 * this prevents a bot profile from becoming an external tracking pixel or a
 * script-capable SVG.
 */
export const botAvatarUrlSchema = z
  .string()
  .regex(
    /^\/api\/attachments\/[A-Za-z0-9-]+\.(?:png|jpg|gif|webp)$/,
    "must be a stored PNG, JPEG, GIF, or WebP attachment",
  );

export const BOT_AVATAR_STATE_KEYS = ["idle", "working", "listening", "talking", "thinking"] as const;
export type BotAvatarStateKey = (typeof BOT_AVATAR_STATE_KEYS)[number];

/** State avatar slots may hold either a static image or a short looping MP4/WebM clip. */
export const botAvatarMediaUrlSchema = z
  .string()
  .regex(
    /^\/api\/attachments\/[A-Za-z0-9-]+\.(?:png|jpg|gif|webp|mp4|webm)$/,
    "must be a stored PNG, JPEG, GIF, WebP, MP4, or WebM attachment",
  );

export const botAvatarStatesPatchSchema = z
  .object({
    idle: z.union([botAvatarMediaUrlSchema, z.literal(""), z.null()]).optional(),
    working: z.union([botAvatarMediaUrlSchema, z.literal(""), z.null()]).optional(),
    listening: z.union([botAvatarMediaUrlSchema, z.literal(""), z.null()]).optional(),
    talking: z.union([botAvatarMediaUrlSchema, z.literal(""), z.null()]).optional(),
    thinking: z.union([botAvatarMediaUrlSchema, z.literal(""), z.null()]).optional(),
  })
  .strict();

export type BotAvatarStates = Partial<Record<BotAvatarStateKey, string>>;
export type BotAvatarStatesPatch = z.infer<typeof botAvatarStatesPatchSchema>;

export function isVideoAvatarUrl(url: string | null | undefined): boolean {
  return Boolean(url && /\.(?:mp4|webm)$/i.test(url));
}

export function botAvatarUrlFromStoredPath(path: string): string | null {
  const name = path.replaceAll("\\", "/").split("/").pop();
  if (!name) return null;
  const url = `/api/attachments/${name}`;
  return botAvatarUrlSchema.safeParse(url).success ? url : null;
}

export function botAvatarMediaUrlFromStoredPath(path: string): string | null {
  const name = path.replaceAll("\\", "/").split("/").pop();
  if (!name) return null;
  const url = `/api/attachments/${name}`;
  return botAvatarMediaUrlSchema.safeParse(url).success ? url : null;
}

export function normalizeBotAvatarStates(raw: unknown): BotAvatarStates | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: BotAvatarStates = {};
  for (const key of BOT_AVATAR_STATE_KEYS) {
    const candidate = (raw as Record<string, unknown>)[key];
    const parsed = botAvatarMediaUrlSchema.safeParse(candidate);
    if (parsed.success) out[key] = parsed.data;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Runtime-safe defaults for untrusted persisted/SSE profile data. */
export interface BotAvatarProfileInput {
  avatarUrl?: unknown;
  avatarCrop?: unknown;
  avatarStates?: unknown;
}

export interface BotAvatarProfile {
  avatarUrl?: string;
  avatarCrop: BotAvatarCrop;
  avatarStates?: BotAvatarStates;
}

export function botAvatarProfile(value: BotAvatarProfileInput): BotAvatarProfile {
  const profile: BotAvatarProfile = {
    avatarCrop: botAvatarCropSchema.safeParse(value.avatarCrop).data ?? "mascot",
  };
  const url = botAvatarUrlSchema.safeParse(value.avatarUrl);
  if (url.success) profile.avatarUrl = url.data;
  const states = normalizeBotAvatarStates(value.avatarStates);
  if (states) profile.avatarStates = states;
  return profile;
}
