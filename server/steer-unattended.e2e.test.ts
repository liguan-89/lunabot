// The fake pi CLI in `slow` mode holds the turn behind a gate; a steer carrying the marker raises the turn's
// own permission ask after it lands — what the broker socket once took mid-turn for the retired engine. POSIX-gated.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = join(SERVER_DIR, "testing", "fake-pi-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");

// A steer whose text carries this marker makes the fixture raise the permission ask once it lands.
const STEER_ASK = "permission please";

let child: ChildProcess;
let home = "";
let base = "";
let stderr = "";
let finishGate = "";
let model = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const getBot = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: { id: string }) => b.id === id);
const threadMessages = async (threadId: string): Promise<Array<{ kind: string; card?: { requestId?: string; answered?: string } }>> =>
  (await api("GET", `/api/threads/${threadId}/messages`)).body.messages ?? [];

/** The turn's own permission ask lands as a card on its conversation; `answered()` is whether anything already replied. */
function ask(threadId: string, requestId: string): { answered: () => Promise<boolean> } {
  return {
    answered: async () =>
      (await threadMessages(threadId)).find((m) => m.card?.requestId === requestId)?.card?.answered !== undefined,
  };
}

posixOnly("a steered message does not lift the unattended mark on its own", () => {
  beforeAll(async () => {
    chmodSync(FAKE_PI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-steer-unattended-"));
    const data = join(home, ".lunabot");
    mkdirSync(data, { recursive: true });
    finishGate = join(home, "finish.gate");
    writeFileSync(join(data, "config.json"), JSON.stringify({
      instances: {
        pi: {
          driver: "piAgent",
          // The webhook turn holds behind the gate; the steered line carries the marker its ask waits on.
          environment: {
            FAKE_PI_MODE: "slow", FAKE_PI_SLOW_FINISH_GATE: finishGate, FAKE_PI_PERMISSION_ON_STEER: STEER_ASK,
            FAKE_PI_PROMPTS: join(home, "prompts.jsonl"),
          },
          config: { cli: FAKE_PI },
        },
      },
    }));
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(port),
        OMB_WEBHOOK_PORT: String(port + 1),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    for (;;) {
      const state = await (await fetch(`${base}/api/instances`)).json() as any;
      const found = (state.instances ?? []).find((instance: { instanceId: string; models?: { default?: string } }) => instance.instanceId === "pi");
      if (found?.models?.default) {
        model = found.models.default;
        break;
      }
      if (Date.now() > deadline) throw new Error(`the pi instance never reported a default model: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 40_000);

  afterAll(async () => {
    writeFileSync(finishGate, "finish");
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("keeps asking after the turn POSTs into itself with no session", async () => {
    const bot = (await api("GET", "/api/bots?messages=0")).body.bots[0];
    // auto mode ON: an attended turn would sail straight through
    expect((await api("PATCH", `/api/bots/${bot.id}`, {
      autoApprove: true,
      modelSelection: { instanceId: "pi", model },
    })).status).toBe(200);
    const hook = await api("POST", "/api/webhooks", {
      name: "Nightly build",
      prompt: "Handle the incoming build event",
      botId: bot.id,
      runOn: "maus",
    });
    expect(hook.status).toBe(201);
    const delivered = await fetch(hook.body.credential.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "failed" }),
    });
    expect(delivered.status).toBe(202);
    const { runId } = (await delivered.json()) as { runId: string };

    // A webhook run works in a conversation of its own, out of the way: the turn names it when it POSTs into itself.
    let runThreadId = "";
    await expect.poll(async () => {
      const run = ((await api("GET", "/api/routines")).body.runs ?? []).find((r: { id: string }) => r.id === runId);
      runThreadId = run?.threadId ?? "";
      return Boolean(runThreadId);
    }, { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await getBot(bot.id))?.busy === true && (await getBot(bot.id))?.threadId !== runThreadId, {
      timeout: 20_000,
    }).toBe(true);
    // busy flips at dispatch, before the driver owns the turn: a steer sent now would refuse into the queue. Only a
    // prompt the fake took proves the driver's live entry — the broker socket's existence did the same waiting before.
    const prompts = join(home, "prompts.jsonl");
    await expect.poll(() => existsSync(prompts) && readFileSync(prompts, "utf8").trim().length > 0, { timeout: 20_000 }).toBe(true);

    try {
      const steer = await api("POST", `/api/bots/${bot.id}/messages`, { text: `continue — ${STEER_ASK}`, threadId: runThreadId });
      expect(steer.status).toBe(202);
      expect(steer.body.steered).toBe(true);

      const second = ask(runThreadId, "ask-steer");
      await expect.poll(
        async () => (await threadMessages(runThreadId)).some((m) => m.kind === "options" && m.card?.requestId === "ask-steer"),
        { timeout: 20_000 },
      ).toBe(true);
      const card = (await threadMessages(runThreadId)).find((m) => m.card?.requestId === "ask-steer");
      expect(card?.card?.answered, "the steered turn auto-approved — the self-POST lifted the unattended mark").toBeUndefined();
      expect(await second.answered()).toBe(false);
    } finally {
      writeFileSync(finishGate, "finish");
      await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
    }
  }, 60_000);
});
