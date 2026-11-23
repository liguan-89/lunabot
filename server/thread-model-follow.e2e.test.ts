// A thread saved on an engine this build no longer has runs on its bot's model instead, and the thread follows it.
// The old per-engine matrix and its two signed-out cases are gone with those engines: the product fleet is the single
// pi instance, which can be neither disabled nor signed out, so there is no second engine for a thread to fall back to
// and none whose sign-in failure could still be kept. What remains is the product's own fallback: a thread whose saved
// engine is unknown gives way to the bot's model with a notice, once per turn, and the thread then follows the bot.
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLunabot } from "../scripts/control-lunabot.ts";
import { piDumpPath, piTurnsForThread } from "./testing/pi-dump.ts";

async function withPi(check: (fixture: Fixture) => Promise<void>) {
  const fixture = await launchVerificationServer();
  const { dataDir, url } = fixture.info;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const control = (...args: string[]) => runControlLunabot([...args, "--url", url]) as Promise<any>;
  try {
    const instances = ((await api("GET", "/api/instances")) as { instances: Array<{ instanceId: string; displayName: string;
      models: { default: string; options: Array<{ id: string; label: string }> } }> }).instances;
    const pi = instances.find((instance) => instance.instanceId === "pi")!;
    expect(pi, "the fixture runs one pi instance").toBeTruthy();
    const label = pi.models.options.find((option) => option.id === pi.models.default)?.label ?? pi.models.default;
    const promptCount = (threadId: string) => piTurnsForThread(piDumpPath(dataDir), threadId)
      .filter((turn) => turn.prompt.includes("FOLLOW")).length;
    await check({ api, control, promptCount, botModel: { instanceId: "pi", model: pi.models.default }, botModelName: `Verification pi · ${label}` });
  } finally {
    await fixture.close();
  }
}

type Fixture = {
  api: (method: string, path: string, body?: unknown) => Promise<any>;
  control: (...args: string[]) => Promise<any>;
  promptCount: (threadId: string) => number;
  botModel: { instanceId: string; model: string };
  botModelName: string;
};

const notice = (message: any) => typeof message.tool?.name === "string" && message.tool.name.includes("isn't available, so it now uses");

async function botWithOwnModel(fixture: Fixture, own: { instanceId: string; model: string }) {
  const { bot: created } = await fixture.control("new-bot", "--name", "Ada");
  const { task } = await fixture.api("POST", `/api/bots/${created.id}/tasks`, { title: "Own model" });
  await fixture.api("PATCH", `/api/bots/${created.id}/tasks/${task.threadId}`, { modelSelection: own });
  const profile = async () => (await fixture.api("GET", "/api/bots")).bots.find((entry: any) => entry.id === created.id);
  const thread = async () => (await profile()).tasks.find((entry: any) => entry.threadId === task.threadId);
  expect(await thread()).toMatchObject({ modelSelection: own, followsBotModel: false });
  return { bot: await profile(), threadId: task.threadId as string, thread };
}

async function sendAndSettle(fixture: Fixture, botId: string, threadId: string, text: string) {
  await fixture.control("send", "--bot", botId, "--task", threadId, "--text", text);
  expect((await fixture.control("wait", "--bot", botId, "--task", threadId, "--timeout", "30")).status).toBe("settled");
  return (await fixture.api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
}

it("runs a thread whose engine is gone on its bot's model, once per turn, and the thread follows the bot", async () => {
  await withPi(async (fixture) => {
    // A thread saved on an engine this build deleted: the instance is unknown, so its model gives way.
    const { bot, threadId, thread } = await botWithOwnModel(fixture, { instanceId: "spare", model: "claude-opus-5" });
    const messages = await sendAndSettle(fixture, bot.id, threadId, "FOLLOW_THE_BOT_4K");
    expect(fixture.promptCount(threadId)).toBe(1);
    expect(messages.filter(notice)).toHaveLength(1);
    expect(messages.find(notice).tool.name).toBe(
      `notice: This thread's model (claude-opus-5) isn't available, so it now uses Ada's model (${fixture.botModelName}).`,
    );
    expect(messages.findLast((message) => message.role === "bot" && message.kind === "text")).toMatchObject({ turnSucceeded: true });
    expect(bot.modelSelection).toEqual(fixture.botModel);
    expect(await thread()).toMatchObject({ modelSelection: bot.modelSelection, followsBotModel: true });
    const again = await sendAndSettle(fixture, bot.id, threadId, "STILL_FOLLOWING_5L");
    expect(again.filter(notice)).toHaveLength(1);
    expect(fixture.promptCount(threadId)).toBe(2);
  });
}, 120_000);
