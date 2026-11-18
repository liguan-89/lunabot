// A Team Cloud confines what comes in from outside. A thread that work opens must not start free of that: on a bot at Full
// access it would run with every tool and no approval.
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchCloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { piTurns } from "./testing/pi-dump.ts";

it("a confined webhook turn can't open a thread that runs unconfined; a person's own turn still can", async () => {
  const dump = join(tmpdir(), `outside-work-${randomBytes(6).toString("hex")}.jsonl`);
  const fx = await launchCloudSendFixture({
    onePasswordToken: `ops_fake-${randomBytes(8).toString("hex")}`,
    team: { id: "team-acme-1", name: "Acme", engine: `process.env.FAKE_CLAUDE_MODE = "hang"; process.env.FAKE_PI_DUMP = ${JSON.stringify(dump)};` },
  });
  try {
    const team = fx.team!;
    const ada = (await team.pair({ email: "ada@acme.test", role: "admin" })).token!;
    const bot = (await team.as(ada, "POST", "/api/bots", { name: "Scout" })).body.bot as { id: string; threadId: string };
    expect((await team.as(ada, "PATCH", `/api/bots/${bot.id}`, { approvalMode: "full", applyToAllThreads: true })).status).toBe(200);
    const hook = (await team.as(ada, "POST", "/api/webhooks", { name: "Inbox", prompt: "Handle the event.", botId: bot.id })).body;
    // Every turn this fixture's pi processes were given, and the launch each ran on: the log is a JSONL of both.
    const turns = () => piTurns(dump);
    const reached = (marker: string) => expect.poll(() => turns().some((turn) => turn.prompt.includes(marker)), { timeout: hostTimeout(30_000) }).toBe(true);
    const receiver = team.base.replace(/:(\d+)$/, (_: string, port: string) => `:${Number(port) + 1}`);
    const delivered = await fetch(`${receiver}/hooks/${hook.webhook.endpointId}/${encodeURIComponent(hook.credential.secret)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "webhook-marker" }) });
    expect(delivered.status).toBe(202);
    await reached("webhook-marker");
    // pi has no `--restricted` argv: the confined turn's scope denies every native tool, so the child gets no shell,
    // no file reads anywhere, and only what the harness-MCP gate lets through.
    const confined = turns().find((turn) => turn.prompt.includes("webhook-marker"))!;
    expect((confined.launch?.mcpConfig?.toolScope as { deny?: string[] } | undefined)?.deny).toContain("native:*");

    const runs = (await team.as(ada, "GET", "/api/routines")).body.runs as Array<{ webhookId?: string; threadId: string }>;
    const thread = runs.find((run) => run.webhookId === hook.webhook.id)!.threadId;
    const open = async (from: string, message: string) => fetch(`${team.base}/api/internal/threads?fromBotId=${bot.id}`, {
      method: "POST", headers: { authorization: `Bearer ${await team.capability(bot.id, from)}`, "content-type": "application/json" },
      body: JSON.stringify({ fromBotId: bot.id, fromThreadId: from, title: "Own thread", message }),
    });
    const tasks = async () => ((await team.as(ada, "GET", "/api/bots")).body.bots as Array<{ id: string; tasks: unknown[] }>).find((one) => one.id === bot.id)!.tasks.length;
    const before = await tasks();
    const refused = await open(thread, "started-from-outside");
    expect(refused.status).toBe(403);
    expect(await tasks()).toBe(before);
    expect(turns().some((turn) => turn.prompt.includes("started-from-outside"))).toBe(false);

    const allowed = await open(bot.threadId, "started-by-a-person");
    expect(allowed.status).toBe(201);
    await reached("started-by-a-person");
  } finally {
    await fx.close?.();
  }
}, hostTimeout(180_000));
