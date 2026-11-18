import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { piDumpPath, piInstructionsFor, piTurns } from "./testing/pi-dump.ts";

it("keeps ordinary work out of setup and carries explicit bot defaults and file locations into rooms", async () => {
  const fixture = await launchVerificationServer();
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const dumpPath = piDumpPath(fixture.info.dataDir);
  const control = async (args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  const api = async (method: string, path: string, body?: unknown, status?: number) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    evidence.push({ method, path, body, status: response.status });
    if (status) expect(response.status, JSON.stringify(result)).toBe(status);
    else expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  /** The model a pi child is running: pi switches it over its RPC, and the dump records that under the child's pid, so a
   * warm child that keeps its model is not told again and its last switch still stands. */
  const modelOf = (pid: number | undefined): string | undefined => {
    let launch: number | undefined;
    let model: string | undefined;
    for (const line of readFileSync(dumpPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let row: { pid?: number; argv?: unknown; setModel?: { provider?: string; modelId?: string } };
      try { row = JSON.parse(line); } catch { continue; }
      if (row.argv) launch = row.pid;
      else if (row.setModel?.provider && row.setModel.modelId && launch === pid) model = `${row.setModel.provider}/${row.setModel.modelId}`;
    }
    return model;
  };
  /** What the turn that carried `marker` was told: pi's instructions for it, its own words, and the model the child that
   * ran it held. */
  const receipt = (marker: string, since: number) => {
    const turns = piTurns(dumpPath);
    const index = turns.findIndex((turn, at) => at >= since && turn.prompt.includes(marker));
    expect(index, `no pi turn carried "${marker}"`).toBeGreaterThanOrEqual(0);
    const result = {
      model: modelOf(turns[index]!.launch?.pid),
      system: piInstructionsFor(turns, index),
      prompt: turns[index]!.prompt,
    };
    evidence.push({ receipt: result });
    return result;
  };
  const turnsSeen = () => piTurns(dumpPath).length;
  try {
    const catalog = await control(["models"]);
    const pi = catalog.instances.find((item: any) => item.instanceId === "pi");
    // The catalog's "default" row is the picker's own entry, not a model pi can be switched to.
    const [a, b] = pi.models.options.map((item: any) => item.id).filter((id: string) => id.includes("/"));
    const selection = (model: string) => ({ instanceId: "pi", model });
    const { bot } = await api("POST", "/api/bots", { name: "Garden helper", title: "Gardener", modelSelection: selection(a) });
    const direct = async (marker: string, sent = marker) => {
      const since = turnsSeen();
      await control(["send", "--bot", bot.id, "--task", bot.threadId, "--text", sent]);
      expect((await control(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "30"])).status).toBe("settled");
      return receipt(marker, since);
    };
    const ordinary = await direct("What is 17 + 25? Answer with the number.");
    expect(ordinary.system).not.toContain("at most four questions");
    expect(ordinary.system).not.toContain("The user explicitly asked you to set yourself up");
    const oldFile = join(fixture.info.dataDir, "workspaces", bot.id, "garden-plan.txt");
    writeFileSync(oldFile, "Water the garden on Friday. Fixture code: MOSS-42.\n");
    // The prompt JSON-encodes paths, including Windows backslashes.
    expect(ordinary.system).toContain(JSON.stringify(join(fixture.info.dataDir, "workspaces", bot.id)));
    expect(ordinary.system).toContain(JSON.stringify(join(fixture.info.dataDir, "task-workspaces", bot.id, bot.threadId)));

    // The app's own setup turn rewrites the slash command into its request; the prompt carries that request's words.
    const setup = await direct("Set yourself up for this job: Help me track garden watering", "/setup Help me track garden watering");
    expect(setup.system).toContain("The user explicitly asked you to set yourself up");
    expect(setup.system).toContain("at most four questions");
    const afterSetup = await direct("Never mind setup. Summarize: the garden needs water Friday.");
    expect(afterSetup.system).not.toContain("at most four questions");
    expect(afterSetup.prompt).toContain("Never mind setup");

    await api("PATCH", `/api/bots/${bot.id}`, { soul: "You look after the garden. Keep its watering plan.", description: "Garden helper" });
    const { task: sibling } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Sibling follows the bot" });
    // Change an inactive task, not the newly selected sibling.
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { modelSelection: selection(b), updateBotDefault: true });
    expect((await direct("Tell me your responsibility in one sentence.")).model).toBe(b);
    const { group } = await api("POST", "/api/groups", {
      name: "Garden room", memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    });
    const room = async (marker: string) => {
      const since = turnsSeen();
      await control(["send-channel", "--channel", group.id, "--text", marker]);
      expect((await control(["wait", "--channel", group.id, "--timeout", "30"])).status).toBe("settled");
      return receipt(marker, since);
    };
    const shared = await room("Read the garden-plan.txt you made earlier and tell me its fixture code.");
    expect(shared.model).toBe(b);
    expect(shared.system).toContain("You look after the garden");
    expect(shared.system).toContain(JSON.stringify(join(fixture.info.dataDir, "task-workspaces", bot.id)));
    expect(shared.system).toContain(JSON.stringify(join(fixture.info.dataDir, "workspaces", bot.id)));
    // The room's turn worked in the bot's folders without moving or losing what was already there.
    expect(readFileSync(oldFile, "utf8")).toContain("MOSS-42");
    const state = (await api("GET", "/api/bots")).bots.find((item: any) => item.id === bot.id);
    expect(state.modelSelection).toEqual(selection(b));
    expect(state.tasks.find((task: any) => task.threadId === sibling.threadId)).toMatchObject({ modelSelection: selection(b), followsBotModel: true });
    const { task: future } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Future uses default" });
    expect(future.modelSelection).toEqual(selection(b));

    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { modelSelection: selection(a) });
    expect((await direct("Reply once for the thread-only model test.")).model).toBe(a);
    expect((await room("Reply once for the unchanged room default.")).model).toBe(b);
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { updateBotDefault: true }, 400);
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { modelSelection: selection(a), updateBotDefault: "yes" }, 400);
    await api("PATCH", `/api/bots/${bot.id}/tasks/not-a-thread`, { modelSelection: selection(a), updateBotDefault: true }, 404);
    await control(["messages", "--bot", bot.id, "--task", bot.threadId, "--limit", "20"]);
    await control(["messages", "--channel", group.id, "--limit", "20"]);
  } finally {
    const evidencePath = `${fixture.info.logPath}.bot-continuity.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ evidencePath }));
    await fixture.close();
  }
}, 90_000);
