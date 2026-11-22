// The provider key never leaves the harness: the renderer only ever holds the SDP answer and its media connection.
import { WebSocket } from "ws";
import { CLOUD_HOME_PLACE } from "./system-prompt.ts";
import type { LiveProvider } from "../shared/wire.ts";
import type { Message } from "./store.ts";

export const LIVE_MODEL = "gpt-live-1";
const OPENAI_BASE = "https://api.openai.com";
export const DEFAULT_LIVE_VOICE = "marin";
export const MAX_SDP_BYTES = 64 * 1024;
export const LIVE_NEEDS_KEY = "Live calls use your own OpenAI key. Add it in Settings → API keys.";
export const LIVE_NEEDS_AZURE = "Live calls through Azure OpenAI need the resource endpoint, the GPT-Live deployment name and its key. Add them in Call settings.";
export const LIVE_NEEDS_QWEN = "Live calls through Qwen need the realtime gateway's https address and its key. Add them in Call settings.";
export const LIVE_NEEDS_VOLC = "Live calls through Doubao need the speech app's App ID and its Access Token as the Live key. Add them in Call settings.";
export const LIVE_QWEN_TRANSPORT = "Qwen realtime calls run over the app's WebSocket audio path; start the call from Luna Bot.";
export const LIVE_VOLC_TRANSPORT = "Doubao realtime calls run over the app's WebSocket audio path; start the call from Luna Bot.";

/** The client's data channel is untrusted: it may only hang up; every append goes over the sideband.
 * Exception: Azure OpenAI refuses `session.client`, so an Azure call goes without this list and its caller's channel keeps
 * Azure's default events. Read that as: the caller may send session or item events and receive events holding the bot's
 * instructions (not checked against Azure itself). So an Azure call is only for an admin or the owner of a single-owner
 * server, never another team Member, a shared workspace's non-admin or anyone else: azureLiveCallRefusal (own-provider calls) in live-access.ts,
 * asked by LiveCallController.start. */
export const LIVE_DATA_CHANNEL = {
  allowed_client_events: ["session.close"],
  allowed_server_events: [
    { type: "session.started" },
    { type: "session.input_transcript.delta" },
    { type: "session.output_transcript.delta" },
    { type: "session.closed" },
    { type: "error" },
    { type: "info" },
  ],
};

/** The hosts an Azure call may use: Azure OpenAI and Foundry resources, Azure OpenAI on Azure Government (.us) and Azure China (.cn), and API Management gateways on .azure-api.net. The key is only ever sent to one of these, and to the one it was saved for. */
const AZURE_HOST_SUFFIXES = [
  ".openai.azure.com",
  ".services.ai.azure.com",
  ".cognitiveservices.azure.com",
  ".openai.azure.us",
  ".openai.azure.cn",
  ".azure-api.net",
] as const;
const AZURE_DEPLOYMENT = /^[A-Za-z0-9][\w.-]{0,63}$/;

/** Where a Live call's session is created and its sideband attached. Never carries the key. */
export interface LiveEndpoint {
  provider: LiveProvider;
  /** The versioned API root, e.g. `https://api.openai.com/v1` or `https://my-res.openai.azure.com/openai/v1`. */
  apiBase: string;
  /** The OpenAI model id, or the Azure deployment name. */
  model: string;
}

export function liveProviderName(provider: LiveProvider): string {
  return provider === "azure" ? "Azure OpenAI" : provider === "qwen" ? "Qwen" : provider === "volc" ? "Doubao" : "OpenAI";
}

export const LIVE_QWEN_MODEL = "qwen3.5-omni-flash-realtime";

