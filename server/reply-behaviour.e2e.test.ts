// The model's steps are scripted through the pi room-plan agent and the real agents tools, so this proves what the
// server does with them, not what a model chooses to say. The memory learner's scripted one-shot text route was removed
// with the Claude/openaiCompat text engine: pi's driver has no one-shot text call, so only the product's own reply
// behaviour is proven here.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLunabot } from "../scripts/control-lunabot.ts";
import { REPLY_HABITS_PROMPT } from "./reply-habits.ts";
import { REMEMBER_AND_FORGET } from "./workspace.ts";

type Step = { tool: string; arguments: Record<string, unknown> };

it("remembers at once, forgets everywhere, and words a routine plainly", async () => {
  const fixture = await launchVerificationServer({ ...process.env, TZ: "Asia/Kolkata" }, undefined, undefined, undefined, undefined, { scripted: true });
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const evidence = () => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const api = async <T = any>(path: string, method = "GET", body?: unknown, status = 200): Promise<T> => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status, `${method} ${path}`).toBe(status);
    return response.json() as Promise<T>;
  };
  const cli = (...args: string[]) => runControlLunabot([...args, "--url", fixture.info.url]) as Promise<any>;
  const turn = async (bot: { id: string; activeTaskId: string }, text: string, steps: Step[], reply: string) => {
    const before = evidence().length;
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { steps, reply } }));
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", text);
    await expect.poll(() => evidence().length, { timeout: 20_000 }).toBe(before + 1);
    await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "20");
    const row = evidence().at(-1);
    return { system: row.system as string, results: (row.evidence as Array<{ step?: Step; response: any }>).filter((entry) => entry.step).map((entry) => String(entry.response?.result?.content?.[0]?.text ?? "")) };
  };
  const notes = async (botId: string) => (await api<{ text: string }>(`/api/bots/${botId}/memory/file?path=MEMORY.md`)).text;
  const aboutMe = async () => String((await api("/api/config")).profile?.aboutMe ?? "");
  try {
    const { bot } = await cli("new-bot", "--name", "Memo");

    // Every bot is told how to talk: the preview and a real turn's prompt both carry it, with the memory habits.
    const preview = await api<{ sections: Array<{ id: string; text: string }> }>(`/api/bots/${bot.id}/system-prompt`);
    expect(preview.sections.find((section) => section.id === "reply-habits")?.text).toBe(REPLY_HABITS_PROMPT);

    // 1. A real turn's instructions carry the reply habits and the memory rules.
    const asked = await turn(bot, "Write a one-page launch plan for an open-source AI agent app, with a 7-day timeline.", [], "Goal: 1,000 stars in week one.");
    expect(asked.system).toContain(REPLY_HABITS_PROMPT);
    expect(asked.system).toContain(REMEMBER_AND_FORGET);

    // 2. "Remember" is saved during the turn, where What it remembers reads.
    const remembered = await turn(bot, "Remember: I prefer short answers and I'm in India (IST).", [
      { tool: "memory_update", arguments: { action: "append", text: "The person prefers short answers" } },
      { tool: "memory_update", arguments: { action: "append", text: "The person is in India (IST)" } },
    ], "Got it: short answers, and times in India time.");
    expect(remembered.results.map((text) => text.slice(0, 15))).toEqual(["Memory updated.", "Memory updated."]);
    const saved = await notes(bot.id);
    expect(saved).toContain("· The person prefers short answers");
    expect(saved).toContain("· The person is in India (IST)");

    // 3. "Forget" removes it from the notes and About me, and the bot is told in plain words. About me carries the same
    // two lines the learner used to add (its one-shot text call went with the Claude/openaiCompat engine).
    await api("/api/config", "PUT", { profile: { aboutMe: "The person prefers short answers\nThe person is in India (IST)" } });
    expect(await aboutMe()).toContain("The person prefers short answers");
    const forgot = await turn(bot, "That was a test. Please forget both of those (short answers and IST).", [
      { tool: "memory_update", arguments: { action: "forget", old_text: "short answers" } },
      { tool: "memory_update", arguments: { action: "forget", old_text: "IST" } },
    ], "Done: I've forgotten both.");
    expect(forgot.results[0]).toBe('Forgotten everywhere it was saved, About me included, which all their bots read: "The person prefers short answers". Confirm to the person in one plain line what you forgot.');
    expect(forgot.results[1]).toContain('"The person is in India (IST)"');
    for (const text of forgot.results) expect(text).not.toMatch(/MEMORY\.md|memory\//);
    expect(await notes(bot.id)).not.toMatch(/short answers|\(IST\)/);
    expect(await aboutMe()).not.toMatch(/short answers|\(IST\)/);
    // What it remembers never shows a note with a date and no words.
    expect((await notes(bot.id)).split("\n").filter((line) => /^- \d{4}-\d{2}-\d{2} · from [^·]* · ?$/.test(line))).toEqual([]);

    // 4. A routine's confirmation names the time as people say it and the first run, never a zone id.
    const routine = await turn(bot, "Every weekday at 9am, send me a 5-bullet AI news brief.", [
      { tool: "create_trigger", arguments: { when: "schedule", name: "Weekday AI news brief", instructions: "Send five bullets of the biggest AI news, each with a source link.", schedule: { type: "weekly", time: "09:00", weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"] } } },
    ], "All set: weekdays at 9:00 AM India time, here in this chat.");
    expect(routine.results[0]).toContain("It applied at once");
    expect(routine.results[0]).toContain("weekdays at 9:00 India time");
    expect(routine.results[0]).not.toMatch(/Asia\/(?:Calcutta|Kolkata)/);
    expect(routine.results[0]).toMatch(/saying the time zone as "India time", never as a zone id; where its results will appear \(here in this chat\); what each run covers; and that the first run is .+ at 9:00 AM India time\.$/);

    // 5. A tap-to-answer question does not hold the chat: typing something else is simply the next message.
    const asking = await turn(bot, "Book a table for 2 tonight at a good Italian place in Bangalore.", [
      { tool: "show_widget", arguments: { widget: { type: "Card", title: "What time works?", caption: "Or just type a time.", children: [{ type: "Row", children: ["7 PM", "8 PM", "9 PM"].map((label) => ({ type: "Button", label, onClickAction: { type: "time", payload: { time: label } } })) }] } } },
    ], "Here are three places with prices for two while you pick a time. Nothing gets booked until you pick a slot.");
    expect(asking.results[0]).toMatch(/^Shown as widget \S+\. Its answer arrives as the person's next message, even while you are still working; if they type something else instead, that is their answer\./);
    const typed = await turn(bot, "Around 8:30 works.", [], "Checking 8:30 at the first place now.");
    expect(typed.results).toEqual([]);
    const messages = (await api(`/api/threads/${bot.activeTaskId}/messages?limit=200`)).messages as Array<{ role: string; text?: string; widget?: { settled?: unknown } }>;
    expect(messages.some((message) => message.role === "bot" && message.text === "Checking 8:30 at the first place now.")).toBe(true);
    // The card stays answerable: a typed reply neither settled nor removed it.
    expect(messages.find((message) => message.widget)?.widget?.settled).toBeUndefined();
  } finally {
    await fixture.close();
  }
}, 240_000);
