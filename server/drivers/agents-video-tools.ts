import { BOT_AVATAR_STATE_KEYS } from "../../shared/bot-avatar.ts";
import { SEEDANCE_PROVIDERS } from "../seedance-config.ts";
import { SEEDANCE_AVATAR_STYLES } from "../seedance.ts";
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const VIDEO_PROMPT_MAX_CHARS = 800;
export const VIDEO_TOOL_NAMES: ReadonlySet<string> = new Set(["generate_video"]);

export async function callVideoTool(_name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse("/api/internal/videos/generate", {
    method: "POST",
    body: JSON.stringify({ fromBotId: context.botId, fromThreadId: context.threadId, ...args }),
  });
  return ok
    ? { text: String(body.text ?? "") }
    : { text: String(body.error ?? "The video was not generated. Try again shortly."), isError: true };
}

export const VIDEO_TOOL_DEFINITIONS = [
  {
    name: "generate_video",
    description:
      "Generate a short video clip (720p by default) using the person's configured Seedance video provider (Volcengine Ark or TK1688). When `avatar_state` is set (idle, working, listening, talking, or thinking), uses your current avatar image as reference frame(s), falls back to a built-in studio motion prompt if `prompt` is omitted, and automatically binds the video to your dynamic avatar. IMPORTANT UX WORKFLOW for dynamic avatars: if the person asks to create/animate a dynamic avatar without specifying a visual style yet, DO NOT immediately generate videos — first ask one brief, friendly question offering concrete style choices (e.g., keep current avatar style, photorealistic portrait / 真人写真, 3D human-like / 3D 类人, anime / 二次元, or cute cartoon / 卡通萌系) and confirm whether to generate the core 3 states (待机 / 工作中 / 说话) or all 5. If they want a new character look and `generate_image` is available, offer to create a base static portrait first so all video states stay consistent. Once style is clear (or if they already specified it), call `generate_video` for each state directly without asking for technical state names or prompts.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: VIDEO_PROMPT_MAX_CHARS,
          description: "Visual & motion description (English or Chinese). Required for standalone videos; optional when `avatar_state` is set (uses built-in Muse-style state motion prompt if omitted).",
        },
        avatar_state: {
          type: "string",
          enum: [...BOT_AVATAR_STATE_KEYS],
          description: "Optional. When set, binds the generated video directly to this bot's dynamic avatar state slot.",
        },
        style: {
          type: "string",
          enum: [...SEEDANCE_AVATAR_STYLES],
          description: "Optional visual style preset: 'auto' (match current avatar), 'photorealistic' (真人写真), 'stylized3d' (3D 类人), 'anime' (二次元), or 'cartoon' (卡通萌系).",
        },
        provider: {
          type: "string",
          enum: [...SEEDANCE_PROVIDERS],
          description: "Optional provider override ('ark' or 'tk1688'); omit to use the configured default.",
        },
        resolution: {
          type: "string",
          enum: ["720p", "480p"],
          description: "Video resolution; defaults to 720p.",
        },
        duration: {
          type: "integer",
          minimum: 4,
          maximum: 30,
          description: "Clip duration in seconds (4–30s for per-second SKU; defaults to 5s or 15s for per-clip SKU).",
        },
        seamless_loop: {
          type: "boolean",
          description: "Use the reference avatar as both first and last frame for seamless looping.",
        },
      },
    },
  },
];