/** The `wss` realtime root of a Qwen gateway: its https origin only, so `https://host` and `https://host/compatible-mode/v1` save alike. A loopback http URL maps to `ws://` for tests; anything else is not a place a key may go. */
export function qwenRealtimeRoot(raw: string | undefined): string | null {
  let url: URL;
  try {
    url = new URL(raw?.trim() ?? "");
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return `wss://${url.host}`;
  if (url.protocol === "http:" && /^127\.0\.0\.1:\d{1,5}$/.test(url.host)) return `ws://${url.host}`;
  return null;
}

export function qwenLiveDeployment(raw: string | undefined): string | null {
  const name = raw?.trim() || LIVE_QWEN_MODEL;
  return /^[\w.-]{1,64}$/.test(name) ? name : null;
}

export function qwenLiveEndpoint(endpoint: string | undefined, model: string | undefined): LiveEndpoint | null {
  const root = qwenRealtimeRoot(endpoint);
  const deployment = qwenLiveDeployment(model);
  return root && deployment ? { provider: "qwen", apiBase: `${root}/api-ws/v1`, model: deployment } : null;
}

/** The realtime socket a Qwen session opens: `session.created` answers the connect. */
export function qwenRealtimeUrl(endpoint: LiveEndpoint): string {
  return `${endpoint.apiBase}/realtime?model=${encodeURIComponent(endpoint.model)}`;
}

export const VOLC_LIVE_HOST = "wss://openspeech.bytedance.com";
export const LIVE_VOLC_MODEL = "1.2.1.1";
const VOLC_RESOURCE_ID = "volc.speech.dialog";
const VOLC_APP_KEY = "PlgvMymc7f3tQnJ6";

export function volcAppId(raw: string | undefined): string | null {
  const id = raw?.trim() ?? "";
  return /^\d{4,20}$/.test(id) ? id : null;
}

export function volcLiveModel(raw: string | undefined): string | null {
  const name = raw?.trim() || LIVE_VOLC_MODEL;
  return /^[\w.-]{1,32}$/.test(name) ? name : null;
}

/** The realtime root is fixed (openspeech.bytedance.com); OMB_LIVE_VOLC_ENDPOINT swaps in a loopback ws root for tests. */
export function volcLiveEndpoint(appId: string | undefined, model: string | undefined, env: NodeJS.ProcessEnv = process.env): LiveEndpoint | null {
  if (!volcAppId(appId)) return null;
  const version = volcLiveModel(model);
  const override = env.OMB_LIVE_VOLC_ENDPOINT?.trim() ?? "";
  const root = /^wss?:\/\/127\.0\.0\.1:\d{1,5}$/.test(override) ? override : VOLC_LIVE_HOST;
  return version ? { provider: "volc", apiBase: root, model: version } : null;
}

export function volcRealtimeUrl(endpoint: LiveEndpoint): string {
  return `${endpoint.apiBase}/api/v3/realtime/dialogue`;
}

// The Seeduplex dialogue API fixes its model field; the configured volcModel only drives the legacy binary protocol.
export const VOLC_DUPLEX_MODEL = "1.2.6.1";

/** Seeduplex realtime dialogue: JSON event frames, the only volc transport that supports function calling. */
export function volcDuplexRealtimeUrl(endpoint: LiveEndpoint): string {
  return `${endpoint.apiBase}/api/v3/duplex/realtime/dialogue`;
}

/** Doubao's realtime dialogue API takes the speech app's App ID and Access Token in its own X-Api-* headers; the App Key and Resource ID are fixed product constants. */
export function volcAuthHeaders(appId: string, accessToken: string, connectId?: string): Record<string, string> {
  return {
    "X-Api-App-ID": appId,
    "X-Api-Access-Key": accessToken,
    "X-Api-Resource-Id": VOLC_RESOURCE_ID,
    "X-Api-App-Key": VOLC_APP_KEY,
    ...(connectId ? { "X-Api-Connect-Id": connectId } : {}),
  };
}

// The dialogue socket's v1 binary protocol: 4-byte header (version|header-size, message-type|flags, JSON|no-compression,
// reserved) + event id + [session id size + session id] + payload size + payload. Session-level events carry the id field.
export const VOLC_EVENT_START_CONNECTION = 1;
export const VOLC_EVENT_START_SESSION = 100;
export const VOLC_EVENT_CONNECTION_STARTED = 50;
export const VOLC_EVENT_SESSION_STARTED = 150;
export const VOLC_EVENT_TASK_REQUEST = 200;

export function volcFrame(event: number, payload: string, sessionId?: string): Buffer {
  const parts: Buffer[] = [Buffer.from([0x11, 0x14, 0x10, 0x00])];
  const ev = Buffer.alloc(4);
  ev.writeUInt32BE(event);
  parts.push(ev);
  if (sessionId !== undefined) {
    const id = Buffer.from(sessionId, "utf8");
    const size = Buffer.alloc(4);
    size.writeUInt32BE(id.length);
    parts.push(size, id);
  }
  const body = Buffer.from(payload, "utf8");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length);
  parts.push(size, body);
  return Buffer.concat(parts);
}

