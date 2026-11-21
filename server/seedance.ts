import { z } from "zod";
import { BOT_AVATAR_STATE_KEYS, type BotAvatarStateKey } from "../shared/bot-avatar.ts";
import {
  DEFAULT_ARK_ENDPOINT,
  DEFAULT_ARK_MODEL,
  DEFAULT_TK1688_ENDPOINT,
  DEFAULT_TK1688_MODEL,
  SEEDANCE_PROVIDERS,
  type SeedanceConfig,
  type SeedanceProvider,
} from "./seedance-config.ts";

export const SEEDANCE_VIDEO_MAX_BYTES = 25 * 1024 * 1024;
export const SEEDANCE_POLL_INTERVAL_MS = 5_000;
export const SEEDANCE_MAX_WAIT_MS = 1_500_000;

export const SEEDANCE_AVATAR_STYLES = ["auto", "photorealistic", "stylized3d", "anime", "cartoon"] as const;
export type SeedanceAvatarStyle = (typeof SEEDANCE_AVATAR_STYLES)[number];

export const SEEDANCE_STYLE_PREFIXES: Record<Exclude<SeedanceAvatarStyle, "auto">, string> = {
  photorealistic: "Photorealistic studio portrait photography, natural skin texture, lifelike softbox studio lighting.",
  stylized3d: "Stylized 3D human-like digital character, smooth high-end 3D animation rendering, soft studio lighting.",
  anime: "Clean 2D Japanese anime illustration style, crisp lineart, soft cel shading, expressive eyes.",
  cartoon: "Cute expressive cartoon character style, warm playful colors, clean smooth 2D animation.",
};

export const seedanceGenerateRequestSchema = z.object({
  state: z.enum(BOT_AVATAR_STATE_KEYS),
  provider: z.enum(SEEDANCE_PROVIDERS).optional(),
  style: z.enum(SEEDANCE_AVATAR_STYLES).optional(),
  prompt: z.string().trim().max(800).optional(),
  duration: z.number().int().min(4).max(30).optional(),
  resolution: z.enum(["480p", "720p"]).optional(),
  seamlessLoop: z.boolean().optional(),
});

export type SeedanceGenerateRequest = z.infer<typeof seedanceGenerateRequestSchema>;

/** Built-in state motion briefs designed for clean white-studio avatar loops and Muse-style working scenes. */
export const SEEDANCE_STATE_PROMPTS: Record<BotAvatarStateKey, string> = {
  idle:
    "Keep the exact same person, outfit, and pure white background. Gentle natural breathing, soft blink, subtle warm smile, minimal head sway, seamless loop back to the starting pose. Static camera, soft studio lighting.",
  working:
    "Keep the exact same person and outfit on a clean pure white studio background. The character wears sleek cream wireless over-ear headphones and sits at a minimalist desk focused on typing on a sleek silver laptop, subtle natural typing motion and focused gaze at the screen. Static camera, crisp studio lighting.",
  listening:
    "Keep the exact same person, outfit, and pure white background. Attentive listening expression looking into the camera, gentle natural nods, blinking naturally, slight relaxed shoulder breathing, seamless loop back to the starting pose. Static camera.",
  talking:
    "Keep the exact same person, outfit, and pure white background. Speaking warmly and naturally toward the camera with smooth conversational mouth movement, gentle expressive head nods, soft natural blinking and subtle upper-body gestures, seamless loop back to the starting pose. Static camera.",
  thinking:
    "Keep the exact same person, outfit, and pure white background. Thoughtful expression with gentle upward gaze, subtle finger tap or chin rest, soft breathing, seamless loop back to the starting pose. Static camera.",
};

export interface SeedanceResolvedTarget {
  provider: SeedanceProvider;
  createUrl: string;
  pollUrlFor(taskId: string): string;
  contentUrlFor(taskId: string): string;
  apiKey: string;
  model: string;
  resolution: "480p" | "720p";
  duration: number;
}

