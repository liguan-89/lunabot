// The browser↔provider WebSocket audio bridge for providers whose realtime transport is a socket, not WebRTC.
// Client sends binary PCM s16le 16kHz mono frames and {"t":"end"}; it gets back binary PCM s16le audio and JSON
// events {"t":"ready"|"transcript"|"event"|"error"|"end"}. The provider key stays on this server.
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import type { LiveBot } from "./live-call.ts";
import type { RequestAuth } from "./request-auth.ts";
import {
  liveAuthHeaders,
  type LiveEndpoint,
  qwenRealtimeUrl,
  volcAudioTask,
  volcAuthHeaders,
  volcDecodeFrame,
  volcFrame,
  volcRealtimeUrl,
  VOLC_EVENT_CONNECTION_STARTED,
  VOLC_EVENT_SESSION_STARTED,
  VOLC_EVENT_START_CONNECTION,
  VOLC_EVENT_START_SESSION,
} from "./live-call.ts";

export const LIVE_RELAY_PATH = "/api/live/relay";
const MAX_FRAME = 256 * 1024;
const MAX_MS = 30 * 60_000;
const OPEN_MS = 15_000;

export interface LiveRelayOptions {
  endpoint: LiveEndpoint;
  /** Access token / API key for the provider socket — never reaches the client. */
  key: string;
  /** Doubao only: the speech app's App ID. */
  appId?: string;
  voice?: string;
  instructions?: string;
  /** Test seam: replaces the provider socket factory. */
  ws?: (url: string, headers: Record<string, string>) => ProviderSocket;
}

export interface ProviderSocket {
  readyState: number;
  close(): void;
  send(data: Buffer | string): void;
  on(event: "message", fn: (data: unknown, binary?: boolean) => void): void;
  on(event: "error", fn: (error: unknown) => void): void;
  on(event: "close", fn: (code?: number, reason?: Buffer) => void): void;
  on(event: "open", fn: () => void): void;
}

export interface RelaySink {
  ready(): void;
  audio(pcm: Buffer): void;
  transcript(role: "user" | "assistant", delta: string): void;
  event(name: string, data: unknown): void;
  error(message: string): void;
  end(): void;
}

export interface ProviderLink {
  sendPcm(pcm: Buffer): void;
  close(): void;
}

function asBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(String(data));
}

function defaultSocket(url: string, headers: Record<string, string>): ProviderSocket {
  return new WebSocket(url, { headers }) as unknown as ProviderSocket;
}

/** Qwen's gateway speaks the OpenAI realtime JSON event shape; audio travels as base64 inside
 * input_audio_buffer.append / response output_audio deltas. */
function qwenLink(socket: ProviderSocket, options: LiveRelayOptions, sink: RelaySink): ProviderLink {
  let ready = false;
  socket.on("open", () => { /* the gateway speaks first: session.created */ });
  socket.on("error", () => sink.error("The Qwen realtime connection failed."));
  socket.on("close", () => sink.end());
  socket.on("message", (data) => {
    let event: { type?: string; delta?: string; transcript?: string; error?: { message?: string } };
    try { event = JSON.parse(asBuffer(data).toString("utf8")); } catch { return; }
    if (event.type === "session.created") {
      socket.send(JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          ...(options.voice ? { voice: options.voice } : {}),
          ...(options.instructions ? { instructions: options.instructions } : {}),
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          turn_detection: { type: "server_vad" },
        },
      }));
      if (!ready) { ready = true; sink.ready(); }
      return;
    }
    if (event.type === "session.updated") return;
    if ((event.type === "response.output_audio.delta" || event.type === "response.audio.delta") && event.delta) {
      sink.audio(Buffer.from(event.delta, "base64"));
      return;
    }
    if ((event.type === "conversation.item.input_audio_transcription.delta" || event.type === "conversation.item.input_audio_transcription.completed") && event.transcript) {
      sink.transcript("user", event.transcript);
      return;
    }
    if ((event.type === "response.output_audio_transcript.delta" || event.type === "response.audio_transcript.delta" || event.type === "response.audio_transcript.done") && event.transcript) {
      sink.transcript("assistant", event.transcript);
      return;
    }
    if (event.type === "error") {
      sink.error(String(event.error?.message ?? "The Qwen realtime session failed.").slice(0, 300));
      return;
    }
    if (event.type === "session.finished" || event.type === "session.closed") sink.end();
  });
  return {
    sendPcm(pcm) {
      if (!ready || socket.readyState !== 1) return;
      socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }));
    },
    close() { try { socket.close(); } catch { /* already closed */ } },
  };
}

