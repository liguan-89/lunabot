// The DingTalk channel end to end: a Stream-mode robot callback becomes a person message on a
// mapped task, and the settled turn's reply is POSTed back through the session webhook — no public
// callback needed.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { DINGTALK_ROBOT_TOPIC } from "./dingtalk.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { workerPort } from "./testing/worker-port.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const fake = (name: string) => join(SERVER_DIR, "testing", name);
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("a DingTalk text message reaches the bot and the reply posts back", () => {
  it("works over Stream mode", async () => {
    const sentToWebhook: Array<{ body: { msgtype?: string; text?: { content?: string } }; token: string | null }> = [];
    let platform: WebSocket | null = null;
    const platformFrames: string[] = [];
    const dingtalk: Server = createServer((req, res) => {
      if (req.method !== "POST") { res.writeHead(404).end(); return; }
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        if (req.url === "/v1.0/gateway/connections/open") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            endpoint: `ws://127.0.0.1:${wsPort}/connect`, ticket: "ticket-1",
          }));
          return;
        }
        if (req.url === "/v1.0/oauth2/accessToken") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ accessToken: "d-token", expireIn: 7200 }));
          return;
        }
        if (req.url?.startsWith("/robot/sendBySession")) {
          sentToWebhook.push({ body: JSON.parse(raw), token: req.headers["x-acs-dingtalk-access-token"] as string ?? null });
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ errcode: 0 }));
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => dingtalk.listen(0, "127.0.0.1", resolve));
    const dingtalkPort = (dingtalk.address() as AddressInfo).port;

    const wsPort = workerPort(19300, 5_000);
    const wss = new WebSocketServer({ port: wsPort, host: "127.0.0.1" });
    wss.on("connection", (socket) => {
      platform = socket;
      socket.on("message", (data) => platformFrames.push(String(data)));
    });
    await new Promise<void>((resolve) => wss.on("listening", resolve));

    const port = workerPort(19400, 5_000);
    const base = `http://127.0.0.1:${port}`;
    const home = mkdtempSync(join(tmpdir(), "omb-dingtalk-"));
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
      await new Promise<void>((resolve) => dingtalk.close(() => resolve()));
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
        dingtalk: { appKey: "dinga", appSecret: "secret", botId: created.id, baseUrl: `http://127.0.0.1:${dingtalkPort}` },
      })).status).toBe(200);
      await waitFor(() => platform !== null, "the dingtalk stream connection");

      const deliver = JSON.stringify({
        specVersion: "1.0", type: "CALLBACK",
        headers: { appId: "a1", connectionId: "c1", contentType: "application/json", messageId: "env_1", time: "1700000000000", topic: DINGTALK_ROBOT_TOPIC },
        data: JSON.stringify({
          conversationId: "cid1", conversationType: "2", msgId: "msg1", msgtype: "text",
          text: { content: "@Robot hi from dingtalk" },
          senderId: "u1", senderStaffId: "staff1", senderNick: "小李", chatbotUserId: "robot1",
          sessionWebhook: `http://127.0.0.1:${dingtalkPort}/robot/sendBySession?session=s1`,
          sessionWebhookExpiredTime: Date.now() + 3_600_000, createAt: 1700000000000,
        }),
      });
      platform!.send(deliver);

      await waitFor(() => platformFrames.length > 0, "the envelope ACK");
      expect(JSON.parse(platformFrames[0]!)).toMatchObject({ code: 200, headers: { messageId: "env_1" } });

      await waitFor(() => sentToWebhook.length > 0, "the reply to post to the session webhook");
      expect(sentToWebhook[0]!.token).toBe("d-token");
      expect(sentToWebhook[0]!.body).toMatchObject({ msgtype: "text", text: { content: expect.stringContaining("Hello from pi") } });

      await waitFor(() => existsSync(join(home, ".lunabot", "dingtalk-chats.json")), "the chat mapping to persist");
      const mapping = JSON.parse(readFileSync(join(home, ".lunabot", "dingtalk-chats.json"), "utf8")) as { chats: Record<string, string> };
      expect(Object.keys(mapping.chats)).toEqual(["cid1"]);

      // A replay of the same delivery is deduped by sendId, not turned into a second turn.
      const userLines = async () => {
        const bots = (await api("GET", "/api/bots")).body.bots as Array<{ id: string; messages: Array<{ role: string }> }>;
        return bots.find((b) => b.id === created.id)!.messages.filter((m) => m.role === "user").length;
      };
      const before = await userLines();
      platform!.send(deliver);
      await waitFor(() => platformFrames.length > 1, "the replay ACK");
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(await userLines()).toBe(before);
      expect(sentToWebhook.length).toBe(1);
    } finally {
      await close();
    }
  }, 120_000);
});
