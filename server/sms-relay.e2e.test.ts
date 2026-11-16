// The SMS relay end to end: a paired phone pushes an inbound text, it becomes a person message on a
// mapped task, and the settled turn's reply reaches the phone as a PHONE_REPLY_SMS job it answers —
// the way the Android phone app would drive it.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { workerPort } from "./testing/worker-port.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("a text a paired phone receives reaches the bot and the reply comes back as a phone job", () => {
  it("works over the phone events endpoint", async () => {
    const port = workerPort(19450, 5_000);
    const base = `http://127.0.0.1:${port}`;
    const home = mkdtempSync(join(tmpdir(), "omb-sms-relay-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({
      features: { smartSetupChoices: false },
      instances: { pi: { driver: "piAgent", config: { cli: join(SERVER_DIR, "testing", "fake-pi-cli.ts"), fullAuto: true } } },
    }));
    let stderr = "";
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(port) };
    if (process.env.PATH) env.PATH = process.env.PATH;
    const child: ChildProcess = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], { cwd: join(SERVER_DIR, ".."), env, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr!.on("data", (chunk) => { stderr += chunk; });

    const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    const waitFor = async (predicate: () => Promise<boolean> | boolean, what: string, ms = 60_000) => {
      const deadline = Date.now() + ms;
      while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    };

    try {
      await waitFor(async () => {
        if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
        try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
      }, "the server to come up");

      const created = (await api("POST", "/api/bots")).body.bot as { id: string };
      expect((await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "pi", model: "fake-model" } })).status).toBe(200);
      expect((await api("PATCH", "/api/config", { sms: { botId: created.id } })).status).toBe(200);

      // Pair the way the phone app does, then register with Messages allowed.
      const opened = await api("POST", "/api/auth/pairing", { scopes: ["client", "admin"] }, { origin: base });
      expect(opened.status).toBe(200);
      const paired = await api("POST", "/api/auth/pair", { code: opened.body.code }, { origin: base });
      expect(paired.status).toBe(200);
      const phone = { authorization: `Bearer ${paired.body.token as string}`, origin: base };
      const registered = await api("PUT", "/api/phones/self", {
        installId: "install-sms", name: "Relay Android", platform: "android", appVersion: "1.5.0", timeZone: "Asia/Shanghai",
        capabilities: { messages: "full" },
      }, phone);
      expect(registered.status).toBe(200);
      const phoneKey = registered.body.phone.key as string;
      expect(phoneKey.startsWith("session:")).toBe(true);

      // The phone forwards an inbound text; the reply must arrive on the job poll it already uses.
      const polled = api("GET", "/api/phones/self/jobs", undefined, phone);
      const pushed = await api("POST", "/api/phones/self/events",
        { kind: "sms", sendId: "sms-1", from: "+8613800138000", text: "帮我看下明天上海的天气" }, phone);
      expect(pushed.status).toBe(202);

      const job = (await polled).body.job as { id: string; tool: string; arguments: { to?: string; text?: string } };
      expect(job.tool).toBe("PHONE_REPLY_SMS");
      expect(job.arguments.to).toBe("8613800138000");
      expect(job.arguments.text).toContain("Hello from pi");
      expect((await api("POST", `/api/phones/self/jobs/${job.id}/result`, { ok: true, result: { sent: true } }, phone)).body).toEqual({ ok: true });

      await waitFor(() => existsSync(join(home, ".lunabot", "sms-chats.json")), "the chat mapping to persist");
      const mapping = JSON.parse(readFileSync(join(home, ".lunabot", "sms-chats.json"), "utf8")) as { chats: Record<string, string> };
      expect(Object.keys(mapping.chats)).toEqual([`${phoneKey}|8613800138000`]);

      // The inbound line belongs to the sms sender; a phone-side retry of the same sms is deduped.
      const userLines = async () => {
        const bots = (await api("GET", "/api/bots")).body.bots as Array<{ id: string; messages: Array<{ role: string; sender?: { id?: string } }> }>;
        return bots.find((b) => b.id === created.id)!.messages.filter((m) => m.role === "user");
      };
      await waitFor(async () => (await userLines()).length === 1, "the sms person line");
      expect((await userLines())[0]!.sender?.id).toBe(`sms:${phoneKey}|8613800138000`);
      expect((await api("POST", "/api/phones/self/events",
        { kind: "sms", sendId: "sms-1", from: "+8613800138000", text: "帮我看下明天上海的天气" }, phone)).status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect((await userLines()).length).toBe(1);
    } finally {
      await waitForExit(child, { signal: "SIGTERM" });
      await removeTempDir(home);
    }
  }, 120_000);
});
