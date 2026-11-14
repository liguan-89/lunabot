// Qwen speech via DashScope: TTS through the native multimodal-generation API
// (the OpenAI-compatible shim has no /audio/speech), ASR through
// compatible-mode chat/completions with an input_audio data URI. The key is
// the Live call's realtime gateway key, sent only to the origin it was saved for.
import type { Audio, Voice } from "./elevenlabs.ts";

const TTS_MODEL = "qwen3-tts-flash";
const ASR_MODEL = "qwen3-asr-flash";
const MAX_ERROR_LENGTH = 240;
const MAX_AUDIO_URL_LENGTH = 4096;

export const QWEN_VOICES: Voice[] = [
  { id: "Cherry", label: "芊悦 Cherry" },
  { id: "Ethan", label: "晨煦 Ethan" },
  { id: "Chelsie", label: "千雪 Chelsie" },
  { id: "Serena", label: "苏娜 Serena" },
  { id: "Nofish", label: "不吃鱼 Nofish" },
  { id: "Jennifer", label: "詹妮弗 Jennifer" },
  { id: "Ryan", label: "甜茶 Ryan" },
  { id: "Katerina", label: "卡捷琳娜 Katerina" },
  { id: "Aiden", label: "艾登 Aiden" },
];

export function listVoices(): Voice[] {
  return QWEN_VOICES;
}

function detail(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message
    : typeof record.Message === "string" ? record.Message
    : "";
  return message.trim().slice(0, MAX_ERROR_LENGTH);
}

function assertAudioUrl(url: unknown): string {
  // DashScope answers with a signed OSS link; keep the fetch on https and
  // bounded so a hostile endpoint cannot turn this into an arbitrary sink.
  if (typeof url !== "string" || url.length > MAX_AUDIO_URL_LENGTH || !url.startsWith("https://")) {
    throw new Error("Qwen speech returned no audio.");
  }
  return url;
}

export async function synthesize(
  text: string,
  voice: string,
  key: string,
  origin: string,
  signal?: AbortSignal,
): Promise<Audio> {
  let res: Response;
  try {
    res = await fetch(`${origin}/api/v1/services/aigc/multimodal-generation/generation`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: TTS_MODEL, input: { text, voice } }),
      redirect: "error",
      signal: signal ?? AbortSignal.timeout(60_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error("Couldn't reach Qwen speech — check your connection.");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const why = detail(body);
    throw new Error(why ? `Qwen speech failed (${res.status}): ${why}` : `Qwen speech failed (${res.status})`);
  }
  const output = (body as Record<string, unknown> | null)?.output;
  const audio = output && typeof output === "object" ? (output as Record<string, unknown>).audio : undefined;
  const url = assertAudioUrl(audio && typeof audio === "object" ? (audio as Record<string, unknown>).url : undefined);
  let audioRes: Response;
  try {
    audioRes = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new Error("Couldn't fetch Qwen speech audio — check your connection.");
  }
  if (!audioRes.ok) throw new Error(`Qwen speech audio fetch failed (${audioRes.status})`);
  return { bytes: new Uint8Array(await audioRes.arrayBuffer()), mime: "audio/wav" };
}

/** qwen3-asr-flash over the OpenAI-compatible endpoint; WAV goes base64 inline. */
export async function transcribe(audio: Uint8Array, key: string, origin: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${origin}/compatible-mode/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: ASR_MODEL,
        messages: [{
          role: "user",
          content: [{
            type: "input_audio",
            input_audio: { data: `data:audio/wav;base64,${Buffer.from(audio).toString("base64")}` },
          }],
        }],
        stream: false,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new Error("Couldn't reach Qwen speech-to-text — check your connection.");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const why = detail(body);
    throw new Error(why ? `Qwen speech-to-text failed (${res.status}): ${why}` : `Qwen speech-to-text failed (${res.status})`);
  }
  const choices = (body as Record<string, unknown> | null)?.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const message = first && typeof first === "object" ? (first as Record<string, unknown>).message : undefined;
  const text = message && typeof message === "object" ? (message as Record<string, unknown>).content : undefined;
  return typeof text === "string" ? text.trim() : "";
}