/** Audio goes up as a TaskRequest: an audio-only request carrying event 200 and the session id. Frames without the event or the id are refused with 45000000/45000001 — verified against openspeech. */
export function volcAudioTask(pcm: Buffer, sessionId: string): Buffer {
  const parts: Buffer[] = [Buffer.from([0x11, 0x24, 0x00, 0x00])];
  const ev = Buffer.alloc(4);
  ev.writeUInt32BE(VOLC_EVENT_TASK_REQUEST);
  parts.push(ev);
  const id = Buffer.from(sessionId, "utf8");
  const idSize = Buffer.alloc(4);
  idSize.writeUInt32BE(id.length);
  parts.push(idSize, id);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(pcm.length);
  parts.push(size, pcm);
  return Buffer.concat(parts);
}

export interface VolcFrame {
  /** 0b1111 is an error packet; 0b1001 a full server response; 0b1011 audio. */
  type: number;
  event?: number;
  code?: number;
  sessionId?: string;
  /** Control frames only: an audio packet's bytes are in `raw`. */
  payload?: string;
  /** The payload bytes before text decoding: TTS audio, or any frame whose body is not JSON. */
  raw?: Buffer;
}

export function volcDecodeFrame(data: Buffer): VolcFrame | null {
  if (data.length < 4) return null;
  const type = data[1] >> 4;
  const flags = data[1] & 0xf;
  let at = 4;
  const frame: VolcFrame = { type };
  if (type === 0xf && data.length >= at + 4) {
    frame.code = data.readUInt32BE(at);
    at += 4;
  }
  if ((flags === 0b0001 || flags === 0b0011) && data.length >= at + 4) at += 4;
  if (flags & 0x4) {
    if (data.length < at + 4) return null;
    frame.event = data.readUInt32BE(at);
    at += 4;
  }
  if (data.length >= at + 4) {
    const idSize = data.readUInt32BE(at);
    if (idSize > 0 && idSize <= 256 && data.length >= at + 4 + idSize + 4) {
      frame.sessionId = data.subarray(at + 4, at + 4 + idSize).toString("utf8");
      at += 4 + idSize;
    }
  }
  if (data.length >= at + 4) {
    const size = data.readUInt32BE(at);
    at += 4;
    if (data.length >= at + size) {
      frame.raw = data.subarray(at, at + size);
      if (type !== 0xb) frame.payload = frame.raw.toString("utf8");
    }
  }
  return frame;
}

export interface VolcProbeResult {
  ok: boolean;
  dialogId?: string;
  error?: string;
}

/** Opens the dialogue socket and drives it through StartConnection → ConnectionStarted (50) and StartSession →
 * SessionStarted (150): reaching 150 means App ID, Access Token and the model's activation are all good. The socket
 * carries only these control frames; the key goes to openspeech.bytedance.com alone. */
interface VolcSocket {
  close(): void;
  send(data: Buffer): void;
  on(event: "message", fn: (data: unknown) => void): void;
  on(event: "error", fn: (error: unknown) => void): void;
  on(event: "close", fn: () => void): void;
  on(event: "open", fn: () => void): void;
}

