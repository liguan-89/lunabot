// Feishu (Lark) self-built-app channel over the platform's WebSocket long connection: no public callback
// URL, so a desktop can host a Feishu bot directly. Handshake POSTs the app credentials to
// /callback/ws/endpoint for a wss URL; frames on it are pbbp2 protobuf envelopes carrying event JSON
// (schema 2.0) which every delivery must ACK or the platform redelivers.
import { randomUUID } from "node:crypto";

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  /** Open-platform origin, default https://open.feishu.cn (overridable for fixtures). */
  baseUrl?: string;
}

export interface FeishuInbound {
  chatId: string;
  messageId: string;
  /** The sender's open_id, for attribution. */
  openId: string;
  text: string;
}

/** The slice of `ws`'s WebSocket the channel needs. */
export interface WsLike {
  send(data: Buffer | string): void;
  close(): void;
  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): void;
  on(event: "open" | "close" | "error", listener: (arg?: unknown) => void): void;
}

export interface FeishuDeps {
  fetch: typeof fetch;
  ws: (url: string) => WsLike;
  onText: (inbound: FeishuInbound) => void;
  log?: (line: string) => void;
  /** Test seam: heartbeat + reconnect timers run through it. */
  setInterval?: typeof setInterval;
  setTimeout?: typeof setTimeout;
}

// pbbp2.Frame, proto2: required SeqID/LogID/service/method stay on the wire even at 0.
const F_SEQ_ID = 1, F_LOG_ID = 2, F_SERVICE = 3, F_METHOD = 4, F_HEADERS = 5, F_PAYLOAD = 8;
const H_KEY = 1, H_VALUE = 2;
export const METHOD_CONTROL = 0, METHOD_DATA = 1;

