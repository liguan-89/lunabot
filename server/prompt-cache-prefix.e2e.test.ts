// Providers cache a prompt from its start: tools, then the system prompt. Anything in there that differs between two threads
// of one bot makes each new thread write the rest again at the cache-write rate.
// The fake pi sends a session's whole instructions on its first turn and, afterwards, only what changed, so the shared
// head is what two threads must have in common and each thread's own folder rides in its own turn.
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLunabot } from "../scripts/control-lunabot.ts";
import { piDumpPath, piInstructionsFor, piTurns } from "./testing/pi-dump.ts";

const FILE_LOCATIONS = "File locations for this bot (absolute paths): ";

it("sends two threads of one bot the same stable instructions, each with its own folder in its own turn", async () => {
  const fixture = await launchVerificationServer();
  const dumpPath = piDumpPath(fixture.info.dataDir);
  const control = (args: string[]) => runControlLunabot([...args, "--url", fixture.info.url]) as Promise<any>;
  const api = async (method: string, path: string, body: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.ok).toBe(true);
    return await response.json() as any;
  };
  /** The turn that carried `text`: the instructions in effect on it, the prompt it was given, and the child that ran it. */
  const turn = async (botId: string, threadId: string, text: string) => {
    const since = piTurns(dumpPath).length;
    await control(["send", "--bot", botId, "--task", threadId, "--text", text]);
    expect((await control(["wait", "--bot", botId, "--task", threadId, "--timeout", "30"])).status).toBe("settled");
    const turns = piTurns(dumpPath);
    const index = turns.findIndex((candidate, at) => at >= since && candidate.prompt.includes(text));
    expect(index, `no pi turn carried "${text}"`).toBeGreaterThanOrEqual(0);
    return { instructions: piInstructionsFor(turns, index), prompt: turns[index]!.prompt, pid: turns[index]!.launch?.pid };
  };
  // The stable head: everything before the per-thread file locations, which pi keeps in its volatile half.
  const head = (instructions: string) => instructions.slice(0, instructions.indexOf(FILE_LOCATIONS));
  const folder = (botId: string, threadId: string) => join(fixture.info.dataDir, "task-workspaces", botId, threadId);
  try {
    const { bot } = await api("POST", "/api/bots", { name: "Garden helper" });
    const { task: second } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Second", select: false });
    const first = await turn(bot.id, bot.threadId, "hi");
    const other = await turn(bot.id, second.threadId, "hi");
    expect(head(first.instructions)).toContain("You are Garden helper");
    expect(head(other.instructions)).toBe(head(first.instructions));
    // Each thread is told its own folder, JSON-encoded as the prompt quotes a path (Windows' backslashes come doubled).
    expect(first.instructions).toContain(JSON.stringify(folder(bot.id, bot.threadId)));
    expect(other.instructions).toContain(JSON.stringify(folder(bot.id, second.threadId)));
    expect(other.instructions).not.toContain(JSON.stringify(folder(bot.id, bot.threadId)));
    // pi re-sends nothing while a conversation's instructions hold: the thread's next turn is its own words alone, on the
    // same child, so the provider's cached prefix stays byte-identical.
    const again = await turn(bot.id, bot.threadId, "hi again");
    expect(again.prompt).not.toContain("You are Garden helper");
    expect(again.pid).toBe(first.pid);
  } finally {
    await fixture.close();
  }
}, 120_000);