export function probeVolcLive(endpoint: LiveEndpoint, appId: string, accessToken: string, deps: { ws?: (url: string, headers: Record<string, string>) => VolcSocket; timeoutMs?: number } = {}): Promise<VolcProbeResult> {
  if (endpoint.provider !== "volc") return Promise.resolve({ ok: false, error: "not a volc endpoint" });
  const make = deps.ws ?? ((url, headers) => new WebSocket(url, { headers }) as unknown as VolcSocket);
  return new Promise((resolve) => {
    const done = (result: VolcProbeResult) => { clearTimeout(timer); try { socket.close(); } catch { /* already closed */ } resolve(result); };
    const timer = setTimeout(() => done({ ok: false, error: "timeout" }), deps.timeoutMs ?? 8_000);
    const socket = make(volcRealtimeUrl(endpoint), volcAuthHeaders(appId, accessToken));
    const sessionId = `probe-${Date.now().toString(36)}`;
    socket.on("error", () => done({ ok: false, error: "connect" }));
    socket.on("close", () => done({ ok: false, error: "closed" }));
    socket.on("open", () => {
      socket.send(volcFrame(VOLC_EVENT_START_CONNECTION, "{}"));
    });
    let connected = false;
    socket.on("message", (data) => {
      const frame = volcDecodeFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      if (!frame) return;
      if (frame.type === 0xf) {
        let message = "rejected";
        try {
          message = String((JSON.parse(frame.payload ?? "{}") as { error?: unknown }).error ?? message).slice(0, 200);
        } catch { /* not JSON */ }
        done({ ok: false, error: message });
        return;
      }
      if (frame.event === VOLC_EVENT_CONNECTION_STARTED && !connected) {
        connected = true;
        socket.send(volcFrame(VOLC_EVENT_START_SESSION, JSON.stringify({
          asr: { audio_info: { format: "pcm", sample_rate: 16000, channel: 1 } },
          tts: { speaker: "zh_female_vv_jupiter_bigtts", audio_config: { channel: 1, format: "pcm_s16le", sample_rate: 24000 } },
          dialog: { extra: { model: endpoint.model } },
        }), sessionId));
        return;
      }
      if (frame.event === VOLC_EVENT_SESSION_STARTED) {
        let dialogId: string | undefined;
        try {
          const id = (JSON.parse(frame.payload ?? "{}") as { dialog_id?: unknown }).dialog_id;
          if (typeof id === "string") dialogId = id;
        } catch { /* not JSON */ }
        done({ ok: true, ...(dialogId ? { dialogId } : {}) });
      }
    });
  });
}

/** Only a loopback http URL is accepted, read at call time. */
export function liveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OMB_OPENAI_LIVE_URL?.trim() ?? "";
  return /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(override) ? override : OPENAI_BASE;
}

export function openAiLiveEndpoint(env: NodeJS.ProcessEnv = process.env): LiveEndpoint {
  return { provider: "openai", apiBase: `${liveBaseUrl(env)}/v1`, model: LIVE_MODEL };
}

/** The `…/openai` root of an Azure resource URL as people paste it (bare, with `/openai/v1`, or a full request URL); null for anything that is not https on an Azure host. */
export function azureOpenAiRoot(raw: string | undefined): string | null {
  let url: URL;
  try {
    url = new URL(raw?.trim() ?? "");
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (!AZURE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length)) return null;
  const path = url.pathname.replace(/\/+$/, "");
  const at = path.search(/\/openai(\/|$)/i);
  const prefix = at >= 0 ? path.slice(0, at) : path;
  return `${url.origin}${prefix}/openai`;
}

export function azureLiveDeployment(raw: string | undefined): string | null {
  const name = raw?.trim() || LIVE_MODEL;
  return AZURE_DEPLOYMENT.test(name) ? name : null;
}

export function azureLiveEndpoint(endpoint: string | undefined, deployment: string | undefined): LiveEndpoint | null {
  const root = azureOpenAiRoot(endpoint);
  const model = azureLiveDeployment(deployment);
  return root && model ? { provider: "azure", apiBase: `${root}/v1`, model } : null;
}

export function liveSessionsUrl(endpoint: LiveEndpoint = openAiLiveEndpoint()): string {
  return `${endpoint.apiBase}/live/sessions`;
}

export function liveAttachUrl(sessionId: string, endpoint: LiveEndpoint = openAiLiveEndpoint()): string {
  return `${endpoint.apiBase.replace(/^http/, "ws")}/live/sessions/${encodeURIComponent(sessionId)}/attach`;
}

