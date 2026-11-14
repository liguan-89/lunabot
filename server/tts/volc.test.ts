import { afterEach, describe, expect, it, vi } from "vitest";

import { listVoices, synthesize, transcribe } from "./volc.ts";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Volcengine TTS", () => {
  it("posts the v1 one-shot shape and decodes base64 mp3", async () => {
    const audio = Buffer.from("mp3-bytes");
    const fetchMock = stubFetch(200, { code: 3000, data: audio.toString("base64") });
    const out = await synthesize("你好", "BV001_streaming", "123456", "access-token");
    expect(out.mime).toBe("audio/mpeg");
    expect(Buffer.from(out.bytes).toString()).toBe("mp3-bytes");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openspeech.bytedance.com/api/v1/tts");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer;access-token");
    const sent = JSON.parse(init.body as string);
    expect(sent.app).toMatchObject({ appid: "123456", cluster: "volcano_tts" });
    expect(sent.audio).toMatchObject({ voice_type: "BV001_streaming", encoding: "mp3" });
    expect(sent.request).toMatchObject({ text: "你好", text_type: "plain", operation: "query" });
    expect(sent.request.reqid).toBeTruthy();
  });

  it("turns a speech error code and a dead HTTP status into readable failures", async () => {
    stubFetch(200, { code: 6001, message: "voice not found" });
    await expect(synthesize("x", "v", "a", "t")).rejects.toThrow("voice not found");
    stubFetch(403, { message: "denied" });
    await expect(synthesize("x", "v", "a", "t")).rejects.toThrow("(403)");
    stubFetch(200, { code: 3000, data: "" });
    await expect(synthesize("x", "v", "a", "t")).rejects.toThrow("no audio");
  });

  it("keeps a classic-catalog voice list (O2.0 voices are V3-only)", () => {
    const ids = listVoices().map((voice) => voice.id);
    expect(ids).toContain("BV001_streaming");
    expect(ids.every((id) => !id.includes("vv_"))).toBe(true);
  });
});

describe("Volcengine flash recognition", () => {
  it("sends the WAV as base64 under the bigasr resource headers", async () => {
    const fetchMock = stubFetch(200, { result: { text: "  hello " } }, { "x-api-status-code": "20000000" });
    expect(await transcribe(new Uint8Array([82, 73, 70, 70]), "123456", "tok")).toBe("hello");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Api-App-Key"]).toBe("123456");
    expect(headers["X-Api-Access-Key"]).toBe("tok");
    expect(headers["X-Api-Resource-Id"]).toBe("volc.bigasr.auc_turbo");
    expect(headers["X-Api-Sequence"]).toBe("-1");
    const sent = JSON.parse(init.body as string);
    expect(sent.audio.data).toBe(Buffer.from([82, 73, 70, 70]).toString("base64"));
    expect(sent.request.model_name).toBe("bigmodel");
  });

  it("surfaces the API status headers on failure", async () => {
    stubFetch(200, {}, { "x-api-status-code": "45000001", "x-api-message": "quota exhausted" });
    await expect(transcribe(new Uint8Array(4), "a", "t")).rejects.toThrow("45000001");
    await expect(transcribe(new Uint8Array(4), "a", "t")).rejects.toThrow("quota exhausted");
  });

  it("says the service was unreachable when the request throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("down"); }));
    await expect(transcribe(new Uint8Array(4), "a", "t")).rejects.toThrow("Couldn't reach Volcengine");
  });
});
