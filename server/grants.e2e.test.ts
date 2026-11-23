// The temporary-grant path end to end: a scripted agents call to propose_grant posts the person's
// confirm card; answering it writes the live grant into config.json, where every later approval reads it.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { runControlLunabot } from "../scripts/control-lunabot.ts";
import { launchRestartableServer } from "./testing/restartable-server.ts";

it("lets a bot propose a temporary grant the person confirms into config.json", async () => {
  const server = await launchRestartableServer({ engine: "pi", scripted: true });
  const grants = () => (JSON.parse(readFileSync(join(server.dataDir, "config.json"), "utf8")) as { decisions?: { grants?: unknown[] } }).decisions?.grants;
  try {
    const { bot } = await runControlLunabot(["new-bot", "--name", "Scout", "--url", server.url]) as { bot: { id: string } };
    writeFileSync(join(server.dataDir, "room-plan.json"), JSON.stringify({
      [bot.id]: { turns: [
        { steps: [{ tool: "propose_grant", arguments: { text: "billing mails may be sent", hours: 4 } }], reply: "The card is up." },
      ] },
    }));
    const sent = await runControlLunabot(["send", "--bot", bot.id, "--text", "Stop asking me about billing mails today.", "--url", server.url]) as { taskId?: string };
    const threadId = sent.taskId!;
    const waited = await runControlLunabot(["wait", "--bot", bot.id, "--timeout", "30", "--url", server.url]) as { state?: string };
    expect(waited.state).toBe("completed");

    const raw = await fetch(`${server.url}/api/threads/${threadId}/messages?limit=50`);
    const { messages } = await raw.json() as
      { messages: Array<{ id: string; grantProposal?: { id: string; text: string; expiresAt: number; answer?: string } }> };
    const proposal = messages.find((message) => message.grantProposal);
    expect(proposal?.grantProposal?.text).toBe("billing mails may be sent");
    expect(proposal?.grantProposal?.answer).toBeUndefined();
    expect(grants() ?? []).toEqual([]);

    const answered = await fetch(`${server.url}/api/grants/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId, messageId: proposal!.id, answer: "granted" }),
    });
    expect(answered.status).toBe(200);
    await expect.poll(() => grants()?.length ?? 0, { timeout: 30_000 }).toBe(1);
    expect((grants() as Array<{ text: string }>)[0]?.text).toBe("billing mails may be sent");
  } finally {
    await server.close();
  }
}, 120_000);
