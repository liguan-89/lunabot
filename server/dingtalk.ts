// DingTalk self-built-app channel over the platform's Stream mode: no public callback URL, so a
// desktop can host a DingTalk bot directly. Handshake POSTs the app credentials to
// /v1.0/gateway/connections/open for a wss endpoint plus a one-shot ticket; JSON envelopes on the
// socket carry callback data, and every delivery must be ACKed with its own headers or the platform
// redelivers.
export interface DingtalkConfig {
  appKey: string;
  appSecret: string;
  /** Open-platform origin, default https://api.dingtalk.com (overridable for fixtures). */
  baseUrl?: string;
}

export interface DingtalkInbound {
  chatId: string;
  messageId: string;
  /** The sender's staff id, for attribution. */
  senderId: string;
  senderNick?: string;
  text: string;
  /** The per-session reply endpoint the platform attaches to each delivery (~1h TTL). */
  sessionWebhook: string;
  sessionWebhookExpiresAt?: number;
}

/** The slice of `ws`'s WebSocket the channel needs. */
export interface DingtalkWs {
  send(data: Buffer | string): void;
  close(): void;
  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): void;
  on(event: "open" | "close" | "error", listener: (arg?: unknown) => void): void;
}

export interface DingtalkDeps {
  fetch: typeof fetch;
  ws: (url: string) => DingtalkWs;
  onText: (inbound: DingtalkInbound) => void;
  log?: (line: string) => void;
  /** Test seam: the reconnect timer runs through it. */
  setTimeout?: typeof setTimeout;
}

export interface DingtalkChannel {
  sendText(chatId: string, text: string): Promise<void>;
  close(): void;
  /** Settles on the first established connection; rejects if the handshake fails. */
  ready: Promise<void>;
}

export const DINGTALK_ROBOT_TOPIC = "/v1.0/im/bot/messages/get";

interface StreamEnvelope {
  type?: string;
  headers?: { messageId?: string; topic?: string; [key: string]: unknown };
  data?: unknown;
}

interface RobotMessage {
  conversationId?: string;
  msgId?: string;
  msgtype?: string;
  text?: { content?: string };
  senderId?: string;
  senderNick?: string;
  senderStaffId?: string;
  chatbotUserId?: string;
  sessionWebhook?: string;
  sessionWebhookExpiredTime?: number;
}

/** Envelope JSON → the inbound text, or null for anything we do not handle. */
export function textFromEvent(payload: string): DingtalkInbound | null {
  let envelope: StreamEnvelope;
  try { envelope = JSON.parse(payload) as StreamEnvelope; } catch { return null; }
  return inboundFromEnvelope(envelope);
}

function inboundFromEnvelope(envelope: StreamEnvelope): DingtalkInbound | null {
  if (envelope.type !== "CALLBACK" || envelope.headers?.topic !== DINGTALK_ROBOT_TOPIC) return null;
  let message: RobotMessage;
  try { message = (typeof envelope.data === "string" ? JSON.parse(envelope.data) : envelope.data) as RobotMessage; } catch { return null; }
  if (!message || message.msgtype !== "text" || !message.conversationId || !message.msgId || !message.sessionWebhook) return null;
  const sender = message.senderStaffId || message.senderId || "";
  if (sender && sender === message.chatbotUserId) return null;
  // Group delivery leaves the leading @bot mention in the text.
  const text = (message.text?.content ?? "").replace(/^@[^\s@]+\s*/, "").trim();
  if (!text) return null;
  return {
    chatId: message.conversationId, messageId: message.msgId, senderId: sender,
    ...(message.senderNick ? { senderNick: message.senderNick } : {}), text,
    sessionWebhook: message.sessionWebhook,
    ...(message.sessionWebhookExpiredTime ? { sessionWebhookExpiresAt: message.sessionWebhookExpiredTime } : {}),
  };
}

