// The approval level a turn runs at is read at each decision, never copied when the turn started (server/host/live-approval.ts).
// Real isolated server with the fake pi: a turn at Ask raises pi's own confirmation card, the person picks a level while that
// turn is still working, the card still waits for them, and the level picked answers the next turn's ask by itself.
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

const MARKER = "Run the fixture write.";

it("applies a level picked while the bot is working to its next tool call, and leaves the person's card to answer", async () => {
  const fixture = await launchVerificationServer({ FAKE_PI_PERMISSION_ON: MARKER });
  const { url } = fixture.info;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { origin: url, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path} ${JSON.stringify(value)}`).toBeLessThan(300);
    return value;
  };
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  /** The turn's open card, once pi has asked. */
  const openCard = async (threadId: string) => {
    let card: any;
    await expect.poll(async () => {
      card = (await messages(threadId)).find((message) => message.card?.requestId && !message.card.answered)?.card;
      return Boolean(card);
    }, { timeout: 20_000, interval: 100 }).toBe(true);
    return card;
  };
  const decisions = async () => (await api("GET", "/api/decisions")).decisions as Array<{ requestId: string; decision: string; source?: string }>;
  try {
    const bot = (await api("POST", "/api/bots", { name: "Level fixture" })).bot as { id: string; threadId: string };
    // Ask, so the first turn's own confirmation waits for the person.
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask", applyToAllThreads: true });
    const first = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Ask first" })).task as { threadId: string };
    await api("POST", `/api/bots/${bot.id}/messages`, { text: MARKER, threadId: first.threadId });
    const card = await openCard(first.threadId);
    expect(card.requestType).toBe("permission");

    // The level changes while the turn is still working: Full access, for this bot's every thread.
    const saved = (await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "full", applyToAllThreads: true })).bot;
    expect(saved.approvalMode).toBe("full");
    // The card already up is the person's to answer: the new level answers the next decision, not this one.
    const still = (await messages(first.threadId)).find((message) => message.card?.requestId === card.requestId)?.card;
    expect(still.answered).toBeUndefined();
    expect((await api("POST", `/api/threads/${first.threadId}/respond`, { requestId: card.requestId, behavior: "deny" })).outcome).toBe("rejected");
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).bots.find((entry: any) => entry.id === bot.id).busy, { timeout: 20_000 }).toBe(false);

    // The next turn's ask is answered by Full access itself: no card, and the decision log says so.
    const second = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Full next" })).task as { threadId: string };
    const since = (await decisions()).length;
    await api("POST", `/api/bots/${bot.id}/messages`, { text: MARKER, threadId: second.threadId });
    await expect.poll(async () => (await decisions()).slice(since).some((row) => row.decision === "auto-approved" && row.source === "full-access"),
      { timeout: 20_000, interval: 100 }).toBe(true);
    expect((await messages(second.threadId)).some((message) => message.card?.requestId), "no card at Full access").toBe(false);
    expect((await messages(first.threadId)).some((message) => message.card?.requestId && message.card.answered === "unavailable")).toBe(false);
  } finally {
    await fixture.close();
  }
}, 90_000);
