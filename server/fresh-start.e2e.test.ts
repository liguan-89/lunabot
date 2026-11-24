import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlLunabot } from "../scripts/control-lunabot.ts";
import { request } from "../scripts/mcp-server.ts";
import { piDumpPath, piTurnText, piTurns } from "./testing/pi-dump.ts";
import type { WireMessage } from "../shared/wire.ts";
import { withoutTurnClock } from "./testing/turn-clock-text.ts";

const OLD = /OLD_SECRET_ALPHA|OLD_BETA_REPLY|OLD_DELTA_REPLY|OLD_GAMMA_MORE|Earlier conversation summary/;

/** The session command each turn's launch was given, in piTurns order: "new" when the driver opened a session,
 * "resume" when it switched to the stored one, and null when a warm child took the turn without a session command.
 * The retired Claude fixture read this off `--resume` argv; pi speaks it over its RPC launch log. */
function sessionPerTurn(path: string): Array<"new" | "resume" | null> {
  if (!existsSync(path)) return [];
  const marks: Array<"new" | "resume" | null> = [];
  let pending: "new" | "resume" | null = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, any>;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.argv) continue;
    if (row.newSession) pending = "new";
    else if (row.switchSession !== undefined) pending = "resume";
    else if (row.prompt?.message !== undefined) { marks.push(pending); pending = null; }
  }
  return marks;
}

async function setup(extraEnv: NodeJS.ProcessEnv) {
  const fixture = await launchVerificationServer({ ...process.env, ...extraEnv }, undefined, undefined, undefined, undefined, undefined);
  const control = async (...args: string[]) => runControlLunabot([...args, "--url", fixture.info.url]) as Promise<any>;
  const bot = (await control("new-bot", "--name", "Fresh probe")).bot;
  const thread: string = bot.activeTaskId;
  const api = (path: string, options: RequestInit = {}) => request(path, options, fixture.info.url);
  const messages = async () => (await api(`/api/threads/${thread}/messages?limit=200`) as { messages: WireMessage[] }).messages;
  const settled = async () => expect((await control("wait", "--bot", bot.id, "--task", thread, "--timeout", "30")).status).toBe("settled");
  const dumpPath = piDumpPath(fixture.info.dataDir);
  /** Set by a test while its turn must carry nothing from before the divider. */
  let oldLines = /(?!)/;
  const send = async (text: string) => {
    await control("send", "--bot", bot.id, "--task", thread, "--text", text);
    await settled();
    const sent = piTurns(dumpPath).at(-1)!;
    const full = withoutTurnClock(sent.prompt);
    // Everything the provider got is checked (`full`); `prompt` is the turn's own line, after the time line it opens with.
    expect(full).not.toMatch(oldLines);
    return {
      prompt: withoutTurnClock(piTurnText(sent)),
      full,
      pid: sent.launch?.pid as number | undefined,
      session: sessionPerTurn(dumpPath).at(-1) ?? null,
    };
  };
  const startFresh = () => api(`/api/bots/${bot.id}/start-fresh`, { method: "POST", body: JSON.stringify({ threadId: thread }) });
  const close = async () => { try { await fixture.close(); } finally { expect(existsSync(fixture.info.dataDir)).toBe(false); } };
  const guard = () => { oldLines = OLD; };
  return { fixture, control, bot, thread, api, messages, settled, send, startFresh, guard, close };
}

