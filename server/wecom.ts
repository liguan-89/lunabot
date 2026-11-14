// WeCom (企业微信) self-built-app channel. Unlike Feishu/DingTalk there is no long connection: the
// only inbound path is the app's receiving-message callback, so this needs a public URL pointing at
// this server (config.wecom + /api/wecom/callback). Replies go out over the message APIs.
// Callback crypto per the WeCom docs: AES-256-CBC with key = base64decode(encodingAesKey + "="),
// IV = key[0:16]; plaintext = random(16) | msg_len(4, big-endian) | msg | receiveid; the URL
// signature is sha1(sort(token, timestamp, nonce, encrypt_msg)).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface WecomConfig {
  corpId: string;
  corpSecret: string;
  token: string;
  encodingAesKey: string;
  agentId: string;
  /** Operator override for the qyapi.weixin.qq.com origin (fixtures, private deploys). */
  baseUrl?: string;
}

/** chatKey routes a reply: `u:` a single member (message/send touser), `g:` a group chat (appchat/send chatid). */
export interface WecomInbound {
  chatKey: string;
  messageId: string;
  senderId: string;
  text: string;
}

export interface WecomChannel {
  /** Pre-auth route for GET (URL verification) and POST (encrypted messages). False = not ours. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  sendText(chatKey: string, text: string): Promise<void>;
}

export interface WecomDeps {
  fetch: typeof fetch;
  setTimeout?: typeof setTimeout;
  log?: (line: string) => void;
  onText(inbound: WecomInbound): void;
}

export const WECOM_CALLBACK_PATH = "/api/wecom/callback";
const QYAPI = "https://qyapi.weixin.qq.com";

const aesKeyOf = (encodingAesKey: string): Buffer => Buffer.from(`${encodingAesKey}=`, "base64");

const signature = (token: string, timestamp: string, nonce: string, encrypt: string): string =>
  createHash("sha1").update([token, timestamp, nonce, encrypt].sort().join("")).digest("hex");

/** Decrypts a WeCom envelope block; returns the carried message (the receiveid tail is unchecked: the
 * channel is a single corp, and a wrong key already fails at padding). */
export function decrypt(encodingAesKey: string, encrypted: string): string {
  const key = aesKeyOf(encodingAesKey);
  const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  // WeCom pads to a 32-byte boundary, which OpenSSL's 16-byte PKCS7 check rejects; the message is
  // recovered by its length field anyway, so padding stays attached and ignored.
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(encrypted, "base64"), decipher.final()]);
  const length = plain.readUInt32BE(16);
  if (20 + length > plain.length) throw new Error("bad wecom envelope");
  return plain.subarray(20, 20 + length).toString("utf8");
}

