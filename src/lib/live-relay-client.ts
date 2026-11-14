// The renderer half of the WebSocket live relay: microphone → PCM s16le 16kHz → /api/live/relay → provider,
// provider audio → PCM s16le playback. Used for providers without a WebRTC transport (qwen, volc); OpenAI/Azure
// calls still go over RTCPeerConnection in live-call-media.ts.
export const RELAY_INPUT_HZ = 16_000;
export const RELAY_OUTPUT_HZ = 24_000;

export function floatToPcm16(samples: Float32Array<ArrayBufferLike>): ArrayBuffer {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = Math.max(-0x8000, Math.min(0x7fff, Math.round(s * 0x8000)));
  }
  return out.buffer;
}

export function pcm16ToFloat32(data: ArrayBuffer): Float32Array<ArrayBuffer> {
  const int = new Int16Array(data);
  const out = new Float32Array(int.length);
  for (let i = 0; i < int.length; i += 1) out[i] = int[i]! / 0x8000;
  return out;
}

export type RelayEvent =
  | { t: "ready"; provider: string; inputHz?: number; outputHz?: number }
  | { t: "transcript"; role: "user" | "assistant"; delta: string }
  | { t: "event"; name: string }
  | { t: "error"; message: string }
  | { t: "end" };

export function relayEvent(text: string): RelayEvent | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.t === "ready" || parsed.t === "end") return parsed as RelayEvent;
    if (parsed.t === "transcript" && (parsed.role === "user" || parsed.role === "assistant") && typeof parsed.delta === "string") return parsed as unknown as RelayEvent;
    if (parsed.t === "event" && typeof parsed.name === "string") return parsed as unknown as RelayEvent;
    if (parsed.t === "error" && typeof parsed.message === "string") return parsed as unknown as RelayEvent;
    return null;
  } catch {
    return null;
  }
}

// The worklet's own source stays here: bundled apps cannot load a second worklet asset from a file URL.
const CAPTURE_WORKLET = `
class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("omb-pcm-capture", PcmCapture);
`;

export interface PcmSocket {
  readonly readyState: number;
  binaryType: string;
  close(): void;
  send(data: ArrayBuffer | string): void;
  addEventListener(type: string, fn: (event?: { data?: unknown }) => void): void;
}

export interface PcmCallDeps {
  socket(url: string): PcmSocket;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  audioContext(options: { sampleRate: number }): AudioContext;
  workletUrl(source: string): string;
}

const defaults: PcmCallDeps = {
  socket: (url) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    return ws as unknown as PcmSocket;
  },
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  audioContext: (options) => new AudioContext(options),
  workletUrl: (source) => URL.createObjectURL(new Blob([source], { type: "application/javascript" })),
};

export interface PcmCall {
  /** The captured microphone, kept so mute toggles the same tracks as a WebRTC call. */
  stream: MediaStream | null;
  end(): void;
  close(): void;
}

export interface PcmCallEvents {
  onReady(provider: string): void;
  onAudio(pcm: Float32Array): void;
  onTranscript(role: "user" | "assistant", delta: string): void;
  onError(message: string): void;
  onEnd(): void;
}

/** Plays PCM s16le chunks on one AudioContext, scheduling each chunk right after the last. */
export class PcmPlayer {
  private readonly ctx: AudioContext;
  private nextAt = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();
  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }
  push(samples: Float32Array<ArrayBuffer>): void {
    const buffer = this.ctx.createBuffer(1, samples.length, this.ctx.sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
    this.nextAt = Math.max(this.nextAt, this.ctx.currentTime + 0.02);
    source.start(this.nextAt);
    this.nextAt += buffer.duration;
  }
  async close(): Promise<void> {
    for (const source of this.sources) try { source.stop(); } catch { /* not started */ }
    this.sources.clear();
    await this.ctx.close().catch(() => undefined);
  }
}

/** Opens the relay socket and hooks the microphone: resolves once the relay says ready and capture runs. */
export async function openPcmCall(input: {
  url: string;
  events: PcmCallEvents;
  deps?: Partial<PcmCallDeps>;
}): Promise<PcmCall> {
  const deps = { ...defaults, ...input.deps };
  const socket = deps.socket(input.url);
  let closed = false;
  let stream: MediaStream | null = null;
  let captureCtx: AudioContext | null = null;
  let player: PcmPlayer | null = null;
  const call: PcmCall = {
    stream: null,
    end() { if (!closed && socket.readyState === 1) socket.send(JSON.stringify({ t: "end" })); },
    close() {
      if (closed) return;
      closed = true;
      call.end();
      try { socket.close(); } catch { /* already closed */ }
    },
  };
  const release = () => {
    stream?.getTracks().forEach((track) => track.stop());
    void captureCtx?.close().catch(() => undefined);
    void player?.close();
  };
  const ready = new Promise<void>((resolve, reject) => {
    socket.addEventListener("error", () => {
      closed = true;
      release();
      reject(new Error("The call connection failed."));
    });
    socket.addEventListener("close", () => {
      const wasClosed = closed;
      closed = true;
      release();
      if (wasClosed) return;
      reject(new Error("The call connection closed."));
      input.events.onEnd();
    });
    socket.addEventListener("message", (event) => {
      if (event?.data instanceof ArrayBuffer) {
        const pcm = pcm16ToFloat32(event.data);
        player?.push(pcm);
        input.events.onAudio(pcm);
        return;
      }
      const parsed = relayEvent(String(event?.data));
      if (!parsed) return;
      if (parsed.t === "ready") {
        input.events.onReady(parsed.provider);
        // A refused microphone still owes the relay a goodbye: the provider session is already open.
        void startCapture().then(resolve, (error: unknown) => {
          closed = true;
          release();
          try { socket.close(); } catch { /* already closed */ }
          reject(error);
        });
      } else if (parsed.t === "transcript") input.events.onTranscript(parsed.role, parsed.delta);
      else if (parsed.t === "error") { closed = true; reject(new Error(parsed.message)); }
      else if (parsed.t === "end") socket.close();
    });
  });
  async function startCapture(): Promise<void> {
    stream = await deps.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    call.stream = stream;
    const ctx = deps.audioContext({ sampleRate: RELAY_INPUT_HZ });
    captureCtx = ctx;
    await ctx.audioWorklet!.addModule(deps.workletUrl(CAPTURE_WORKLET));
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "omb-pcm-capture");
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!closed && socket.readyState === 1) socket.send(floatToPcm16(event.data));
    };
    source.connect(node);
    player = new PcmPlayer(deps.audioContext({ sampleRate: RELAY_OUTPUT_HZ }));
  }
  await ready;
  return call;
}