/**
 * Resolves Volcengine Ark official (`/api/v3/contents/generations/tasks`) or TK1688 relay (`/v1/videos`) URLs
 * cleanly whether the user gives a bare host, versioned base path, or full endpoint URL.
 */
export function resolveSeedanceTarget(
  cfg: SeedanceConfig | undefined,
  overrideProvider?: SeedanceProvider,
): SeedanceResolvedTarget {
  const provider: SeedanceProvider = overrideProvider ?? (cfg?.provider === "tk1688" ? "tk1688" : "ark");
  const isTk = provider === "tk1688";
  const rawBase = (isTk ? cfg?.tk1688Endpoint : cfg?.arkEndpoint)?.trim() || (isTk ? DEFAULT_TK1688_ENDPOINT : DEFAULT_ARK_ENDPOINT);
  if (!rawBase) {
    throw Object.assign(new Error("请先在设置中填写 TK1688 中转接口地址（Base URL）"), { status: 409 });
  }
  const apiKey = (isTk ? cfg?.tk1688Key : cfg?.arkKey)?.trim() ?? "";
  if (!apiKey) {
    throw Object.assign(
      new Error(isTk ? "请先在设置中配置 TK1688 中转 API Key" : "请先在设置中配置火山方舟 Ark API Key"),
      { status: 409 },
    );
  }
  const model = (isTk ? cfg?.tk1688Model : cfg?.arkModel)?.trim() || (isTk ? DEFAULT_TK1688_MODEL : DEFAULT_ARK_MODEL);
  const cleaned = rawBase.replace(/\/+$/, "");
  const createUrl = isTk
    ? /\/videos$/i.test(cleaned)
      ? cleaned
      : /\/v\d+$/i.test(cleaned)
        ? `${cleaned}/videos`
        : `${cleaned}/v1/videos`
    : /\/contents\/generations\/tasks$/i.test(cleaned)
      ? cleaned
      : /\/api\/v\d+$/i.test(cleaned) || /\/v\d+$/i.test(cleaned)
        ? `${cleaned}/contents/generations/tasks`
        : `${cleaned}/api/v3/contents/generations/tasks`;
  return {
    provider,
    createUrl,
    pollUrlFor: (taskId: string) => `${createUrl}/${encodeURIComponent(taskId)}`,
    contentUrlFor: (taskId: string) => `${createUrl}/${encodeURIComponent(taskId)}/content`,
    apiKey,
    model,
    resolution: cfg?.resolution === "480p" ? "480p" : "720p",
    duration: typeof cfg?.duration === "number" && cfg.duration >= 4 && cfg.duration <= 30 ? cfg.duration : 5,
  };
}

/** Extracts the generated video URL from Ark official responses and TK1688 /v1/videos response envelopes. */
export function extractSeedanceVideoUrl(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  const dataObj = !Array.isArray(obj.data) && obj.data && typeof obj.data === "object"
    ? (obj.data as Record<string, unknown>)
    : undefined;
  const resultObj = obj.result && typeof obj.result === "object"
    ? (obj.result as Record<string, unknown>)
    : undefined;
  const videosArr = Array.isArray(obj.videos) ? obj.videos : Array.isArray(dataObj?.videos) ? dataObj.videos : null;
  const outputsArr = Array.isArray(obj.outputs) ? obj.outputs : Array.isArray(dataObj?.outputs) ? dataObj.outputs : null;
  const dataArr = Array.isArray(obj.data) ? obj.data : null;
  const firstVideo = (videosArr?.[0] ?? outputsArr?.[0] ?? dataArr?.[0]) as Record<string, unknown> | undefined;
  const candidates = [
    (obj.content as Record<string, unknown> | undefined)?.video_url,
    (obj.content as Record<string, unknown> | undefined)?.url,
    dataObj?.video_url,
    dataObj?.url,
    (dataObj?.content as Record<string, unknown> | undefined)?.video_url,
    resultObj?.video_url,
    resultObj?.url,
    (obj.output as Record<string, unknown> | undefined)?.video_url,
    (obj.output as Record<string, unknown> | undefined)?.url,
    firstVideo?.video_url,
    firstVideo?.url,
    obj.video_url,
    obj.url,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^https?:\/\//i.test(candidate.trim())) {
      return candidate.trim();
    }
  }
  return null;
}

