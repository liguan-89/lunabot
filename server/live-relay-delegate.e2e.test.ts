// POSIX-gated: the fakes are shebang scripts.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = join(SERVER_DIR, "testing", "fake-pi-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");

/** A fake Doubao Seeduplex dialogue socket: session.create in, session.created out, one scripted
 * function_call_arguments.done, then it records the tool result the server sends back. */
class FakeVolcDuplex {
  readonly url: string;
  readonly received: Array<Record<string, unknown>> = [];
  private server: WebSocketServer;
  private socket: WebSocket | null = null;

  private constructor(port: number) {
    this.url = `ws://127.0.0.1:${port}`;
    this.server = new WebSocketServer({ port, host: "127.0.0.1" });
    this.server.on("connection", (ws) => {
      this.socket = ws;
      ws.on("message", (data) => {
        let event: Record<string, unknown>;
        try { event = JSON.parse(String(data)); } catch { return; }
        this.received.push(event);
        if (event.type === "session.create") ws.send(JSON.stringify({ type: "session.created", session: { id: "d1" } }));
      });
    });
  }

  static async start(): Promise<FakeVolcDuplex> {
    return new FakeVolcDuplex(await freePortBlock([0]));
  }

  emit(event: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(event));
  }

  async waitFor(fn: (event: Record<string, unknown>) => boolean, ms = 30_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.received.find(fn);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`volc duplex: event never arrived in ${JSON.stringify(this.received)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async stop(): Promise<void> {
    for (const client of this.server.clients) client.close();
    await new Promise<void>((done) => this.server.close(() => done()));
  }
}

posixOnly("Live relay delegate e2e", () => {
  let child: ChildProcess;
  let home = "";
  let base = "";
  let output = "";
  let duplex: FakeVolcDuplex;
  const clients: WebSocket[] = [];

  const post = async (path: string, body: unknown): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  beforeAll(async () => {
    chmodSync(FAKE_PI, 0o755);
    duplex = await FakeVolcDuplex.start();
    home = mkdtempSync(join(tmpdir(), "omb-live-relay-"));
    mkdirSync(join(home, ".lunabot"), { recursive: true });
    writeFileSync(
      join(home, ".lunabot", "config.json"),
      JSON.stringify({
        instances: {
          pi: {
            driver: "piAgent",
            environment: {
              FAKE_PI_CLAUDE_COMPAT: "1",
              FAKE_PI_REPLIES: JSON.stringify(["Six times seven is 42."]),
            },
            config: { cli: FAKE_PI },
          },
        },
      }),
    );
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        LUNABOT_PORT: String(port),
        LUNABOT_WEBHOOK_PORT: String(port + 1),
        LUNABOT_LIVE_PROVIDER: "volc",
        LUNABOT_LIVE_VOLC_APP_ID: "6255978659",
        LUNABOT_LIVE_VOLC_ENDPOINT: duplex.url,
        LUNABOT_OPENAI_LIVE_KEY: "fake-token",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk) => (output += chunk));
    child.stderr!.on("data", (chunk) => (output += chunk));
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. output:\n${output}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. output:\n${output}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 120_000);

  afterAll(async () => {
    for (const ws of clients.splice(0)) ws.close();
    await waitForExit(child, { signal: "SIGTERM" });
    await duplex?.stop();
    if (home) await removeTempDir(home);
  });

  it("declares the delegate tool, runs the spoken request through the bot and returns the reply", async () => {
    const { bot } = (await post("/api/bots", {})).body as { bot: { id: string; threadId: string } };
    const client = new WebSocket(`${base.replace("http", "ws")}/api/live/relay?botId=${bot.id}&client=android`);
    clients.push(client);
    const frames: Array<Record<string, unknown>> = [];
    client.on("message", (data, binary) => { if (!binary) frames.push(JSON.parse(String(data))); });
    await new Promise<void>((open, reject) => { client.on("open", open); client.on("error", reject); });

    await duplex.waitFor((e) => e.type === "session.create");
    const create = duplex.received.find((e) => e.type === "session.create")!;
    const session = create.session as { model?: string; tools?: Array<{ name: string }>; instructions?: string };
    expect(session.model).toBe("1.2.6.1");
    expect(session.tools?.map((t) => t.name)).toEqual(["delegate"]);
    expect(session.instructions).toContain("delegate");

    await expect.poll(() => frames.some((f) => f.t === "ready" && f.provider === "volc"), { timeout: 10_000 }).toBe(true);

    duplex.emit({
      type: "response.function_call_arguments.done",
      items: [{ call_id: "fc1", name: "delegate", arguments: JSON.stringify({ request: "what is six times seven" }) }],
    });

    const toolResult = await duplex.waitFor((e) => e.type === "conversation.item.create");
    const items = toolResult.items as Array<{ call_id: string; role: string; content: Array<{ type: string; text: string }> }>;
    expect(items[0]).toMatchObject({ call_id: "fc1", role: "tool" });
    expect(items[0]!.content[0]).toMatchObject({ type: "input_text" });
    expect(items[0]!.content[0]!.text).toContain("收到");

    const narrated = await duplex.waitFor((e) => e.type === "speech_text_buffer.commit" && String(e.text).includes("42"));
    expect(String(narrated.text)).toContain("42");

    const { messages } = (await (await fetch(`${base}/api/threads/${bot.threadId}/messages`)).json()) as {
      messages: Array<{ role: string; via?: string; callId?: string; text?: string }>;
    };
    const spoken = messages.find((m) => m.role === "user" && m.via === "call");
    expect(spoken?.text).toBe("what is six times seven");
    expect(spoken?.callId).toBeTruthy();
    expect(messages.some((m) => m.role === "bot" && m.text?.includes("42"))).toBe(true);
    expect(JSON.stringify(duplex.received)).not.toContain("fake-token");
  }, 60_000);

  it("stays tool-less without a bot target and still reaches ready", async () => {
    const client = new WebSocket(`${base.replace("http", "ws")}/api/live/relay`);
    clients.push(client);
    const frames: Array<Record<string, unknown>> = [];
    client.on("message", (data, binary) => { if (!binary) frames.push(JSON.parse(String(data))); });
    await new Promise<void>((open, reject) => { client.on("open", open); client.on("error", reject); });
    await expect.poll(() => frames.some((f) => f.t === "ready"), { timeout: 10_000 }).toBe(true);
    const creates = duplex.received.filter((e) => e.type === "session.create");
    const session = creates.at(-1)!.session as { tools?: unknown[] };
    expect(session.tools).toBeUndefined();
  }, 30_000);
});