export interface FeishuFrame {
  seqId: number;
  logId: number;
  service: number;
  method: number;
  headers: Array<{ key: string; value: string }>;
  payload?: Buffer;
}

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let v = BigInt(Math.trunc(value));
  while (v > 0x7fn) { bytes.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function readVarint(buf: Buffer, at: number): { value: number; next: number } {
  let value = 0n, shift = 0n, i = at;
  while (i < buf.length) {
    const b = buf[i]!;
    value |= BigInt(b & 0x7f) << shift;
    i += 1;
    if (!(b & 0x80)) return { value: Number(value), next: i };
    shift += 7n;
  }
  throw new Error("truncated varint");
}

const tag = (field: number, wire: number) => varint((field << 3) | wire);
const lenDelimited = (field: number, body: Buffer) => Buffer.concat([tag(field, 2), varint(body.length), body]);

export function encodeFrame(frame: FeishuFrame): Buffer {
  const header = (h: { key: string; value: string }) =>
    Buffer.concat([lenDelimited(H_KEY, Buffer.from(h.key, "utf8")), lenDelimited(H_VALUE, Buffer.from(h.value, "utf8"))]);
  return Buffer.concat([
    tag(F_SEQ_ID, 0), varint(frame.seqId),
    tag(F_LOG_ID, 0), varint(frame.logId),
    tag(F_SERVICE, 0), varint(frame.service),
    tag(F_METHOD, 0), varint(frame.method),
    ...frame.headers.map((h) => lenDelimited(F_HEADERS, header(h))),
    ...(frame.payload ? [lenDelimited(F_PAYLOAD, frame.payload)] : []),
  ]);
}

export function decodeFrame(buf: Buffer): FeishuFrame {
  const frame: FeishuFrame = { seqId: 0, logId: 0, service: 0, method: 0, headers: [] };
  let at = 0;
  while (at < buf.length) {
    const key = readVarint(buf, at); at = key.next;
    const field = key.value >> 3, wire = key.value & 7;
    if (wire === 0) {
      const v = readVarint(buf, at); at = v.next;
      if (field === F_SEQ_ID) frame.seqId = v.value;
      else if (field === F_LOG_ID) frame.logId = v.value;
      else if (field === F_SERVICE) frame.service = v.value;
      else if (field === F_METHOD) frame.method = v.value;
    } else if (wire === 2) {
      const len = readVarint(buf, at); at = len.next;
      if (at + len.value > buf.length) throw new Error("truncated length-delimited field");
      const body = buf.subarray(at, at + len.value); at += len.value;
      if (field === F_HEADERS) {
        let h = 0, key = "", value = "";
        while (h < body.length) {
          const k = readVarint(body, h); h = k.next;
          const l = readVarint(body, h); h = l.next;
          const s = body.subarray(h, h + l.value).toString("utf8"); h += l.value;
          if (k.value >> 3 === H_KEY) key = s; else if (k.value >> 3 === H_VALUE) value = s;
        }
        frame.headers.push({ key, value });
      } else if (field === F_PAYLOAD) frame.payload = body;
      // payload_encoding / payload_type / LogIDNew are read as strings but unused.
    } else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
  return frame;
}

const headerOf = (frame: FeishuFrame, name: string) => frame.headers.find((h) => h.key === name)?.value;

interface Endpoint {
  url: string;
  pingIntervalMs: number;
  serviceId: number;
}

async function handshake(cfg: FeishuConfig, fetchImpl: typeof fetch): Promise<Endpoint> {
  const base = cfg.baseUrl ?? "https://open.feishu.cn";
  const response = await fetchImpl(`${base}/callback/ws/endpoint`, {
    method: "POST",
    headers: { "content-type": "application/json", locale: "zh" },
    body: JSON.stringify({ AppID: cfg.appId, AppSecret: cfg.appSecret }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null) as { code?: number; msg?: string; data?: { URL?: string; ClientConfig?: { PingInterval?: number } } } | null;
  if (!response.ok || body?.code !== 0 || !body.data?.URL) {
    throw new Error(`feishu handshake failed (${response.status}): ${body?.msg ?? JSON.stringify(body)}`);
  }
  const url = body.data.URL;
  const serviceId = Number(new URL(url).searchParams.get("service_id") ?? "0") || 0;
  return { url, serviceId, pingIntervalMs: Math.max(5, body.data.ClientConfig?.PingInterval ?? 120) * 1000 };
}

interface TextReceiveEvent {
  schema?: string;
  header?: { event_id?: string; event_type?: string };
  event?: {
    sender?: { sender_id?: { open_id?: string } };
    message?: { message_id?: string; chat_id?: string; message_type?: string; content?: string };
  };
}

/** Exported for tests: event-envelope JSON → the inbound text, or null for anything we do not handle. */
export function textFromEvent(payload: string): FeishuInbound | null {
  let parsed: TextReceiveEvent;
  try { parsed = JSON.parse(payload) as TextReceiveEvent; } catch { return null; }
  if (parsed.header?.event_type !== "im.message.receive_v1") return null;
  const message = parsed.event?.message;
  if (!message?.chat_id || !message.message_id || message.message_type !== "text") return null;
  let text = "";
  try { text = (JSON.parse(message.content ?? "{}") as { text?: string }).text?.trim() ?? ""; } catch { return null; }
  if (!text) return null;
  return { chatId: message.chat_id, messageId: message.message_id, openId: parsed.event?.sender?.sender_id?.open_id ?? "", text };
}

export interface FeishuChannel {
  sendText(chatId: string, text: string): Promise<void>;
  close(): void;
  /** Settles on the first established connection; rejects if the handshake fails. */
  ready: Promise<void>;
}

const TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
const SEND_PATH = "/open-apis/im/v1/messages";
const ACK_PAYLOAD = Buffer.from(JSON.stringify({ code: 200, headers: {}, data: "" }), "utf8");

export function connectFeishu(cfg: FeishuConfig, deps: FeishuDeps): FeishuChannel {
  const log = (line: string) => deps.log?.(`feishu: ${line}`);
  const later = deps.setTimeout ?? setTimeout;
  const every = deps.setInterval ?? setInterval;
  const base = cfg.baseUrl ?? "https://open.feishu.cn";
  let socket: WsLike | null = null;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let retries = 0;
  let token: { value: string; expiresAt: number } | null = null;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let readySettled = false;
  const settleReady = (error?: Error) => {
    if (readySettled) return;
    readySettled = true;
    if (error) rejectReady(error); else resolveReady();
  };

  const tenantToken = async (): Promise<string> => {
    if (token && token.expiresAt > Date.now() + 60_000) return token.value;
    const response = await deps.fetch(`${base}${TOKEN_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => null) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number } | null;
    if (!response.ok || body?.code !== 0 || !body.tenant_access_token) {
      throw new Error(`feishu token failed (${response.status}): ${body?.msg ?? response.status}`);
    }
    token = { value: body.tenant_access_token, expiresAt: Date.now() + (body.expire ?? 7200) * 1000 };
    return token.value;
  };

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    const wait = Math.min(30_000, 1000 * 2 ** Math.min(retries, 5));
    retries += 1;
    reconnectTimer = later(() => { reconnectTimer = undefined; void open(); }, wait);
  }

  async function open() {
    if (closed) return;
    let endpoint: Endpoint;
    try {
      endpoint = await handshake(cfg, deps.fetch);
    } catch (error) {
      log(`handshake failed: ${(error as Error).message}`);
      settleReady(error instanceof Error ? error : new Error(String(error)));
      scheduleReconnect();
      return;
    }
    let ws: WsLike;
    try {
      ws = deps.ws(endpoint.url);
    } catch (error) {
      log(`connect failed: ${(error as Error).message}`);
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.on("open", () => {
      retries = 0;
      settleReady();
      pingTimer = every(() => {
        try {
          ws.send(encodeFrame({ seqId: 0, logId: 0, service: endpoint.serviceId, method: METHOD_CONTROL, headers: [{ key: "type", value: "ping" }] }));
        } catch (error) { log(`ping failed: ${(error as Error).message}`); }
      }, endpoint.pingIntervalMs);
    });
    // Large events arrive split over frames sharing message_id: sum parts numbered 1..sum via seq.
    const fragments = new Map<string, { sum: number; parts: Map<number, Buffer> }>();
    ws.on("message", (data: Buffer) => {
      let frame: FeishuFrame;
      try { frame = decodeFrame(data); } catch (error) { log(`bad frame: ${(error as Error).message}`); return; }
      if (frame.method === METHOD_CONTROL) {
        // A server ping gets a pong back; pongs to our pings need no handling.
        if (headerOf(frame, "type") === "ping") {
          try { ws.send(encodeFrame({ ...frame, headers: [...frame.headers.filter((h) => h.key !== "type"), { key: "type", value: "pong" }] })); } catch {}
        }
        return;
      }
      if (frame.method !== METHOD_DATA || !frame.payload) return;
      const started = Date.now();
      let payload = frame.payload;
      const sum = Number(headerOf(frame, "sum") ?? "1") || 1;
      const messageKey = headerOf(frame, "message_id");
      if (sum > 1 && messageKey) {
        const seq = Number(headerOf(frame, "seq") ?? "0") || 0;
        const group = fragments.get(messageKey) ?? { sum, parts: new Map() };
        group.parts.set(seq, frame.payload);
        fragments.set(messageKey, group);
        if (group.parts.size < sum) {
          try { ws.send(encodeFrame({ ...frame, headers: [...frame.headers, { key: "biz_rt", value: String(Date.now() - started) }], payload: ACK_PAYLOAD })); } catch {}
          return;
        }
        fragments.delete(messageKey);
        payload = Buffer.concat(Array.from({ length: sum }, (_, i) => group.parts.get(i + 1) ?? Buffer.alloc(0)));
      }
      const inbound = textFromEvent(payload.toString("utf8"));
      if (inbound) deps.onText(inbound);
      // Unacked deliveries are retried by the platform; answer every data frame.
      try {
        ws.send(encodeFrame({
          ...frame,
          headers: [...frame.headers, { key: "biz_rt", value: String(Date.now() - started) }],
          payload: ACK_PAYLOAD,
        }));
      } catch (error) { log(`ack failed: ${(error as Error).message}`); }
    });
    const drop = () => {
      if (socket !== ws) return;
      socket = null;
      if (pingTimer) { clearInterval(pingTimer); pingTimer = undefined; }
      scheduleReconnect();
    };
    ws.on("close", drop);
    ws.on("error", (arg) => { log(`socket error: ${arg instanceof Error ? arg.message : String(arg ?? "")}`); try { ws.close(); } catch {} drop(); });
  }

  void open();
  return {
    ready,
    sendText: async (chatId, text) => {
      const response = await deps.fetch(`${base}${SEND_PATH}?receive_id_type=chat_id`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${await tenantToken()}` },
        body: JSON.stringify({ receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }), uuid: randomUUID() }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json().catch(() => null) as { code?: number; msg?: string } | null;
      if (!response.ok || (body && body.code !== 0)) throw new Error(`feishu send failed (${response.status}): ${body?.msg ?? response.status}`);
    },
    close: () => {
      closed = true;
      if (pingTimer) clearInterval(pingTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { socket?.close(); } catch {}
      settleReady();
    },
  };
}
