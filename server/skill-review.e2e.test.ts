import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLunabot } from "../scripts/control-lunabot.ts";
import type { WireBot, WireMessage } from "../shared/wire.ts";

// pi has no one-off text call and no other engine is connected, so the review a full counter earns
// is refused and the steps stay counted — the run and its guards are still exercised end to end.
it("counts a pi turn's tool steps toward the review, then refuses it for want of a text call", async () => {
  const fixture = await launchVerificationServer({ ...process.env, FAKE_PI_MODE: "tooluse" });
  const { url } = fixture.info;
  const api = async <T = any>(path: string, method = "GET", body?: unknown, status = 200): Promise<T> => {
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status, `${method} ${path}`).toBe(status);
    return response.json() as Promise<T>;
  };
  const turn = async (bot: WireBot, text: string) => {
    await runControlLunabot(["send", "--bot", bot.id, "--task", bot.threadId, "--text", text, "--url", url]);
    expect(await runControlLunabot(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "30", "--url", url])).toMatchObject({ status: "settled" });
  };
  const messages = async (bot: WireBot) =>
    ((await api<{ bots: Array<WireBot & { messages: WireMessage[] }> }>("/api/bots")).bots.find((candidate) => candidate.id === bot.id)?.messages ?? []);
  const counters = () => JSON.parse(readFileSync(join(fixture.info.dataDir, "skill-review.json"), "utf8")).counters;
  try {
    const config = await api("/api/config", "PATCH", { features: { skillReview: true, skillReviewSteps: 3 } });
    expect(config.features).toMatchObject({ skillAuthoring: true, skillReview: true, skillReviewSteps: 3 });
    const { bot } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Reporter" }, 201);

    // One scripted tool call a turn: three reaches the threshold.
    await turn(bot, "Write the weekly report from the notes.");
    expect(counters()).toEqual([expect.objectContaining({ botId: bot.id, threadId: bot.threadId, steps: 1 })]);
    await turn(bot, "Shorter please, five bullets at most.");
    expect(counters()).toEqual([expect.objectContaining({ botId: bot.id, threadId: bot.threadId, steps: 2 })]);
    expect((await messages(bot)).some((message) => message.card?.skillRequest)).toBe(false);

    await turn(bot, "One more pass over the notes.");
    await expect.poll(async () => readFileSync(fixture.info.logPath, "utf8")
      .includes(`skill review: ${bot.id}: this bot's engine cannot run a background review`), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => counters()[0]?.failures, { timeout: 10_000 }).toBe(1);
    expect(counters()).toEqual([expect.objectContaining({ botId: bot.id, threadId: bot.threadId, steps: 3, failures: 1 })]);
    expect((await messages(bot)).some((message) => message.card?.skillRequest)).toBe(false);
    await api(`/api/bots/${bot.id}/skills/weekly-report`, "GET", undefined, 404);
  } finally {
    await fixture.close();
  }
}, 90_000);
