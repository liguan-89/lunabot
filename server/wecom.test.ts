import { createHash, randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import { createWecom, decrypt, encrypt, inboundFromXml, WECOM_CALLBACK_PATH, type WecomConfig } from "./wecom.ts";

const KEY = randomBytes(32).toString("base64").slice(0, 43);
const cfg: WecomConfig = { corpId: "ww1", corpSecret: "s3cr3t", token: "tok", encodingAesKey: KEY, agentId: "1000002", baseUrl: "https://qyapi.test" };

const sign = (timestamp: string, nonce: string, encrypted: string) =>
  createHash("sha1").update([cfg.token, timestamp, nonce, encrypted].sort().join("")).digest("hex");

const callbackUrl = (encrypted: string, extra = "") =>
  `${WECOM_CALLBACK_PATH}?msg_signature=${sign("1700", "n1", encrypted)}&timestamp=1700&nonce=n1${extra}`;

const innerXml = (over: Record<string, string> = {}) => `<xml>${Object.entries({
  ToUserName: "ww1", FromUserName: "ZhangSan", CreateTime: "1700", MsgType: "text",
  Content: "hi bot", MsgId: "msg_1", AgentID: "1000002", ...over,
}).map(([k, v]) => `<${k}><![CDATA[${v}]]></${k}>`).join("")}</xml>`;

const postBody = (inner = innerXml()) =>
  `<xml><ToUserName><![CDATA[ww1]]></ToUserName><Encrypt><![CDATA[${encrypt(KEY, inner, "ww1")}]]></Encrypt><AgentID><![CDATA[1000002]]></AgentID></xml>`;

const fakeReq = (method: string, body = ""): IncomingMessage => {
  const stream = new PassThrough();
  if (body) stream.write(body);
  stream.end();
  const req = stream as unknown as IncomingMessage;
  req.method = method;
  return req;
};

const fakeRes = () => {
  const res = { status: 0, body: "", writeHead(status: number) { res.status = status; return res; }, end(body = "") { res.body = body; return res; } };
  return res as unknown as ServerResponse & { status: number; body: string };
};

const connectDeps = () => {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/cgi-bin/gettoken")) return new Response(JSON.stringify({ access_token: "w-token", expires_in: 7200 }), { status: 200 });
    posts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
  });
  return { posts, deps: { fetch: fetchImpl as unknown as typeof fetch, onText: vi.fn() } };
};

describe("callback crypto", () => {
  it("round-trips an envelope and rejects a wrong key", () => {
    const packed = encrypt(KEY, "hello", "ww1");
    expect(decrypt(KEY, packed)).toBe("hello");
    expect(() => decrypt(randomBytes(32).toString("base64").slice(0, 43), packed)).toThrow();
  });

  it("handles WeCom's 32-byte-boundary padding that OpenSSL's PKCS7 check would reject", () => {
    // 20 + msg + "ww1" lands exactly on a 32 boundary -> pad byte 0x20, invalid under 16-byte PKCS7.
    expect(decrypt(KEY, encrypt(KEY, "012345678", "ww1"))).toBe("012345678");
  });

  it("parses a text message into an inbound keyed by member or group chat", () => {
    expect(inboundFromXml(innerXml())).toEqual({ chatKey: "u:ZhangSan", messageId: "msg_1", senderId: "ZhangSan", text: "hi bot" });
    expect(inboundFromXml(innerXml({ ChatId: "wrOgQqDgAA" }))).toMatchObject({ chatKey: "g:wrOgQqDgAA", senderId: "ZhangSan" });
  });

  it("ignores non-text and incomplete messages", () => {
    expect(inboundFromXml(innerXml({ MsgType: "image" }))).toBeNull();
    expect(inboundFromXml(innerXml({ MsgId: "" }))).toBeNull();
    expect(inboundFromXml(innerXml({ Content: "  " }))).toBeNull();
  });
});

describe("createWecom handle", () => {
  it("answers the GET URL verification with the decrypted echostr", async () => {
    const { deps } = connectDeps();
    const channel = createWecom(() => cfg, deps);
    const echo = encrypt(KEY, "echo-123", "ww1");
    const res = fakeRes();
    expect(await channel.handle(fakeReq("GET"), res, new URL(`${callbackUrl(echo)}&echostr=${encodeURIComponent(echo)}`, "http://x"))).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body).toBe("echo-123");
  });

  it("rejects a bad signature", async () => {
    const { deps } = connectDeps();
    const channel = createWecom(() => cfg, deps);
    const res = fakeRes();
    const url = `${WECOM_CALLBACK_PATH}?msg_signature=deadbeef&timestamp=1700&nonce=n1&echostr=${encodeURIComponent(encrypt(KEY, "x", "ww1"))}`;
    await channel.handle(fakeReq("GET"), res, new URL(url, "http://x"));
    expect(res.status).toBe(403);
  });

  it("delivers a POSTed message to onText and replies success", async () => {
    const { deps } = connectDeps();
    const channel = createWecom(() => cfg, deps);
    const body = postBody();
    const encrypted = /<Encrypt><!\[CDATA\[(.*)\]\]><\/Encrypt>/.exec(body)![1]!;
    const res = fakeRes();
    await channel.handle(fakeReq("POST", body), res, new URL(callbackUrl(encrypted), "http://x"));
    expect(res.status).toBe(200);
    expect(res.body).toBe("success");
    expect(deps.onText).toHaveBeenCalledWith({ chatKey: "u:ZhangSan", messageId: "msg_1", senderId: "ZhangSan", text: "hi bot" });
  });

  it("still replies success to a message kind we ignore, and 404s when unconfigured", async () => {
    const { deps } = connectDeps();
    const channel = createWecom(() => cfg, deps);
    const res = fakeRes();
    const body = postBody(innerXml({ MsgType: "image" }));
    const encrypted = /<Encrypt><!\[CDATA\[(.*)\]\]><\/Encrypt>/.exec(body)![1]!;
    await channel.handle(fakeReq("POST", body), res, new URL(callbackUrl(encrypted), "http://x"));
    expect(res.body).toBe("success");
    expect(deps.onText).not.toHaveBeenCalled();

    const off = createWecom(() => null, deps);
    const res2 = fakeRes();
    await off.handle(fakeReq("GET"), res2, new URL(WECOM_CALLBACK_PATH, "http://x"));
    expect(res2.status).toBe(404);
    expect(await off.handle(fakeReq("GET"), fakeRes(), new URL("/api/other", "http://x"))).toBe(false);
  });
});

describe("sendText", () => {
  it("sends to a member over message/send and caches the token", async () => {
    const { posts, deps } = connectDeps();
    const channel = createWecom(() => cfg, deps);
    await channel.sendText("u:ZhangSan", "answer");
    await channel.sendText("u:ZhangSan", "answer 2");
    expect(posts).toHaveLength(2);
    expect(posts[0]!.url).toBe("https://qyapi.test/cgi-bin/message/send?access_token=w-token");
    expect(posts[0]!.body).toMatchObject({ touser: "ZhangSan", agentid: "1000002", text: { content: "answer" } });
    expect((deps.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) => String(u).includes("gettoken"))).toHaveLength(1);
  });

  it("sends to a group over appchat/send", async () => {
    const { posts, deps } = connectDeps();
    const channel = createWecom(() => cfg, deps);
    await channel.sendText("g:wrOgQqDgAA", "answer");
    expect(posts[0]!.url).toBe("https://qyapi.test/cgi-bin/appchat/send?access_token=w-token");
    expect(posts[0]!.body).toMatchObject({ chatid: "wrOgQqDgAA", msgtype: "text" });
  });
});
