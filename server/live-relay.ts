// The browser↔provider WebSocket audio bridge for providers whose realtime transport is a socket, not WebRTC.
// Client sends binary PCM s16le 16kHz mono frames and {"t":"end"}; it gets back binary PCM s16le audio and JSON
// events {"t":"ready"|"transcript"|"event"|"error"|"end"}. The provider key stays on this server.
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import type { LiveCallRecord, LiveClient, LiveEndReason } from "../shared/live-call-wire.ts";
import type { LiveBot } from "./live-call.ts";
import type { RequestAuth } from "./request-auth.ts";
import {
  liveAuthHeaders,
  type LiveEndpoint,
  qwenRealtimeUrl,
  volcAudioTask,
  volcAuthHeaders,
  volcDecodeFrame,
  VOLC_DUPLEX_MODEL,
  volcDuplexRealtimeUrl,
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
  /** When the call belongs to a bot's chat: what the call row records once it ends. */
  call?: { botId: string; botName: string; threadId: string; client: LiveClient };
  /** Sends the request into the call's chat as a person message and resolves with the bot's reply text. */
  delegate?: (request: string) => Promise<string>;
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

/** The voice model's one tool: hand the user's request to the bot's own chat and speak what comes back. */
function delegateTool(botName: string): Record<string, unknown> {
  return {
    type: "function",
    name: "delegate",
    description: `Delegate work to ${botName} — its own files, tools, memory and services on the owner's computer. Use it whenever the user asks a question or asks for work. Report only what the result says.`,
    parameters: {
      type: "object",
      properties: { request: { type: "string", description: `The user's request for ${botName}, in the user's own words.` } },
      required: ["request"],
      additionalProperties: false,
    },
  };
}

interface DelegationCall {
  callId: string;
  request: string;
}

// `response.function_call_arguments.done` arrives as OpenAI's flat {call_id, name, arguments} or Doubao's
// {items: [{call_id, name, arguments}]}. Anything that is not our tool is ignored.
function delegationCalls(payload: Record<string, unknown>): DelegationCall[] {
  const items = Array.isArray(payload.items) ? payload.items : [payload];
  const calls: DelegationCall[] = [];
  for (const raw of items) {
    const item = raw as { call_id?: unknown; name?: unknown; arguments?: unknown };
    if (item?.name !== "delegate" || typeof item.call_id !== "string" || !item.call_id || typeof item.arguments !== "string") continue;
    try {
      const args = JSON.parse(item.arguments) as { request?: unknown };
      if (typeof args.request === "string" && args.request.trim()) calls.push({ callId: item.call_id, request: args.request.trim().slice(0, 2000) });
    } catch { /* arguments not JSON yet */ }
  }
  return calls;
}

// One delegated turn at a time per call: a second call waits instead of racing the same chat.
class DelegateQueue {
  readonly #delegate: (request: string) => Promise<string>;
  readonly #seen = new Set<string>();
  #queue: Promise<void> = Promise.resolve();

  constructor(delegate: (request: string) => Promise<string>) {
    this.#delegate = delegate;
  }

  run(socket: ProviderSocket, payload: Record<string, unknown>, result: (callId: string, text: string) => unknown[]): void {
    for (const call of delegationCalls(payload)) {
      if (this.#seen.has(call.callId)) continue;
      this.#seen.add(call.callId);
      this.#queue = this.#queue.then(async () => {
        let text: string;
        try {
          text = (await this.#delegate(call.request)).slice(0, 4000) || "The request returned no answer.";
        } catch {
          text = "The request could not be run. Try again in a moment.";
        }
        if (socket.readyState !== 1) return;
        for (const event of result(call.callId, text)) socket.send(JSON.stringify(event));
      });
    }
  }
}

/** Qwen's gateway speaks the OpenAI realtime JSON event shape; audio travels as base64 inside
 * input_audio_buffer.append / response output_audio deltas. */
function qwenLink(socket: ProviderSocket, options: LiveRelayOptions, sink: RelaySink): ProviderLink {
  let ready = false;
  const delegate = options.delegate && options.call
    ? new DelegateQueue(options.delegate)
    : null;
  socket.on("open", () => { /* the gateway speaks first: session.created */ });
  socket.on("error", () => sink.error("The Qwen realtime connection failed."));
  socket.on("close", () => sink.end());
  socket.on("message", (data) => {
    let event: Record<string, unknown> & { type?: string; delta?: string; transcript?: string; error?: { message?: string } };
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
          ...(delegate ? { tools: [delegateTool(options.call!.botName)], tool_choice: "auto" } : {}),
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
    if (event.type === "response.function_call_arguments.done" && delegate) {
      delegate.run(socket, event, (callId, text) => [
        { type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: text } },
        { type: "response.create" },
      ]);
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

/** Doubao Seeduplex realtime dialogue: JSON events on /api/v3/duplex/realtime/dialogue — the only volc transport
 * with function calling, so the delegate tool rides on it. The legacy console headers still authenticate it. */
function volcDuplexLink(socket: ProviderSocket, options: LiveRelayOptions, sink: RelaySink): ProviderLink {
  let ready = false;
  const delegate = options.delegate && options.call
    ? new DelegateQueue(options.delegate)
    : null;
  socket.on("open", () => {
    socket.send(JSON.stringify({
      type: "session.create",
      session: {
        model: VOLC_DUPLEX_MODEL,
        ...(options.instructions ? { instructions: options.instructions } : {}),
        audio: {
          input: { format: { type: "pcm", rate: 16000 } },
          output: {
            format: { type: "pcm_s16le", rate: 24000 },
            voice: options.voice ?? "zh_female_vv_jupiter_bigtts",
          },
        },
        ...(delegate ? { tools: [delegateTool(options.call!.botName)] } : {}),
      },
    }));
  });
  socket.on("error", () => sink.error("The Doubao realtime connection failed."));
  socket.on("close", () => sink.end());
  socket.on("message", (data) => {
    let event: Record<string, unknown> & { type?: string; delta?: string; transcript?: string; status_code?: number; message?: string };
    try { event = JSON.parse(asBuffer(data).toString("utf8")); } catch { return; }
    if (event.type === "session.created") {
      if (!ready) { ready = true; sink.ready(); }
      return;
    }
    if (event.type === "response.output_audio.delta" && event.delta) {
      sink.audio(Buffer.from(event.delta, "base64"));
      return;
    }
    if ((event.type === "conversation.item.input_audio_transcription.delta" || event.type === "conversation.item.input_audio_transcription.completed") && event.transcript) {
      sink.transcript("user", event.transcript);
      return;
    }
    if ((event.type === "response.output_text.delta" || event.type === "response.output_text.done") && event.transcript) {
      sink.transcript("assistant", event.transcript);
      return;
    }
    if (event.type === "response.function_call_arguments.done" && delegate) {
      delegate.run(socket, event, (callId, text) => [
        { type: "conversation.item.create", items: [{ call_id: callId, role: "tool", content: [{ type: "input_text", text }] }] },
      ]);
      return;
    }
    if (event.type === "error") {
      sink.error(String(event.message ?? `The Doubao realtime session failed (${event.status_code ?? "error"}).`).slice(0, 300));
      return;
    }
    if (event.type === "session.closed" || event.type === "session.finished") sink.end();
  });
  return {
    sendPcm(pcm) {
      if (!ready || socket.readyState !== 1) return;
      socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }));
    },
    close() { try { socket.close(); } catch { /* already closed */ } },
  };
}

/** Doubao prefers the Seeduplex transport and falls back to the legacy binary protocol when the account refuses
 * it before the call is ready — a legacy call still works, it just cannot delegate. */
function volcAutoLink(make: (url: string, headers: Record<string, string>) => ProviderSocket, options: LiveRelayOptions, sink: RelaySink): ProviderLink {
  let committed = false;
  let fell = false;
  let inner: ProviderLink;
  // Closing the refused duplex socket raises "close" too: the swap happens once, before that close is seen.
  const fallback = () => { if (fell) return; fell = true; const prev = inner; inner = legacy(); prev.close(); sink.event("volc:legacy-fallback", "duplex refused before ready"); };
  const guarded: RelaySink = {
    ready: () => { committed = true; sink.ready(); },
    audio: (pcm) => sink.audio(pcm),
    transcript: (role, delta) => sink.transcript(role, delta),
    event: (name, data) => sink.event(name, data),
    error: (message) => { if (committed) sink.error(message); else fallback(); },
    end: () => { if (committed) sink.end(); else fallback(); },
  };
  const legacy = () => volcLink(make(volcRealtimeUrl(options.endpoint), volcAuthHeaders(options.appId ?? "", options.key)), options, sink);
  inner = volcDuplexLink(
    make(volcDuplexRealtimeUrl(options.endpoint), { ...volcAuthHeaders(options.appId ?? "", options.key), "X-Api-Request-Id": randomUUID() }),
    options,
    guarded,
  );
  return {
    sendPcm(pcm) { inner.sendPcm(pcm); },
    close() { inner.close(); },
  };
}

export function openProviderLink(options: LiveRelayOptions, sink: RelaySink): ProviderLink {
  const make = options.ws ?? defaultSocket;
  if (options.endpoint.provider === "qwen") {
    return qwenLink(make(qwenRealtimeUrl(options.endpoint), liveAuthHeaders("qwen", options.key)), options, sink);
  }
  if (options.endpoint.provider === "volc") {
    return volcAutoLink(make, options, sink);
  }
  throw new Error(`provider ${options.endpoint.provider} has no socket transport`);
}

const LIVE_CLIENTS = new Set<LiveClient>(["desktop", "web", "ios", "android"]);

/** Who may open a relay and with what: the same own-provider gate as a Live call, plus the socket-provider's
 * endpoint/key and the bot persona for its instructions. `target` is the same bot+chat check a WebRTC session runs. */
export function liveRelayResolver(deps: {
  refusal(auth: RequestAuth): string | null;
  settings(): { key: string; endpoint: LiveEndpoint | null; setupProblem?: string | null };
  appId(): string | undefined;
  bot(botId: string): LiveBot | null;
  target(botId: string, threadId: string | null): { botId: string; botName: string; threadId: string } | null;
  instructions(bot: LiveBot): string;
  /** Wires a call's chat to the delegate tool; null keeps the provider session tool-less (calls still work). */
  delegate?(auth: RequestAuth, call: { botId: string; botName: string; threadId: string }): ((request: string) => Promise<string>) | null;
}): (auth: RequestAuth, botId: string | null, threadId?: string | null, client?: string | null) => { options: LiveRelayOptions } | { error: string; status?: number } {
  return (auth, botId, threadId = null, client = null) => {
    const refusal = deps.refusal(auth);
    if (refusal) return { error: refusal };
    const settings = deps.settings();
    if (settings.endpoint?.provider !== "qwen" && settings.endpoint?.provider !== "volc") {
      return { error: "This Live provider calls over WebRTC, not the socket relay.", status: 400 };
    }
    if (settings.setupProblem || !settings.key) return { error: settings.setupProblem || "Live calls need a provider key.", status: 409 };
    let instructions: string | undefined;
    let call: LiveRelayOptions["call"];
    let delegate: LiveRelayOptions["delegate"];
    if (botId) {
      const bot = deps.bot(botId);
      if (!bot) return { error: "That bot does not exist.", status: 404 };
      instructions = deps.instructions(bot);
      const target = deps.target(botId, threadId);
      if (!target) return { error: "That bot or chat does not exist.", status: 404 };
      call = { ...target, client: LIVE_CLIENTS.has(client as LiveClient) ? client as LiveClient : "web" };
      delegate = deps.delegate?.(auth, target) ?? undefined;
    }
    return {
      options: {
        endpoint: settings.endpoint,
        key: settings.key,
        ...(settings.endpoint.provider === "volc" && deps.appId() ? { appId: deps.appId() } : {}),
        ...(instructions ? { instructions } : {}),
        ...(call ? { call } : {}),
        ...(delegate ? { delegate } : {}),
      },
    };
  };
}

/** Browser-facing WebSocket relays on LIVE_RELAY_PATH: one relay per call, bounded frames, bounded lifetime. */
export class LiveRelays {
  readonly #server = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_FRAME });
  readonly #open = new Set<{ ws: WebSocket; link: ProviderLink | null }>();
  readonly #record?: (input: { threadId: string; botName: string; record: LiveCallRecord }) => void;
  #closed = false;

  constructor(deps: { record?(input: { threadId: string; botName: string; record: LiveCallRecord }): void } = {}) {
    this.#record = deps.record;
  }

  accept(upgrade: { req: IncomingMessage; socket: Socket; head: Buffer }, options: LiveRelayOptions): void {
    this.#server.handleUpgrade(upgrade.req, upgrade.socket, upgrade.head, (ws) => {
      if (this.#closed) { ws.close(1001, "restarting"); return; }
      const send = (event: Record<string, unknown>) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event)); };
      const open: { ws: WebSocket; link: ProviderLink | null } = { ws, link: null };
      let ended = false;
      let startedAt = 0;
      const finish = (event: Record<string, unknown>, code: number, reason: string, endReason: LiveEndReason) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        if (options.call && startedAt && this.#record) {
          const endedAt = Date.now();
          this.#record({
            threadId: options.call.threadId,
            botName: options.call.botName,
            record: {
              callId: randomUUID(), botId: options.call.botId, client: options.call.client,
              startedAt, endedAt, seconds: Math.max(0, Math.round((endedAt - startedAt) / 1000)), endReason,
            },
          });
        }
        send(event);
        try { open.link?.close(); } catch { /* already closed */ }
        try { ws.close(code, reason); } catch { /* already closed */ }
        this.#open.delete(open);
        if (!open.link) try { upgrade.socket.destroy(); } catch { /* already closed */ }
      };
      const sink: RelaySink = {
        ready: () => { startedAt = Date.now(); send({ t: "ready", provider: options.endpoint.provider, inputHz: 16000, outputHz: 24000 }); },
        audio: (pcm) => { if (ws.readyState === ws.OPEN) ws.send(pcm); },
        transcript: (role, delta) => send({ t: "transcript", role, delta: delta.slice(0, 500) }),
        event: (name, data) => send({ t: "event", name, data: typeof data === "string" ? data.slice(0, 1000) : null }),
        error: (message) => finish({ t: "error", message }, 1011, "provider error", "error"),
        end: () => finish({ t: "end" }, 1000, "provider ended", "remote-hangup"),
      };
      const timer = setTimeout(() => finish({ t: "error", message: "The call reached its time limit." }, 1000, "time limit", "expired"), MAX_MS);
      timer.unref();
      const openTimer = setTimeout(() => { if (!open.link) finish({ t: "error", message: "The provider could not be reached." }, 1011, "open timeout", "error"); }, OPEN_MS);
      timer.unref();
      openTimer.unref();
      try {
        open.link = openProviderLink(options, sink);
        clearTimeout(openTimer);
      } catch {
        finish({ t: "error", message: "The provider could not be reached." }, 1011, "open failed", "error");
        return;
      }
      this.#open.add(open);
      ws.on("message", (data, binary) => {
        const frame = asBuffer(data);
        if (binary) { open.link?.sendPcm(frame); return; }
        try {
          const control = JSON.parse(frame.toString("utf8")) as { t?: string };
          if (control.t === "end") finish({ t: "end" }, 1000, "client ended", "hung-up");
        } catch { /* not JSON: ignore */ }
      });
      ws.on("error", () => finish({ t: "error", message: "The connection failed." }, 1011, "client error", "error"));
      ws.on("close", () => finish({ t: "end" }, 1000, "closed", this.#closed ? "shutdown" : "connection-lost"));
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
