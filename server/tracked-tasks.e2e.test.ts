// The task-list path end to end: a scripted agents call to tracked_tasks lands
// on the bot's wire record for the person to see.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { runControlLunabot } from "../scripts/control-lunabot.ts";
import { launchRestartableServer } from "./testing/restartable-server.ts";

it("lets a bot keep a task list the person can see", async () => {
  const server = await launchRestartableServer({ engine: "pi", scripted: true });
  const trackedItems = async (botId: string) => {
    const response = await fetch(`${server.url}/api/bots`);
    const body = await response.json() as { bots: Array<{ id: string; trackedItems?: Array<{ title: string; state: string; note?: string }> }> };
    return body.bots.find((bot) => bot.id === botId)?.trackedItems ?? [];
  };
  try {
    const { bot } = await runControlLunabot(["new-bot", "--name", "Tracker", "--url", server.url]) as { bot: { id: string } };
    writeFileSync(join(server.dataDir, "room-plan.json"), JSON.stringify({
      [bot.id]: { turns: [
        { steps: [{ tool: "tracked_tasks", arguments: { action: "create", title: "Check overnight invoices", note: "waiting on finance" } }], reply: "On it." },
      ] },
    }));
    await runControlLunabot(["send", "--bot", bot.id, "--text", "Keep track of the invoices.", "--url", server.url]);
    const waited = await runControlLunabot(["wait", "--bot", bot.id, "--timeout", "30", "--url", server.url]) as { state?: string };
    expect(waited.state).toBe("completed");
    await expect.poll(async () => (await trackedItems(bot.id)).some((item) => item.title === "Check overnight invoices"), { timeout: 30_000 }).toBe(true);
    expect(await trackedItems(bot.id)).toMatchObject([{ title: "Check overnight invoices", state: "open", note: "waiting on finance" }]);
  } finally {
    await server.close();
  }
}, 120_000);
