import type { ServerResponse } from "node:http";
import { z } from "zod";

import { BOT_AVATAR_STATE_KEYS, botAvatarMediaUrlFromStoredPath, type BotAvatarStateKey } from "../../shared/bot-avatar.ts";
import type { WireBot } from "../../shared/wire.ts";
import { deleteAttachment, readAttachment, saveAvatarVideo } from "../attachments.ts";
import type { AppConfig } from "../config.ts";
import { VIDEO_PROMPT_MAX_CHARS } from "../drivers/agents-video-tools.ts";
import type { json } from "../harness/http.ts";
import { SEEDANCE_PROVIDERS, seedancePublicStatus } from "../seedance-config.ts";
import { generateSeedanceStateVideo, SEEDANCE_AVATAR_STYLES } from "../seedance.ts";
import type { BotRecord, Store } from "../store.ts";
import { PASS } from "./table.ts";

export const VIDEO_MESSAGES = {
  notSetUp:
    "Video generation isn't set up yet. Ask the person to configure Volcengine Ark or TK1688 in Settings → AI → Video generation.",
  notPerson:
    "Videos can only be generated from a person's own message in chat. Ask the person to request it directly in a conversation.",
} as const;

const requestSchema = z.object({
  fromBotId: z.string().min(1).optional(),
  fromThreadId: z.string().min(1).optional(),
  prompt: z.string().trim().max(VIDEO_PROMPT_MAX_CHARS).optional(),
  avatar_state: z.enum(BOT_AVATAR_STATE_KEYS).optional(),
  style: z.enum(SEEDANCE_AVATAR_STYLES).optional(),
  provider: z.enum(SEEDANCE_PROVIDERS).optional(),
  resolution: z.enum(["720p", "480p"]).optional(),
  duration: z.number().int().min(4).max(30).optional(),
  seamless_loop: z.boolean().optional(),
}).refine((data) => Boolean(data.avatar_state || data.prompt), {
  message: "Provide a `prompt` or an `avatar_state`.",
});

export interface VideoRouteContext {
  method: string;
  path: string;
  res: ServerResponse;
  json: typeof json;
  readBody: () => Promise<unknown>;
  botId: string;
  threadId: string;
  personTurn: boolean;
}

export function createVideoToolRoutes(deps: {
  config: () => AppConfig;
  store: Pick<Store, "bot" | "patchBot">;
  wireBot: (bot: BotRecord) => WireBot;
  broadcast: (payload: Record<string, unknown>) => void;
  fetchImpl?: typeof fetch;
}) {
  return {
    async internal(ctx: VideoRouteContext): Promise<typeof PASS | void> {
      if (ctx.method !== "POST" || ctx.path !== "/api/internal/videos/generate") return PASS;
      ctx.res.setTimeout(0);
      if (!ctx.personTurn) {
        ctx.json(ctx.res, 403, { error: VIDEO_MESSAGES.notPerson });
        return;
      }
      const parsed = requestSchema.safeParse(await ctx.readBody());
      if (!parsed.success) {
        ctx.json(ctx.res, 400, {
          error: parsed.error.issues[0]?.message ?? "Invalid generate_video arguments.",
        });
        return;
      }
      const cfg = deps.config();
      const status = seedancePublicStatus(cfg.seedance);
      const effectiveProvider = parsed.data.provider ?? status.provider;
      const providerReady = effectiveProvider === "tk1688"
        ? status.tk1688Configured && Boolean(status.tk1688Endpoint)
        : status.arkConfigured;
      if (!providerReady) {
        ctx.json(ctx.res, 409, { error: VIDEO_MESSAGES.notSetUp });
        return;
      }

      const bot = deps.store.bot(ctx.botId);
      const targetState: BotAvatarStateKey = parsed.data.avatar_state ?? "idle";
      let referenceImageDataUrl: string | undefined;
      if (parsed.data.avatar_state && bot?.avatarUrl && bot.avatarUrl.startsWith("/api/attachments/")) {
        const att = readAttachment(bot.avatarUrl.slice("/api/attachments/".length));
        if (att && att.mime.startsWith("image/")) {
          referenceImageDataUrl = `data:${att.mime};base64,${att.bytes.toString("base64")}`;
        }
      }

      try {
        const generated = await generateSeedanceStateVideo(cfg.seedance, {
          state: targetState,
          provider: parsed.data.provider,
          style: parsed.data.style,
          prompt: parsed.data.prompt,
          duration: parsed.data.duration,
          resolution: parsed.data.resolution ?? "720p",
          seamlessLoop: parsed.data.seamless_loop ?? (parsed.data.avatar_state ? parsed.data.avatar_state !== "working" : false),
          referenceImageDataUrl,
          fetchImpl: deps.fetchImpl,
        });
        const saved = saveAvatarVideo(generated.bytes, generated.mime);
        const mediaUrl = botAvatarMediaUrlFromStoredPath(saved.path);
        if (!mediaUrl) {
          deleteAttachment(saved.path);
          ctx.json(ctx.res, 500, { error: "Could not store the generated video." });
          return;
        }

        if (parsed.data.avatar_state && bot) {
          const nextStates = { ...bot.avatarStates, [parsed.data.avatar_state]: mediaUrl };
          const updated = deps.store.patchBot(bot.id, { avatarStates: nextStates });
          if (updated) {
            deps.broadcast({ kind: "bot", bot: deps.wireBot(updated) });
          }
          ctx.json(ctx.res, 201, {
            text: `Generated ${parsed.data.resolution ?? "720p"} video via ${generated.provider} (task ${generated.taskId}) and bound it to avatar state "${parsed.data.avatar_state}" (${mediaUrl}).`,
          });
          return;
        }

        ctx.json(ctx.res, 201, {
          text: `Generated ${parsed.data.resolution ?? "720p"} video via ${generated.provider} (task ${generated.taskId}). Saved at ${mediaUrl}.`,
        });
      } catch (error) {
        const code = (error as { status?: unknown } | null)?.status;
        ctx.json(
          ctx.res,
          typeof code === "number" ? code : 502,
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
    },
  };
}
