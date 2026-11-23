// The pi fixture's own turn: the real server, the real PiDriver and the fake pi
// RPC CLI in a disposable home. This is the replacement path for the retired
// Claude/Codex fixtures; new end-to-end recipes should grow from here.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { runControlLunabot } from "../scripts/control-lunabot.ts";
import { launchRestartableServer } from "./testing/restartable-server.ts";

it("answers a chat turn through the real server and the fake pi RPC CLI", async () => {
  const server = await launchRestartableServer({ engine: "pi" });
  try {
    const { bot } = await runControlLunabot(["new-bot", "--name", "Pi fixture", "--url", server.url]) as { bot: { id: string } };
    await runControlLunabot(["send", "--bot", bot.id, "--text", "Say hello", "--url", server.url]);
    const waited = await runControlLunabot(["wait", "--bot", bot.id, "--timeout", "30", "--url", server.url]) as { state?: string };
    expect(waited.state).toBe("completed");
    const { messages } = await runControlLunabot(["messages", "--bot", bot.id, "--limit", "10", "--url", server.url]) as { messages: Array<{ role: string; kind: string; text?: string }> };
    expect(messages.some((message) => message.role === "bot" && message.kind === "text" && message.text === "Hello from pi")).toBe(true);
  } finally {
    await server.close();
  }
}, 120_000);

it("runs a scripted room plan through the real agents proxy", async () => {
  const server = await launchRestartableServer({ engine: "pi", scripted: true });
  const tasks = async (botId: string) => {
    const response = await fetch(`${server.url}/api/bots`);
    const body = await response.json() as { bots: Array<{ id: string; tasks: Array<{ threadId: string; title: string }> }> };
    return body.bots.find((bot) => bot.id === botId)?.tasks ?? [];
  };
  const said = async (threadId: string) => {
    const response = await fetch(`${server.url}/api/threads/${threadId}/messages?limit=50`);
    return (await response.json() as { messages: Array<{ role: string; kind: string; text?: string }> }).messages;
  };
  try {
    const { bot } = await runControlLunabot(["new-bot", "--name", "Planner", "--url", server.url]) as { bot: { id: string } };
    writeFileSync(join(server.dataDir, "room-plan.json"), JSON.stringify({
      [bot.id]: { turns: [
        { steps: [{ tool: "start_thread", arguments: { title: "Side job", message: "Check the side job." } }], reply: "Opened a side job." },
        { reply: "Side job checked." },
      ] },
    }));
    await runControlLunabot(["send", "--bot", bot.id, "--text", "Open a side job.", "--url", server.url]);
    await expect.poll(async () => (await tasks(bot.id)).some((task) => task.title === "Side job"), { timeout: 30_000 }).toBe(true);
    const side = (await tasks(bot.id)).find((task) => task.title === "Side job")!;
    await expect.poll(async () => (await said(side.threadId)).some((message) => message.role === "bot" && message.text === "Side job checked."), { timeout: 30_000 }).toBe(true);
    const main = (await tasks(bot.id)).find((task) => task.title !== "Side job");
    if (main) expect((await said(main.threadId)).some((message) => message.text === "Opened a side job.")).toBe(true);
  } finally {
    await server.close();
  }
}, 120_000);