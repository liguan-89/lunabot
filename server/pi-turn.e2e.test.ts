// The pi fixture's own turn: the real server, the real PiDriver and the fake pi
// RPC CLI in a disposable home. This is the replacement path for the retired
// Claude/Codex fixtures; new end-to-end recipes should grow from here.
import { expect, it } from "vitest";

import { runControlOmb } from "../scripts/control-omb.ts";
import { launchRestartableServer } from "./testing/restartable-server.ts";

it("answers a chat turn through the real server and the fake pi RPC CLI", async () => {
  const server = await launchRestartableServer({ engine: "pi" });
  try {
    const { bot } = await runControlOmb(["new-bot", "--name", "Pi fixture", "--url", server.url]) as { bot: { id: string } };
    await runControlOmb(["send", "--bot", bot.id, "--text", "Say hello", "--url", server.url]);
    const waited = await runControlOmb(["wait", "--bot", bot.id, "--timeout", "30", "--url", server.url]) as { state?: string };
    expect(waited.state).toBe("completed");
    const { messages } = await runControlOmb(["messages", "--bot", bot.id, "--limit", "10", "--url", server.url]) as { messages: Array<{ role: string; kind: string; text?: string }> };
    expect(messages.some((message) => message.role === "bot" && message.kind === "text" && message.text === "Hello from pi")).toBe(true);
  } finally {
    await server.close();
  }
});