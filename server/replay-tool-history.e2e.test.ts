import { existsSync } from "node:fs";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlLunabot } from "../scripts/control-lunabot.ts";
import { request } from "../scripts/mcp-server.ts";
import type { WireMessage } from "../shared/wire.ts";
import { piDumpPath, piTurnText, piTurns } from "./testing/pi-dump.ts";
import { withoutTurnClock } from "./testing/turn-clock-text.ts";

it("names earlier tool calls in a rebuilt session only when switched on", async () => {
  const fixture = await launchVerificationServer({
    ...process.env,
    // every turn runs a failing command and a read before it replies. Scripted calls ride the fake pi's compat bridge,
    // which the launcher turns on when a caller sets one of the retired Claude knob names.
    FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([
      { name: "Bash", input: { command: "pnpm test", description: "INPUT_PREVIEW_ONLY" }, output: "RESULT_BODY 3 failed", ok: false },
      { name: "Read", input: { file_path: "/fixture/notes.md", limit: 40 }, output: "RESULT_BODY notes", ok: true },
    ]),
  });
  const dumpPath = piDumpPath(fixture.info.dataDir);
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const control = async (...args: string[]) => {
    const result = await runControlLunabot([...args, "--url", fixture.info.url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  try {
    const bot = (await control("new-bot", "--name", "Replay probe")).bot;
    const thread: string = bot.activeTaskId;
    const messages = async () =>
      (await request(`/api/threads/${thread}/messages?limit=100`, {}, fixture.info.url) as { messages: WireMessage[] }).messages;
    const settled = async () =>
      expect((await control("wait", "--bot", bot.id, "--task", thread, "--timeout", "30")).status).toBe("settled");
    /** The last pi turn's own words as the provider received them: the replay when the turn rebuilt the session, and
     * only the new line when it resumed one (pi sends the standing prompt once, on a session's first turn). */
    const prompt = () => {
      const turn = piTurns(dumpPath).at(-1);
      const text = withoutTurnClock(turn ? piTurnText(turn) : "");
      evidence.push({ prompt: text });
      return text;
    };
    const send = async (text: string) => {
      await control("send", "--bot", bot.id, "--task", thread, "--text", text);
      await settled();
      return prompt();
    };
    /** Rewind: edit the latest user message, which replays the surviving branch. */
    const rewind = async (text: string) => {
      const latest = (await messages()).findLast(message => message.role === "user")!;
      await control("edit", "--bot", bot.id, "--task", thread, "--message", latest.id, "--text", text);
      await settled();
      return prompt();
    };
    const toolLines = (text: string) => text.split("\n").filter(line => line.startsWith("Assistant: [ran: "));

    await send("FIRST_REQUEST run the tests");
    const calls = (await messages()).filter(message => message.tool?.itemId);
    expect(calls.map(message => [message.tool?.name, message.tool?.ok])).toEqual([["Bash", false], ["Read", true]]);
    // the Read's chip shows no file: the path is only in the stored input preview
    expect(calls[1]!.tool).toMatchObject({ name: "Read", input: expect.stringContaining('"file_path": "/fixture/notes.md"') });
    expect(calls[1]!.tool?.summary).toBeUndefined();

    // A turn that resumes its session is sent the message, and no replay.
    expect(await send("SECOND_REQUEST anything else?")).toBe("SECOND_REQUEST anything else?");

    // Off (the default): the rewind replays what was said, as it always has.
    const off = await rewind("SECOND_REQUEST, edited");
    expect(off).toContain("rewound this conversation");
    expect(off).toContain("User: FIRST_REQUEST run the tests");
    expect(off).not.toContain("[ran: ");

    await request("/api/config", { method: "PATCH", body: JSON.stringify({ context: { replayToolHistory: true } }) }, fixture.info.url);

    // On: the same replay, plus one line per earlier call, between the
    // request it followed and the reply it led to: the command that ran,
    // and the file that was read.
    const on = await rewind("SECOND_REQUEST, edited again");
    expect(toolLines(on)).toEqual(["Assistant: [ran: Bash: pnpm test — failed]", "Assistant: [ran: Read: /fixture/notes.md — ok]"]);
    expect(on).toMatch(/User: FIRST_REQUEST run the tests\nAssistant: \[ran: Bash: pnpm test — failed\]\nAssistant: \[ran: Read: \/fixture\/notes\.md — ok\]\nAssistant: (?!\[)/);
    // no tool result, and of the input preview behind the chip only its target
    expect(on).not.toContain("RESULT_BODY");
    expect(on).not.toContain("INPUT_PREVIEW_ONLY");
    // and nothing else moved: without those lines it is the replay sent while off
    expect(on.split("\n").filter(line => !line.startsWith("Assistant: [ran: ")).join("\n"))
      .toBe(off.replace("SECOND_REQUEST, edited", "SECOND_REQUEST, edited again"));

    // A rewind throws the recorded session away, so the turn right after it rebuilds the branch as well: the same
    // replay, now from the rewound leaf. (The engine-switched-in-mid-thread case this recipe once covered went with the
    // other engines: this build runs one, and a rebuilt session is the same path a switched-in engine took.)
    const rebuilt = await send("THIRD_REQUEST thanks");
    expect(rebuilt.endsWith("THIRD_REQUEST thanks")).toBe(true);
    // Both surviving turns on the branch are named, each with the calls it ran.
    expect(toolLines(rebuilt)).toEqual([...toolLines(on), ...toolLines(on)]);
    expect(rebuilt).not.toContain("RESULT_BODY");

    // Then the new session continues normally: the next turn is sent its own line and no replay.
    expect(await send("FOURTH_REQUEST carry on")).toBe("FOURTH_REQUEST carry on");

    // The lines are built for the replay; the stored conversation has none.
    expect(JSON.stringify(await messages())).not.toContain("[ran: ");
  } finally {
    try {
      evidence.push({ turns: piTurns(dumpPath).length });
      console.info(`Replay tool-history evidence: ${JSON.stringify(evidence.at(-1))}`);
    } finally { await fixture.close(); }
    expect(existsSync(fixture.info.dataDir)).toBe(false);
  }
}, 120_000);