/** Test helper + symmetric counterpart for the receive path; exported for fixtures. */
export function encrypt(encodingAesKey: string, message: string, receiveId = ""): string {
  const key = aesKeyOf(encodingAesKey);
  const msg = Buffer.from(message, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(msg.length);
  const block = Buffer.concat([randomBytes(16), length, msg, Buffer.from(receiveId, "utf8")]);
  const pad = 32 - (block.length % 32);
  const padded = Buffer.concat([block, Buffer.alloc(pad, pad)]);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

const xmlField = (xml: string, name: string): string | null => {
  const m = xml.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`));
  return m ? (m[1] ?? "") : null;
};

/** Decrypts and validates a callback envelope (echostr or a message Encrypt body). */
const openEnvelope = (cfg: WecomConfig, url: URL, encrypted: string): string | null => {
  const timestamp = url.searchParams.get("timestamp") ?? "";
  const nonce = url.searchParams.get("nonce") ?? "";
  if (signature(cfg.token, timestamp, nonce, encrypted) !== (url.searchParams.get("msg_signature") ?? "")) return null;
  try {
    return decrypt(cfg.encodingAesKey, encrypted);
  } catch {
    return null;
  }
};

/** The decrypted inner XML of an incoming message, or null when it carries nothing we take. */
export function inboundFromXml(xml: string): WecomInbound | null {
  if (xmlField(xml, "MsgType") !== "text") return null;
  const text = (xmlField(xml, "Content") ?? "").trim();
  const senderId = xmlField(xml, "FromUserName") ?? "";
  const messageId = xmlField(xml, "MsgId") ?? "";
  if (!text || !senderId || !messageId) return null;
  const chatId = xmlField(xml, "ChatId")?.trim();
  return { chatKey: chatId ? `g:${chatId}` : `u:${senderId}`, messageId, senderId, text };
}

const readRawBody = (req: IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  req.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 256 * 1024) return reject(Object.assign(new Error("request too large"), { status: 413 }));
    chunks.push(chunk);
  });
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});

export function createWecom(config: () => WecomConfig | null, deps: WecomDeps): WecomChannel {
  const base = () => (config()?.baseUrl ?? QYAPI).replace(/\/+$/, "");
  let token: { value: string; until: number; creds: string } | null = null;
  const accessToken = async (cfg: WecomConfig): Promise<string> => {
    const creds = `${cfg.corpId}:${cfg.corpSecret}`;
    if (token && token.creds === creds && Date.now() < token.until) return token.value;
    const response = await deps.fetch(`${base()}/cgi-bin/gettoken?corpid=${encodeURIComponent(cfg.corpId)}&corpsecret=${encodeURIComponent(cfg.corpSecret)}`);
    const body = await response.json() as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };
    if (!response.ok || !body.access_token) throw new Error(`wecom gettoken ${response.status}: ${body.errmsg ?? "no token"}`);
    token = { value: body.access_token, until: Date.now() + Math.max(60, (body.expires_in ?? 7200) - 300) * 1000, creds };
    return token.value;
  };

  const post = async (cfg: WecomConfig, path: string, body: Record<string, unknown>): Promise<void> => {
    const access = await accessToken(cfg);
    const response = await deps.fetch(`${base()}${path}?access_token=${encodeURIComponent(access)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const result = await response.json() as { errcode?: number; errmsg?: string };
    if (!response.ok || (result.errcode ?? 0) !== 0) throw new Error(`wecom send ${response.status}: ${result.errmsg ?? "failed"}`);
  };

  const text = (res: ServerResponse, status: number, body: string) => {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end(body);
  };

  const sendText = async (chatKey: string, content: string): Promise<void> => {
    const cfg = config();
    if (!cfg) throw new Error("wecom channel is not configured");
    if (chatKey.startsWith("g:")) {
      await post(cfg, "/cgi-bin/appchat/send", { chatid: chatKey.slice(2), msgtype: "text", text: { content } });
    } else {
      await post(cfg, "/cgi-bin/message/send", { touser: chatKey.slice(2), msgtype: "text", agentid: cfg.agentId, text: { content }, safe: 0 });
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== WECOM_CALLBACK_PATH) return false;
    const cfg = config();
    if (!cfg?.corpId || !cfg.corpSecret || !cfg.token || !cfg.encodingAesKey || !cfg.agentId) {
      text(res, 404, "wecom channel is not configured");
      return true;
    }
    if (req.method === "GET") {
      const echo = url.searchParams.get("echostr") ?? "";
      const plain = echo ? openEnvelope(cfg, url, echo) : null;
      if (plain === null) { text(res, 403, "invalid signature"); return true; }
      text(res, 200, plain);
      return true;
    }
    if (req.method === "POST") {
      let raw: string;
      try {
        raw = await readRawBody(req);
      } catch {
        text(res, 413, "request too large");
        return true;
      }
      const encrypted = xmlField(raw, "Encrypt") ?? "";
      const inner = encrypted ? openEnvelope(cfg, url, encrypted) : null;
      if (inner === null) { text(res, 403, "invalid signature"); return true; }
      // Reply "success" no matter the message kind: the real answer goes out asynchronously on the
      // turn-completed path, and a redelivery would only hit the sendId dedupe.
      const inbound = inboundFromXml(inner);
      if (inbound) {
        try { deps.onText(inbound); }
        catch (error) { deps.log?.(`wecom: inbound failed: ${(error as Error).message}`); }
      }
      text(res, 200, "success");
      return true;
    }
    text(res, 405, "method not allowed");
    return true;
  };

  return { handle, sendText };
}
