// The Feishu channel end to end: a pbbp2 event on the long connection becomes a person message on a
// mapped task, and the settled turn's reply is POSTed back to the chat — no public callback needed.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { decodeFrame, encodeFrame } from "./feishu.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { workerPort } from "./testing/worker-port.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const fake = (name: string) => join(SERVER_DIR, "testing", name);
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("a Feishu text message reaches the bot and the reply posts back", () => {
  it("works over the long connection", async () => {
    const sentToChat: Array<{ receive_id?: string; content?: string }> = [];
    let platform: WebSocket | null = null;
    const platformFrames: Buffer[] = [];
    const feishu: Server = createServer((req, res) => {
      if (req.method !== "POST") { res.writeHead(404).end(); return; }
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        if (req.url === "/callback/ws/endpoint") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            code: 0, data: { URL: `ws://127.0.0.1:${wsPort}/`, ClientConfig: { PingInterval: 30 } },
          }));
          return;
        }
        if (req.url === "/open-apis/auth/v3/tenant_access_token/internal") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ code: 0, tenant_access_token: "t-token", expire: 7200 }));
          return;
        }
        if (req.url?.startsWith("/open-apis/im/v1/messages")) {
          sentToChat.push(JSON.parse(raw) as { receive_id?: string; content?: string });
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ code: 0, data: {} }));
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => feishu.listen(0, "127.0.0.1", resolve));
    const feishuPort = (feishu.address() as AddressInfo).port;

    const wsPort = workerPort(19100, 5_000);
    const wss = new WebSocketServer({ port: wsPort, host: "127.0.0.1" });
    wss.on("connection", (socket) => {
      platform = socket;
      socket.on("message", (data) => platformFrames.push(data as Buffer));
    });
    await new Promise<void>((resolve) => wss.on("listening", resolve));

    const port = workerPort(19200, 5_000);
    const base = `http://127.0.0.1:${port}`;
    const home = mkdtempSync(join(tmpdir(), "omb-feishu-"));
    mkdirSync(join(home, ".lunabot"), { recursive: true });
    writeFileSync(join(home, ".lunabot", "config.json"), JSON.stringify({
      features: { smartSetupChoices: false },
      instances: { pi: { driver: "piAgent", config: { cli: fake("fake-pi-cli.ts"), fullAuto: true } } },
    }));
    let stderr = "";
    let stdout = "";
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, LUNABOT_PORT: String(port) };
    if (process.env.PATH) env.PATH = process.env.PATH;
    const child: ChildProcess = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], { cwd: join(SERVER_DIR, ".."), env, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    child.stdout!.on("data", (chunk) => { stdout += chunk; });

    const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    const waitFor = async (predicate: () => Promise<boolean> | boolean, what: string, ms = 60_000) => {
      const deadline = Date.now() + ms;
      while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}\nstdout: ${stdout.slice(-3000)}`);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    };
    const close = async () => {
      await waitForExit(child, { signal: "SIGTERM" });
      await new Promise<void>((resolve) => feishu.close(() => resolve()));
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await removeTempDir(home);
    };

    try {
      await waitFor(async () => {
        if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
        try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
      }, "the server to come up");

      const created = (await api("POST", "/api/bots")).body.bot as { id: string };
      expect((await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "pi", model: "fake-model" } })).status).toBe(200);
      expect((await api("PATCH", "/api/config", {
        feishu: { appId: "cli_a", appSecret: "secret", botId: created.id, baseUrl: `http://127.0.0.1:${feishuPort}` },
      })).status).toBe(200);
      await waitFor(() => platform !== null, "the feishu long connection");

      const inbound = JSON.stringify({
        schema: "2.0",
        header: { event_id: "evt_1", event_type: "im.message.receive_v1" },
        event: {
          sender: { sender_id: { open_id: "ou_person" } },
          message: { message_id: "om_1", chat_id: "oc_1", message_type: "text", content: JSON.stringify({ text: "hi from feishu" }) },
        },
      });
      platform!.send(encodeFrame({ seqId: 1, logId: 1, service: 0, method: 1, headers: [], payload: Buffer.from(inbound, "utf8") }));

      await waitFor(() => platformFrames.length > 0, "the event ACK");
      const ack = decodeFrame(platformFrames[0]!);
      expect(JSON.parse(ack.payload!.toString("utf8"))).toMatchObject({ code: 200 });

      await waitFor(() => sentToChat.length > 0, "the reply to post back to the chat");
      expect(sentToChat[0]).toMatchObject({ receive_id: "oc_1", msg_type: "text" });
      expect(JSON.parse(sentToChat[0]!.content!) as { text?: string }).toMatchObject({ text: expect.stringContaining("Hello from pi") });

      // The chat maps to a task so a later message in the same chat continues it. The seeded
      // .lunabot dir is renamed to .dexbot at startup (legacy data-dir migration).
      await waitFor(() => existsSync(join(home, ".lunabot", "feishu-chats.json")), "the chat mapping to persist");
      const mapping = JSON.parse(readFileSync(join(home, ".lunabot", "feishu-chats.json"), "utf8")) as { chats: Record<string, string> };
      expect(Object.keys(mapping.chats)).toEqual(["oc_1"]);

      // A replay of the same delivery is deduped by sendId, not turned into a second turn.
      const userLines = async () => {
        const bots = (await api("GET", "/api/bots")).body.bots as Array<{ id: string; messages: Array<{ role: string }> }>;
        return bots.find((b) => b.id === created.id)!.messages.filter((m) => m.role === "user").length;
      };
      const before = await userLines();
      platform!.send(encodeFrame({ seqId: 2, logId: 2, service: 0, method: 1, headers: [], payload: Buffer.from(inbound, "utf8") }));
      await waitFor(() => platformFrames.length > 1, "the replay ACK");
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(await userLines()).toBe(before);
      expect(sentToChat.length).toBe(1);
    } finally {
      await close();
    }
  }, 120_000);
});