/** Doubao's end-to-end dialogue socket: v1 binary frames, StartConnection → StartSession → TaskRequest audio. */
function volcLink(socket: ProviderSocket, options: LiveRelayOptions, sink: RelaySink): ProviderLink {
  const sessionId = `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let ready = false;
  socket.on("open", () => socket.send(volcFrame(VOLC_EVENT_START_CONNECTION, "{}")));
  socket.on("error", () => sink.error("The Doubao realtime connection failed."));
  socket.on("close", () => sink.end());
  socket.on("message", (data) => {
    const frame = volcDecodeFrame(asBuffer(data));
    if (!frame) return;
    if (frame.type === 0xf) {
      let message = `The Doubao realtime session was refused (${frame.code ?? "error"}).`;
      try {
        const body = JSON.parse(frame.payload ?? "{}") as { error?: unknown };
        if (typeof body.error === "string" && body.error) message = body.error.slice(0, 300);
      } catch { /* not JSON */ }
      sink.error(message);
      return;
    }
    if (frame.type === 0xb) {
      if (frame.raw) sink.audio(frame.raw);
      return;
    }
    if (frame.event === VOLC_EVENT_CONNECTION_STARTED) {
      socket.send(volcFrame(VOLC_EVENT_START_SESSION, JSON.stringify({
        asr: { audio_info: { format: "pcm", sample_rate: 16000, channel: 1 } },
        tts: {
          speaker: options.voice ?? "zh_female_vv_jupiter_bigtts",
          audio_config: { channel: 1, format: "pcm_s16le", sample_rate: 24000 },
        },
        dialog: {
          ...(options.instructions ? { bot_name: "assistant", system_role: options.instructions } : {}),
          extra: { model: options.endpoint.model },
        },
      }), sessionId));
      return;
    }
    if (frame.event === VOLC_EVENT_SESSION_STARTED) {
      if (!ready) { ready = true; sink.ready(); }
      return;
    }
    if (frame.event !== undefined && frame.payload) sink.event(`volc:${frame.event}`, frame.payload);
  });
  return {
    sendPcm(pcm) {
      if (!ready || socket.readyState !== 1) return;
      socket.send(volcAudioTask(pcm, sessionId));
    },
    close() { try { socket.close(); } catch { /* already closed */ } },
  };
}

export function openProviderLink(options: LiveRelayOptions, sink: RelaySink): ProviderLink {
  const make = options.ws ?? defaultSocket;
  if (options.endpoint.provider === "qwen") {
    return qwenLink(make(qwenRealtimeUrl(options.endpoint), liveAuthHeaders("qwen", options.key)), options, sink);
  }
  if (options.endpoint.provider === "volc") {
    return volcLink(make(volcRealtimeUrl(options.endpoint), volcAuthHeaders(options.appId ?? "", options.key)), options, sink);
  }
  throw new Error(`provider ${options.endpoint.provider} has no socket transport`);
}

/** Who may open a relay and with what: the same own-provider gate as a Live call, plus the socket-provider's
 * endpoint/key and the bot persona for its instructions. */
export function liveRelayResolver(deps: {
  refusal(auth: RequestAuth): string | null;
  settings(): { key: string; endpoint: LiveEndpoint | null; setupProblem?: string | null };
  appId(): string | undefined;
  bot(botId: string): LiveBot | null;
  instructions(bot: LiveBot): string;
}): (auth: RequestAuth, botId: string | null) => { options: LiveRelayOptions } | { error: string; status?: number } {
  return (auth, botId) => {
    const refusal = deps.refusal(auth);
    if (refusal) return { error: refusal };
    const settings = deps.settings();
    if (settings.endpoint?.provider !== "qwen" && settings.endpoint?.provider !== "volc") {
      return { error: "This Live provider calls over WebRTC, not the socket relay.", status: 400 };
    }
    if (settings.setupProblem || !settings.key) return { error: settings.setupProblem || "Live calls need a provider key.", status: 409 };
    let instructions: string | undefined;
    if (botId) {
      const bot = deps.bot(botId);
      if (!bot) return { error: "That bot does not exist.", status: 404 };
      instructions = deps.instructions(bot);
    }
    return {
      options: {
        endpoint: settings.endpoint,
        key: settings.key,
        ...(settings.endpoint.provider === "volc" && deps.appId() ? { appId: deps.appId() } : {}),
        ...(instructions ? { instructions } : {}),
      },
    };
  };
}

/** Browser-facing WebSocket relays on LIVE_RELAY_PATH: one relay per call, bounded frames, bounded lifetime. */
export class LiveRelays {
  readonly #server = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_FRAME });
  readonly #open = new Set<{ ws: WebSocket; link: ProviderLink | null }>();
  #closed = false;

  accept(upgrade: { req: IncomingMessage; socket: Socket; head: Buffer }, options: LiveRelayOptions): void {
    this.#server.handleUpgrade(upgrade.req, upgrade.socket, upgrade.head, (ws) => {
      if (this.#closed) { ws.close(1001, "restarting"); return; }
      const send = (event: Record<string, unknown>) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event)); };
      const open: { ws: WebSocket; link: ProviderLink | null } = { ws, link: null };
      let ended = false;
      const finish = (event: Record<string, unknown>, code: number, reason: string) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        send(event);
        try { open.link?.close(); } catch { /* already closed */ }
        try { ws.close(code, reason); } catch { /* already closed */ }
        this.#open.delete(open);
        if (!open.link) try { upgrade.socket.destroy(); } catch { /* already closed */ }
      };
      const sink: RelaySink = {
        ready: () => send({ t: "ready", provider: options.endpoint.provider, inputHz: 16000, outputHz: 24000 }),
        audio: (pcm) => { if (ws.readyState === ws.OPEN) ws.send(pcm); },
        transcript: (role, delta) => send({ t: "transcript", role, delta: delta.slice(0, 500) }),
        event: (name, data) => send({ t: "event", name, data: typeof data === "string" ? data.slice(0, 1000) : null }),
        error: (message) => finish({ t: "error", message }, 1011, "provider error"),
        end: () => finish({ t: "end" }, 1000, "provider ended"),
      };
      const timer = setTimeout(() => finish({ t: "error", message: "The call reached its time limit." }, 1000, "time limit"), MAX_MS);
      timer.unref();
      const openTimer = setTimeout(() => { if (!open.link) finish({ t: "error", message: "The provider could not be reached." }, 1011, "open timeout"); }, OPEN_MS);
      timer.unref();
      openTimer.unref();
      try {
        open.link = openProviderLink(options, sink);
        clearTimeout(openTimer);
      } catch {
        finish({ t: "error", message: "The provider could not be reached." }, 1011, "open failed");
        return;
      }
      this.#open.add(open);
      ws.on("message", (data, binary) => {
        const frame = asBuffer(data);
        if (binary) { open.link?.sendPcm(frame); return; }
        try {
          const control = JSON.parse(frame.toString("utf8")) as { t?: string };
          if (control.t === "end") finish({ t: "end" }, 1000, "client ended");
        } catch { /* not JSON: ignore */ }
      });
      ws.on("error", () => finish({ t: "error", message: "The connection failed." }, 1011, "client error"));
      ws.on("close", () => finish({ t: "end" }, 1000, "closed"));
    });
  }

  close(): void {
    this.#closed = true;
    for (const { ws, link } of this.#open) {
      try { link?.close(); } catch { /* already closed */ }
      try { ws.close(1001, "restarting"); } catch { /* already closed */ }
    }
    this.#open.clear();
    this.#server.close();
  }
}
