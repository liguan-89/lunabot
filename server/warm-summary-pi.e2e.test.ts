// Warm summary end to end on pi: the real server drives the fake pi CLI, which
// reports a 60k-token context — past the native plan's floor (min(100k,
// (128k−16.4k)/2) ≈ 55.8k) but under its soon line — so the host schedules the
// summary on the idle timer (3 min at LUNABOT_WARM_SUMMARY_TIME_SCALE=0.01 → ~1.8 s),
// clones the session onto a fork and runs pi's own `compact` on it.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlLunabot } from "../scripts/control-lunabot.ts";
import { request } from "../scripts/mcp-server.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(extra: NodeJS.ProcessEnv = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "omb-pi-warm-summary-"));
  const env = {
    ...process.env,
    FAKE_PI_CONTEXT_TOKENS: "60000",
    LUNABOT_WARM_SUMMARY_TIME_SCALE: "0.01",
    ...extra,
  };
  const session = await launchVerificationServer(env);
  try {
    const url = session.info.url;
    const cli = (...args: string[]) => runControlLunabot(args, { env: { LUNABOT_URL: url } }) as Promise<any>;
    const bot = (await cli("new-bot", "--name", "pi warm summary probe")).bot;
    const thread = bot.activeTaskId as string;
    const task = () => JSON.parse(readFileSync(join(session.info.dataDir, "bots.json"), "utf8"))
      .find((b: any) => b.id === bot.id).tasks.find((t: any) => t.threadId === thread);
    const send = async (text: string) => {
      await cli("send", "--bot", bot.id, "--task", thread, "--text", text);
      expect((await cli("wait", "--bot", bot.id, "--task", thread, "--timeout", "60")).status).toBe("settled");
    };
    const messages = async () => (await request(`/api/threads/${thread}/messages?limit=200`, {}, url) as any).messages as any[];
    const rows = () => readFileSync(session.fixtureDumpPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    return { session, bot, thread, task, send, messages, rows,
      close: async () => { try { await session.close(); } finally { await removeTempDir(scratch); } } };
  } catch (error) {
    await session.close();
    await removeTempDir(scratch);
    throw error;
  }
}

it("pi summarizes its own session fork while the conversation idles, and the next turn rides the fork", async () => {
  const f = await setup();
  try {
    await f.send("remember the codename ALBATROSS");
    const before = f.task().resumeCursors.pi as string;
    expect(before).toMatch(/pi-session-\d+\.json$/);

    // The parked warm child picks up the summary on the idle timer.
    await sleep(6_000);
    const fork = f.task().resumeCursors.pi as string;
    expect(fork).toBe(`${before}.fork1.json`);
    const rows = f.rows();
    expect(rows.some((row) => row.clone === fork)).toBe(true);
    expect(rows.some((row) => typeof row.compact === "object" && row.compact !== null)).toBe(true);
    expect((await f.messages()).some((m) => m.kind === "activity" && /summarized this conversation while it was idle/.test(m.tool?.name ?? ""))).toBe(true);

    const spawnsBefore = rows.filter((row) => "argv" in row).length;
    await f.send("what was the codename?");
    // One warm child the whole time: the fork turn reuses it — no respawn, no
    // session switch, just a prompt on the compacted fork.
    const after = f.rows();
    expect(after.filter((row) => "argv" in row).length).toBe(spawnsBefore);
    expect(after.filter((row) => row.switchSession)).toHaveLength(0);
    expect(f.task().resumeCursors.pi).toBe(fork);
  } finally {
    await f.close();
  }
}, 90_000);
