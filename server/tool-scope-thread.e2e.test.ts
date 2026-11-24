// A scoped worker thread end to end: start_thread's tool_scope lands on the
// task record and stays there, so the job's turns run with only those tools.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { runControlLunabot } from "../scripts/control-lunabot.ts";
import { launchRestartableServer } from "./testing/restartable-server.ts";

it("opens a self thread with a narrowed tool selection that persists", async () => {
  const server = await launchRestartableServer({ engine: "pi", scripted: true });
  const tasksOnDisk = (botId: string) =>
    (JSON.parse(readFileSync(join(server.dataDir, "bots.json"), "utf8")) as Array<{ id: string; tasks?: Array<{ threadId: string; title?: string; toolScope?: unknown }> }>)
      .find((bot) => bot.id === botId)?.tasks ?? [];
  try {
    const { bot } = await runControlLunabot(["new-bot", "--name", "Delegator", "--url", server.url]) as { bot: { id: string } };
    writeFileSync(join(server.dataDir, "room-plan.json"), JSON.stringify({
      [bot.id]: { turns: [
        { steps: [{ tool: "start_thread", arguments: { title: "Explore the logs", message: "Read the logs and summarize.", tool_scope: { deny: ["native:bash", "mcp:agents:*"] } } }], reply: "Opened an explore job." },
      ] },
    }));
    await runControlLunabot(["send", "--bot", bot.id, "--text", "Delegate a read-only pass over the logs.", "--url", server.url]);
    const waited = await runControlLunabot(["wait", "--bot", bot.id, "--timeout", "30", "--url", server.url]) as { state?: string };
    expect(waited.state).toBe("completed");
    await expect.poll(async () => tasksOnDisk(bot.id).some((task) => task.title === "Explore the logs"), { timeout: 30_000 }).toBe(true);
    expect(tasksOnDisk(bot.id).find((task) => task.title === "Explore the logs")?.toolScope).toEqual({ deny: ["native:bash", "mcp:agents:*"] });
  } finally {
    await server.close();
  }
}, 120_000);