/** Azure OpenAI takes a resource key in `api-key`; OpenAI and the Qwen realtime gateway take a bearer token. */
export function liveAuthHeaders(provider: LiveProvider, key: string): Record<string, string> {
  return provider === "azure" ? { "api-key": key } : { authorization: `Bearer ${key}` };
}

export interface QwenProbeResult {
  ok: boolean;
  model?: string;
  voice?: string;
  error?: string;
}

interface ProbeSocket {
  close(): void;
  on(event: "message", fn: (data: unknown) => void): void;
  on(event: "error", fn: (error: unknown) => void): void;
  on(event: "close", fn: () => void): void;
}

/** Opens the realtime socket and waits for `session.created`: a true answer means endpoint, key and model all work. The socket carries one JSON event at a time and nothing else leaves the key's host. */
export function probeQwenLive(endpoint: LiveEndpoint, key: string, deps: { ws?: (url: string, headers: Record<string, string>) => ProbeSocket; timeoutMs?: number } = {}): Promise<QwenProbeResult> {
  if (endpoint.provider !== "qwen") return Promise.resolve({ ok: false, error: "not a qwen endpoint" });
  const make = deps.ws ?? ((url, headers) => new WebSocket(url, { headers }) as unknown as ProbeSocket);
  // `ws`'s WebSocket takes the headers option; the global undici one cannot send them.
  return new Promise((resolve) => {
    const done = (result: QwenProbeResult) => { clearTimeout(timer); try { socket.close(); } catch { /* already closed */ } resolve(result); };
    const timer = setTimeout(() => done({ ok: false, error: "timeout" }), deps.timeoutMs ?? 8_000);
    const socket = make(qwenRealtimeUrl(endpoint), liveAuthHeaders("qwen", key));
    socket.on("error", () => done({ ok: false, error: "connect" }));
    socket.on("close", () => done({ ok: false, error: "closed" }));
    socket.on("message", (data) => {
      let event: { type?: unknown; code?: unknown; message?: unknown; session?: { model?: unknown; voice?: unknown } };
      try {
        event = JSON.parse(String(data));
      } catch {
        return;
      }
      if (event.type === "session.created") {
        done({
          ok: true,
          ...(typeof event.session?.model === "string" ? { model: event.session.model } : {}),
          ...(typeof event.session?.voice === "string" ? { voice: event.session.voice } : {}),
        });
      } else if (event.type === "error" || typeof event.code === "string") {
        done({ ok: false, error: typeof event.message === "string" ? event.message.slice(0, 200) : "rejected" });
      }
    });
  });
}

// The API caps startup history at 128 messages / 8,192 tokens; stay well inside it.
const HISTORY_MESSAGES = 8;
const HISTORY_MESSAGE_CHARS = 600;
const HISTORY_TOTAL_CHARS = 6_000;
const CREATE_TIMEOUT_MS = 20_000;

export interface LiveBot {
  name: string;
  title?: string;
  description?: string;
}

export interface LiveHistoryMessage {
  role: "user" | "assistant";
  text: string;
}

export function liveHistoryFrom(messages: ReadonlyArray<Pick<Message, "role" | "kind" | "text">>): LiveHistoryMessage[] {
  return messages
    .filter((message) => message.kind === "text" && typeof message.text === "string" && (message.role === "user" || message.role === "bot"))
    .map((message) => ({ role: message.role === "user" ? "user" as const : "assistant" as const, text: message.text ?? "" }));
}

