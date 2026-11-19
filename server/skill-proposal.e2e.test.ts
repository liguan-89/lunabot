// The skill proposal end to end: a turn settles, the helper gate says the work is reusable, the review
// prompt drafts a skill, and the person gets an unanswered confirm card — never a silent write.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SKILL_REVIEW_MARKER } from "./skill-review.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { workerPort } from "./testing/worker-port.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const fake = (name: string) => join(SERVER_DIR, "testing", name);
const posixOnly = describe.skipIf(process.platform === "win32");

const SKILL_MD = "---\nname: weekly-report\ndescription: Writes the weekly status report.\n---\n\n# Weekly report\n\nWrites the weekly status report from the project notes.\n\n## When to Use\n- \"write the weekly report\"\n\n## Procedure\n1. Read notes/status.md.\n2. Keep it to five bullets.\n\n## Pitfalls\n- Ask which week when the notes span two.\n\n## Verification\n- The report has at most five bullets.\n";
const SKILL_DRAFT = JSON.stringify({ changes: [{ action: "create", skill_md: SKILL_MD, gist: "Five-bullet weekly report." }] });

interface Msg {
  role: string;
  kind: string;
  text?: string;
  card?: { title?: string; options?: string[]; answered?: string; autoApplied?: boolean; skillRequest?: { name: string; requestId: string } };
}

posixOnly("a turn the helper judges reusable ends in an unanswered skill card", () => {
  it("proposes, and writes nothing until the person taps Enable", async () => {
    /* One loopback plays both small models: requests carrying a json_schema are the decider (a confident
     * yes to every question); a plain prompt is the helper's one-off text call (the review draft). */
    const deciderRequests: unknown[] = [];
    let helperPrompts = 0;
    const llm: Server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "vendor/model" }] }));
        return;
      }
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        let jsonSchema = false;
        let ids = ["answer"];
        try {
          const parsed = JSON.parse(raw) as {
            response_format?: { json_schema?: { schema?: { properties?: { answers?: { properties?: Record<string, unknown> } } } } };
            messages?: Array<{ content?: string }>;
          };
          jsonSchema = parsed.response_format?.json_schema !== undefined;
          const properties = parsed.response_format?.json_schema?.schema?.properties?.answers?.properties;
          if (properties && Object.keys(properties).length) ids = Object.keys(properties);
          if (!jsonSchema && !parsed.messages?.some((message) => message.content?.includes(SKILL_REVIEW_MARKER))) {
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
              model: "vendor/model",
              choices: [{ message: { role: "assistant", content: "{}" } }],
            }));
            return;
          }
        } catch {}
        const content = jsonSchema
          ? JSON.stringify({ answers: Object.fromEntries(ids.map((id) => [id, { type: "noul", noul: 0.95 }])) })
          : SKILL_DRAFT;
        if (jsonSchema) deciderRequests.push(req.url);
        else helperPrompts += 1;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          model: "vendor/model",
          choices: [{ message: { role: "assistant", content } }],
        }));
      });
    });
    await new Promise<void>((resolve) => llm.listen(0, "127.0.0.1", resolve));
    const llmPort = (llm.address() as AddressInfo).port;

    const port = workerPort(18900, 10_000);
    const base = `http://127.0.0.1:${port}`;
    const home = mkdtempSync(join(tmpdir(), "omb-skill-proposal-"));
    mkdirSync(join(home, ".lunabot"), { recursive: true });
    writeFileSync(join(home, ".lunabot", "config.json"), JSON.stringify({
      features: { smartSetupChoices: false },
      decider: {
        enabled: true, provider: "openrouter", openrouterApi: "chat",
        openrouterKey: "fixture", openrouterModel: "vendor/model",
        openrouterBaseUrl: `http://127.0.0.1:${llmPort}/v1`,
      },
      instances: {
        pi: { driver: "piAgent", config: { cli: fake("fake-pi-cli.ts"), fullAuto: true } },
      },
    }));
    let stderr = "";
    let stdout = "";
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(port) };
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
      await new Promise<void>((resolve) => llm.close(() => resolve()));
      await removeTempDir(home);
    };

    try {
      await waitFor(async () => {
        if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
        try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
      }, "the server to come up");

      const created = (await api("POST", "/api/bots")).body.bot as { id: string };
      expect((await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "pi", model: "fake-model" } })).status).toBe(200);
      const getBot = async () => (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === created.id) as { busy: boolean; messages: Msg[] };

      expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "Write the weekly report from the notes." })).status).toBe(202);
      await waitFor(async () => {
        const bot = await getBot();
        return !bot.busy && bot.messages.some((message) => message.role === "bot" && message.kind === "text");
      }, "the turn to settle");

      await waitFor(() => deciderRequests.length > 0, "the helper gate to ask the decider");
      await waitFor(() => helperPrompts > 0, "the decision model to draft the skill");
      let card: Msg["card"] | undefined;
      await waitFor(async () => {
        card = (await getBot()).messages.find((message) => message.card?.skillRequest)?.card;
        return card !== undefined;
      }, "the proposal card");

      expect(card).toMatchObject({ options: ["Enable", "Deny"], skillRequest: { name: "weekly-report", requestId: expect.any(String) } });
      expect(card?.answered).toBeUndefined();
      expect(card?.autoApplied).toBeUndefined();

      // A proposal never writes: the skill lands only after the person taps Enable.
      expect((await api("GET", `/api/bots/${created.id}/skills/weekly-report`)).status).toBe(404);
    } finally {
      await close();
    }
  }, 120_000);
});
