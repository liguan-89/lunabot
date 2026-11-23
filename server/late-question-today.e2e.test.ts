// pi asks the person through its own dialog, which holds the turn open: a person who does not answer and stops the turn
// leaves the question on Today, and answering it later wakes the bot with that answer as a new line.
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLunabot } from "../scripts/control-lunabot.ts";

const QUESTION = "Ask me which file to update";

it("keeps a question nobody answered on Today after its turn ends, and a late answer wakes the bot and clears it", async () => {
  const fixture = await launchVerificationServer({ ...process.env, FAKE_PI_QUESTION_ON: QUESTION });
  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const cli = (...args: string[]) => runControlLunabot(args, { env: { LUNABOT_URL: fixture.info.url } }) as Promise<any>;
  console.log(`late-question Today fixture: ${fixture.info.logPath}`);
  try {
    const bot = (await cli("new-bot", "--name", "Asker")).bot;
    const threadId = (await api("GET", "/api/bots?messages=0")).body.bots.find((candidate: any) => candidate.id === bot.id).threadId as string;
    const messages = async () => (await api("GET", `/api/threads/${threadId}/messages`)).body.messages as any[];
    const busy = async () => Boolean((await api("GET", "/api/bots?messages=0")).body.bots.find((candidate: any) => candidate.id === bot.id)?.busy);
    const questions = async () => (await api("GET", `/api/today?since=${Date.now() - 60_000}`)).body.needsYou
      .filter((item: any) => item.kind === "question");

    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: QUESTION })).status).toBeLessThan(300);
    await expect.poll(busy, { timeout: 15_000 }).toBe(true);
    // The fake pi's own dialog: a select question with two answers, which the harness turns into a question card.
    await expect.poll(async () => (await messages()).find((message) => message.card?.requestType === "question" && !message.card.answered),
      { timeout: 15_000 }).toBeTruthy();
    const question = (await messages()).find((message) => message.card?.requestType === "question" && !message.card.answered)!;
    expect(question.card.options).toEqual(["Blue", "Green"]);

    // The person stops the turn without answering: the card stays, and the question is still theirs to answer.
    expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId })).status).toBeLessThan(300);
    await expect.poll(busy, { timeout: 10_000 }).toBe(false);
    await expect.poll(async () => (await messages()).some((message) => message.kind === "digest" && message.at > question.at),
      { timeout: 10_000 }).toBe(true);
    expect((await messages()).find((message) => message.id === question.id)?.card.answered).toBeUndefined();
    expect(await questions()).toEqual([expect.objectContaining({ id: question.id, threadId, botId: bot.id, text: "Which colour?" })]);

    const answer = await api("POST", `/api/threads/${threadId}/respond`, { requestId: question.card.requestId, behavior: "answer", message: "Blue" });
    expect(answer, JSON.stringify(answer.body)).toMatchObject({ status: 200, body: { ok: true, outcome: "answered", late: true } });
    await expect.poll(async () => (await messages()).filter((message) => message.kind === "digest").length, { timeout: 10_000 }).toBe(2);
    const after = await messages();
    expect(after).toContainEqual(expect.objectContaining({ role: "user", kind: "text", text: "Blue", replyToId: question.id }));
    expect(after.find((message) => message.id === question.id)?.card).toMatchObject({ answered: "answer", answeredText: "Blue" });
    expect(await questions()).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 60_000);
