// The read side of memory (recall, the prompt preview, tidy's model-free parts) against the real server. pi's driver has
// no one-shot text call, so the model steps memory upkeep used to script (capture, organize, contradictions) never run:
// this recipe proves the recall plumbing and what upkeep does without them, and that a turn's own memory_update tool —
// the one way anything reaches memory now — still writes through the real agents proxy.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { WireBot } from "../shared/wire.ts";
import { NO_TEXT_ENGINE } from "./memory-upkeep.ts";
import { piDumpPath, piTurns } from "./testing/pi-dump.ts";

it("recalls, previews and tidies a bot's memory, and says why the model steps never run", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-memory-layer-"));
  const calls = join(scratch, "tool-calls.json");
  // FAKE_PI_CLAUDE_COMPAT routes the fake's turns through the scripted-calls bridge, which is how a turn runs the calls
  // a recipe writes into FAKE_PI_TOOL_CALLS_FILE; FAKE_PI_MOUNT_TOOLS mounts the turn's own agents proxy so one reaches it.
  const fixture = await launchVerificationServer({ ...process.env, FAKE_PI_CLAUDE_COMPAT: "1", FAKE_PI_MOUNT_TOOLS: "1", FAKE_PI_TOOL_CALLS_FILE: calls });
  const control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
  const api = async <T = any>(path: string, method = "GET", body?: unknown, status = 200): Promise<T> => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status, `${method} ${path}`).toBe(status);
    return response.json() as Promise<T>;
  };
  const dumpPath = piDumpPath(fixture.info.dataDir);
  const turn = async (botId: string, threadId: string, text: string) => {
    await control("send", "--bot", botId, "--task", threadId, "--text", text);
    expect(await control("wait", "--bot", botId, "--task", threadId, "--timeout", "30")).toMatchObject({ status: "settled" });
  };
  /** Every prompt the pi turns were given since `count`, as one text: recall rides in front of a turn's own words. */
  const sentSince = (count: number) => piTurns(dumpPath).slice(count).map((entry) => entry.prompt).join("\n");
  const sentCount = () => piTurns(dumpPath).length;
  const memoryFile = async (botId: string, path = "MEMORY.md") => (await api<{ text: string; hash: string }>(`/api/bots/${botId}/memory/file?path=${encodeURIComponent(path)}`));
  try {
    const { bot } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Memo" }, 201);
    await api("/api/config", "PUT", { memory: { captureQuietMs: 1_000 } });
    // upkeep is on for a new bot; switched off here so the read side is tested alone
    expect(await api(`/api/bots/${bot.id}/memory/upkeep`)).toMatchObject({ enabled: true });
    await api(`/api/bots/${bot.id}`, "PATCH", { memoryUpkeep: false });

    // A routine's run is never captured, and pi has no background call to capture with in any case: a person's own turn
    // is what proves the call was reached, and it stops at the engine check and says why.
    const { bot: scheduled } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Scheduled memory" }, 201);
    const { routine } = await api("/api/routines", "POST", {
      name: "Automated report", prompt: "Report the work status.", botId: scheduled.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    }, 201);
    const { run } = await api(`/api/routines/${routine.id}/run`, "POST", undefined, 201);
    await expect.poll(async () => (await api("/api/routines")).runs.find((entry: any) => entry.id === run.id)?.status,
      { timeout: 20_000 }).toBe("completed");
    await turn(scheduled.id, scheduled.threadId, "Just so you know, I'm vegetarian and I have exams this weekend.");
    await expect.poll(async () => (await api(`/api/bots/${scheduled.id}/memory/upkeep`)).lastCapture?.note ?? null,
      { timeout: 20_000 }).toBe(NO_TEXT_ENGINE);
    expect((await memoryFile(scheduled.id)).text).not.toContain("The person is vegetarian");
    expect((await api("/api/profile/learned")).learned).toEqual([]);

    await api(`/api/bots/${bot.id}/memory/file`, "PUT", { path: "memory/dining.md", text: "---\ntitle: Dining\naliases: [food, restaurants, lunch]\n---\n- Loves pasta, hates olives\n" });
    const preview = JSON.stringify(await api(`/api/bots/${bot.id}/system-prompt`));
    expect(preview).toContain("memory/dining.md — Dining (also: food, restaurants, lunch)");
    let before = sentCount();
    await turn(bot.id, bot.threadId, "Can you suggest some restaurants for Friday?");
    expect(sentSince(before)).toContain("Recalled for this message");
    expect(sentSince(before)).toContain("Loves pasta, hates olives");

    await turn(bot.id, bot.threadId, "Note for later: the project codename is Bluebird.");
    const created = await api<any>(`/api/bots/${bot.id}/tasks`, "POST", { title: "New chat" }, 201);
    const second: string = created.task?.threadId ?? created.threadId;
    before = sentCount();
    await turn(bot.id, second, "What was the project codename again?");
    expect(sentSince(before)).toContain("Bluebird");
    expect(sentSince(before)).toMatch(/your main chat|chat "[^"]+"/);

    await api(`/api/bots/${bot.id}/memory/file`, "PUT", { path: "memory/home.md", text: "- 净水器的滤芯每六个月更换一次，上次是五月初换的。\n" });
    before = sentCount();
    await turn(bot.id, second, "滤芯多久要换一次？");
    expect(sentSince(before)).toContain("滤芯每六个月更换一次");
    await turn(bot.id, bot.threadId, "备忘：周三下午三点去社区图书馆还书。");
    before = sentCount();
    await turn(bot.id, second, "借的书哪天去图书馆还？");
    expect(sentSince(before)).toContain("社区图书馆还书");

    await api(`/api/bots/${bot.id}`, "PATCH", { memoryEnabled: false });
    before = sentCount();
    await turn(bot.id, second, "Can you suggest some restaurants for Friday?");
    expect(sentSince(before)).not.toContain("Recalled for this message");
    expect(JSON.stringify(await api(`/api/bots/${bot.id}/system-prompt`))).not.toContain("memory/dining.md");
    await api(`/api/bots/${bot.id}`, "PATCH", { memoryEnabled: true });

    const index = await memoryFile(bot.id);
    await api(`/api/bots/${bot.id}/memory/file`, "PUT", {
      path: "MEMORY.md",
      text: `${index.text}\n- 2026-01-01 · Dentist appointment on Monday · until 2026-01-05\n- 2026-01-01 · Prefers short replies\n`,
      expectedHash: index.hash,
    });
    const withExpired = JSON.stringify(await api(`/api/bots/${bot.id}/system-prompt`));
    expect(withExpired).not.toContain("Dentist appointment on Monday");
    expect(withExpired).toContain("Prefers short replies");

    // A turn's own memory_update is how a fact reaches memory now: it goes through the real agents proxy.
    writeFileSync(calls, JSON.stringify([
      { name: "memory_update", server: "agents", input: { action: "append", text: "The person is vegetarian" } },
    ]));
    await turn(bot.id, bot.threadId, "Just so you know, I'm vegetarian.");
    expect((await memoryFile(bot.id)).text).toContain("The person is vegetarian");

    // With upkeep off, the tidy route refuses.
    await api(`/api/bots/${bot.id}/memory/tidy`, "POST", undefined, 409);

    // Tidy without a model still expires and archives notes, and says the contradiction check had no engine to ask.
    await api(`/api/bots/${bot.id}`, "PATCH", { memoryUpkeep: true });
    const { report } = await api<{ report: { expired: number; superseded: number; contradictionsChecked: boolean; note?: string } }>(`/api/bots/${bot.id}/memory/tidy`, "POST");
    expect(report).toMatchObject({ expired: 1, superseded: 0, contradictionsChecked: false });
    expect(report.note).toBe(NO_TEXT_ENGINE);
    const tidied = (await memoryFile(bot.id)).text;
    expect(tidied).not.toContain("Dentist appointment");
    expect(tidied).toContain("Prefers short replies");
    expect((await memoryFile(bot.id, "memory/archive.md")).text).toContain("Dentist appointment on Monday · until 2026-01-05 · expired");
    const status = await api(`/api/bots/${bot.id}/memory/upkeep`);
    expect(status).toMatchObject({ enabled: true, modelSteps: false, lastTidy: { expired: 1, superseded: 0 } });

    const rows = await api<{ entries: Array<{ id: string; actor: string; via: string; path: string }> }>(`/api/bots/${bot.id}/memory/journal`);
    const tidyRow = rows.entries.find((row) => row.actor === "upkeep" && row.via === "tidy" && row.path === "MEMORY.md")!;
    await api(`/api/bots/${bot.id}/memory/journal/${tidyRow.id}/revert`, "POST");
    expect((await memoryFile(bot.id)).text).toContain("Dentist appointment on Monday");
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 180_000);