export function connectDingtalk(cfg: DingtalkConfig, deps: DingtalkDeps): DingtalkChannel {
  const log = (line: string) => deps.log?.(`dingtalk: ${line}`);
  const later = deps.setTimeout ?? setTimeout;
  const base = cfg.baseUrl ?? "https://api.dingtalk.com";
  let socket: DingtalkWs | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let retries = 0;
  let token: { value: string; expiresAt: number } | null = null;
  const webhooks = new Map<string, { url: string; expiresAt?: number }>();
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let readySettled = false;
  const settleReady = (error?: Error) => {
    if (readySettled) return;
    readySettled = true;
    if (error) rejectReady(error); else resolveReady();
  };

  const accessToken = async (): Promise<string> => {
    if (token && token.expiresAt > Date.now() + 60_000) return token.value;
    const response = await deps.fetch(`${base}/v1.0/oauth2/accessToken`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appKey: cfg.appKey, appSecret: cfg.appSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => null) as { accessToken?: string; expireIn?: number; errmsg?: string } | null;
    if (!response.ok || !body?.accessToken) {
      throw new Error(`dingtalk token failed (${response.status}): ${body?.errmsg ?? response.status}`);
    }
    token = { value: body.accessToken, expiresAt: Date.now() + (body.expireIn ?? 7200) * 1000 };
    return token.value;
  };

  const handshake = async (): Promise<string> => {
    const response = await deps.fetch(`${base}/v1.0/gateway/connections/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: cfg.appKey, clientSecret: cfg.appSecret, ua: "lunabot",
        subscriptions: [{ type: "EVENT", topic: "*" }, { type: "CALLBACK", topic: DINGTALK_ROBOT_TOPIC }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => null) as { endpoint?: string; ticket?: string; message?: string } | null;
    if (!response.ok || !body?.endpoint || !body.ticket) {
      throw new Error(`dingtalk handshake failed (${response.status}): ${body?.message ?? JSON.stringify(body)}`);
    }
    // The ticket builds one connection only and lives 90 s — it goes on the URL, never into storage.
    const sep = body.endpoint.includes("?") ? "&" : "?";
    return `${body.endpoint}${sep}ticket=${encodeURIComponent(body.ticket)}`;
  };

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    const wait = Math.min(30_000, 1000 * 2 ** Math.min(retries, 5));
    retries += 1;
    reconnectTimer = later(() => { reconnectTimer = undefined; void open(); }, wait);
  }

  async function open() {
    if (closed) return;
    let url: string;
    try {
      url = await handshake();
    } catch (error) {
      log(`handshake failed: ${(error as Error).message}`);
      settleReady(error instanceof Error ? error : new Error(String(error)));
      scheduleReconnect();
      return;
    }
    let ws: DingtalkWs;
    try {
      ws = deps.ws(url);
    } catch (error) {
      log(`connect failed: ${(error as Error).message}`);
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.on("open", () => { retries = 0; settleReady(); });
    ws.on("message", (data: Buffer) => {
      let envelope: StreamEnvelope;
      try { envelope = JSON.parse(data.toString("utf8")) as StreamEnvelope; } catch { return; }
      const inbound = inboundFromEnvelope(envelope);
      if (inbound) {
        webhooks.set(inbound.chatId, { url: inbound.sessionWebhook, ...(inbound.sessionWebhookExpiresAt ? { expiresAt: inbound.sessionWebhookExpiresAt } : {}) });
        try { deps.onText(inbound); } catch (error) { log(`inbound failed: ${(error as Error).message}`); }
      }
      // Unacked deliveries are retried by the platform; answer every envelope with its own headers.
      if (envelope.headers?.messageId) {
        try {
          ws.send(JSON.stringify({ code: 200, headers: envelope.headers, message: "OK", data: "" }));
        } catch (error) { log(`ack failed: ${(error as Error).message}`); }
      }
    });
    const drop = () => {
      if (socket !== ws) return;
      socket = null;
      scheduleReconnect();
    };
    ws.on("close", drop);
    ws.on("error", (arg) => { log(`socket error: ${arg instanceof Error ? arg.message : String(arg ?? "")}`); try { ws.close(); } catch {} drop(); });
  }

  void open();
  return {
    ready,
    sendText: async (chatId, text) => {
      const hook = webhooks.get(chatId);
      if (!hook || (hook.expiresAt !== undefined && hook.expiresAt < Date.now())) {
        throw new Error(`dingtalk: no live session webhook for ${chatId}`);
      }
      const response = await deps.fetch(hook.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": await accessToken() },
        body: JSON.stringify({ msgtype: "text", text: { content: text } }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json().catch(() => null) as { errcode?: number; errmsg?: string } | null;
      if (!response.ok || (body && body.errcode)) throw new Error(`dingtalk send failed (${response.status}): ${body?.errmsg ?? response.status}`);
    },
    close: () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { socket?.close(); } catch {}
      settleReady();
    },
  };
}