export class LiveSessionError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function liveInstructions(bot: LiveBot, { cloudHome = false }: { cloudHome?: boolean } = {}): string {
  const name = oneLine(bot.name) || "the agent";
  const title = oneLine(bot.title ?? "");
  const description = oneLine(bot.description ?? "").slice(0, 400);
  const where = cloudHome ? `runs on ${CLOUD_HOME_PLACE}` : "runs in Luna Bot on the user's own computer";
  const changes = cloudHome ? "My Cloud" : "the computer";
  return [
    `You are ${name}${title ? `, ${title}` : ""}, an AI agent that ${where}.${description ? ` ${description}` : ""}`,
    `To the user you are one assistant, ${name}, and you speak in the first person. Your work — looking things up, using your tools, files and memory, researching, deciding, and answering anything that needs facts this conversation does not hold — happens when you delegate. Delegating is how you think and act; it is not someone else.`,
    "Never mention a backend, delegation, a voice layer, or another system or model doing the work, and never say you are only a voice. Say \"I\" about the work.",
    "Never ask the user whether you may look something up or check something. When it needs checking, delegate at once and say briefly that you are checking.",
    "Speak warmly and naturally, at an unhurried pace. Keep replies short: one or two sentences unless the user asks for more. Speak the language the user speaks.",
    "",
    "Backchannel policy: Use light backchannels. Acknowledge naturally without competing with the user.",
    "Interruption policy: Stop speaking when the user interrupts. Listen to what they say.",
    "Delegation policy:",
    "Backend tools:",
    `- ${name}: your own files, tools, memory, settings and this conversation's history. It researches, writes, changes things on ${changes}, and answers questions, including questions about yourself such as which AI model you run on, your settings, your tools and your memory.`,
    "Delegate to the backend when:",
    "- The user asks a question, asks for work, or gives an instruction.",
    "- The user asks something about you that this conversation does not already answer, for example which AI model you run on.",
    "- The user answers a question you asked, including yes or no to a permission request.",
    "- A correction or a new detail changes work already requested.",
    "- The user clearly asks you to hang up or end the call. Never end or offer to end the call on your own.",
    "Do not delegate to the backend when:",
    "- You can answer from this conversation or from a result that is still current.",
    "- The user only greets you, thanks you, or asks you to repeat something you already said.",
    "- The user only asks whether you are still working or stuck.",
    "- You cannot tell what they are asking for without a brief clarification.",
    "Delegate before giving an answer that depends on backend work.",
    "Do not guess the result while waiting. You may say briefly that you are on it, then wait for the update.",
    "While you work you get quiet status notes: how long you have worked, how many steps you took, and your last step. Answer questions about progress from the latest note in one short sentence. Only say you are stuck when the note shows no new step for several minutes.",
    "Never say that an action happened until the result reports it.",
    "When a permission question comes up, ask it clearly and wait for a clear yes or no. Never answer it yourself.",
  ].join("\n");
}