export function extractSeedanceTaskId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  const dataObj = !Array.isArray(obj.data) && obj.data && typeof obj.data === "object"
    ? (obj.data as Record<string, unknown>)
    : undefined;
  const candidates = [
    obj.id,
    obj.task_id,
    dataObj?.id,
    dataObj?.task_id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

export function extractSeedanceStatus(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const obj = payload as Record<string, unknown>;
  const dataObj = !Array.isArray(obj.data) && obj.data && typeof obj.data === "object"
    ? (obj.data as Record<string, unknown>)
    : undefined;
  const raw = obj.status ?? dataObj?.status;
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

export function extractSeedanceError(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  const dataObj = !Array.isArray(obj.data) && obj.data && typeof obj.data === "object"
    ? (obj.data as Record<string, unknown>)
    : undefined;
  const err = obj.error ?? dataObj?.error;
  if (typeof err === "string" && err.trim()) return err.trim();
  if (err && typeof err === "object") {
    const message = (err as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  if (typeof obj.message === "string" && obj.message.trim()) return obj.message.trim();
  return null;
}

export interface GeneratedSeedanceVideo {
  bytes: Buffer;
  mime: string;
  taskId: string;
  provider: SeedanceProvider;
}

export async function generateSeedanceStateVideo(
  cfg: SeedanceConfig | undefined,
  options: {
    state: BotAvatarStateKey;
    provider?: SeedanceProvider;
    style?: SeedanceAvatarStyle;
    prompt?: string;
    duration?: number;
    resolution?: "480p" | "720p";
    seamlessLoop?: boolean;
    referenceImageDataUrl?: string;
    fetchImpl?: typeof fetch;
    pollIntervalMs?: number;
    maxWaitMs?: number;
  },
): Promise<GeneratedSeedanceVideo> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const target = resolveSeedanceTarget(cfg, options.provider);
  const resolution = options.resolution ?? target.resolution;
  const basePrompt = options.prompt?.trim() || SEEDANCE_STATE_PROMPTS[options.state];
  const stylePrefix = options.style && options.style !== "auto" ? SEEDANCE_STYLE_PREFIXES[options.style] : "";
  const prompt = stylePrefix ? `${stylePrefix} ${basePrompt}` : basePrompt;
  const seamlessLoop = options.seamlessLoop ?? (options.state !== "working");

  let createBody: Record<string, unknown>;
  if (target.provider === "tk1688") {
    // TK1688 /v1/videos protocol:
    // - Per-second SKU (model contains "-sec-"): supports 4-30s duration & resolution
    // - Per-clip SKU (bare model name without "-sec-"): fixed 15s duration
    // - References: "images" array (1 image = first frame, 2 images = first + last frame)
    const isPerSecondSku = /-sec-/i.test(target.model);
    const seconds = isPerSecondSku
      ? (options.duration ?? target.duration)
      : (options.duration ?? 15);
    createBody = {
      model: target.model,
      prompt,
      seconds,
      ...(isPerSecondSku ? { resolution } : {}),
      ...(options.referenceImageDataUrl
        ? {
            images: seamlessLoop
              ? [options.referenceImageDataUrl, options.referenceImageDataUrl]
              : [options.referenceImageDataUrl],
          }
        : {}),
    };
  } else {
    // Volcengine Ark official /api/v3/contents/generations/tasks protocol
    const duration = Math.min(10, Math.max(4, options.duration ?? target.duration));
    const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
    if (options.referenceImageDataUrl) {
      content.push({
        type: "image_url",
        image_url: { url: options.referenceImageDataUrl },
        role: "first_frame",
      });
      if (seamlessLoop) {
        content.push({
          type: "image_url",
          image_url: { url: options.referenceImageDataUrl },
          role: "last_frame",
        });
      }
    }
    createBody = {
      model: target.model,
      content,
      duration,
      resolution,
      ratio: options.referenceImageDataUrl ? "adaptive" : "1:1",
      watermark: false,
    };
  }

  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${target.apiKey}`,
  };

  const createRes = await fetchImpl(target.createUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(createBody),
    signal: AbortSignal.timeout(30_000),
  });
  const createJson = await createRes.json().catch(() => null);
  if (!createRes.ok) {
    const detail = extractSeedanceError(createJson) ?? `HTTP ${createRes.status}`;
    throw Object.assign(new Error(`Seedance 创建任务失败 (${target.provider}): ${detail}`), { status: 502 });
  }
  const taskId = extractSeedanceTaskId(createJson);
  if (!taskId) {
    throw Object.assign(new Error("Seedance 未返回有效任务 ID"), { status: 502 });
  }

  const deadline = Date.now() + (options.maxWaitMs ?? SEEDANCE_MAX_WAIT_MS);
  const pollInterval = options.pollIntervalMs ?? SEEDANCE_POLL_INTERVAL_MS;
  let videoUrl = extractSeedanceVideoUrl(createJson);
  let useAuthorizedContentFallback = false;
  let lastStatus = extractSeedanceStatus(createJson);

  while (!videoUrl && !useAuthorizedContentFallback) {
    if (Date.now() >= deadline) {
      const statusSuffix = lastStatus ? `，最后状态：${lastStatus}` : "";
      throw Object.assign(new Error(`Seedance 视频生成超时（任务 ${taskId}${statusSuffix}）`), { status: 504 });
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    const pollRes = await fetchImpl(target.pollUrlFor(taskId), {
      method: "GET",
      headers: { authorization: `Bearer ${target.apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    const pollJson = await pollRes.json().catch(() => null);
    if (!pollRes.ok) {
      const detail = extractSeedanceError(pollJson) ?? `HTTP ${pollRes.status}`;
      throw Object.assign(new Error(`Seedance 查询任务失败 (${target.provider}): ${detail}`), { status: 502 });
    }
    const status = extractSeedanceStatus(pollJson);
    if (status) lastStatus = status;
    if (status === "failed" || status === "cancelled" || status === "canceled" || status === "expired" || status === "error") {
      const detail = extractSeedanceError(pollJson) ?? status;
      throw Object.assign(new Error(`Seedance 生成失败: ${detail}`), { status: 502 });
    }
    const polledUrl = extractSeedanceVideoUrl(pollJson);
    if (polledUrl) {
      videoUrl = polledUrl;
      break;
    }
    if (status === "succeeded" || status === "completed" || status === "complete" || status === "success" || status === "done" || status === "finished" || status === "ready") {
      if (target.provider === "tk1688") {
        useAuthorizedContentFallback = true;
        videoUrl = target.contentUrlFor(taskId);
      } else {
        throw Object.assign(new Error("Seedance 任务已完成但未返回 video_url"), { status: 502 });
      }
      break;
    }
  }

  const mediaRes = await fetchImpl(videoUrl!, {
    ...(useAuthorizedContentFallback ? { headers: { authorization: `Bearer ${target.apiKey}` } } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  if (!mediaRes.ok) {
    throw Object.assign(new Error(`下载 Seedance 生成视频失败 (HTTP ${mediaRes.status})`), { status: 502 });
  }
  const rawMime = mediaRes.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  const mime = rawMime === "video/webm" ? "video/webm" : "video/mp4";
  const bytes = Buffer.from(await mediaRes.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw Object.assign(new Error("Seedance 返回了空视频文件"), { status: 502 });
  }
  if (bytes.byteLength > SEEDANCE_VIDEO_MAX_BYTES) {
    throw Object.assign(new Error(`生成的视频超出 ${Math.round(SEEDANCE_VIDEO_MAX_BYTES / (1024 * 1024))}MB 限制`), { status: 413 });
  }
  return { bytes, mime, taskId, provider: target.provider };
}