it("sends the provider nothing from before the divider, while a warm session and the turn before it stay untouched", async () => {
  // The reply state keeps the scripted replies in order across the new process, so "OLD" only ever marks the turns before the divider.
  const dir = mkdtempSync(join(tmpdir(), "omb-fresh-start-"));
  // Scripted replies run through the fake's compat bridge (room-holds and live-call do the same).
  const f = await setup({ FAKE_PI_CLAUDE_COMPAT: "1", FAKE_PI_REPLIES: JSON.stringify(["OLD_BETA_REPLY", "OLD_DELTA_REPLY", "after one", "after two", "after three"]), FAKE_PI_REPLY_STATE: join(dir, "replies") });
  try {
    const first = await f.send("OLD_SECRET_ALPHA remember this");
    expect(first.prompt).toBe("OLD_SECRET_ALPHA remember this");
    expect(first.session).toBe("new");

    // Before the divider nothing changes: the warm process takes the turn, sent only the new line.
    const second = await f.send("OLD_GAMMA_MORE and this");
    expect(second.prompt).toBe("OLD_GAMMA_MORE and this");
    expect(second.pid).toBe(first.pid);
    expect(second.session).toBeNull();

    // A summary written before the divider must not cross it either.
    await f.api(`/api/bots/${f.bot.id}/compact`, { method: "POST", body: JSON.stringify({ threadId: f.thread }) });
    await f.settled();
    expect((await f.messages()).some((m) => m.kind === "compaction" && m.compaction && !m.compaction.fresh)).toBe(true);

    f.guard();
    const reset = await f.startFresh() as { message: WireMessage | null };
    expect(reset.message?.compaction?.fresh).toBe(true);
    const shown = await f.messages();
    expect(shown.at(-1)?.compaction?.fresh).toBe(true);
    expect(shown.some((m) => m.text?.includes("OLD_SECRET_ALPHA"))).toBe(true);

    // The next turn is a new provider session, carrying only its own words.
    const third = await f.send("after the divider");
    expect(third.prompt).toBe("after the divider");
    expect(third.session).toBe("new");
    expect(third.pid).not.toBe(first.pid);

    // After it, the new session continues normally. The turn right after a divider re-anchors once more — the
    // recorded cursor is cleared when the rewound turn dispatches — so it replays the post-divider lines on its
    // own new session, and only the turn after that settles into the bare resumed shape.
    const fourth = await f.send("still fresh");
    expect(fourth.full).toContain("User: after the divider");
    expect(fourth.prompt.endsWith("still fresh")).toBe(true);
    expect(fourth.session).toBe("new");
    expect(fourth.pid).not.toBe(third.pid);
    const fifth = await f.send("and again");
    expect(fifth.prompt).toBe("and again");
    expect(fifth.pid).toBe(fourth.pid);
    expect(fifth.session).toBeNull();

    // A summary written after the divider covers only what follows it.
    await f.api(`/api/bots/${f.bot.id}/compact`, { method: "POST", body: JSON.stringify({ threadId: f.thread }) });
    await f.settled();
    const newest = (await f.messages()).findLast((m) => m.kind === "compaction" && !m.compaction?.fresh)!;
    expect(newest.compaction?.summary).toMatch(/after the divider|after one|and again/);
    expect(newest.compaction?.summary).not.toMatch(OLD);
  } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
}, 120_000);

it("does not resume the old session when the engine process has already exited", async () => {
  const f = await setup({ FAKE_PI_CLAUDE_COMPAT: "1", FAKE_PI_EXIT_AFTER_TURN: "1" });
  try {
    const first = await f.send("OLD_SECRET_ALPHA remember this");
    const second = await f.send("OLD_GAMMA_MORE and this");
    // Before the divider a cold turn resumes, as it always has.
    expect(second.session).toBe("resume");
    expect(second.prompt).toBe("OLD_GAMMA_MORE and this");
    expect(second.pid).not.toBe(first.pid);

    f.guard();
    await f.startFresh();
    const third = await f.send("after the divider");
    expect(third.prompt).toBe("after the divider");
    expect(third.session).toBe("new");
  } finally { await f.close(); }
}, 120_000);

it("refuses while a turn is running, and a repeat press adds nothing", async () => {
  const f = await setup({ FAKE_PI_HOLD_ON: "stuck turn" });
  try {
    await f.control("send", "--bot", f.bot.id, "--task", f.thread, "--text", "stuck turn");
    await expect.poll(async () => (await f.api(`/api/bots`) as { bots: Array<{ id: string; busy: boolean }> }).bots.find((b) => b.id === f.bot.id)?.busy, { timeout: 20_000 }).toBe(true);
    await expect(f.startFresh()).rejects.toThrow(/409|stop it before starting fresh/);
    await f.api(`/api/bots/${f.bot.id}/interrupt`, { method: "POST", body: JSON.stringify({ threadId: f.thread }) });
    await expect.poll(async () => (await f.api(`/api/bots`) as { bots: Array<{ id: string; busy: boolean }> }).bots.find((b) => b.id === f.bot.id)?.busy, { timeout: 20_000 }).toBe(false);

    await f.startFresh();
    expect(((await f.startFresh()) as { message: unknown }).message).toBeNull();
    expect((await f.messages()).filter((m) => m.compaction?.fresh)).toHaveLength(1);
  } finally { await f.close(); }
}, 90_000);
