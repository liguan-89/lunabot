import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { piDumpPath, piInstructionsFor, piTurnText, piTurns } from "./testing/pi-dump.ts";

function dailyLogs(root: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || !existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(path, depth + 1);
      } else if (/[\\/]memory[\\/]log[\\/]\d{4}-\d{2}-\d{2}\.md$/.test(path)) {
        out.push({ path, text: readFileSync(path, "utf8") });
      }
    }
  };
  walk(root, 0);
  return out;
}

it("carries a bot's recent 1:1 work into a room turn, tells the room, logs the turn, and carries the room back", async () => {
  const fixture = await launchVerificationServer();
  const env = { OPENMAUSBOT_URL: fixture.info.url };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as { [key: string]: unknown };
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  const dumpPath = piDumpPath(fixture.info.dataDir);
  // Everything the last pi turn was given: the instructions in effect on it, then its own words (the time line and what
  // the person wrote). pi sends the whole system prompt on a session's first turn and only the note that replaced part
  // of it afterwards, so both halves are read as the model saw them.
  const given = () => {
    const turns = piTurns(dumpPath);
    const index = turns.length - 1;
    return index < 0 ? "" : `${piInstructionsFor(turns, index)}\n${piTurnText(turns[index]!)}`;
  };
  try {
    // SAFETY: control-omb returns the created bot record under `bot`
    const { bot: lead } = await runControlOmb(["new-bot", "--name", "Lead"], { env }) as { bot: { id: string; threadId: string } };
    // SAFETY: same shape as above
    const { bot: helper } = await runControlOmb(["new-bot", "--name", "Helper"], { env }) as { bot: { id: string } };

    await runControlOmb(["send", "--bot", lead.id, "--text", "Please reconcile the September invoices."], { env });
    await runControlOmb(["wait", "--bot", lead.id, "--timeout", "30"], { env });
    const first = given();
    expect(first).not.toContain("Your recent work");

    await expect.poll(() => dailyLogs(fixture.info.dataDir).some((log) => log.path.includes(lead.id) && /from (chat|thread) /.test(log.text)), { timeout: 10_000 }).toBe(true);
    const logged = dailyLogs(fixture.info.dataDir).find((log) => log.path.includes(lead.id))!;
    expect(logged.text).toMatch(/^- \d{2}:\d{2} · from (chat|thread) .+ · .+/m);

    // SAFETY: the groups route returns the created room under `group`
    const { group } = await api("POST", "/api/groups", {
      name: "Standup", memberIds: [lead.id, helper.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    }) as { group: { id: string; threadId: string } };
    await api("POST", `/api/groups/${group.id}/messages`, { text: "Lead, what did you do today?" });
    await expect.poll(() => piTurns(dumpPath).some((turn) => turn.prompt.includes("what did you do today")), { timeout: 30_000 }).toBe(true);
    await runControlOmb(["wait", "--bot", lead.id, "--timeout", "30"], { env });
    const room = given();
    expect(room).toContain("Your recent work");
    expect(room).toMatch(/- today \d{2}:\d{2} · 1:1 with User · (?:"[^"]*" · )?you said: "/);
    const exported = await api("GET", `/api/threads/${group.threadId}/export?format=json`) as { messages?: Array<{ kind?: string; tool?: { name?: string } }> };
    const chips = (exported.messages ?? []).filter((message) => message.kind === "activity" && /recent-work brief/.test(message.tool?.name ?? ""));
    expect(chips).toHaveLength(1);
    expect(chips[0]!.tool!.name).toBe("Lead's recent-work brief covers 1 private chat with you");

    await runControlOmb(["send", "--bot", lead.id, "--text", "And now?"], { env });
    await runControlOmb(["wait", "--bot", lead.id, "--timeout", "30"], { env });
    const second = given();
    expect(second).toContain("Your recent work");
    expect(second).toContain('room "Standup" · you said: "');
    expect(dailyLogs(fixture.info.dataDir).find((log) => log.path.includes(lead.id))!.text).toContain('from room "Standup"');
    const journal = await api("GET", `/api/bots/${lead.id}/memory/journal`) as { entries: Array<{ path: string; actor: string; via: string; threadId?: string }> };
    const logRows = journal.entries.filter((entry) => entry.path.startsWith("memory/log/"));
    expect(logRows.map((row) => `${row.actor}/${row.via}`)).toEqual(["bot/turn", "bot/turn", "bot/turn"]);
    // SAFETY: /api/bots lists every bot with its main thread
    const leadThread = ((await api("GET", "/api/bots")) as { bots: Array<{ id: string; threadId: string }> }).bots.find((bot) => bot.id === lead.id)!.threadId;
    expect(logRows.map((row) => row.threadId).sort()).toEqual([leadThread, leadThread, group.threadId].sort());
  } finally {
    await fixture.close();
  }
}, 180_000);
