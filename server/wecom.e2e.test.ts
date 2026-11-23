// The WeCom channel end to end: an encrypted receiving-message callback becomes a person message on
// a mapped task, and the settled turn's reply is POSTed back through the message/send API. Unlike the
// Feishu/DingTalk long connections, the callback is a public route — its URL signature is the auth.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { encrypt, WECOM_CALLBACK_PATH } from "./wecom.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { workerPort } from "./testing/worker-port.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const fake = (name: string) => join(SERVER_DIR, "testing", name);
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("a WeCom text message reaches the bot and the reply posts back", () => {
  it("works over the receiving-message callback", async () => {
    const KEY = randomBytes(32).toString("base64").slice(0, 43);
    const TOKEN = "tok-e2e";
    const sentToApi: Array<{ url: string; body: Record<string, unknown> }> = [];
    const qyapi: Server = createServer((req, res) => {
      if (req.url?.startsWith("/cgi-bin/gettoken")) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "w-token", expires_in: 7200 }));
        return;
      }
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        sentToApi.push({ url: req.url ?? "", body: JSON.parse(raw || "{}") });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ errcode: 0 }));
      });
    });
    await new Promise<void>((resolve) => qyapi.listen(0, "127.0.0.1", resolve));
    const qyapiPort = (qyapi.address() as AddressInfo).port;

    const port = workerPort(19500, 5_000);
    const base = `http://127.0.0.1:${port}`;
    const home = mkdtempSync(join(tmpdir(), "omb-wecom-"));
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

    const sign = (encrypted: string) =>
      createHash("sha1").update([TOKEN, "1700", "n1", encrypted].sort().join("")).digest("hex");
    const callback = (encrypted: string, extra = "") =>
      `${base}${WECOM_CALLBACK_PATH}?msg_signature=${sign(encrypted)}&timestamp=1700&nonce=n1${extra}`;
    const postBody = () => {
      const inner = `<xml><ToUserName><![CDATA[ww1]]></ToUserName><FromUserName><![CDATA[ZhangSan]]></FromUserName><CreateTime>1700</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hi from wecom]]></Content><MsgId><![CDATA[msg_1]]></MsgId><AgentID><![CDATA[1000002]]></AgentID></xml>`;
      const packed = encrypt(KEY, inner, "ww1");
      return { packed, body: `<xml><ToUserName><![CDATA[ww1]]></ToUserName><Encrypt><![CDATA[${packed}]]></Encrypt><AgentID><![CDATA[1000002]]></AgentID></xml>` };
    };
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
      await new Promise<void>((resolve) => qyapi.close(() => resolve()));
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
        wecom: { corpId: "ww1", corpSecret: "s3cr3t", token: TOKEN, encodingAesKey: KEY, agentId: "1000002", botId: created.id, baseUrl: `http://127.0.0.1:${qyapiPort}` },
      })).status).toBe(200);

      // URL verification: the platform GETs an encrypted echostr and expects it back decrypted.
      const echo = encrypt(KEY, "verify-me", "ww1");
      const verify = await fetch(callback(echo, `&echostr=${encodeURIComponent(echo)}`));
      expect(verify.status).toBe(200);
      expect(await verify.text()).toBe("verify-me");

      const { packed, body } = postBody();
      const posted = await fetch(callback(packed), { method: "POST", headers: { "content-type": "text/xml" }, body });
      expect(posted.status).toBe(200);
      expect(await posted.text()).toBe("success");

      await waitFor(() => sentToApi.some((p) => p.url.includes("/cgi-bin/message/send")), "the reply to post to message/send");
      const send = sentToApi.find((p) => p.url.includes("/cgi-bin/message/send"))!;
      expect(send.url).toContain("access_token=w-token");
      expect(send.body).toMatchObject({ touser: "ZhangSan", agentid: "1000002", msgtype: "text", text: { content: expect.stringContaining("Hello from pi") } });

      await waitFor(() => existsSync(join(home, ".lunabot", "wecom-chats.json")), "the chat mapping to persist");
      const mapping = JSON.parse(readFileSync(join(home, ".lunabot", "wecom-chats.json"), "utf8")) as { chats: Record<string, string> };
      expect(Object.keys(mapping.chats)).toEqual(["u:ZhangSan"]);

      // A replay of the same delivery is deduped by sendId, not turned into a second turn.
      const userLines = async () => {
        const bots = (await api("GET", "/api/bots")).body.bots as Array<{ id: string; messages: Array<{ role: string }> }>;
        return bots.find((b) => b.id === created.id)!.messages.filter((m) => m.role === "user").length;
      };
      const before = await userLines();
      const replay = await fetch(callback(packed), { method: "POST", headers: { "content-type": "text/xml" }, body });
      expect(await replay.text()).toBe("success");
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(await userLines()).toBe(before);
      expect(sentToApi.filter((p) => p.url.includes("/cgi-bin/message/send"))).toHaveLength(1);
    } finally {
      await close();
    }
  }, 120_000);
});
