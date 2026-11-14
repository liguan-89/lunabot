import { describe, expect, it, vi } from "vitest";

import { floatToPcm16, openPcmCall, pcm16ToFloat32, relayEvent, type PcmSocket } from "./live-relay-client";

class FakeSocket implements PcmSocket {
  readyState = 1;
  binaryType = "arraybuffer";
  sent: Array<ArrayBuffer | string> = [];
  closed = false;
  private listeners = new Map<string, Array<(event?: { data?: unknown }) => void>>();
  addEventListener(type: string, fn: (event?: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, event?: { data?: unknown }): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  send(data: ArrayBuffer | string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 3; this.emit("close"); }
}

function fakeAudio() {
  const ctx = {
    sampleRate: 16000,
    currentTime: 0,
    destination: {},
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    createMediaStreamSource: () => ({ connect: vi.fn() }),
    createBuffer: (_ch: number, len: number, rate: number) => {
      const data = new Float32Array(len);
      return { duration: len / rate, copyToChannel: (src: Float32Array) => data.set(src) };
    },
    createBufferSource: () => ({ connect: vi.fn(), start: vi.fn(), stop: vi.fn(), buffer: null as unknown }),
    close: vi.fn(async () => undefined),
  };
  (globalThis as Record<string, unknown>).AudioWorkletNode ??= class {
    port = { onmessage: null as unknown };
    connect = vi.fn();
    constructor(_ctx: unknown, _name: string) {}
  };
  const track = { stop: vi.fn(), enabled: true };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  return {
    ctx,
    stream,
    deps: {
      socket: () => new FakeSocket(),
      getUserMedia: async () => stream,
      audioContext: () => ctx as unknown as AudioContext,
      workletUrl: () => "blob:fake",
    },
  };
}

describe("pcm conversion", () => {
  it("round-trips int16 LE", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 2]);
    const back = pcm16ToFloat32(floatToPcm16(samples));
    expect(back[0]).toBe(0);
    expect(back[1]).toBeCloseTo(0.5, 3);
    expect(back[2]).toBeCloseTo(-0.5, 3);
    expect(back[3]).toBeCloseTo(1, 3);
    expect(back[4]).toBeCloseTo(-1, 3);
    expect(back[5]).toBeCloseTo(1, 3); // clamped
  });
  it("writes little-endian bytes", () => {
    const bytes = new Uint8Array(floatToPcm16(new Float32Array([1 / 0x8000])));
    expect(bytes).toEqual(new Uint8Array([1, 0]));
  });
});

describe("relayEvent", () => {
  it("parses the known shapes and ignores the rest", () => {
    expect(relayEvent('{"t":"ready","provider":"volc","outputHz":24000}')).toEqual({ t: "ready", provider: "volc", outputHz: 24000 });
    expect(relayEvent('{"t":"transcript","role":"user","delta":"hi"}')).toEqual({ t: "transcript", role: "user", delta: "hi" });
    expect(relayEvent('{"t":"error","message":"x"}')).toEqual({ t: "error", message: "x" });
    expect(relayEvent('{"t":"end"}')).toEqual({ t: "end" });
    expect(relayEvent("not json")).toBeNull();
    expect(relayEvent('{"t":"transcript","role":"bot","delta":1}')).toBeNull();
  });
});

describe("openPcmCall", () => {
  it("starts capture on ready, forwards audio events, sends end on close", async () => {
    const { deps, ctx, stream } = fakeAudio();
    let socket: FakeSocket | null = null;
    deps.socket = () => (socket = new FakeSocket());
    const events = {
      onReady: vi.fn(), onAudio: vi.fn(), onTranscript: vi.fn(), onError: vi.fn(), onEnd: vi.fn(),
    };
    const promise = openPcmCall({ url: "ws://x/api/live/relay", events, deps });
    socket!.emit("message", { data: JSON.stringify({ t: "ready", provider: "volc" }) });
    const call = await promise;
    expect(events.onReady).toHaveBeenCalledWith("volc");
    expect(ctx.audioWorklet.addModule).toHaveBeenCalled();
    socket!.emit("message", { data: floatToPcm16(new Float32Array([0.25])) });
    expect(events.onAudio).toHaveBeenCalled();
    socket!.emit("message", { data: JSON.stringify({ t: "transcript", role: "assistant", delta: "hey" }) });
    expect(events.onTranscript).toHaveBeenCalledWith("assistant", "hey");
    call.end();
    expect(JSON.parse(String(socket!.sent[0]))).toEqual({ t: "end" });
    call.close();
    expect(socket!.closed).toBe(true);
    expect(stream.getTracks()[0]!.stop).toHaveBeenCalled();
  });

  it("closes the relay when the microphone is refused after ready", async () => {
    const { deps } = fakeAudio();
    let socket: FakeSocket | null = null;
    deps.socket = () => (socket = new FakeSocket());
    deps.getUserMedia = async () => { throw new DOMException("denied", "NotAllowedError"); };
    const events = { onReady: vi.fn(), onAudio: vi.fn(), onTranscript: vi.fn(), onError: vi.fn(), onEnd: vi.fn() };
    const promise = openPcmCall({ url: "ws://x", events, deps });
    socket!.emit("message", { data: JSON.stringify({ t: "ready", provider: "volc" }) });
    await expect(promise).rejects.toThrow("denied");
    expect(socket!.closed).toBe(true);
  });

  it("rejects on provider error and reports end on close", async () => {
    const { deps } = fakeAudio();
    let socket: FakeSocket | null = null;
    deps.socket = () => (socket = new FakeSocket());
    const events = { onReady: vi.fn(), onAudio: vi.fn(), onTranscript: vi.fn(), onError: vi.fn(), onEnd: vi.fn() };
    const promise = openPcmCall({ url: "ws://x", events, deps });
    socket!.emit("message", { data: JSON.stringify({ t: "error", message: "quota" }) });
    await expect(promise).rejects.toThrow("quota");
  });
});
