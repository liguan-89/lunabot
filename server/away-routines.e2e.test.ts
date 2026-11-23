import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { launchVerificationServer } from "../scripts/control-lunabot.ts";

// The person being away end to end on a real server (temporary home, fake engine): presence pings stop, routines pause
// themselves except the one that fills the brief, the Chief gets one quiet line, and a return ping frees them.
type Fixture = Awaited<ReturnType<typeof launchVerificationServer>>;

function client(fixture: Fixture) {
  return async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
}

describe("routines pause while the person is away", () => {
  let fixture: Fixture;
  let api: ReturnType<typeof client>;
  let chief: { id: string; threadId: string };

  beforeAll(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fixture = await launchVerificationServer({ ...process.env, LUNABOT_AWAY_ROUTINES_MS: "300", LUNABOT_AWAY_REVIEW_MS: "100" });
    api = client(fixture);
    const bots = (await api("GET", "/api/bots")).bots as any[];
    const found = bots.find((bot) => bot.defaultBot && !bot.defaultBot.person);
    chief = { id: found.id, threadId: found.mainThreadId ?? found.threadId };
  }, 120_000);

  afterAll(async () => {
    await fixture?.close();
    vi.restoreAllMocks();
  });

  const routines = async () => (await api("GET", "/api/routines")).routines as any[];
  const messages = async () => (await api("GET", `/api/threads/${chief.threadId}/messages?limit=200`)).messages as any[];

  it("pauses once pings stop, keeps the briefing watch on, says one line, and comes back on return", async () => {
    const { routine } = await api("POST", "/api/routines", {
      name: "Nightly tidy", prompt: "Tidy up", botId: chief.id, enabled: true,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 60_000 },
    }, 201);
    const { routine: watch } = await api("POST", "/api/routines", {
      name: "Brief watch", prompt: "Sum the day", botId: chief.id, enabled: true, deliver: "brief",
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 60_000 },
    }, 201);
    expect(watch?.enabled).toBe(true);

    await api("POST", "/api/presence/active", { source: "desktop", timeZone: "UTC" });
    await expect.poll(async () => (await routines()).find((candidate) => candidate.id === routine.id)?.enabled, { timeout: 15_000 }).toBe(true);

    await expect.poll(async () => (await routines()).find((candidate) => candidate.id === routine.id)?.heldFor, { timeout: 15_000 }).toBe("person_away");
    expect((await routines()).find((candidate) => candidate.id === routine.id).enabled).toBe(false);
    expect((await routines()).find((candidate) => candidate.id === watch.id)?.enabled).toBe(true);

    const line = (await messages()).find((message) => message.kind === "activity" && String(message.tool?.name ?? "").includes("paused themselves while you were away"));
    expect(line, "the Chief's one quiet line").toBeTruthy();

    await api("POST", "/api/presence/active", { source: "desktop", timeZone: "UTC" });
    await expect.poll(async () => (await routines()).find((candidate) => candidate.id === routine.id)?.enabled, { timeout: 15_000 }).toBe(true);
    expect((await routines()).find((candidate) => candidate.id === routine.id).heldFor).toBeUndefined();
  });
});
