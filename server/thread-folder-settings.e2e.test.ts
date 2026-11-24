import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLunabot } from "../scripts/control-lunabot.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { piDumpPath, piTurns } from "./testing/pi-dump.ts";

it("runs every thread of a bot in a folder of its own, and moves its threads to the working folder it is given", async () => {
  // pi loads no Claude Code settings or hooks, so the `.claude/settings.json` this recipe used to write (and the Stop hook
  // it ran) has nothing to assert here: what remains is the folder each turn runs in and what a moved conversation keeps.
  const fixture = await launchVerificationServer();
  const dumpPath = piDumpPath(fixture.info.dataDir);
  const project = realpathSync(mkdtempSync(join(tmpdir(), "omb-thread-settings-project-")));
  const chosen = realpathSync(mkdtempSync(join(tmpdir(), "omb-thread-settings-chosen-")));
  const control = (args: string[]) => runControlLunabot([...args, "--url", fixture.info.url]) as Promise<any>;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  /** The turn that carried `text`: the folder its child ran in, and the prompt it was given. */
  const turn = async (botId: string, threadId: string, text: string) => {
    const since = piTurns(dumpPath).length;
    await control(["send", "--bot", botId, "--task", threadId, "--text", text]);
    expect((await control(["wait", "--bot", botId, "--task", threadId, "--timeout", "30"])).status).toBe("settled");
    const turns = piTurns(dumpPath);
    const index = turns.findIndex((candidate, at) => at >= since && candidate.prompt.includes(text));
    expect(index, `no pi turn carried "${text}"`).toBeGreaterThanOrEqual(0);
    return { cwd: turns[index]!.launch?.cwd as string, prompt: turns[index]!.prompt };
  };
  try {
    const { bot } = await api("POST", "/api/bots", { name: "Guarded helper" });
    const ownFolder = (threadId: string) => realpathSync(join(fixture.info.dataDir, "task-workspaces", bot.id, threadId));

    const first = await turn(bot.id, bot.threadId, "Remember the fixture code MOSS-42.");
    expect(realpathSync(first.cwd)).toBe(ownFolder(bot.threadId));
    const { task: sibling } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Sibling" });
    const second = await turn(bot.id, sibling.threadId, "Say hello.");
    expect(realpathSync(second.cwd)).toBe(ownFolder(sibling.threadId));

    // The bot's working folder is where its threads move, and the conversation keeps its history across the move.
    await api("PATCH", `/api/bots/${bot.id}`, { cwd: project });
    const moved = await turn(bot.id, bot.threadId, "What was the fixture code?");
    expect(realpathSync(moved.cwd)).toBe(project);
    expect(moved.prompt).toContain("MOSS-42");
    const tasks = (await api("GET", "/api/bots?messages=0")).bots.find((item: any) => item.id === bot.id).tasks;
    expect(tasks.find((task: any) => task.threadId === bot.threadId).cwd).toBe(project);
    expect(tasks.find((task: any) => task.threadId === sibling.threadId).cwd).toBe(join(fixture.info.dataDir, "task-workspaces", bot.id, sibling.threadId));

    // A thread given a folder of its own keeps it.
    const { task: picked } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Chosen folder", cwd: chosen });
    const kept = await turn(bot.id, picked.threadId, "Say hello from the chosen folder.");
    expect(realpathSync(kept.cwd)).toBe(chosen);

    // A room without a folder of its own runs its members in their own bot folders.
    const { group } = await api("POST", "/api/groups", { name: "Guarded room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
    const since = piTurns(dumpPath).length;
    await control(["send-channel", "--channel", group.id, "--text", "Say hello to the room."]);
    expect((await control(["wait", "--channel", group.id, "--timeout", "30"])).status).toBe("settled");
    const room = piTurns(dumpPath).find((_turn, at) => at >= since)!;
    expect(realpathSync(room.launch?.cwd as string)).toBe(realpathSync(join(fixture.info.dataDir, "workspaces", bot.id)));
  } finally {
    await fixture.close();
    await removeTempDir(project);
    await removeTempDir(chosen);
  }
}, 90_000);