// Words that may open or close a hang-up request ("okay, bye, hang up now").
const HANG_UP_LEAD = /^(?:(?:um+|uh+|er+|so|well|ok|okay|alright|all right|great|thanks|thank you|bye|goodbye|that's all|that is all)(?:[\s,.!?-]+|$))+/i;
// The whole utterance must be the request: "don't hang up", "how do I end the call?" or
// "hang up the poster" never match, and neither does anything a page, file or bot said.
const HANG_UP = /^(?:(?:please|you can|you may|go ahead and|can you|could you|would you|will you|let's|let us)[\s,]+)*(?:hang\s+up(?:\s+(?:the|this)\s+(?:call|phone))?|end\s+(?:(?:the|this|our)\s+)?call)(?:[\s,.!]+(?:now|please|thanks|thank you|bye|goodbye))*[\s.!?]*$/i;

// Chinese has no word boundaries, so a hang-up request must match the whole utterance.
// 嗯 mm, 好/好的 okay, 行/可以 sure, 那 then, 就这样 that's all, 没事了 nothing else.
// 谢谢 thanks, 再见 goodbye, 拜拜 bye.
const ZH_HANG_UP_LEAD = /^(?:(?:嗯|ok(?:ay)?|好的?|行|可以|那|就[这這][样樣]|[没沒]事了|[谢謝]{2}|再[见見]|拜拜)[\s,，、。.!！]*)+/i;
// 请/麻烦 please, 你/您 you, 可以 can, 帮我 help me, 就 just, 吧/了 soften or mark the end of the request.
// 挂断/挂掉/挂了/挂机 hang up, 挂吧 go ahead and hang up, 电话 phone, 挂电话/挂断电话/挂掉电话 hang up the phone.
// 把电话挂了/把电话挂断/把电话挂掉 hang up the phone, 结束通话 end the call, 结束这次通话/结束本次通话 end this call.
const ZH_HANG_UP = /^(?:[请請]|麻[烦煩]|你|您|可以|[帮幫]我|就)*(?:[挂掛](?:[断斷掉了机機吧](?:[电電][话話])?|[电電][话話])|把[电電][话話][挂掛][了断斷掉]|[结結]束(?:[这這]次|本次)?通[话話])[吧了]?(?:[\s,，、。.!！]*(?:[谢謝]{2}|再[见見]|拜拜))*[\s,，、。.!！]*$/;

/** True only when the person's own words on a Live call are a clear request to hang up. */
export function spokenHangUp(text: string): boolean {
  return HANG_UP.test(text.trim().replace(/[\u2018\u2019]/g, "'").replace(HANG_UP_LEAD, ""))
    || ZH_HANG_UP.test(text.trim().replace(ZH_HANG_UP_LEAD, ""));
}

export function liveInitialInput(history: LiveHistoryMessage[]) {
  const picked: LiveHistoryMessage[] = [];
  let total = 0;
  for (const message of [...history].reverse()) {
    if (picked.length >= HISTORY_MESSAGES) break;
    const text = message.text.replace(/\s+/g, " ").trim().slice(0, HISTORY_MESSAGE_CHARS);
    if (!text) continue;
    if (total + text.length > HISTORY_TOTAL_CHARS) break;
    total += text.length;
    picked.unshift({ role: message.role, text });
  }
  return picked.map((message) => message.role === "user"
    ? { type: "message" as const, role: "user" as const, content: [{ type: "input_text" as const, text: message.text }] }
    : { type: "message" as const, role: "assistant" as const, content: [{ type: "output_text" as const, text: message.text }] });
}

/** OpenAI rejects an unknown voice name with a clear 400. */
export function liveVoice(voice: string | undefined): string {
  const name = voice?.trim().toLowerCase() ?? "";
  return /^[a-z]{2,40}$/.test(name) ? name : DEFAULT_LIVE_VOICE;
}

export interface CreateLiveSessionInput {
  key: string;
  sdp: string;
  bot: LiveBot;
  history: LiveHistoryMessage[];
  cloudHome: boolean;
  voice?: string;
  endpoint?: LiveEndpoint;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Errors carry a status and a message fit for the user: never the key, never the provider's raw body. */
export async function createLiveSession(input: CreateLiveSessionInput): Promise<{ sessionId: string; sdp: string }> {
  const endpoint = input.endpoint ?? openAiLiveEndpoint();
  const provider = liveProviderName(endpoint.provider);
  if (endpoint.provider === "qwen") throw new LiveSessionError(LIVE_QWEN_TRANSPORT, 400);
  if (endpoint.provider === "volc") throw new LiveSessionError(LIVE_VOLC_TRANSPORT, 400);
  const key = input.key.trim();
  if (!key) throw new LiveSessionError(`Add an ${provider} API key to use Live calls.`, 409);
  if (!input.sdp.trim() || Buffer.byteLength(input.sdp) > MAX_SDP_BYTES) {
    throw new LiveSessionError("The call could not start: the connection offer was invalid.", 400);
  }
  const initialInput = liveInitialInput(input.history);
  const body = {
    session: {
      model: endpoint.model,
      instructions: liveInstructions(input.bot, { cloudHome: input.cloudHome }),
      delegation: { type: "client" },
      audio: { output: { voice: liveVoice(input.voice) } },
      // Azure's GPT-Live refuses `session.client` ("Unknown parameter"): see LIVE_DATA_CHANNEL for who may hold such a call.
      ...(endpoint.provider === "azure" ? {} : { client: { data_channel: LIVE_DATA_CHANNEL } }),
      ...(initialInput.length ? { input: initialInput } : {}),
    },
    transport: { type: "webrtc", sdp: input.sdp },
  };
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(liveSessionsUrl(endpoint), {
      method: "POST",
      headers: { ...liveAuthHeaders(endpoint.provider, key), "content-type": "application/json" },
      // fetch drops `authorization` on a redirect to another host, but keeps `api-key`.
      ...(endpoint.provider === "azure" ? { redirect: "error" as const } : {}),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(input.timeoutMs ?? CREATE_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new LiveSessionError(
      timedOut ? `${provider} did not answer in time. Try the call again.` : `Could not reach ${provider}. Check the internet connection.`,
      502,
    );
  }
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { error?: { param?: unknown } } | null;
    const param = typeof failure?.error?.param === "string" ? failure.error.param : undefined;
    throw new LiveSessionError(liveErrorMessage(response.status, param, endpoint.provider), response.status === 429 ? 429 : 502);
  }
  const payload = await response.json().catch(() => null) as { session?: { id?: unknown }; transport?: { sdp?: unknown } } | null;
  const sessionId = payload?.session?.id;
  const sdp = payload?.transport?.sdp;
  if (typeof sessionId !== "string" || typeof sdp !== "string" || !sdp.trim()) {
    throw new LiveSessionError(`${provider} returned an unexpected answer. Try the call again.`, 502);
  }
  return { sessionId, sdp };
}

export function liveErrorMessage(status: number, param?: string, provider: LiveProvider = "openai"): string {
  const name = liveProviderName(provider);
  if (status === 400) {
    return param && /voice/i.test(param)
      ? `${name} rejected the voice for this call. Choose another voice.`
      : `${name} rejected the call settings (HTTP 400${param ? `, ${param.replace(/[^\w.]/g, "").slice(0, 60)}` : ""}).`;
  }
  if (provider === "azure") {
    if (status === 401) return "Azure OpenAI rejected the API key. Check the key of the Azure resource.";
    if (status === 403) return "This Azure OpenAI resource refused the call. Check its network rules and that the key belongs to it.";
    if (status === 404) return "Azure OpenAI has no GPT-Live deployment by that name on this resource. Check the endpoint and the deployment name.";
    if (status === 429) return "Azure OpenAI is limiting Live sessions right now (rate limit or quota). Try again in a moment.";
  } else if (provider === "qwen") {
    if (status === 401 || status === 403) return "The Qwen realtime gateway rejected the API key. Check the key for Live calls.";
    if (status === 404) return "The Qwen realtime gateway has no realtime model by that name. Check the endpoint and the model.";
    if (status === 429) return "The Qwen realtime gateway is limiting sessions right now (rate limit or quota). Try again in a moment.";
  } else if (provider === "volc") {
    if (status === 401 || status === 403) return "Doubao speech rejected the App ID or Access Token. Check the speech app's credentials.";
    if (status === 429) return "Doubao speech is limiting sessions right now (rate limit or quota). Try again in a moment.";
  } else {
    if (status === 401) return "OpenAI rejected the API key. Check the key for Live calls.";
    if (status === 403) return "This OpenAI project has no access to GPT-Live. Check the project's model access and billing.";
    if (status === 404) return "GPT-Live is not available for this OpenAI project.";
    if (status === 429) return "OpenAI is limiting Live sessions right now (rate limit or quota). Try again in a moment.";
  }
  if (status >= 500) return `${name} had a problem starting the call. Try again in a moment.`;
  return `${name} could not start the call (HTTP ${status}).`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Numbers and short codes only: never what anyone said. */
export function liveCallSummaryLine(body: Record<string, unknown>): string {
  const count = (value: unknown) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), 1_000_000) : 0;
  };
  const code = (value: unknown) => typeof value === "string" ? value.replace(/[^\w.-]/g, "").slice(0, 40) : "";
  const errors = Array.isArray(body.errors) ? body.errors.slice(0, 5).map(code).filter(Boolean) : [];
  return [
    "[live] call ended",
    `bot=${code(body.botId) || "?"}`,
    `voice=${code(body.voice) || DEFAULT_LIVE_VOICE}`,
    `client=${code(body.client) || "?"}`,
    `seconds=${count(body.seconds)}`,
    `delegations=${count(body.delegations)}`,
    `sentToBot=${count(body.sentToBot)}`,
    `answers=${count(body.answers)}`,
    `approvals=${count(body.approvals)}`,
    `notHeard=${count(body.notHeard)}`,
    `replies=${count(body.replies)}`,
    `end=${code(body.end) || "unknown"}`,
    `errors=${errors.length ? errors.join(",") : "none"}`,
  ].join(" ");
}
