// Two direct turns and one room turn through the shared control fixture, now on its only engine, the fake pi.
// pi reports a call from `tool_execution_end` as a bounded preview and has no hook channel, so observed tool
// evidence reads `preview`, never `full`; the retired fixture's hook spill files and untruncated results are
// gone with that channel, and the per-turn evidence kept here is the durable `digest.append` receipt.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLunabot } from "../scripts/control-lunabot.ts";
import { piDumpPath, piTurns } from "./testing/pi-dump.ts";
import type { WireMessage } from "../shared/wire.ts";

it("records independent turns and room speakers through the shared control fixture", async () => {
  const fixture = await launchVerificationServer({
    // The launcher keeps only OS launch variables and FAKE_PI_* knobs; Windows shell hooks need COMSPEC/SYSTEMROOT.
    ...process.env,
    // `slow` plays the scripted call and then answers, so every turn shows a real tool call. The fake names the
    // call `compat-0` on every turn: the two turns genuinely reuse one tool id, as the retired fixture's
    // `reused-tool-id` did, but each turn's row carries its own turn id.
    FAKE_PI_MODE: "slow",
    FAKE_PI_TOOL_CALLS: JSON.stringify([{ name: "Bash", input: { command: "echo receipt" }, output: "receipt", ok: true }]),
  });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const control = async (args: string[]) => {
    const result = await runControlLunabot([...args, "--url", fixture.info.url]);
    evidence.push({ command: args, result });
    return result as any;
  };
  const messages = async (threadId: string) => {
    const response = await fetch(`${fixture.info.url}/api/threads/${threadId}/messages?limit=50`);
    expect(response.ok).toBe(true);
    return (await response.json() as { messages: WireMessage[] }).messages;
  };
  try {
    expect((await control(["doctor"])).ok).toBe(true);
    const first = (await control(["new-bot", "--name", "Digest one"])).bot;
    const second = (await control(["new-bot", "--name", "Digest two"])).bot;
    for (const text of ["First receipt", "Second receipt"]) {
      await control(["send", "--bot", first.id, "--text", text]);
      expect((await control(["wait", "--bot", first.id, "--timeout", "20"])).status).toBe("settled");
    }
    await control(["messages", "--bot", first.id, "--limit", "20"]);
    // Both turns are direct and read their own live pi session, never another speaker's delta note.
    const prompts = piTurns(piDumpPath(fixture.info.dataDir)).map(turn => turn.prompt);
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) expect(prompt).not.toContain("Messages this conversation received");
    const direct = await messages(first.activeTaskId);
    const digests = direct.filter(row => row.kind === "digest");
    expect(digests).toHaveLength(2);
    expect(new Set(digests.map(row => row.turnId)).size).toBe(2);
    for (const row of digests) {
      expect(row.digest?.botId).toBe(first.id);
      expect(row.digest?.tools).toMatchObject([{ name: "Bash", count: 1, failed: 0, sample: "echo receipt" }]);
      // pi's driver has no hook channel: what a digest reports is the bounded preview it observed.
      expect(row.digest?.hookCoverage).toBe("preview");
      const tools = direct.filter(message => message.turnId === row.turnId && message.tool?.itemId);
      expect(tools).toHaveLength(1);
      expect(tools[0]!.tool).toMatchObject({ name: "Bash", itemId: "compat-0" });
      // No hook wrote an untruncated result or a spill path, so neither field exists on a pi turn's row.
      expect(tools[0]!.tool).not.toHaveProperty("fullResult");
      expect(tools[0]!.tool).not.toHaveProperty("outputPath");
    }
    // The fake reuses `compat-0` on both turns; the rows stay distinct because each keeps its own turn id.
    expect(direct.filter(message => message.tool?.itemId).map(message => message.tool!.itemId)).toEqual(["compat-0", "compat-0"]);
    // Replacing the retired fixture's two spill files under tool-results/<thread>: pi spills nothing, so the
    // durable per-turn evidence is the receipt row below (one per turn id), not a file on disk.
    expect(JSON.stringify(direct)).not.toContain(fixture.info.dataDir);
    const channel = (await control(["new-channel", "--name", "Receipt room", "--members", `${first.id},${second.id}`])).channel;
    await control(["send-channel", "--channel", channel.id, "--text", "Each reply once"]);
    expect((await control(["wait", "--channel", channel.id, "--timeout", "30"])).status).toBe("settled");
    const transcript = await control(["messages", "--channel", channel.id, "--limit", "30"]);
    const roomDigests = transcript.messages.filter((row: WireMessage) => row.kind === "digest");
    expect(roomDigests.length).toBeGreaterThan(0);
    for (const row of roomDigests) expect([first.id, second.id]).toContain(row.from?.botId);
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
    try {
      const receipts = db.prepare("SELECT key FROM command_receipts WHERE kind = 'digest.append' AND key LIKE ?")
        .all(`${first.activeTaskId}:%`) as Array<{ key: string }>;
      expect(receipts).toHaveLength(2);
      expect(receipts.map(row => row.key).sort()).toEqual(digests.map(row => `${first.activeTaskId}:${row.turnId}`).sort());
    } finally { db.close(); }
  } finally {
    try {
      const path = `${fixture.info.logPath}.digests.json`;
      writeFileSync(path, JSON.stringify(evidence, null, 2));
      console.log("Digest control evidence saved.");
    } finally { await fixture.close(); }
    expect(existsSync(fixture.info.dataDir)).toBe(false);
  }
}, 90_000);
