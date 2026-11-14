import { afterEach, describe, expect, it, vi } from "vitest";

import { listVoices, synthesize, transcribe } from "./qwen.ts";

afterEach(() => vi.unstubAllGlobals());

const ORIGIN = "https://dashscope.aliyuncs.com";

describe("Qwen TTS", () => {
  it("asks multimodal-generation for an audio url, then downloads it", async () => {
    const calls: Array<[string, RequestInit]> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      if (calls.length === 1) {
        return new Response(JSON.stringify({ output: { audio: { url: "https://oss.example/a.wav" } } }), { status: 200 });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }));
    const out = await synthesize("你好", "Cherry", "sk-qwen", ORIGIN);
    expect(out.mime).toBe("audio/wav");
    expect([...out.bytes]).toEqual([1, 2, 3]);
    expect(calls[0]![0]).toBe(`${ORIGIN}/api/v1/services/aigc/multimodal-generation/generation`);
    expect((calls[0]![1].headers as Record<string, string>).authorization).toBe("Bearer sk-qwen");
    const sent = JSON.parse(calls[0]![1].body as string);
    expect(sent).toEqual({ model: "qwen3-tts-flash", input: { text: "你好", voice: "Cherry" } });
    expect(calls[1]![0]).toBe("https://oss.example/a.wav");
    expect(calls[1]![1]?.redirect).toBe("error");
  });

  it("rejects a missing or non-https audio url", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ output: {} }), { status: 200 })));
    await expect(synthesize("x", "Cherry", "k", ORIGIN)).rejects.toThrow("no audio");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ output: { audio: { url: "http://evil.example/a.wav" } } }), { status: 200 },
    )));
    await expect(synthesize("x", "Cherry", "k", ORIGIN)).rejects.toThrow("no audio");
  });

  it("reads the service's error message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "invalid key" }), { status: 401 })));
    await expect(synthesize("x", "Cherry", "k", ORIGIN)).rejects.toThrow("invalid key");
  });

  it("keeps a fixed qwen3-tts-flash voice list", () => {
    expect(listVoices().map((voice) => voice.id)).toContain("Cherry");
  });
});

describe("Qwen ASR", () => {
  it("posts a base64 data URI to compatible-mode chat/completions", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: " 你好世界 " } }] }), { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    expect(await transcribe(new Uint8Array([82, 73]), "sk-qwen", ORIGIN)).toBe("你好世界");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${ORIGIN}/compatible-mode/v1/chat/completions`);
    const sent = JSON.parse(init.body as string);
    expect(sent.model).toBe("qwen3-asr-flash");
    expect(sent.messages[0].content[0].type).toBe("input_audio");
    expect(sent.messages[0].content[0].input_audio.data).toBe(`data:audio/wav;base64,${Buffer.from([82, 73]).toString("base64")}`);
  });

  it("surfaces the API error and an unreachable network", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "nope" }), { status: 429 })));
    await expect(transcribe(new Uint8Array(4), "k", ORIGIN)).rejects.toThrow("(429)");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("down"); }));
    await expect(transcribe(new Uint8Array(4), "k", ORIGIN)).rejects.toThrow("Couldn't reach Qwen speech-to-text");
  });
});
