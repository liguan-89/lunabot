// Volcengine speech (openspeech): one-shot HTTP TTS (v1) and BigASR flash
// file recognition (v3). Both reuse the Live call's App ID + Access Token.
import { randomUUID } from "node:crypto";
import type { Audio, Voice } from "./elevenlabs.ts";

const API = "https://openspeech.bytedance.com";
const ASR_RESOURCE_ID = "volc.bigasr.auc_turbo";
const MAX_ERROR_LENGTH = 240;

/** V1 `/api/v1/tts` serves the classic catalog; the dialogue (O2.0) voices
 * live calls use are V3-only and would fail here. */
export const VOLC_VOICES: Voice[] = [
  { id: "BV001_streaming", label: "通用女声" },
  { id: "BV002_streaming", label: "通用男声" },
  { id: "BV700_streaming", label: "灿灿" },
  { id: "BV701_streaming", label: "擎苍" },
  { id: "zh_female_qingxin", label: "清新女声" },
  { id: "zh_female_sajiaonvyou_moon_bigtts", label: "撒娇女友" },
  { id: "zh_male_yangguangqingnian_moon_bigtts", label: "阳光青年" },
  { id: "zh_male_jingqiangkanye_moon_bigtts", label: "京腔侃爷" },
];

export function listVoices(): Voice[] {
  return VOLC_VOICES;
}

function detail(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message
    : typeof record.Message === "string" ? record.Message
    : "";
  return message.trim().slice(0, MAX_ERROR_LENGTH);
}

export async function synthesize(
  text: string,
  voiceType: string,
  appId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<Audio> {
  let res: Response;
  try {
    res = await fetch(`${API}/api/v1/tts`, {
      method: "POST",
      headers: {
        // V1 auth is the literal word Bearer, a semicolon, then the token.
        authorization: `Bearer;${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        app: { appid: appId, token: "access_token", cluster: "volcano_tts" },
        user: { uid: "lunabot" },
        audio: { voice_type: voiceType, encoding: "mp3", speed_ratio: 1.0 },
        request: { reqid: randomUUID(), text, text_type: "plain", operation: "query" },
      }),
      redirect: "error",
      signal: signal ?? AbortSignal.timeout(60_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error("Couldn't reach Volcengine speech — check your connection.");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const why = detail(body);
    throw new Error(why ? `Volcengine speech failed (${res.status}): ${why}` : `Volcengine speech failed (${res.status})`);
  }
  const record = (body ?? {}) as Record<string, unknown>;
  if (record.code !== 3000) {
    const why = detail(body);
    throw new Error(why ? `Volcengine speech failed: ${why}` : `Volcengine speech failed (code ${String(record.code)})`);
  }
  const data = typeof record.data === "string" ? record.data : "";
  const bytes = data ? Buffer.from(data, "base64") : null;
  if (!bytes?.length) throw new Error("Volcengine speech returned no audio.");
  return { bytes, mime: "audio/mpeg" };
}

/** BigASR flash file recognition: one request, the whole WAV as base64. */
export async function transcribe(audio: Uint8Array, appId: string, accessToken: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${API}/api/v3/auc/bigmodel/recognize/flash`, {
      method: "POST",
      headers: {
        "X-Api-App-Key": appId,
        "X-Api-Access-Key": accessToken,
        "X-Api-Resource-Id": ASR_RESOURCE_ID,
        "X-Api-Request-Id": randomUUID(),
        "X-Api-Sequence": "-1",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        user: { uid: appId },
        audio: { data: Buffer.from(audio).toString("base64") },
        request: { model_name: "bigmodel" },
      }),
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new Error("Couldn't reach Volcengine speech — check your connection.");
  }
  const statusCode = (res.headers.get("x-api-status-code") ?? "").trim();
  const apiMessage = (res.headers.get("x-api-message") ?? "").trim().slice(0, MAX_ERROR_LENGTH);
  if (!res.ok || (statusCode && !statusCode.startsWith("200"))) {
    throw new Error(
      `Doubao speech-to-text failed${statusCode ? ` (${statusCode})` : res.ok ? "" : ` (${res.status})`}${apiMessage ? `: ${apiMessage}` : ""}`,
    );
  }
  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  const result = body?.result;
  const text = result && typeof result === "object" ? (result as Record<string, unknown>).text : undefined;
  return typeof text === "string" ? text.trim() : "";
}
