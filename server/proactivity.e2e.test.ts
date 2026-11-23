// The proactivity path end to end: a scripted agents call to proactivity sets
// the level in config.json, where every later turn reads it.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { runControlLunabot } from "../scripts/control-lunabot.ts";
import { launchRestartableServer } from "./testing/restartable-server.ts";

it("lets a bot set the person's proactivity level", async () => {
  const server = await launchRestartableServer({ engine: "pi", scripted: true });
  const proactivity = () => (JSON.parse(readFileSync(join(server.dataDir, "config.json"), "utf8")) as { proactivity?: string }).proactivity;
  try {
    const { bot } = await runControlLunabot(["new-bot", "--name", "Tone", "--url", server.url]) as { bot: { id: string } };
    writeFileSync(join(server.dataDir, "room-plan.json"), JSON.stringify({
      [bot.id]: { turns: [
        { steps: [{ tool: "proactivity", arguments: { level: "quiet" } }], reply: "Went quiet." },
      ] },
    }));
    await runControlLunabot(["send", "--bot", bot.id, "--text", "Do not ping me.", "--url", server.url]);
    const waited = await runControlLunabot(["wait", "--bot", bot.id, "--timeout", "30", "--url", server.url]) as { state?: string };
    expect(waited.state).toBe("completed");
    await expect.poll(proactivity, { timeout: 30_000 }).toBe("quiet");
  } finally {
    await server.close();
  }
}, 120_000);
